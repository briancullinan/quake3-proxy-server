
const { MAP_DICTIONARY } = require('../assetServer/list-maps.js')
const { sourcePk3Download } = require('../mapServer/download.js')
const { GAME_SERVERS } = require('./master.js')
const { getGame } = require('../utilities/env.js')
const { renderList } = require('../utilities/render.js')
const { renderIndex } = require('../utilities/render.js')

/*
  if (rangeString && rangeString.includes(':')) {
    let address = rangeString.split(':')[0]
    let port = rangeString.split(':')[1]
    return next()
  }
*/

async function gameInfo(serverInfo) {
  if (!serverInfo.hostname || !serverInfo.mapname) {
    return
  }
  let mapname = serverInfo.mapname.toLocaleLowerCase()
  let levelshot
  let pk3name = await sourcePk3Download(mapname)
  if (pk3name) {
    levelshot = `/${getGame()}/${MAP_DICTIONARY[mapname]}.pk3dir/levelshots/${mapname}.jpg`
  } else {
    levelshot = '/unknownmap.jpg'
  }
  return {
    title: serverInfo.hostname,
    levelshot: levelshot,
    bsp: mapname,
    pakname: MAP_DICTIONARY[mapname],
    have: !!pk3name,
    mapname: mapname,
    link: `games/${serverInfo.address}:${serverInfo.port}`,
  }
}


async function serveGames(request, response, next) {
  let isJson = request.originalUrl.match(/\?json/)
  let start = 0
  let end = 100
  return serveGamesReal(start, end, isJson, response, next)
}


async function serveGamesRange(request, response, next) {
  let filename = request.originalUrl.replace(/\?.*$/, '')
  let isJson = request.originalUrl.match(/\?json/)
  let rangeString = filename.split('\/games\/')[1]
  let start = 0
  let end = 100
  if (rangeString && rangeString.includes('\/')) {
    start = parseInt(rangeString.split('\/')[0])
    end = parseInt(rangeString.split('\/')[1])
  }
  return serveGamesReal(start, end, isJson, response, next)
}


async function serveGamesReal(start, end, isJson, response, next) {
  // TODO: filter games by game type
  let games = await Promise.all(Object.values(GAME_SERVERS).slice(start, end).map(game => gameInfo(game)))
  if (isJson) {
    return response.json(games)
  }
  console.log(GAME_SERVERS)
  let total = Object.values(GAME_SERVERS).length
  let index = renderIndex(renderList('/games/', games, total, 'game-list'))
  return response.send(index)
}


async function serveList(request, response, next) {
  let isJson = request.originalUrl.match(/\?json/)
  let start = 0
  let end = 100
  // TODO: add filtering
  return response.json(Object.values(GAME_SERVERS))

  // TODO: add list HTML display, same for processes, for many details
}


module.exports = {
  serveGames,
  serveGamesRange,
  serveList,
}