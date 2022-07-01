
const { redirectAddress } = require('../utilities/env.js')

const UDP_SERVERS = []
const UDP_CLIENTS = []
const WS_FORWARDS = []

async function serveUDP(socket, address, port) {
  const { createServer } = require('http')
  const { createSocket } = require('dgram')
  const redirectApp = createRedirect(redirectAddress())
  console.log('UDP associate: ' + address + ':' + port)

  if (typeof UDP_SERVERS[port] == 'undefined') {
    UDP_SERVERS[port] = createSocket('udp4')
    UDP_SERVERS[port].bind(port, '0.0.0.0')
    UDP_SERVERS[port].on('message', function (message, rinfo) {
      return forwardMessage(port, false /* isWS */, message, rinfo)
    })
    let httpServer = createServer(redirectApp).listen(port)
    HTTP_LISTENERS[port] = httpServer
    WS_FORWARDS[port] = createWebsocket(httpServer)
    WS_FORWARDS[port].on('message', function (message, rinfo) {
      return forwardMessage(port, true /* isWS */, message, rinfo)
    })
  }

  // instead of using on() event listeners, just use a list
  UDP_CLIENTS[port] = socket
  let bindIP = await lookupDNS(socket._socket.localAddress)
  let IPsegments = bindIP.split('.').map(seg => parseInt(seg))
  console.log(bindIP)

  return [
    0x05, REP.SUCCESS, 0x00, ATYP.IPv4
    // for simplicity, the mock DNS service inside the browser
    //   only deals in IPv4, so addresses are converted back.
  ].concat(IPsegments).concat([
    (port & 0xF0 >> 8), (port & 0xF)
  ])
}

function forwardMessage(port, isWS, message, rinfo) {
  //console.log(arguments)
  let domain = reverseLookup(isWS, rinfo.address)
  let buffer
  if (!domain) {
    let localbytes = rinfo.address.replace('::ffff:', '')
      .split('.').map(seg => parseInt(seg))
    buffer = Buffer.alloc(4 + localbytes.length + 2 /* port */).fill(0)
    buffer[3] = ATYP.IPv4
    for (let i = 0, p = 4; i < localbytes.length; ++i, ++p) {
      buffer[p] = localbytes[i]
    }
    buffer.writeUInt16LE(rinfo.port, 8, true)
  } else {
    buffer = Buffer.alloc(4 + 1 /* for strlen */ + domain.length + 1 /* \0 null */ + 2 /* port */).fill(0)
    buffer[3] = ATYP.NAME
    buffer[4] = domain.length + 1
    buffer.write(domain, 5)
    buffer.writeUInt16LE(rinfo.port, 5 + buffer[4], true)
  }
  buffer[0] = 0x05
  buffer[1] = message === true ? REP.SUCCESS : 0x00
  buffer[2] = 0x00
  if (UDP_CLIENTS[port])
    UDP_CLIENTS[port].send(message === true
      ? buffer : Buffer.concat([buffer, message]),
      { binary: true })
}


module.exports = {
  serveUDP,
}
