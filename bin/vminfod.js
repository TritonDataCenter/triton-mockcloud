/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * A dummy version of something like vminfod that's used for mockcloud in order
 * to ensure different node-vmadm clients have a consistent view of events.
 *
 * It loads all VMs at startup, then watches for changes:
 *
 *  - new servers
 *  - removed servers
 *  - new vms
 *  - removed vms
 *  - modified vms (assuming all modification is done through atomic replace)
 *
 * And then maintains the state for all of the mock VMs, emitting events
 * whenever something has changed.
 *
 */

var child_process = require('child_process');
var fs = require('fs');
var net = require('net');
var path = require('path');
var stream = require('stream');
var util = require('util');

var assert = require('assert-plus');
var bunyan = require('bunyan');
var bunyanSerializers = require('sdc-bunyan-serializers');
var vasync = require('vasync');

var DummyVmadm = require('vmadm/lib/index.dummy');

// This will blow up if something goes wrong. That's what we want.
var MOCKCLOUD_ROOT = process.env.MOCKCLOUD_ROOT ||
    child_process.execSync('/usr/sbin/mdata-get mockcloudRoot',
    {encoding: 'utf8'}).trim();
var SERVER_ROOT = MOCKCLOUD_ROOT + '/servers';


function loadVmMap(vmadm, callback) {
    vmadm._loadVms({}, function _onLoadVms(err, loadedVms) {
        var idx;
        var vms = {};

        if (!err) {
            for (idx = 0; idx < loadedVms.length; idx++) {
                vms[loadedVms[idx].uuid] = loadedVms[idx];
            }
        }

        callback(err, vms);
    });
}

function DummyVminfod(opts) {
    assert.object(opts);
    assert.object(opts.log, 'opts.log');
    assert.string(opts.serverRoot, 'opts.serverRoot');

    var self = this;

    self.log = opts.log;
    self.running = false;
    self.serverRoot = opts.serverRoot;
    self.servers = {};
}

DummyVminfod.prototype._startServer =
function _startServer(serverUuid, callback) {
    var self = this;

    if (!self.servers[serverUuid]) {
        self.servers[serverUuid] = {};
    }

    if (self.servers[serverUuid].vmadm !== undefined) {
        // We already have this server
        callback();
        return;
    }

    self.log.info('setting up watcher for ' + serverUuid);

    // Create a new vmadm just for this server
    self.servers[serverUuid].vmadm = new DummyVmadm({
        log: self.log,
        serverRoot: self.serverRoot,
        serverUuid: serverUuid
    });

    // load VMs
    loadVmMap(self.servers[serverUuid].vmadm, function _onLoaded(err, vms) {
        if (err) {
            callback(err);
            return;
        }

        self.servers[serverUuid].vms = vms;
        self.log.info('loaded ' + Object.keys(vms).length + ' VMs for ' + serverUuid);

        self.servers[serverUuid].vmadm.events({}, function _handler(evt) {
            self.log.info({
                evtType: evt.type
                zonename: evt.zonename
            }, 'Got a vmadm.events evt');

            switch (evt.type) {
                case 'modify':
                    self.servers[serverUuid].vms[evt.zonename] = evt.vm;
                    break;
                case 'create':
                    self.servers[serverUuid].vms[evt.zonename] = evt.vm;
                    break;
                case 'delete':
                    delete self.servers[serverUuid].vms[evt.zonename];
                    break;
                default:
                    assert.fail('unknown evt.type ' + evt.type);
                    break;
            }

            // TODO also pass the event on to vmadm.events watchers
        }, function _onReady(eventErr) {
            self.log.info('listening for events from ' + serverUuid);
            callback();
        });
    });
};

DummyVminfod.prototype._removeServer =
function _removeServer(serverUuid, callback) {
    var self = this;

    self.log.info('removing server ' + serverUuid);

    if (self.servers[serverUuid] && self.servers[serverUuid].vmadm) {
        self.servers[serverUuid].vmadm._deleteAllWatchers();
        delete self.servers[serverUuid].vmadm;
    }
    delete self.servers[serverUuid];

    callback();
};

DummyVminfod.prototype._updateServers = function _updateServers(callback) {
    var self = this;

    if (self.prevServers === undefined) {
        self.prevServers = [];
    }

    function _addServers(dirs, cb) {
        vasync.forEachPipeline({
            func: function _runStartServer(serverUuid, cb) {
                assert.uuid(serverUuid, 'serverUuid');
                self._startServer(serverUuid, cb);
            },
            inputs: dirs
        }, cb);
    }

    function _delServers(dirs, cb) {
        vasync.forEachPipeline({
            func: function _runRemoveServer(serverUuid, cb) {
                assert.uuid(serverUuid, 'serverUuid');
                self._removeServer(serverUuid, cb);
            },
            inputs: self.prevServers.filter(function _filterMissing(dir) {
                // Include servers that used to be in the list, but are gone now
                if (dirs.indexOf(dir) === -1) {
                    return true;
                }
                return false;
            })
        }, cb);
    }

    function _updatePrev(dirs, cb) {
        self.prevServers = dirs;
        cb();
    }

    fs.readdir(self.serverRoot, function _onReadDir(err, dirs) {
        if (err) {
            self.log.error({
                err: err,
                serverRoot: self.serverRoot
            }, 'failed to load server root');
            if (callback) {
                callback(err);
            }
            return;
        }
        vasync.pipeline({
            arg: dirs,
            funcs: [
                _addServers,
                _delServers,
                _updatePrev
            ]
        }, function _onUpdated(err) {
            if (callback) {
                callback(err);
            }
        });
    });
};

DummyVminfod.prototype.queueUpdate = function queueUpdate() {
    var self = this;
    var alreadyQueued = self.updateQueue.queued.length;

    if (alreadyQueued === 0) {
        self.updateQueue.push('update');
    } else {
        self.log.debug('already have ' + alreadyQueued +
            ' updates queued, not adding another one');
    }
};

DummyVminfod.prototype.start = function start(callback) {
    var self = this;

    self._updateServers(function _onUpdated(updateErr) {
        assert.ifError(updateErr, 'should be able perform initial update');

        self.updateQueue = vasync.queue(function _doUpdate(task, cb) {
            assert.equal(task, 'update', 'unknown task ' + task);
            self._updateServers(cb);
        }, 1);

        // We watch only the serverRoot directory
        self.serverRootWatch = fs.watch(self.serverRoot, {}, function _onEvent(_evt) {
            // Called whenever the directory changes (servers added/removed)
            self.queueUpdate();
        });

        self.running = true;
        callback();
    });
};

var logLevel = (process.env.LOG_LEVEL || 'debug');
var logger = bunyan.createLogger({
    name: 'dummy-vminfod',
    level: logLevel,
    serializers: bunyanSerializers
});
var vminfod = new DummyVminfod({
    log: logger,
    serverRoot: SERVER_ROOT
});

// Node sucks. If fs.watch() is running and a dir is deleted, node throws an
// exception. We'll catch that here at the expense of ever having useful cores.
process.on('uncaughtException', function _onUncaughtException(err) {
    if (err.code === 'ENOENT') {
        logger.warn('ENOENT on missing file, updating servers');
        vminfod.queueUpdate();
    } else {
        throw (err);
    }
});

vminfod.start(function _onStarted(err) {
    logger.info({err: err}, 'Startup sequence complete');
});
