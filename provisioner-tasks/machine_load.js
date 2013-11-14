var Task = require('task_agent/lib/task');
var VM  = require('/usr/vm/node_modules/VM');
var execFile = require('child_process').execFile;
var fs = require('fs');
var common = require('../common');

var MachineLoadTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(MachineLoadTask);

function start(callback) {
    var dir;
    var filename;
    var self = this;
    var uuid = self.req.params.uuid;

    dir = '/mockcn/' + process.env['MOCKCN_SERVER_UUID'] + '/vms';
    filename = dir + '/' + uuid + '.json';

    fs.stat(filename, function (err, stats) {
        var vmobj;

        fs.readFile(filename, 'utf8', function(e, data) {
            if (e) {
                throw e;
            }
            vmobj = JSON.parse(data);
            vmobj.last_modified = stats.mtime.toISOString();
            self.progress(100);
            self.finish(vmobj);
        });
    });
}

MachineLoadTask.setStart(start);
