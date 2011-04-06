
var fs = require('fs');
var http = require('http');
var cp = require('child_process');

var Server = { host: '172.16.143.8', port: 9200, path: '/traffic', headers: { 'content-type': 'application/json' } };
var Server = { host: '172.16.143.8', port: 5984, path: '/traffic', headers: { 'content-type': 'application/json' } };

//flow-cat -t '3/14/11 9:31:00'  -T '3/14/11 9:32:00' -z9 2011 | flow-print
var formatDate = function(date) {
	return '"'+(date.getMonth()+1)+'/'+date.getDate()+'/'+date.getFullYear()+' '+date.getHours()+':'+date.getMinutes()+":"+date.getSeconds()+'"';
}

var getStartDate = function(done) {
	fs.readFile('flow2couchdb.config', function(err, data) {
		if (err) {
			done();
		} else {
			try {
				done(new Date(JSON.parse(data).startDate));
			} catch(e) {
				done();
			}
		}
	})	
}

var setStartDate = function(date, done) {
	fs.writeFile('flow2couchdb.config', JSON.stringify({ startDate: date }), done);
}

var gid = 1;
var running = 0;
var storeCouch = function(cmds, id, cmd, i, found, count) {
	found = false	
	for (i = running; i < 12; ++i) {
		running = 12;
		found = true;
//console.log('QUEUE:'+i);
		storeCouch(cmds, id, cmd);
	}
	if (found) {
		return
	}
	
	cmd = cmds.shift();
	if (!cmd) {
		return;
	}
	//srcIP            dstIP            prot  srcPort  dstPort  octets      packets
	id = ++gid;
	count = 0;
	var run = function() {
		cp.exec(cmd.cmd.join(' '), { maxBuffer: 10*1024*1024 }, function(error, stdout, stderr, req, lines, out) {
console.log('WROTE:'+cmd.end);
			if (error) {
console.log('ERROR:'+id+":"+error+":"+cmd.cmd.join(' '));
				if (count++ < 3) {
					return run();
				}
				setStartDate(cmd.end, function() {
					running--;
					storeCouch(cmds)
				})
				return;
			}
			lines = stdout.split("\n");
			delete stdout;
			delete stderr;
			lines.shift();
			out = [];
			var out = {
				     _id: ""+cmd.start.getTime(),
				     start: cmd.start,
				     end: cmd.end,
				     tuples: []
				  };
			for(var line in lines) {
				line = lines[line];
				var cols = line.split(/[ ]+/)
				out.tuples.push({
					srcIP: cols[0],
					dstIP: cols[1],
					prot: cols[2],
					srcPort: cols[3],
					dstPort: cols[4],
					octets: cols[5],
					packets: cols[6]
				      });
			}
			Server.method = 'POST';
			req = http.request(Server, function(res) {
	/*
				  res.on('data', function (chunk) {
				    console.log('BODY: ' + chunk);
				  });
	*/
	//console.log(res);
				delete lines;
				delete cols;
				delete data;
				delete req;
				setStartDate(cmd.end, function() {
					running--;
					storeCouch(cmds)
				})
			})
			req.end(JSON.stringify(out));
		})
	}
	run();
}

Server.method = 'PUT';
var req = http.request(Server, function(res) {

getStartDate(function(startDate) {
	if (!startDate) {
		startDate = new Date((~~((new Date()).getTime()/86400000)*86400000)-(2*86400000));
	} 
	endDate = new Date(~~((new Date()).getTime()/60000)*60000);
console.log(startDate+"=>"+endDate)
	var cmds = []
	for (var current = startDate.getTime(); current < endDate.getTime(); current += 60000) {
		var start = new Date(current)
		var end = new Date(current+60000)
		var cmd = ['flow-cat'];
		cmd.push('-t')				
		cmd.push(formatDate(start));
		cmd.push('-T')				
		cmd.push(formatDate(end))
		cmd.push('/tmp/2011')
		cmd.push('| flow-print')
		cmds.push({ cmd: cmd, start: start, end: end})
	}
	storeCouch(cmds);
/*
	setStartDate(endDate, function() {
				
	})
*/

})

}).end();
