const fs = require('fs')
const path = require('path')


const { updatePageViewers } = require('../contentServer/session.js')
const { dedicatedCmd } = require('../cmdServer/cmd-dedicated.js')
const { RESOLVE_DEDICATED, EXECUTING_MAPS, GAME_SERVERS } = require('../gameServer/processes.js')
const { RESOLVE_LOGS, UDP_SOCKETS, MASTER_PORTS, sendOOB } = require('../gameServer/master.js')
const buildChallenge = require('../quake3Utils/generate-challenge.js')
const { FS_GAMEHOME, getGame } = require('../utilities/env.js')
const { START_SERVICES } = require('../contentServer/features.js')


// TODO: this is pretty lame, tried to make a screenshot, and a
//   bunch of stuff failed, now I have some arbitrary wait time
//   and it works okay, but a real solution would be "REAL-TIME"!
// TODO: open a control port and create a new master server. One
//   separate master control for every single map, split up and only
//   do 10 maps at a time, because of this.

const GAMEINFO_TIMEOUT = 60 * 1000
const RESOLVE_INTERVAL = 1000
const RENDERER_TIMEOUT = 20000
const MAX_RENDERERS = 2
const EXECUTING_LVLSHOTS = {}
let lvlshotTimer
let RUNCMD = 0

function listJobs() {
  // sort by if the existing stack has less than <MAX_RENDERERS> commands
  //   and if the time is less than <RENDERER_TIMEOUT> from the request
  let mapNames = Object.keys(EXECUTING_LVLSHOTS)
  let mapNamesFiltered = mapNames.sort(function (a, b) {
    // sort by the average minimum * number of tasks
    EXECUTING_LVLSHOTS[a].sort((c, d) => d.subscribers.length - c.subscribers.length)
    EXECUTING_LVLSHOTS[b].sort((c, d) => d.subscribers.length - c.subscribers.length)
    let aTasks = EXECUTING_LVLSHOTS[a].slice(0, MAX_RENDERERS)
    let bTasks = EXECUTING_LVLSHOTS[b].slice(0, MAX_RENDERERS)
    let aSum = aTasks.reduce((sum, task) => (sum + task.created), 0) || Number.MAX_VALUE
    let bSum = bTasks.reduce((sum, task) => (sum + task.created), 0) || Number.MAX_VALUE
    // oldest to newest
    return aSum / aTasks.length - bSum / bTasks.length
  }).slice(0, MAX_RENDERERS)
  return mapNamesFiltered.filter(map => EXECUTING_LVLSHOTS[map].length)
}


async function resolveSwitchmap(logs, task) {
  let working = Object.keys(EXECUTING_MAPS).filter(challenge => 
    EXECUTING_MAPS[challenge].working == task)[0]
  let serverInfo = Object.values(GAME_SERVERS).filter(info => 
    info.qps_serverId == working)[0]
  if(!working || !serverInfo) {
    // CODE REVIEW: this finally helped me get into a bug involving the processes list pid
    return false
    throw new Error('Not working!')
  }

  if(task.cmd.match(serverInfo.mapname)) {
    return true
  }
  return false
}


async function processQueue() {
  // TODO: keep track of levelshot servers separately, sort / priorize by 
  //   Object.keys(EXECUTING_LVLSHOTS) == mapname, then prioritize by list
  //   i.e. if there are 2 maps with 2 tasks, there should be 4 servers running
  //   in parallel with 2 redundant maps loaded.
  if (!lvlshotTimer) {
    console.log('Starting renderer service.')
    lvlshotTimer = setInterval(function () {
      Promise.resolve(processQueue())
    }, 1000 / 60)
    return
  }
  
  let mapNamesFiltered = listJobs()

  for(let i = 0; i < mapNamesFiltered.length; ++i) {
    // out of these <MAX_RENDERERS> maps, queue up to <MAX_RENDERERS> tasks for each
    //   of the <MAX_RENDERERS> servers to perform simultaneously.
    let mapname = mapNamesFiltered[i]
    let renderers = Object.values(EXECUTING_MAPS).filter(map => map.renderer)
    let freeRenderers = renderers.filter(map => !map.working)

    if(freeRenderers.length == 0) {
      let notTimedOut = renderers.filter(map => {
        let SERVER = Object.values(GAME_SERVERS).filter(info => info.qps_serverId == map.challenge)[0]
        let updateTime = 0
        if(SERVER && SERVER.sv_maxRate) {
          updateTime = parseInt(SERVER.sv_maxRate)
        }
        if(updateTime < GAMEINFO_TIMEOUT) {
          updateTime = GAMEINFO_TIMEOUT
        }        
        return !SERVER || !SERVER.timedout
          // still include the server in the list unless it has failed a few times
          //   to hit that higher GAMEINFO_TIMEOUT
          || (Date.now() - SERVER.timeUpdated) < Math.max(updateTime)
      })
      if(notTimedOut.length >= MAX_RENDERERS) {
        //console.log('Max servers: ' + mapname)
        continue // can't do anything
      } else { // start another server
        Promise.resolve(serveLvlshot(mapname))
        continue
      }
    } else {

      let mapRenderers = renderers.filter(map => map.mapname == mapname)
      let serversAvailable = freeRenderers
          .sort((a, b) => (a.mapname == mapname ? 0 : 1) - (b.mapname == mapname ? 0 : 1))
          .map(map => Object.values(GAME_SERVERS).filter(info => info.qps_serverId == map.challenge)[0])
          .filter(server => server)
      let SERVER
      if (serversAvailable.length == 0 || 
        // if there are other renderers of this map name available
        //   and there are other map names to serve, then try not to switch
        (serversAvailable[0].mapname != mapname
          && mapRenderers.length > 0 && mapNamesFiltered.length > 1)
      ) {
        //console.log('None available: ' + mapname)
        continue
      } else {
        SERVER = EXECUTING_MAPS[serversAvailable[0].qps_serverId]
      }
      //console.log('Server available: ', mapRenderers, mapname, serversAvailable[0])
      
      // remove tasks that have already completed so we don't waste time switching maps

      // TODO: use RCON interface to control servers and get information
      let task = EXECUTING_LVLSHOTS[mapname][0]
      if(!task) {
        //console.log('No tasks: ' + mapname)
        continue
      } else
      if(task.done) {
        EXECUTING_LVLSHOTS[mapname].shift()
      } else
      if(task.started && Date.now() - task.started < 100
        || (task.started && !task.timedout)) {
        continue // don't duplicate tasks
      } else
      if(await updateSubscribers(mapname, serversAvailable[0].logs, task)) {
        //console.log('Already done: ' + mapname)
        EXECUTING_LVLSHOTS[mapname].shift()
        continue // already done, don't command
      }


      // switch the maps
      if(serversAvailable[0].mapname != mapname) {
        // this server is no longer needed by the mapserver
        //   this prevents it from switching servers back and forth
        //   continuously and not getting any work done
        if(!mapNamesFiltered.includes(serversAvailable[0].mapname)
          // this prevents it from running devmap commands on 
          //   more than one server at a time?
          && (!task.started || !task.cmd.match('devmap'))
        ) {
          console.log('Switching maps: ' + mapname)
          // TODO: send map-switch to  <freeRenderer>  command if there is more than 4 tasks
          task = {
            // TODO: not going to risk trying to make this lower
            //   rather just add more servers with com_affinityMask set
            cmd: ` ; devmap ${mapname} ; wait 360 ; heartbeat ; `,
            resolve: resolveSwitchmap,
            outFile: void 0,
            mapname: mapname,
            // drag the time average down so this event is sure to stick when using listJobs() to sort
            //   what events to execute next
            created: Number.MIN_VALUE, 
            subscribers: [],
          }
          // CODE REVIEW: LOL GODDAMNIT, 
          //   interfering with the shift() above and below
          //   this line should have been here when I put task = { ... } in
          //   but I forgot about the shifting, this was causing image 
          //   comands to always get skipped which was causing me to 
          //   refresh the window multiple times.
          EXECUTING_LVLSHOTS[mapname].unshift(task)
          // so it doesn't try and change all servers, 
          SERVER.working = true
          // change this name here to fail the mapNamesFiltered condition
          //   this will be updated by the time the server switches
          SERVER.mapname = mapname
        } else {
          // CODE REVIEW: this was missing, this function is too complicated and leafy
          // skip sending this maps commands to this server, it might be needed elsewhere
          continue
        }
      }

      // run the task
      SERVER.working = task
      task.timedout = false
      task.started = Date.now()
      task.subscribers.push(function () {
        // TODO: add a checkin and a timeout to retry the task
        if(task.timedout) {
          // TODO: add a retry counter
          console.log('Task timed-out. Retrying.')
        } else {
          EXECUTING_LVLSHOTS[mapname].shift()
          console.log('Task completed: took ' + (Date.now() - task.created) / 1000 + ' seconds')
        }
        SERVER.working = false
      })

      // when we get a print response, let waiting clients know about it
      if(typeof RESOLVE_LOGS[serversAvailable[0].challenge] == 'undefined') {
        RESOLVE_LOGS[serversAvailable[0].challenge] = []
      }
      RESOLVE_LOGS[serversAvailable[0].challenge].push(function (logs) {
        Promise.resolve(updateSubscribers(mapname, logs, task))
      })

      console.log('Starting renderer task: ', serversAvailable[0].address 
          + ':' + serversAvailable[0].port, task.cmd)
      ++RUNCMD
      // TODO: ; set developer 1 ; 
      sendOOB(UDP_SOCKETS[MASTER_PORTS[0]], 'rcon password1 set command' 
          + RUNCMD + ' " ' + task.cmd + '"', serversAvailable[0])
      sendOOB(UDP_SOCKETS[MASTER_PORTS[0]], 'rcon password1 vstr command' + RUNCMD, serversAvailable[0])
    }
  }


  Object.values(EXECUTING_MAPS).forEach(task => {
    if(typeof task.working != 'object') {
      return
    }
    if(task.working.updated && Date.now() - task.working.updated < RESOLVE_INTERVAL) {
      return
    }
    task.working.updated = Date.now()
    let SERVER = Object.values(GAME_SERVERS).filter(info => info.qps_serverId == task.challenge)[0]
    if(Date.now() - task.working.started > RENDERER_TIMEOUT) {
      task.timedout = true
      task.working.timedout = true
    }

    // TODO: if the qconsole log file changes on disk, let clients know about it
    // TODO: individual logs files for all client
    // TODO: support for other log parsing mechanism like a game stats generator based on logs?
    let consoleLog = path.join(FS_GAMEHOME, getGame(), 'qconsole.log')
    if(fs.existsSync(consoleLog)) {
      let stat = fs.statSync(consoleLog)
      if(typeof task.logPosition == 'undefined'
       || stat.size < task.logPosition) {
        task.logPosition = stat.size
      } else
      if(stat.size > task.logPosition
        || stat.mtime.getTime() > task.logTime) {
        const fd = fs.openSync(consoleLog)
        const buffer = Buffer.alloc(stat.size - task.logPosition)
        fs.readSync(fd, buffer, { position: task.logPosition })
        fs.close(fd)
        if(SERVER) {
          SERVER.logs += buffer.toString('utf-8')
        } else {
          task.logs += buffer.toString('utf-8')
        }
        //Promise.resolve(updateSubscribers(task.mapname, SERVER.logs, task.working))
        task.logPosition = stat.size
        task.logTime = stat.mtime.getTime()
      }
    }

    if(SERVER) {
      updateSubscribers(task.mapname, SERVER.logs, task.working)
    } else {
      updateSubscribers(task.mapname, task.logs, task.working)
    }
  })
}


// TODO: turn this into some sort of temporary cfg script
async function serveLvlshot(mapname, waitFor) {
  // TODO: wait for the new dedicated process to connect to our specialized
  //   control port. Now we have a Quake 3 server command pipe. Send OOB
  //   RCON messages to control our own process remotely / asynchronously.
  // TODO: take the screenshots, run client commands using local dedicate 
  //   connected commands (side-effect, easily switch out client to a real
  //   server using the reconnect command).
  if(Object.values(EXECUTING_MAPS).filter(map => map.renderer).length >= MAX_RENDERERS) {
    return
  }

  // only start one dedicated server at a time
  let challenge = Object.keys(RESOLVE_DEDICATED).filter(list => RESOLVE_DEDICATED[list].length > 0)[0]
  if(challenge) {
    if(waitFor) {
      return await new Promise(resolve => RESOLVE_DEDICATED[challenge].push(resolve))
    } else {
      return
    }
  }

  try {
    
    let challenge = buildChallenge()
    RESOLVE_DEDICATED[challenge] = []
    RESOLVE_DEDICATED[challenge].push(function () {
      console.log('Renderer started.')
      updatePageViewers('/games')
    })
    EXECUTING_MAPS[challenge] = {
      renderer: true,
      challenge: challenge,
      mapname: mapname,
      logs: ''
    }
    let consoleLog = path.join(FS_GAMEHOME, getGame(), 'qconsole.log')
    if(fs.existsSync(consoleLog)) {
      let stat = fs.statSync(consoleLog)
      EXECUTING_MAPS[challenge].logPosition = stat.size
    }
    // TODO: manually set com_affinityMask to space out servers
    //   sure the OS can do this, but we're trying to maximize
    //   quantity, not performance or usability, we'll fill up
    //   all CPUs 100% when the time comes so make sure they 
    //   are evenly spread out.
    let ps = await dedicatedCmd([
      '+set', 'sv_pure', '0', 
      '+set', 'dedicated', '0',
      '+set', 'developer', '0',
      '+set', 'r_headless', '1',
      //'+set', 's_initsound', '0',
      '+set', 's_muteWhenUnfocused', '1',
      '+set', 's_muteWhenMinimized', '1',
      '+set', 'in_mouse', '0',
      '+set', 'sv_master2', '""',
      '+set', 'sv_master3', '""',
      '+sets', 'qps_serverId', '"' + challenge + '"',
      '+sets', 'qps_renderer', '1',
      // snapshot server has low FPS
      '+set', 'com_yieldCPU', '16',
      '+set', 'com_maxfps', '3',
      '+set', 'com_maxfpsUnfocused', '3',
      '+set', 'snaps', '10',
      '+set', 'sv_fps', '10',
      '+set', 'rconPassword2', 'password1',
      '+set', 'sv_dlURL', '"//maps/repacked/%1"',
      '+devmap', mapname,
      '+exec', `".config/levelinfo.cfg"`,
      '+vstr', 'resetLvlshot',
      '+wait', '20', '+heartbeat',
      // TODO: run a few frames to load images before
      //   taking a screen shot and exporting canvas
      //   might also be necessary for aligning animations.
    ], function (lines) {
      EXECUTING_MAPS[challenge].logs += lines + '\n'
      if(typeof EXECUTING_MAPS[challenge].working == 'object') {
        updateSubscribers(EXECUTING_MAPS[challenge].mapname, 
                          EXECUTING_MAPS[challenge].logs,
                          EXECUTING_MAPS[challenge].working)
      }
    })
    EXECUTING_MAPS[challenge].pid = ps.pid
    ps.on('close', function () {
      delete EXECUTING_MAPS[challenge]
    })
    if(typeof EXECUTING_LVLSHOTS[mapname] == 'undefined') {
      EXECUTING_LVLSHOTS[mapname] = []
    }
  } catch (e) {
    console.error('DEDICATED:', e)
  }

}


// break up the processing of specific events from the logs
//   to allow clients to subscribe
async function updateSubscribers(mapname, logs, cmd) {
  if(cmd.done) {
    return true
  }
  let result = await cmd.resolve(logs, cmd)
  let isResolved = !!result
  if(!isResolved && !cmd.timedout) {
    return false
  }

  if(!cmd.timedout) {
    cmd.done = true
  }
  if(!lvlshotTimer) {
    throw new Error('Task completed before service started.')
  }
  if(cmd.subscribers) {
    for(let j = 0; j < cmd.subscribers.length; ++j) {
      cmd.subscribers[j](result, logs, cmd)
    }
    cmd.subscribers.splice(0)
  } else {
    throw new Error('No subscribers!')
  }
  updatePageViewers('\/maps\/' + mapname)
  updatePageViewers('\/maps\/?$')
  return true
}


module.exports = {
  EXECUTING_LVLSHOTS,
  processQueue,
  listJobs,
}

