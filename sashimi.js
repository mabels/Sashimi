var sys = require('sys')
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


var packet_test_source = function(fn) {
  var data=""
  var maxlen = 1420;
  var base = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
  for(var i = 0; i < maxlen; ++i) { data += base[i%base.length] }
  for(var loops = 0; loops < 10000; ++loops) {
console.log('LOOP:'+loops)
    for(var outlen = 0; outlen < 1400; ++outlen) {
  //  { var outlen = 1
  //console.log('outlen:'+outlen)    
      var segsize = ~~(outlen/3)
      if (segsize == 0) { segsize = 1 }
      var blen = outlen + 4
      var buffer = new Buffer(outlen + blen);    
      buffer.write(((10000+outlen)+"").slice(1), "ascii") 
      buffer.write(data.slice(0,outlen), "binary", 4) 
     
      for(var ofs = 0; ofs < blen; ofs += segsize) {
        var rest = (blen - ofs)
        if (rest > segsize) { rest = segsize }
  //console.log("ofs="+ofs+":"+rest)
        fn(buffer.slice(ofs, ofs + rest), rest, data.slice(0,outlen))
      }
      delete buffer
    }
  }
  console.log('yeah done:'+loops*(outlen*(outlen+1))/2)
}

var Queue = function () {
  this.queue = []
}
Queue.prototype.add = function(obj, wait_len, found_fn) {
  // obj should by { data: data, ofs: 0, len: len }
//console.log('ADD:'+JSON.stringify(obj))
  if (obj) { 
    if (obj.len == 0) { return }
    this.queue.push(obj) 
  }
  if (wait_len == 0) {
    found_fn(new Buffer(0), "")
    return
  }
  var segs = 0
  var need = wait_len
  for (var i in this.queue) {
    var qe = this.queue[i] 
    var diff = qe.len - qe.ofs
    ++segs
    if (diff >= need) { 
      var buffer = new Buffer(wait_len)
      var buffer_ofs = 0
      for (var i = 0; i < segs-1; ++i) {
        /* all but last */
        qe = this.queue.shift()
        buffer.write(qe.data.slice(qe.ofs, qe.len), "binary", buffer_ofs)
        buffer_ofs += qe.len - qe.ofs
        delete qe
      }
      qe = this.queue[0]
      buffer.write(qe.data.slice(qe.ofs, qe.ofs+need), "binary", buffer_ofs)
      if (qe.ofs+need == qe.len) { delete this.queue.shift() }
      else { this.queue[0].ofs += need }
      found_fn(buffer, qe['test'] && qe.test)
      break
    } 
    need -= diff
  }
}

/*
var queue = new Queue()

*/

console.log(JSON.stringify(process.argv))

arg = 2
var tun_dev = split_host_port(process.argv[arg]).host // no nice but working
var tun_fd =  split_host_port(process.argv[arg++]).port

var mode = process.argv[arg++]
var name = process.argv[arg++]

var key = {
             my:   process.argv[arg++],
             peer: process.argv[arg++]
          }

var servers = []
for(var i = arg; i < process.argv.length; ++i) {
  var arg = process.argv[i]
  var no_output = arg.slice(0,1) 
  if (no_output == '!') { arg = arg.slice(1)  }
  var srv = split_srv(arg)
  if (no_output == '!') { srv.no_output = true }
  else { srv.no_output = false }
  servers.push(srv)
}
console.log('tun_dev='+tun_dev+' tun_fd='+tun_fd+" servers="+JSON.stringify(servers))

var output_streams = []
var input_cnt = 0
var packet_input = function() {
  var packet = new Buffer(1600) 
  /* tun has a 4byte header i currently not know what this means */
  fs.read(tun_fd, packet, 4, packet.length-4, null, function(err, len) {
    if (err) { console.log('err:'+err); return }
    var plen = (((len) + 10000)+'').slice(1)
//console.log('plen='+plen) 
    packet.write(plen, 0, 'ascii')  
    if (output_streams.length > 0) {
      ++input_cnt
//console.log('send-plen='+len) 
      try {
        output_streams[input_cnt%output_streams.length].write(packet.slice(0,len+4))
      } catch(e) {
        output_streams[input_cnt%output_streams.length].destroy()
      }
    }
    packet_input()
  })
}

var output_cnt = 0
var streamer = function(stream, fn_closed, opts) {
  stream.setEncoding('binary')
  var connected = false
  var wait_key_peer = true
  //var buffer = new Buffer(16*1024*1024)
  var queue = new Queue()
  var header = { active: true, len: 4, completed: function(data, test) {
  //console.log('found-hdlc:'+data)
        header.active = false
        packet.active = true
        packet.len = ~~data
        queue.add(null, packet.len, packet.completed)
      }
  }
  var packet = { active: false, len: 0, completed: function(data, test) {
  //console.log('found-packet:'+data.length+":"+data+":"+test.length)
        ++output_cnt
        //if (test && test.length && test != data) { console.log('DATA-ERROR: cnt='+cnt+':data='+data+":test="+test) }
console.log('OUTPUT-2')
        fs.write(tun_fd, data, 0, data.length) //, null) 
        header.active = true
        packet.active = false
        packet.len = 0
        queue.add(null, header.len, header.completed)
    }
  }
  stream.on('connect', function() {
console.log('client-connect:'+stream.remoteAddress+":"+stream.remotePort+":"+key.my+":"+opts['no_output'])
    if (!(opts['no_output'] && opts.no_output)) { output_streams.push(stream) }
    stream.write(key.my, 'utf-8')
    connected = true
  })
  var clear_output_streams = function() {
    connected && console.log('client-close:'+stream.remoteAddress+":"+stream.remotePort)
    output_streams = _(output_streams).reject(function(s) { return s == stream })
    connected && stream.destroy()
    connected = false
    fn_closed && fn_closed()   
    fn_closed = false
  }
  stream.on('close', clear_output_streams)
  stream.on('end', clear_output_streams)
  stream.on('error', clear_output_streams)

  stream.on('data', function(data) {
//console.log('INPUT:'+JSON.stringify({})+":"+key.peer+":"+key.peer.length+":"+data.len+":"+typeof(data))    
    var obj = { data: data, ofs: 0, len: data.length }
    if (wait_key_peer) {
      queue.add(obj, key.peer.length, function(in_key) {
        if (in_key == key.peer) {
          console.log('verified key='+in_key)
          stream.setEncoding('binary')
          wait_key_peer = false
        } else {
          console.log('not verified key='+in_key)
          stream.destroy()
        }
      })
      return
    } 
    if (header.active) {
      queue.add(obj, header.len, header.completed)
    } else if (packet.active) { 
      queue.add(obj, packet.len, packet.completed)
    }
  })
}
if (mode == 'server') {
  _(servers).each(function(server) { 
    net.createServer(streamer).listen(server.peer.port, server.peer.host) 
  })
} else {
  var client_connect = function(server, stream) {
console.log('Connect peer='+server.peer.host+":"+ server.peer.port+" my="+server.my.host+":"+ server.my.port+":"+server['no_output'])
    stream = net.createConnection(server.peer.port, server.peer.host, {bind: server.my })   
    streamer(stream, function() {
      setTimeout(function() { client_connect(server, stream) }, 500)
    }, server)
  }
  _(servers).each(function(server) { client_connect(server) })
}


packet_input()

setInterval(function() { 
  sys.print("Status: i="+input_cnt+" o="+output_cnt+"\r")
}, 10000)
