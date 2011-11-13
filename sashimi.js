var sys = require('sys');
var utils = require('util');
var fs = require('fs');
var net = require('net');
var Queue = require('./queue');
var http = require('http');

http.globalAgent.maxSockets = 20

//console.log(http.globalAgent)

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
console.log('node_version:'+process.version+' mode='+mode+' tun_dev='+tun_dev+' tun_fd='+tun_fd+" servers="+JSON.stringify(servers));

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
                                timeout: 0,
                                close: 0,
                                req: 0
                              }
                            }, 
               tun: {
                      queue: {
                               max: 0,
                               timeout: 0
                      },
                      input: {
                               err: 0
                             }
                    },
               failure: { write: 0 }  };


var output_packets = []
var output_packets_max_length = 100;
var packet_input = function() {
  var packet = new Buffer(1600); 
  /* tun has a 4byte header i currently not know what this means */
  ofs = 0 // macos
  fs.read(tun_fd, packet, ofs, packet.length-ofs, null, function(err, len) {
    if (err) { 
      status.tun.input.err++;
      console.log('packet_input err:'+tun_fd+":"+err); 
      packet_input();
      return; 
    }
    if (output_packets.length > output_packets_max_length) {
      status.tun.queue.max++;
      console.log('packet_input err:queue_len '+output_packets_max_length); 
      packet_input();
      return; 
    }
//console.log("READ-TUN:", len, packet);
    output_packets.push({packet: packet, len: len, now: Date.now()});
    ++status.in;
    sender();
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
    stream.write(key.my, 'utf8');
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

var build_packet = function(packets) {
        var len = 0;
        for(var i = 0, l = packets.length; i < l; ++i) {
//console.log("I:",i,packets[i].len);
          len += packets[i].len + 4; 
        }
        var buf = new Buffer(len);
        var ofs = 0;
        for(var i = 0, l = packets.length; i < l; ++i) {
          var packet = packets[i];
          var plen = (packet.len+10000+'').slice(1); // leading zero's
//console.log("LEN:",packet.len, plen);
          buf.write(plen, 0, 'ascii') 
          ofs += 4
          packet.packet.copy(buf, ofs, 0, packet.len);
          ofs += packet.len
        }
        return buf;
}

server_reqs = []; 
server_max_reqs = 10;
var server_sender = function() {
  console.log("sender:"+server_reqs.length+":"+output_packets.length);

  while (server_reqs.length > 0 && output_packets.length > 0) {
//    try {
        var server = server_reqs.shift();
        var packets = output_packets;
        output_packets = [];
        var buf = build_packet(packets);
        server.res.writeHeader(200, {"Content-Length": buf.length,
                                     "Content-Type": "application/sashimi"
                                    })
        server.res.write(buf);
        server.res.end();
        status.connections.server.request++;
//    } catch (e) {
//      console.log('sender:ERROR:'+e);
//      Array.prototype.push(output_packets, packets);
//    }
  }
}

var cleanup = function() {
  var now = Date.now();
  var server_timeout = 30000
  for(var i = server_reqs.length-1; i >= 0; --i) {
    if (now-server_timeout > server_reqs[i].now) {
      var last_i = server_reqs.length-1;
      if (i != last_i) {
        var last = server_reqs[last_i]
        server_reqs[last_i] = server_reqs[i]
        server_reqs[i] = last
      }
      var server = server_reqs.pop();
      server.res.writeHead(408, { "X-Sashimi": "server timeout:"+server_timeout});
      server.res.end();
      status.connections.server.timeout++;
    }
  }
  var packet_timeout = 1000;
  for(var i = output_packets.length-1; i >= 0; --i) {
    if (now-packet_timeout > output_packets[i].now) {
      var last_i = output_packets.length-1;
      if (i != last_i) {
        var last = output_packets[last_i]
        output_packets[last_i] = output_packets[i]
        output_packets[i] = last
      }
      output_packets.pop();
      status.tun.queue.timeout++;
    }
  }
}

var Processor = function() {
  this.queue = new Queue();
  this.processor = this.bind(this, this.headerWait)
  this.processLen = 4
}
Processor.prototype.bind = function(my, fn) { 
  return function(data) { fn.apply(my, [data]) } 
}
Processor.prototype.add = function(data) { 
  this.queue.add(data, this.processLen, this.processor)
}
Processor.prototype.dataWait = function(data) {
//console.log("WRITE-TUN:", data.length, data);
          fs.write(tun_fd, data, 0, data.length);
          this.processor = this.bind(this, this.headerWait)
          this.processLen = 4
          var my = this;
          this.add(null)
      }
Processor.prototype.headerWait = function(len) {
          this.processLen = ~~len.toString('ascii', 0, 4)
          this.processor = this.bind(this, this.dataWait)
          var my = this;
          this.add(null)
      }

if (mode == 'server') {
  console.log('SERVER-MODE');
  var sender = server_sender;
  servers.forEach(function(server) { 
    console.log('LISTEN:'+server.peer.port+":"+server.peer.host);
    http.createServer(function(req, res) {
      var processor = new Processor();
      req.on('data', function(data) {
        processor.add(data);
      })
      req.on('end', function() {
console.log("REQUEST-END");
        if (server_reqs.length > server_max_reqs) {
          console.log("drop server request:"+server_max_reqs);
          res.writeHead(503, "X-Sashimi: server busy:"+server_max_reqs);
          res.end();
          return;
        }
        server_reqs.push({req:req, res: res, now: Date.now()});
        sender();
      })
    }).listen(server.peer.port, server.peer.host);
  })
  packet_input();
  setTimeout(ping(output_streams, "SERV"), 1000);
  setInterval(cleanup, 5000);
} else if (mode == 'client') {
  console.log('CLIENT-MODE');
  var connections = []
  var open_connection = 3;
  var current_server = 0;
  var queue = new Queue();

  var sender = function() {
//    console.log("client-sender", connections.length, output_packets.length);
    current_server = (current_server++) % servers.length

    var packets = output_packets;
    if (connections.length >= 3 && output_packets.length == 0) {
      return;
    }
    output_packets = []
    var buf = build_packet(packets)

    var options = {
      host: servers[current_server].peer.host,
      port: servers[current_server].peer.port,
      path: '/'+status.connections.client.connects++,
      method: 'POST',
      headers:  {
                  "Content-Length": buf.length,
                  "Content-Type": "application/sashimi"
                }
    }
                      
    var transaction = function(id, buf) {
      var cleanup = function() {
        for(var i = connections.length-1; i>=0; --i) {
          if (connections[i].id == id) {
            var lastId = connections.length-1
            var last = connections[lastId]
            connections[lastId] = connections[i]
            connections[i] = last
            connections.pop()
//console.log("REMOVE", id, connections.length, lastId)
            break;
          }
        }
        sender();
      }
      var req = http.request(options, function(res) {
//        console.log('STATUS: ' + res.statusCode);
//        console.log('HEADERS: ' + JSON.stringify(res.headers));
        var processor = new Processor()
        res.on('data', function(data) {
//console.log("RESP:", processLen);
          processor.add(data);
        })
        res.on('error', cleanup);
        res.on('end', cleanup);
      })
      req.on('error', function(e) { 
        console.log("client_sender:", e); 
        cleanup();
        setTimeout(sender, 500);
      })
//console.log("WRITE-NET:", buf.length)
      req.write(buf);
      req.end();
    }
    if ((connections.length < 3 && output_packets.length == 0) || buf.length > 0) { 
      connections.push({id: status.connections.client.connects,
                        transaction: transaction(status.connections.client.connects, buf) })
      sender();
    }
  }
  sender();
  packet_input();
}

/*
  http.createServer(function (req, res) {
    res.writeHead(200, {'Content-Type': 'application/json'});
    status.connections.open = output_streams.length; 
    res.end(JSON.stringify(status))
  }).listen(1708, "0.0.0.0");
  */

setInterval(function() { 
  status.connections.open = output_streams.length; 
  sys.print("Status:"+JSON.stringify(status)+"\n"); 
}, 10000);
