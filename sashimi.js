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
var status = { in: 0, out: 0 };
var packet_input = function() {
  var packet = new Buffer(1600); 
  /* tun has a 4byte header i currently not know what this means */
  fs.read(tun_fd, packet, 4, packet.length-4, null, function(err, len) {
    if (err) { 
			console.log('packet_input err:'+err); 
			return; 
		}
    var plen = (((len) + 10000)+'').slice(1); // leading zero's
    packet.write(plen, 0, 'ascii');  
    if (output_streams.length > 0) {
      ++status.in;
      try {
        output_streams[input_cnt%output_streams.length].write(packet.slice(0, len+4));
      } catch(e) {
        output_streams[input_cnt%output_streams.length].destroy();
      }
    }
    packet_input();
  })
}

var streamer = function(stream, fn_closed, opts) {
	stream.setNoDelay(true);
  //stream.setEncoding('binary');
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
				}
  }
  var packet = { 
			active: false, 
			len: 0, 
			completed: function(data, test) {
				++status.out;
        fs.write(tun_fd, data, 0, data.length);
        header.active = true;
        packet.active = false;
        packet.len = 0;
        queue.add(null, header.len, header.completed);
    	}
  }
  stream.on('connect', function() {
		console.log('client-connect:'+stream.remoteAddress+":"+stream.remotePort+":"+key.my+":"+opts['no_output']);
    if (!(opts && opts.no_output)) { output_streams.push(stream); }
    stream.write(key.my, 'utf-8');
    connected = true;
  })
  var clear_output_streams = function() {
    connected && console.log('client-close:'+stream.remoteAddress+":"+stream.remotePort);
		var tmp = [];
		for(var i in output_streams) {
			var s = output_streams[i];
			s !== stream && tmp.push(s);
		}
		output_streams = tmp;
    connected && stream.destroy();
    connected = false;
    fn_closed && fn_closed();
    fn_closed = false;
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
      queue.add(obj, packet.len, packet.completed);
    }
  });
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
} else if (mode == 'client') {
	console.log('CLIENT-MODE');
  var client_connect = function(server, stream) {
		console.log('Connect peer='+server.peer.host+":"+ server.peer.port+" my="+server.my.host+":"+ server.my.port+":"+server['no_output'])
    stream = net.createConnection(server.peer.port, server.peer.host, { bind: server.my });   
		stream.setNoDelay(true);
    streamer(stream, function() {
      setTimeout(function() { client_connect(server, stream); }, 1000);
    }, server); // reconnect
  }
  servers.forEach(function(server) { client_connect(server); })
  packet_input();
}

setInterval(function() { sys.print("Status:"+util.inspect(status)); }, 10000);
