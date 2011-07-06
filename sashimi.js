var sys = require('sys');
var utils = require('util');
var fs = require('fs');
var net = require('net');
var Queue = require('./queue');

var split_host_port = function(str) {
  var ret = str.split(':');
  return { port: parseInt(ret[1], 10), host: ret[0] };
}

var split_srv = function(str) {
  var val = {
              my:   { port: 0, host: '0.0.0.0' },
              peer: { port: 0, host: '0.0.0.0' }
            };
  var srv = str.split('-');
  if (srv.length == 2) {  
    val.my   = split_host_port(srv[0]);
    val.peer = split_host_port(srv[1]);
  } else {
    val.peer = split_host_port(str);
  }
  return val;
}

/* MAIN */
console.log(JSON.stringify(process.argv));

arg = 2; // skip node and sashimi.js
var tun_dev = split_host_port(process.argv[arg]).host; // not nice but working
var tun_fd  = split_host_port(process.argv[arg++]).port;

var mode = process.argv[arg++];
var name = process.argv[arg++];

var key = {
             my:   process.argv[arg++],
             peer: process.argv[arg++]
          };

var servers = [];
for(var i = arg; i < process.argv.length; ++i) {
  var arg = process.argv[i];
  var no_output = arg.slice(0,1); 
  if (no_output == '!') { arg = arg.slice(1);  }
  var srv = split_srv(arg);
  if (no_output == '!') { srv.no_output = true; }
  else { srv.no_output = false; }
  servers.push(srv);
}
console.log('node_version:'+process.version+' tun_dev='+tun_dev+' tun_fd='+tun_fd+" servers="+JSON.stringify(servers));

var output_streams = [];
var status = { in: 0, 
               out: 0, 
               ping: { id: 0, pings: 0, pongs: 0, errors: 0 },
               connections: { 
                              open: 0,
                              client: {
                                connects: 0 
                              },
                              server: {
                                connects: 0,
                                close: 0
                              }
                            }, 
               tun: {
                      input: {
                               err: 0
                             }
                    },
               failure: { write: 0 }  };

var packet_input = function() {
  var packet = new Buffer(1600); 
  /* tun has a 4byte header i currently not know what this means */
  fs.read(tun_fd, packet, 4, packet.length-4, null, function(err, len) {
    if (err) { 
      status.tun.input.err++;
      console.log('packet_input err:'+err); 
      packet_input();
      return; 
    }
    var plen = (((len) + 10000)+'').slice(1); // leading zero's
    packet.write(plen, 0, 'ascii');  
    if (output_streams.length > 0) {
      ++status.in;
      try {
        output_streams[status.in%output_streams.length].write(packet.slice(0, len+4));
      } catch(e) {
//console.log("packet_input:DESTROY")
        output_streams[status.in%output_streams.length].destroy();
      }
    }
    packet_input();
  })
}

var streamer = function(stream, fns, opts) {
  //stream.setEncoding()
  var connected = false;
  var wait_key_peer = true;
  var queue = new Queue();
  var header = { 
        active: true, 
        len: 4, 
        completed: function(data, test) {
          header.active = false;
          packet.active = true;
          packet.len = ~~data;
          queue.add(null, packet.len, packet.completed);
          return null
        }
  }
  var ping_packet = new Buffer(20);
  var plen = (((16) + 10000)+'').slice(1); // leading zero's
  ping_packet.write(plen, 0, 'ascii');

  var ping_pong = { 
            PING: function(id) {
              status.ping.pongs++
              ping_packet.write("PONG"+id, 4, 'ascii')
              if (!stream.recvPing) { stream.recvPing = { id: null, recv: null } }
              stream.recvPing.id = id
              stream.recvPing.recv = (new Date()).getTime()
//console.log("SEND=>"+ping_packet.toString('ascii'))
              stream.write(ping_packet)
            },
            PONG: function(id) {
              if (stream.sendPing.id == id) {
                status.ping.pongs++
                stream.sendPing.id = null
                stream.sendPing.send = null
              } else {
                status.ping.errors++
                console.log("PING("+stream.sendPing.id+")<>PONG("+id+")")
              }
            }
          };
  var packet = { 
      active: false, 
      len: 0, 
      completed: function(data, test) {
        ++status.out;
        if (data.length == 16) {
          var str = data.toString("ascii");
//console.log("RECV8:"+str);
          ping_pong[str.slice(0,4)](str.slice(4,16));
        } else { 
          fs.write(tun_fd, data, 0, data.length);
        }
        header.active = true;
        packet.active = false;
        packet.len = 0;
        queue.add(null, header.len, header.completed);
      }
  }
  stream.on('connect', function() {
    stream.setNoDelay(true);
    console.log('client-connect:'+stream.remoteAddress+":"+stream.remotePort+":"+key.my+":"+opts['no_output']);
    stream.write(key.my, 'utf-8');
    connected = true;
  })
  var clear_output_streams = function() {
    connected && console.log('client-close:'+stream.remoteAddress+":"+stream.remotePort);
    for(var i = output_streams.length - 1, l = i; i >= 0; --i) {
      if (output_streams[i] === stream) {
        output_streams[i] = output_streams[l]
        output_streams.pop()
//console.log("clear_output_streams:DELETE:"+i+":"+l+":"+output_streams.length);
        break;
      }
    }
    status.connections.server.close++;
    console.log("clear_output_streams:destroy")
    connected && stream.destroy();
    connected = false;
    fns && fns.closed && fns.closed(stream);
    fns && (fns.closed = false);
  }
  stream.on('close', function() { 
    console.log('streamer:close');
    clear_output_streams();
  });
  stream.on('end', function() { 
    console.log('streamer:end');
    clear_output_streams();
  });
  stream.on('error', function() {
    console.log('streamer:error'+utils.inspect(arguments));
    clear_output_streams();
  });
  stream.on('data', function(data) {
    var obj = data;
    if (wait_key_peer) {
      queue.add(obj, key.peer.length, function(in_key) {
        if (in_key == key.peer) {
          console.log('verified key='+in_key);
          //stream.setEncoding('binary');
          wait_key_peer = false;
    	  if (!(opts && opts.no_output)) { output_streams.push(stream); }
          fns && fns.opened && fns.opened(stream);
        } else {
          console.log('not verified key='+in_key);
          stream.destroy();
        }
      })
      return;
    } 
    if (header.active) {
      queue.add(obj, header.len, header.completed);
    } else if (packet.active) { 
      queue.add(obj, packet.len, function(data, test ) { 
        packet.completed(data, test);
      })
    }
  });
}
var ping = function(output_streams, mode) { 
  return function() {
    var packet = new Buffer(20); 
    var plen = (((16) + 10000)+'').slice(1); // leading zero's
    packet.write(plen, 0, 'ascii');  
    var pinger = function() {
//console.log("PINGER:"+output_streams.length);
      for(var i = output_streams.length-1; i >= 0; --i) {
        var stream = output_streams[i]
        if (!stream.sendPing) { stream.sendPing = { id: null, send: null }  }
        if (stream.sendPing.send) { 
            var now = (new Date()).getTime()
            if ((now-stream.sendPing.send) >= 5000 && !stream.destroyed) {
              // CLOSE Stream
console.log("PING DESTROY");
              stream.destroyed = true
              stream.destroy();
            }
        } else {
          var id = ((((status.ping.id++)%10000)+10000)+'').slice(1)
          var sid = ((((i)%10000)+10000)+'').slice(1)
          stream.sendPing.id = mode+sid+id
          stream.sendPing.send = (new Date()).getTime()
          var pingId = "PING"+stream.sendPing.id
          packet.write(pingId, 4, 'ascii');
//console.log("SEND=>"+packet.toString())
          status.ping.pings++
          stream.write(packet);
        }
      }
      setTimeout(pinger, 1000);
    }
    pinger();
  }
}

if (mode == 'server') {
  console.log('SERVER-MODE');
  servers.forEach(function(server) { 
    console.log('LISTEN:'+server.peer.port+":"+server.peer.host);
    net.createServer(function(stream) {
      streamer(stream, null, server);
    }).listen(server.peer.port, server.peer.host);
  })
  packet_input();
  setTimeout(ping(output_streams, "SERV"), 1000);
} else if (mode == 'client') {
  console.log('CLIENT-MODE');
  var connections = []
  var client_connect = function(server, stream) {
    console.log('Connect peer='+server.peer.host+":"+ server.peer.port+" my="+server.my.host+":"+ server.my.port+":"+server['no_output'])
    stream = net.createConnection(server.peer.port, server.peer.host, { bind: server.my });   
    status.connections.client.connects++;
    streamer(stream, {
      closed: function() {
                setTimeout(function() { 
                  client_connect(server, stream); 
                }, 1000);
              }
    }, server)
  }
  servers.forEach(function(server) { 
    client_connect(server); 
  })
  //setTimeout(ping(output_streams), 1000);
  packet_input();
  setTimeout(function recvPing() {
    //console.log("recvPing:"+ output_streams.length)
    for(var i = output_streams.length - 1; i >= 0 ; --i) {
      var stream =  output_streams[i]
      if (!stream.recvPing) { stream.recvPing = { id: null, recv: (new Date()).getTime() } }
      var now = (new Date()).getTime()
      if ((now - stream.recvPing.recv) > 5000 && !stream.destroyed) {
        console.log("LINK-DOWN-DETECTED:")
        stream.destroyed = true
        stream.destroy()
      }
    }
    setTimeout(recvPing, 1000);
  }, 1000);
}

var http = require('http');
http.createServer(function (req, res) {
  res.writeHead(200, {'Content-Type': 'application/json'});
  status.connections.open = output_streams.length; 
  res.end(JSON.stringify(status))
}).listen(1706, "0.0.0.0");

setInterval(function() { 
  status.connections.open = output_streams.length; 
  sys.print("Status:"+JSON.stringify(status)+"\n"); 
}, 10000);
