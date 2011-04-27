var http = require('http');
var url = require('url');
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
    if (!doc) {
      doc = {
             _id: ret.user_id, 
             twitter: ret,
             clients: [{
                        ipv4: req.headers['x-real-ip'] || req.socket.remoteAddress,
                        hwaddr: mac,
                        useragent: req.headers['user-agent'],
                        created_at: new Date()
                       }]
            }
    } else {
      doc.twitter = ret	
      delete doc.completed
      for(var i = doc.clients.length-1; i >= 0; --i) {
        var clients = doc.clients[i]
        if (clients.ipv4 == req.headers['x-real-ip'] || req.socket.remoteAddress) {
          clients.hwaddr = mac
          clients.useragent = req.headers['user-agent']
          clients.created_at = new Date()
          delete clients.iptabled
          break;
        }
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

  var updateIPTables = function(id) {
    streamie.get(id, function(err, doc) {
      if (err) { console.error('couchdb:get:failure:'+err) }
      if (doc.completed) { return }
      for(var i = doc.clients.length-1; i >= 0; --i) {
        var client = doc.clients[i]
        if (!client.iptabled) { 
          console.log('iptables -D INPUT -i eth0 -m mac --mac-source '+client.hwaddr+' -s '+client.ipv4+' -j ACCEPT')
          console.log('iptables -A INPUT -i eth0 -m mac --mac-source '+client.hwaddr+' -s '+client.ipv4+' -j ACCEPT')
          client.iptabled = new Date()
        }
      }
      doc.completed = new Date()
      streamie.save(doc, function(err, doc) {
        if (err) {
          console.log('updateIPTables failed:'+err)
          updateIPTables(id)
        } 
      })
    })
  }

//  var _streamie = CouchClient('http://localhost:5984/streamie')
  fs.readFile('streamie.json', 'utf8', function(err, data) {
    since = data || '0'
    if (err) { since = '0' } 
    console.log('CHANGES:'+since)
    streamie.changes(since, function(err, changes) {
      if (err) {
        console.error('couchdb:changes:failure:'+err)
        return
      }
      fs.writeFile('streamie.json', changes.seq+'', 'utf8', function(err) {
        if (err) {
          console.error('couchdb:write:failure:'+err)
          return
        }
        if (changes.deleted) { return }
            updateIPTables(changes.id)
      })
    })
  })
})

console.log('Server running at http://127.0.0.1:8124/');
