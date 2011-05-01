
var fs = require('fs');
var util = require('util');
var http = require('http');
var cp = require('child_process');
var CouchClient = require('./couch-client');
require('datejs');

var Server = { host: '127.0.0.1', port: 5984, path: '/traffic', headers: { 'content-type': 'application/json' } };

var gid = 1;
var running = 0;
var storeCouch = function(cmds, complete, id, cmd, i, found, count) {
	console.log('ENTER-storeCouch'+util.inspect(cmds));
	found = false;
	for (i = running; i < 12; ++i) {
		running = 12;
		found = true;
		storeCouch(cmds, complete, id, cmd);
	}
	if (found) { return }

	cmd = cmds.shift();
	if (!cmd) { return; }

	console.log('START-storeCouch'+util.inspect(cmd));
	id = ++gid;
	count = 0;
	var run = function() {
		cp.exec(cmd.cmd.join(' '), { maxBuffer: 10*1024*1024 }, function(error, stdout, stderr, req, lines, out) {
			if (error) {
				console.log('ERROR:'+id+":"+error+":"+cmd.cmd.join(' '));
				if (count++ < 3) { return run(); }
				running--;
				storeCouch(cmds, complete);
				return;
			}
			lines = stdout.split("\n");
			delete stdout;
			delete stderr;
			lines.shift();
			out = [];
			var out = {
									 _id: cmd.key,
									 tuples: [],
									 created_at: Date()
								};
			for(var line in lines) {
				line = lines[line];
				var cols = line.split(/[ ]+/);
				//srcIP            dstIP            prot  srcPort  dstPort  octets      packets
				if (cols.length >= 7) { 
					out.tuples.push({
						srcIP: ip2twitter[cols[0]] || cols[0],
						dstIP: ip2twitter[cols[1]] || cols[1],
						prot: cols[2],
						srcPort: cols[3],
						dstPort: cols[4],
						octets: cols[5],
						packets: cols[6]
					});
				}
			}
			var completed = function() {
				delete lines;
				delete cols;
				delete data;
				delete req;
				running--;
				storeCouch(cmds, complete)
				if (!cmds.length) { console.log('storeCouch-COMPLETE'); complete(); }
			}
			if (!out.tuples.length) { 
				completed();
			} else {
				traffic.save(out, function(err, doc) {
					if (err) {
						
					}
					completed();
				})
			}
		})
	}
	run();
}

var ip2twitter = {};
var lastStreamieChange = null;
var streamie = new CouchClient('http://localhost:5984/streamie');
streamie.changes(0, function(err, changes) {
	if (err) {
		console.error('couchdb:changes:failure:'+err);
		return;
	}
	if (changes.deleted) { return; }
	streamie.get(changes.id, function(err, doc) {
		if (err) {
			console.error('couchdb:changes:failure:'+err);
			return;
		}
		for (var i in doc.clients) { 
			var client = doc.clients[i];
			console.log('ADD IP2Twitter:'+client.ipv4+"=>"+doc.twitter.screen_name);
			ip2twitter[client.ipv4] = doc.twitter.screen_name;
		} 
		lastStreamieChange = new Date();
	})
})

crawler = function(base, completed, data) {
	data = data || { dirs: [], files: [], calls: 0 };
	data.calls++;
	console.log('IN-CRAWLER:'+base+":"+data.calls);
	fs.readdir(base, function(err, in_files, dirs, cnt, i) {
		if (err)  {
			console.log('fs.readdir:err:'+err);
			setTimeout(function() {
			  crawler(data, completed, data);
			}, 1000)
		  return;
		}
		dirs = [];
		cnt = 0;
		for(i in in_files) {
			(function(fname, dir) {
				fs.stat(base+'/'+fname, function(err, stat) {
					if (err)  {
						console.log('fs.readdir:err:'+err);
						return;
					}
					if (stat.isFile()) { data.files.push(base+'/'+fname); } 
					else if (stat.isDirectory()) { dirs.push(base+'/'+fname); }
					if (++cnt == in_files.length) {
						data.dirs.push.apply(data.dirs, dirs);
						for(dir in dirs) {
							crawler(dirs[dir], completed, data);
						}
						data.calls--;
						console.log('OUT-CRAWLER-A:'+base+":"+data.calls);
						if (!data.calls) {
							completed(data);
						}
					}
				})
			})(in_files[i]);
		}
		if (!in_files.length) {
			data.calls--;
			console.log('OUT-CRAWLER-B:'+base+":"+data.calls);
			if (!data.calls) {
				completed(data);
			}
		}
  })	
}

var traffic = new CouchClient('http://localhost:5984/traffic');
var observedDirs = {};
setTimeout(function CheckChanges() { 
	var now = new Date();
	if (lastStreamieChange && (now.getTime()-lastStreamieChange.getTime()) > 1000) {
		console.log('START-CRAWLER'+util.inspect(ip2twitter));
		traffic.request('PUT', '/traffic', function(err, result) {
		console.log('AAAA');
			if (err) {
				console.error('couchdb:traffic:failure:'+err)
				return
			}
			var running = false;
			var crawlerQueue = [];
			crawler('/flows', function AddFlows(data) {
				for(var i in data.dirs) {
					(function CheckDir(dir) { 
						if (observedDirs[dir]) { return; };	
						observedDirs[dir] = true;
console.log('OBSERVER:'+dir);

						fs.watchFile(dir, function() {
console.log('dir='+dir);
							if (running) { 
								crawlerQueue.push(dir);
								return;
							} 
							running = true;
							crawler(dir, AddFlows);
						})

					})(data.dirs[i]);
				}
				//var re = new RegExp("^.*\/ft-v05.\(\d+\-\d+\-\d+.\d+\)\+0200");
				var re = new RegExp("^.*\/ft-v05\.\(\\d+-\\d+-\\d+\.\\d+\)\\+\\d+$");
				var cmds = [];
				for(var i in data.files) {
					var file = data.files[i];
					var res = re.exec(file);
					if (res) {
console.log('ADD-Flow:'+file);
						cmds.push({key: res[1], cmd: ['flow-print', '<', file, '&&', 'mv', file, file+'-done']})
						//cmds.push({key: res[1], cmd: ['flow-print', '<', file]});
					}
				}
				if (!cmds.length) {
					running = false;
					var dir = crawlerQueue.shift();
					if (dir) { crawler(dir, AddFlows); }
				}
				storeCouch(cmds, function() {
					running = false;
					var dir = crawlerQueue.shift();
					if (dir) { crawler(dir, AddFlows); }
				});
			});
		})
	} else {
		setTimeout(CheckChanges, 1000);
	}
}, 1000);

