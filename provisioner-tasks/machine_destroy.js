var Task = require('task_agent/lib/task');
var execFile = require('child_process').execFile;
var common = require('../common');
var async = require('async');

var MachineDestroyTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(MachineDestroyTask);

function start() {
    var self = this;
    var uuid = self.req.params.uuid;
    var zone_json;

    zone_json = path.join('/mockcn', process.env['MOCKCN_SERVER_UUID'], 'vms',
        req.params.uuid + '.json');

    common.ensureProvisionComplete(self.req.uuid, function () {
        /*JSSTYLED*/
        fs.unlink(zone_json, function (error) {
            if (error) {
                var msg = error instanceof Error ? error.message : error;
                self.fatal('VM.delete error: ' + msg);
                return;
            }
            self.progress(100);
            self.finish();
        });
    });
}

MachineDestroyTask.setStart(start);
