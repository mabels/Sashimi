var Queue = require('./queue');

var test_packet_source = function(fn, runs) {
  var data = "";
  var maxlen = 1420;
  var base = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for(var i = 0; i < maxlen; ++i) { data += base[i%base.length]; }
	runs = runs || 1;
  for(var loops = 0; loops < runs; ++loops) {
console.log('LOOP:'+loops);
    for(var outlen = 0; outlen < 1400; ++outlen) {
      var segsize = ~~(outlen/3);
      if (segsize == 0) { segsize = 1; }
      var blen = outlen + 4;
      var buffer = new Buffer(outlen + blen);    
      buffer.write(((10000+outlen)+"").slice(1), "ascii"); // leading zero's
      buffer.write(data.slice(0,outlen), "binary", 4); 
      for(var ofs = 0; ofs < blen; ofs += segsize) {
        var rest = (blen - ofs);
        if (rest > segsize) { rest = segsize; }
        fn(buffer.slice(ofs, ofs + rest), rest, data.slice(0,outlen));
      }
      delete buffer;
    }
  }
  console.log('yeah done:'+loops*(outlen*(outlen+1))/2);
}

var queue = new Queue();
var header = { 
	len: 4, 
	completed: function(data, test) {
			packet.len = ~~data;
			state = packet;
			queue.add(null, packet.len, packet.completed);
		}
};
var packet = { 
	len: 0, 
	completed: function(data,test) {
			if (data != test) {
				throw('BUFFER-FAILURE:'+data+":"+test);
		  }
			state = header;
		}
}
var state = header;
test_packet_source(function(buf, rest, cmp) {
	queue.add(buf, state.len, state.completed, cmp);
}, 100)
