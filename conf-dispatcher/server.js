var http = require('http');
var https = require('https');
var url  = require('url');
var util = require('util');
var fs   = require('fs');

var CouchClient = require('./couch-client');

var debug = process.argv[2] == 'debug';

var listen = { host: "127.0.0.1", port: 8124 };

var callStreamie = function(token, fn) {
	var streamie = http.request({
					host: 'streamie.org',
					port: 80,
					path: '/user_info',
					method: 'GET',
					headers: {
					  'Host': 'streamie.org',
				 	  'Cookie': 'token='+token         						 
				  }
		}, function(res) { 
					res.setEncoding('utf8')
          var data = [];
					res.on('data', function(doc) {
            data.push(doc.toString("utf-8"));
          })
					res.on('end', function() {
						try {
							var doc = JSON.parse(data.join(""));
							doc.statusCode = res.statusCode;
							fn(doc);
						} catch(e) {
							console.error('callStreamie:exception:'+e)
						}
					}) 
	}).end();
}

var TwitterCBQueue = {};
var updateTwitterDetails = function(doc, fn) {
  if (!(!doc.twitter.details || doc.twitter.details.error)) {
		fn(doc);
	  return;
  }
	var name = doc.twitter.screen_name;
	if(TwitterCBQueue[name]) {
		TwitterCBQueue[name].push({
			doc: doc,
			fn: fn
		});
		return;
	} else {
		TwitterCBQueue[name] = [{
			doc: doc,
			fn: fn
		}];
	}
	var token = doc.twitter.oauth;
	console.log('Fetching twitter details for ' + name)
	var streamie = http.request({
					host: 'streamie.org',
					port: 80,
					path: '/twitter/1/users/show.json?screen_name='+encodeURIComponent(name)+'&_token='+encodeURIComponent(token),
					method: 'GET',
					headers: {
						'Host': 'streamie.org',
						'Cookie': 'token='+token			 
					}
		},  function(res) { 
					res.setEncoding('utf8');
					var str;
					var data = [];
					res.on('data', function(str) {
						data.push(str.toString("utf-8"));
					})
					res.on('end', function() {
						try {
							str = data.join("");
							console.log(str);
							var details = JSON.parse(str);
							details.statusCode = res.statusCode;
							details._fetchTime = new Date;
						} catch(e) {
							console.error('updateTwitterDetails:exception:'+e+'\n'+str);
						}
						TwitterCBQueue[name].forEach(function(cb) {
							var doc = cb.doc;
							var fn  = cb.fn;
							doc.twitter.details = details;
							fn(doc);
						});
						TwitterCBQueue[name] = null;
					}) 
	}).end();
}


var getMacAddress = function(address, fn) {
  fs.readFile('/proc/net/arp', 'utf8', function(err, data) {
		if (err) { 
			console.error('can not read /proc/net/arp:'+err);
			return;
		}
		var lines = data.toString().split("\n")
		for(var i = lines.length-1; i >= 0; --i) {
			var line = lines[i].split(/\s+/)
			if (line[0] == address) {
				return fn(line[3]);
			}
		}
		fn();
  });
}

var updateStreamie = function(mac, req, ret, retryCnt) {
	retryCnt = retryCnt || 0;
  streamie.get(ret.user_id, function(err, doc) {
    if (err) { 
			console.error('updateStreamie:couchdb:get:failure:'+err); 
		}
		var client = {
									 ipv4:   req.headers['x-real-ip'] || req.socket.remoteAddress,
									 hwaddr: mac,
									 useragent: req.headers['user-agent'],
									 created_at: new Date()
								 };
    if (!doc) {
			console.log('NEW-DOC:'+ret.user_id);
      doc = {
             _id: ret.user_id, 
             twitter: ret,
             clients: [client]
            };
    } else {
      doc.twitter = ret;	
      delete doc.completed
      var found = false;
      for(var i = doc.clients.length-1; i >= 0; --i) {
				var r_ip = req.headers['x-real-ip'] || req.socket.remoteAddress;
        if (doc.clients[i].ipv4 == r_ip) {
					console.log('UPD-IPUPDATE:'+ret.user_id);
					doc.clients[i] = client;
					found = true;
          break;
        }
      }
			if (!found) { 
				console.log('UPD-ADDCLIENT:'+ret.user_id);
				doc.clients.push(client);
			}
    }
    streamie.save(doc, function(err, doc) {
			if (err) { 
				// retry raise condition
				if (retryCnt < 5) { 
					console.error('updateStreamie:couchdb:save:failure:'+err+":"+retryCnt);
					setTimeout(function() { updateStreamie(mac, req, ret, retryCnt + 1); }, 500);
				} else {
					console.error('updateStreamie:couchdb:save:failure:'+err+":MAX-RETRIED");
				}
			}
    });
  });
}

var streamie = CouchClient('http://127.0.0.1:5984/streamie');
streamie.request('PUT', '/streamie', function(err, result) {
	http.createServer(function (req, res) {
	  var dispatch = url.parse(req.url, true);
	  if (dispatch.pathname == '/authorize') {
			callStreamie(dispatch.query['token'], function(ret) {
		  	ret.oauth = dispatch.query['token']
		  	res.writeHead(ret.statusCode+'', {'Content-Type': 'application/javascript'});
				callback = dispatch.query['callback'] || 'callback';
				res.end(callback + '(' + JSON.stringify(ret) + ')')
				if (ret.error) { return; } 
		  	getMacAddress(req.headers['x-real-ip'] || req.socket.remoteAddress, function(mac) {
					if (mac) { updateStreamie(mac, req, ret); }
				}); 
			});
			return;
		}
	  res.writeHead(404, {'Content-Type': 'text/plain'});
	  res.end("Weg hier\n");
	}).listen(listen.port, listen.host);


	var iptablesQueue = [];
	var iptablesRunning = false;
  var SerializeIptables = function() {
		if (iptablesRunning) { return; } 
		iptablesRunning = true;
		var run = function(current) {
			current = iptablesQueue.shift();
			if (!current) { 
				iptablesRunning = false;
				return;
			}
			var iptables  = require('child_process').spawn('sudo', ['/sbin/iptables'].concat(current.para))
			iptables.on('exit', function(code) {
				console.log('iptables:'+current.para.join(' ')+"=>"+code);
				current.fn(code);
				run();
			});
		}
		run();
  }

	
	var iptables = function(para, fn) {
//console.log(para);
		if (debug) {
				console.log('debug-iptables:'+para.join(' '));
				fn(0);
				return;
		}
		iptablesQueue.push({para:para, fn: fn});
		SerializeIptables();
/*
		var iptables  = require('child_process').spawn('sudo', ['/sbin/iptables'].concat(para))
		iptables.on('exit', function(code) {
			~~code && console.log('iptables:'+para.join(' ')+"=>"+code);
			fn(code);
		});
*/
	};

	var writeIPTables = function(para, fn, cmds, codes, cmd) {
		cmds = cmds || ['-D', '-I'];
		codes = codes || [];
		cmd = cmds.shift();
		if (!cmd) { return true; }
		iptables([cmd].concat(para), function(code) {
			codes.push(code);
			writeIPTables(para, fn, cmds, codes) && fn(codes);
		})
		return false;
	}

  var updateIPTables = function(doc, cmds, retryCnt, client, called, i) {
		retryCnt = retryCnt || 0;
//console.log('DOC:'+util.inspect(doc));
//		if (doc._rev != rev) { return; }
		if (doc.completed && doc.completed.pid == process.pid) { return; }
		called = 0;
		for(i = doc.clients.length-1; i >= 0; --i) {
			client = doc.clients[i];
			// $IPTABLES -t mangle -I FREE_MACS -i $CONF_IF -p all -m mac 
			// --mac-source c8:bc:c8:4f:d4:66 -s 10.205.0.100 -j MARK --set-mark 0x1205
			(function(client, iptable, cmds) {
				cmds = ['-D', '-I'];
				iptable = [];
				iptable.push('FREE_MACS');
				iptable.push('-t', 'mangle');
				iptable.push('-p', 'all');
				iptable.push('-m', 'mac');
				iptable.push('--mac-source', client.hwaddr);
				iptable.push('-s', client.ipv4);
				iptable.push('-j', 'MARK');
				iptable.push('--set-mark', '0x1205');
				console.log('Saving', iptable);
				writeIPTables(iptable, function(codes) {
					console.log('writeIPTables CB', client, codes);
					client.iptabled = { date: new Date(), exitcodes: codes, rev: doc._rev };
					if (++called == doc.clients.length) {
						console.log('Called == doc.clients.length')
						doc.completed = { date: new Date(), pid: process.pid, rev: doc._rev };
						streamie.save(doc, function(err, doc) {
							if (err) {
								if (retryCnt < 5) { 
									console.error('updateIPTables:couchdb:save:failure:'+err+":"+retryCnt);
									setTimeout(function() { updateIPTables(id, rev, retryCnt + 1); }, 500);
								} else {
									console.error('updateIPTables:couchdb:save:failure:'+err+":MAX-RETRIED");
								}
							}
							console.log('Saved'); //console.dir(doc);
						})
					} else {
						console.log(called, doc.clients.length)
					}
				}, cmds);
			})(client);
		}
  }
	iptables(['-t', 'mangle', '-F', 'FREE_MACS'], function(code) {
		iptables(['-t', 'mangle', '-A', 'FREE_MACS', '-j', 'RETURN'], function(code) {
			var docrevs = {};
			streamie.changes(0, function(err, changes) {
					if (err) {
						console.error('ERROR:couchdb:changes:'+err);
						return;
					}
					if (changes.deleted) { 
return;
    				streamie.request('GET', '/streamie/'+changes.id+'?rev='+changes.changes[0].rev, function(err, doc) {
							if (err) {
								console.log('ERROR:couchdb:get:'+err);
								return;
							}
							if (doc.blocked) {
								console.log('BLOCKED:'+doc._id);
								return;	
							} 
console.log('DELETE:'+util.inspect(doc));
							updateIPTables(doc, ['-D']);
						})
					}
					for(var i in changes.changes) {
						if (docrevs[changes.id] != changes.changes[i].rev) {
console.log('CHANGES:'+i+":"+util.inspect(changes.id));
							streamie.get(changes.id, function(err, doc) {
								if (err) {
									console.log('ERROR:couchdb:get:'+changes.id+":"+err);
									return;
								}
								if (doc.blocked) {
									console.log('BLOCKED:'+doc.id);
									return;	
								} 
								docrevs[doc._id] = doc._rev;
//console.log('CHANGES:'+util.inspect(doc));
                updateTwitterDetails(doc, updateIPTables);
							})
						}
					}
			})
		})
  })
})

console.log("HALLO");
console.log('Server running at http://'+listen.host+":"+listen.port+'/');
