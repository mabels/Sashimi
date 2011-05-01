var Queue = function () { 
	this.emptyBuffer = new Buffer(0);
	this.queue = []; 
}
Queue.prototype.add = function(obj, wait_len, found_fn, test) {
  if (wait_len == 0) {
    found_fn(this.emptyBuffer, "");
    return;
  }
  if (obj) {
    if (obj.length == 0) { return; }
    this.queue.push({ data: obj, ofs: 0, test: test});
  }
  var segs = 0;
  var need = wait_len;
  for (var i = 0, ql = this.queue.length; i < ql; ++i) {
    var qe = this.queue[i];
    var diff = qe.data.length - qe.ofs;
    ++segs;
		// console.log('PROC qlen='+qe.data.length+" qofs="+qe.ofs+" diff="+diff+" need="+need+":"+util.inspect(qe))
    if (diff >= need) {
      var buffer = new Buffer(wait_len);
      var buffer_ofs = 0;
      for (var i = 0; i < segs-1; ++i) {
        /* all but last */
        qe = this.queue.shift();
        qe.data.copy(buffer, buffer_ofs, qe.ofs);
        buffer_ofs += qe.data.length - qe.ofs;
				//console.log('TOTAL');
        delete qe;
      }
      qe = this.queue[0];
      qe.data.copy(buffer, buffer_ofs, qe.ofs, qe.ofs+need);
			//console.log('PARTIAL', qe.data.length, qe.ofs, need, util.inspect(buffer), util.inspect(qe));
      if (qe.ofs+need == qe.data.length) {
				//console.log('DELETE')
        delete this.queue.shift(); 
      }
      else { this.queue[0].ofs += need; }
      found_fn(buffer, qe['test'] && qe.test);
      break;
    }
    need -= diff;
  }
}
module.exports = Queue;
