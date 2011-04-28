var http = require('http');
var url = require('url');
var util = require('util');
var fs = require('fs');

var CouchClient = require('./couch-client');

var callStreamie = function(token, fn) {
	var streamie = http.request({
					host: 'streamie.org',
					//host: '172.29.29.222',
					//port: 8080,
					port: 80,
					path: '/user_info',
					method: 'GET',
					headers: {
					  'Host': 'streamie.org',
				 	  'Cookie': 'token='+token         						 
				  }
		}, function(res) { 
					res.setEncoding('utf8')
					res.on('data', function(doc) {
						try {
							doc = JSON.parse(doc);
							doc.statusCode = res.statusCode;
							fn(doc);
						} catch(e) {
							console.error('callStreamie:exception:'+e)
						}
					}) 
	}).end()
}

var getMacAddress = function(address, fn) {
  fs.readFile('/proc/net/arp', 'utf8', function(err, data) {
		if (err) { 
			console.error('can not read /proc/net/arp:'+err) 
			return
		}
		var lines = data.toString().split("\n")
		for(var i = lines.length-1; i >= 0; --i) {
			var line = lines[i].split(/\s+/)
			if (line[0] == address) {
				return fn(line[3])
			}
		}
		fn()
  })
}

var updateStreamie = function(mac, req, ret) {
  streamie.get(ret.user_id, function(err, doc) {
    if (err) { console.error('couchdb:get:failure:'+err) }
//console.log('mac:'+mac+":"+JSON.stringify(ret)+":"+JSON.stringify(doc))
//console.log(req)
		var client = {
									 ipv4: req.headers['x-real-ip'] || req.socket.remoteAddress,
									 hwaddr: mac,
									 useragent: req.headers['user-agent'],
									 created_at: new Date()
								 };
    if (!doc) {
console.log('NEW-DOC');
      doc = {
             _id: ret.user_id, 
             twitter: ret,
             clients: [client]
            }
    } else {
console.log('UPDATE-DOC');
      doc.twitter = ret	
      delete doc.completed
      var found = false;
      for(var i = doc.clients.length-1; i >= 0; --i) {
				var r_ip = req.headers['x-real-ip'] || req.socket.remoteAddress;
        if (doc.clients[i].ipv4 == r_ip) {
console.log('UPDATE-IPUPDATE');
					doc.clients[i] = client;
					found = true;
          break;
        }
      }
			if (!found) { 
console.log('UPDATE-ADDCLIENT');
				doc.clients.push(client);
			}
    }
//console.log(JSON.stringify(doc))
    streamie.save(doc, function(err, doc) {
        if (err) { 
          console.error('couchdb:save:failure:'+err) 
          updateStreamie(req, ret)
        }
    })
  })
}


var streamie = CouchClient('http://localhost:5984/streamie')
streamie.request('PUT', '/streamie', function(err, result) {
	http.createServer(function (req, res) {
	  var dispatch = url.parse(req.url, true)
	  if (dispatch.pathname == '/authorize') {
		callStreamie(dispatch.query['token'], function(ret) {
	//	  res.setEncoding('utf-8')
		  ret.oauth = dispatch.query['token']
		  res.writeHead(ret.statusCode+'', {'Content-Type': 'application/javascript'});
		  callback = dispatch.query['callback'] || 'callback';
		  res.end(callback + '(' + JSON.stringify(ret) + ')')
		  if (ret.error) {
			return;
		  } 
		  getMacAddress(req.headers['x-real-ip'] || req.socket.remoteAddress, function(mac) {
		    if (mac) { updateStreamie(mac, req, ret) }
		  }) 
		})
		return;
	  }
	  res.writeHead(404, {'Content-Type': 'text/plain'});
	  res.end('Weg hier \n');
	}).listen(8124, "127.0.0.1");

	var iptables = function(para, fn) {
		var iptables  = require('child_process').spawn('sudo', ['/sbin/iptables'].concat(para))
		iptables.on('exit', function(code) {
			console.log('iptables:'+para.join(' ')+"=>"+code);
			fn(code);
		});
	}
	
  var updateIPTables = function(id, rev) {
    streamie.get(id, function(err, doc) {
      if (err) { console.error('couchdb:get:failure:'+err) }
      if (doc._rev != rev) { return }
      if (doc.completed && doc.completed.pid == process.pid) { return }
      for(var i = doc.clients.length-1; i >= 0; --i) {
        var client = doc.clients[i]

				// $IPTABLES -t mangle -I FREE_MACS -i $CONF_IF -p all -m mac 
				// --mac-source c8:bc:c8:4f:d4:66 -s 10.205.0.100 -j MARK --set-mark 0x1205
				var iptable = [];
				iptable.push('-t');
				iptable.push('mangle');
				iptable.push('-I');
				iptable.push('FREE_MACS');
				iptable.push('-p');
				iptable.push('all');
				iptable.push('-m');
				iptable.push('mac');
				iptable.push('--mac-source');
				iptable.push(client.hwaddr);
				iptable.push('-s');
				iptable.push(client.ipv4);
				iptable.push('-j');
				iptable.push('MARK');
				iptable.push('--set-mark');
				iptable.push('0x1205');
				iptables(iptable, function(code) {
					client.iptabled = { date: new Date(), exitcode: code, rev: doc._rev }
				});
      }
      doc.completed = { date: new Date(), pid: process.pid, rev: doc._rev };
      streamie.save(doc, function(err, doc) {
        if (err) {
          console.log('updateIPTables failed:'+err)
          updateIPTables(id, rev)
        } 
      })
    })
  }
	iptables(['-t', 'mangle', '-F', 'FREE_MACS'], function(code) {
		iptables(['-t', 'mangle', '-A', 'FREE_MACS', '-j', 'RETURN'], function(code) {
			streamie.changes(0, function(err, changes) {
					if (err) {
						console.error('couchdb:changes:failure:'+err)
						return
					}
					if (changes.deleted) { 
console.log('DELETE:'+util.inspect(changes));
						return 
					}
					for(var i in changes.changes) {
						updateIPTables(changes.id, changes.changes[i].rev )
					}
			})
		})
	})
})

console.log('Server running at http://127.0.0.1:8124/');
