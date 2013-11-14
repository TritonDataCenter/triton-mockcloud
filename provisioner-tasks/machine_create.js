var Task = require('task_agent/lib/task');
var async = require('async');
var common = require('../common');
var fs = require('fs');
var path = require('path');
var spawn = require('child_process').spawn;
var spawn = require('child_process').spawn;
var util = require('util');
var zfs = require('zfs').zfs;

var MachineCreateTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
    this.zpool = req.params.zfs_storage_pool_name || 'zones';
};

Task.createTask(MachineCreateTask);

function start(callback) {
    var self = this;

    var creationGuardFilename;

    self.pre_check(function (error) {
        if (error) {
            self.fatal(error.message);
            return;
        }

        async.waterfall([
            function (cb) {
                common.provisionInProgressFile(
                    self.req.params.uuid,
                    function (err, filename) {
                        creationGuardFilename = filename;
                        cb();
                        return;
                    });
            },
            self.ensure_dataset_present.bind(self),
            function (found, cb) {
                // The previous step (ensure..) returns a boolean indicating
                // whether the dataset was found. If that flag is set, we'll
                // run this (fetch) step and skip it if not.
                if (!found) {
                    return self.fetch_dataset(cb);
                } else {
                    return cb();
                }
            },
            self.create_machine.bind(self)
        ],
        function (err) {
            fs.unlink(creationGuardFilename, function () {
                if (err) {
                    self.fatal(err.message);
                    return;
                }
                self.finish();
            });
        });
    });
}

function pre_check(callback) {
    var dataset;
    var self = this;
    var zoneDataset = path.join(self.zpool, self.req.params.uuid);

    dataset = self.req.params.image_uuid;

    var zoneSnapshot
    = path.join(self.zpool, dataset) + '@' + self.req.params.uuid;

    async.waterfall([
        function (cb) {
            // fail if zone with uuid exists
            common.zoneList(self.req.params.uuid, function (error, zones) {
                if (zones[self.req.params.uuid]) {
                    cb(new Error(
                        'Machine ' + self.req.params.uuid + ' exists.'));
                    return;
                }
                cb();
            });
        },
        function (cb) {
            // XXX good news! Your dataset doesn't already exist!
            cb();
        },
        function (cb) {
            // XXX good news! Your snapshot doesn't already exist!
            cb();
        }
    ],
    function (error) {
        if (error) {
            callback(error);
            return;
        }
        callback();
    });
}

function ensure_dataset_present(callback) {
    var self = this;

    var fullDataset;
    var params = self.req.params;

    // TODO Enable provisioner to be able to check a list of image_uuids and
    // fetch any that are not installed
    self.toImport = null;

    if (params.image_uuid) {
        self.toImport = params.image_uuid;
    } else if (self.req.params.disks && self.req.params.disks.length) {
        self.toImport = self.req.params.disks[0].image_uuid;
    }

    fullDataset = this.zpool + '/' + self.toImport;

    self.log.info(
        'Checking whether zone template dataset '
        + fullDataset + ' exists on the system.');

    // XXX Surprise! It exists!
    callback(null, true);
}

function fetch_dataset(callback) {
    var self = this;

    var options = {
        uuid: self.toImport,
        zpool: self.zpool,
        log: self.log
    };

    // XXX Wow! That was fast!
    callback();
}

function normalizeError(error) {
    if (error instanceof String || typeof (error === 'string')) {
        return new Error(error);
    }
    return error;
}

function create_machine(callback) {
    var self = this;
    var req = self.req;
    var vmobj;
    var zone_json;

    zone_json = path.join('/mockcn', process.env['MOCKCN_SERVER_UUID'], 'vms',
        req.params.uuid + '.json');

    vmobj = req.params;
    vmobj.cpu_cap = vmobj.cpu_cap || 800;
    vmobj.max_physical_memory = vmobj.max_physical_memory || 256;
    vmobj.do_not_inventory = vmobj.do_not_inventory || false;
    vmobj.owner_uuid = vmobj.owner_uuid || '00000000-0000-0000-0000-000000000000';
    vmobj.quota = vmobj.quota || 10;
    vmobj.state = 'running';
    vmobj.zonename = vmobj.zonename || vmobj.uuid;
    vmobj.zonepath = vmobj.zonepath || '/zones/' + vmobj.uuid;
    vmobj.zone_state = 'running';

    fs.writeFile(zone_json, JSON.stringify(vmobj, null, 2), callback);
}

MachineCreateTask.setStart(start);

MachineCreateTask.createSteps({
    pre_check: {
        fn: pre_check,
        progress: 20,
        description: 'Pre-flight sanity check'
    },
    ensure_dataset_present: {
        fn: ensure_dataset_present,
        progress: 30,
        description: 'Checking for zone template dataset'
    },
    fetch_dataset: {
        fn: fetch_dataset,
        progress: 50,
        description: 'Fetching zone template dataset'
    },
    create_machine: {
        fn: create_machine,
        progress: 100,
        description: 'Creating machine'
    }
});
