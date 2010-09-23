var fs = require('fs')
var net = require('net')
var _ = require('underscore')._

var split_host_port = function(str) {
  var ret = str.split(':')
  return { port: parseInt(ret[1], 10), host: ret[0] }
}

var split_srv = function(str) {
  var val = {
              my: { port: 0, host: '0.0.0.0' },
              peer: { port: 0, host: '0.0.0.0' }
            }
  var srv = str.split('-')
  if (srv.length == 2) {  
    val.my = split_host_port(srv[0])
    val.peer = split_host_port(srv[1])
  } else {
    val.peer = split_host_port(str)
  }
  return val
}
console.log(JSON.stringify(process.argv))

arg = 2
var tun_dev = split_host_port(process.argv[arg]).host // no nice but working
var tun_fd =  split_host_port(process.argv[arg++]).port

var mode = process.argv[arg++]
var name = process.argv[arg++]

var servers = []
for(var i = arg; i < process.argv.length; ++i) {
  servers.push(split_srv(process.argv[i]))
}
console.log('tun_dev='+tun_dev+' tun_fd='+tun_fd+" servers="+JSON.stringify(servers))

var output_streams = []

var packet_cnt = 0
var packet_input = function() {
  var packet = new Buffer(1600) 
  /* tun has a 4byte header i currently not know what this means */
  fs.read(tun_fd, packet, 4, packet.length-4, null, function(err, len) {
    var plen = (((len) + 10000)+'').slice(1)
//console.log('plen='+plen) 
    packet.write(plen, 0, 'ascii')  
    if (output_streams.length > 0) {
      var cnt = 0
      packet_cnt++
//console.log('send-plen='+len) 
      output_streams[packet_cnt%output_streams.length].write(packet.slice(0,len+4))
    }
    packet_input()
  })
}

packet_input()

var streamer = function(stream, fn_closed) {
  stream.setEncoding('binary')
  var wait_for_packet_length = true
  var buffer = new Buffer(16*1024*1024)
  var start = 0
  var ofs = 0
  var packet_length = -1
  var drop = 0
  stream.on('connect', function() {
console.log('client-connect:'+stream.remoteAddress+":"+stream.remotePort)
    output_streams.push(stream)
  })
  var clear_output_streams = function() {
console.log('client-close:'+stream.remoteAddress+":"+stream.remotePort)
    output_streams = _(output_streams).reject(function(s) { return s == stream })
    console.log('client-close')
    fn_closed && fn_closed()   
    fn_closed = false
  }
  stream.on('close', clear_output_streams)
  stream.on('end', clear_output_streams)
  stream.on('error', clear_output_streams)

  stream.on('data', function(data) {
    try {
	    buffer.write(data, ofs, 'binary')  
    } catch (e) {
console.log('drop output:'+(++drop))
	return;
    }
    ofs += data.length
    while (start != ofs) {
//console.log('-1:'+start+":"+ofs+":"+packet_length+":"+wait_for_packet_length.toString())

    if (wait_for_packet_length) {
      if (ofs-start >= 4) {
        wait_for_packet_length = false
        packet_length = parseInt(buffer.toString('ascii', start, start+4),10)
        start += 4
              if (start == ofs) { ofs = start = 0 }
      } else {
        break
      }
    } 
    if (!wait_for_packet_length) {
      if (ofs-start >= packet_length) {
//console.log('-6-'+start+":"+ofs+":"+packet_length)
        wait_for_packet_length = true
        fs.write(tun_fd, buffer, start, packet_length) //, null) 
        start += packet_length
        packet_length = -1    
              if (start == ofs) { ofs = start = 0 }
      } else {
        break
      }
    }
    }
  })
}
if (mode == 'server') {
  _(servers).each(function(server) { 
    net.createServer(streamer).listen(server.peer.port, server.peer.host) 
  })
} else {
  var client_connect = function(server, stream) {
console.log('Connect peer='+server.peer.host+":"+ server.peer.port+" my="+server.my.host+":"+ server.my.port)
    stream = net.createConnection(server.peer.port, server.peer.host, {bind: server.my })   
    streamer(stream, function() {
      setTimeout(function() { client_connect(server, stream) }, 500)
    })
  }
  _(servers).each(function(server) { client_connect(server) })
}

