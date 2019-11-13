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
var restify = require('restify');
var vasync = require('vasync');
var Watershed = require('watershed').Watershed;

var DummyVmadm = require('vmadm/lib/index.dummy');

// This will blow up if something goes wrong. That's what we want.
var MOCKCLOUD_ROOT =
    process.env.MOCKCLOUD_ROOT ||
    child_process
        .execSync('/usr/sbin/mdata-get mockcloudRoot', {encoding: 'utf8'})
        .trim();
var SERVER_ROOT = MOCKCLOUD_ROOT + '/servers';

// We keep a global cache which maps *all* VMs to their server uuid in case
// someone wants to load a VM frome this mockcloud instance and knows the
// vm_uuid but not the server_uuid. One example is our dummy CMON which serves
// all mockcloud CNs with a single instance currently.
var globalVmServerMap = {};

function loadVmMap(vmadm, serverUuid, callback) {
    vmadm._loadVms({}, function _onLoadVms(err, loadedVms) {
        var idx;
        var vms = {};

        if (!err) {
            for (idx = 0; idx < loadedVms.length; idx++) {
                vms[loadedVms[idx].uuid] = loadedVms[idx];
                globalVmServerMap[loadedVms[idx].uuid] = serverUuid;
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
    self.serverRoot = opts.serverRoot;
    self.servers = {};
    self.startTime = Math.floor(new Date().getTime() / 1000 - process.uptime());
}

DummyVminfod.prototype._startServer = function _startServer(
    serverUuid,
    callback
) {
    var self = this;

    if (!self.servers[serverUuid]) {
        self.servers[serverUuid] = {};
    }

    if (self.servers[serverUuid].id === undefined) {
        self.servers[serverUuid].id = 0;
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
    loadVmMap(self.servers[serverUuid].vmadm, serverUuid, function _onLoaded(
        err,
        vms
    ) {
        if (err) {
            callback(err);
            return;
        }

        self.servers[serverUuid].vms = vms;
        self.log.info(
            'loaded ' + Object.keys(vms).length + ' VMs for ' + serverUuid
        );

        self.servers[serverUuid].vmadm.events(
            {},
            function _handler(evt) {
                var idx;
                var msg;
                var sheds;

                self.log.info(
                    {
                        evtType: evt.type,
                        zonename: evt.zonename
                    },
                    'Got a vmadm.events evt'
                );

                switch (evt.type) {
                    case 'modify':
                        self.servers[serverUuid].vms[evt.zonename] = evt.vm;
                        break;
                    case 'create':
                        self.servers[serverUuid].vms[evt.zonename] = evt.vm;
                        globalVmServerMap[evt.zonename] = serverUuid;
                        break;
                    case 'delete':
                        delete self.servers[serverUuid].vms[evt.zonename];
                        delete globalVmServerMap[evt.zonename];
                        break;
                    default:
                        assert.fail('unknown evt.type ' + evt.type);
                        break;
                }

                // This gives us a unique id for the event so that we can know when
                // reconnecting if we missed events. From the id we also know when
                // vminfod last restarted, what the last event *type* was for this
                // server and how many total events vminfod has seen for this
                // server since starting.
                evt.id =
                    self.startTime +
                    '.' +
                    process.pid +
                    '.' +
                    evt.type +
                    '.' +
                    self.servers[serverUuid].id++;

                self.servers[serverUuid].lastEvent = evt.id;

                // Send the evt to any watershed clients that are connected.
                if (self.servers[serverUuid].sheds) {
                    msg = JSON.stringify(evt);
                    sheds = Object.keys(self.servers[serverUuid].sheds);
                    for (idx = 0; idx < sheds.length; idx++) {
                        // TODO: move to log.trace
                        self.log.debug(
                            {
                                evt: evt,
                                socketId: sheds[idx]
                            },
                            'sending message to client'
                        );

                        try {
                            self.servers[serverUuid].sheds[sheds[idx]].send(
                                msg
                            );
                        } catch (e) {
                            self.log.error(
                                {err: e},
                                'failed to send msg to client'
                            );
                        }
                    }
                }
            },
            function _onReady(eventErr) {
                self.log.info('listening for events from ' + serverUuid);
                callback();
            }
        );
    });
};

DummyVminfod.prototype._removeServer = function _removeServer(
    serverUuid,
    callback
) {
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
        vasync.forEachPipeline(
            {
                func: function _runStartServer(serverUuid, cb) {
                    assert.uuid(serverUuid, 'serverUuid');
                    self._startServer(serverUuid, cb);
                },
                inputs: dirs
            },
            cb
        );
    }

    function _delServers(dirs, cb) {
        vasync.forEachPipeline(
            {
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
            },
            cb
        );
    }

    function _updatePrev(dirs, cb) {
        self.prevServers = dirs;
        cb();
    }

    fs.readdir(self.serverRoot, function _onReadDir(err, dirs) {
        if (err) {
            self.log.error(
                {
                    err: err,
                    serverRoot: self.serverRoot
                },
                'failed to load server root'
            );
            if (callback) {
                callback(err);
            }
            return;
        }
        vasync.pipeline(
            {
                arg: dirs,
                funcs: [_addServers, _delServers, _updatePrev]
            },
            function _onUpdated(err) {
                if (callback) {
                    callback(err);
                }
            }
        );
    });
};

DummyVminfod.prototype.queueUpdate = function queueUpdate() {
    var self = this;
    var alreadyQueued = self.updateQueue.queued.length;

    if (alreadyQueued === 0) {
        self.updateQueue.push('update');
    } else {
        self.log.debug(
            'already have ' +
                alreadyQueued +
                ' updates queued, not adding another one'
        );
    }
};

function listServers(req, res, next) {
    var self = this;

    res.send(200, Object.keys(self.servers));
    next();
}

function getVms(req, res, next) {
    var self = this;
    var vms;

    if (
        !req.params.serverUuid ||
        !self.servers.hasOwnProperty(req.params.serverUuid)
    ) {
        next(
            new restify.ResourceNotFoundError(
                'server ' + req.params.serverUuid + ' not found'
            )
        );
        return;
    }

    vms = Object.keys(self.servers[req.params.serverUuid].vms).map(
        function _mapVm(vm) {
            return self.servers[req.params.serverUuid].vms[vm];
        }
    );

    res.send(200, vms);
    next();
}

function getVm(req, res, next) {
    var self = this;
    var serverUuid = req.params.serverUuid;
    var vmUuid = req.params.vmUuid;

    if (serverUuid === '*' && vmUuid) {
        // Special case: GET /servers/*/vms/<uuid>
        //
        // In this case we'll use the globalVmServerMap to find the server if it
        // exists.
        if (globalVmServerMap.hasOwnProperty(vmUuid)) {
            serverUuid = globalVmServerMap[vmUuid];
        } else {
            next(
                new restify.ResourceNotFoundError('VM ' + vmUuid + ' not found')
            );
            return;
        }
    }

    if (!serverUuid || !self.servers.hasOwnProperty(serverUuid)) {
        next(
            new restify.ResourceNotFoundError(
                'server ' + serverUuid + ' not found'
            )
        );
        return;
    }

    if (!self.servers[serverUuid].vms.hasOwnProperty(req.params.vmUuid)) {
        next(new restify.ResourceNotFoundError('VM ' + vmUuid + ' not found'));
        return;
    }

    res.send(200, self.servers[serverUuid].vms[vmUuid]);
    next();
}

DummyVminfod.prototype.setupRoutes = function setupRoutes() {
    var self = this;
    var idx = 0;
    var ws = new Watershed();

    self.restifyServer.get(
        {
            path: '/servers'
        },
        listServers.bind(self)
    );

    self.restifyServer.get(
        {
            path: '/servers/:serverUuid/vms'
        },
        getVms.bind(self)
    );

    self.restifyServer.get(
        {
            path: '/servers/:serverUuid/vms/:vmUuid'
        },
        getVm.bind(self)
    );

    self.restifyServer.on('upgrade', function(req, socket, head) {
        var shed;
        var serverUuid = req.header('Server');
        var socketId = socket.remoteAddress + ':' + socket.remotePort;

        self.log.debug(
            {
                socketId: socketId,
                serverUuid: serverUuid
            },
            'saw upgrade'
        );

        if (!serverUuid || !self.servers.hasOwnProperty(serverUuid)) {
            self.log.error(
                {serverUuid: serverUUid},
                'Unknown or missing "Server:" header'
            );
            socket.write(
                'HTTP/1.1 404 Server Not Found\r\n' +
                    'Connection: close\r\n' +
                    '\r\n'
            );
            socket.end();
            return;
        }

        try {
            shed = ws.accept(req, socket, head);
        } catch (ex) {
            self.log.error({err: ex}, 'failed to accept upgrade');
            socket.end();
            return;
        }

        if (!self.servers[serverUuid].hasOwnProperty('sheds')) {
            self.servers[serverUuid].sheds = {};
        }
        self.servers[serverUuid].sheds[socketId] = shed;

        // node-watershed doesn't allow us to add additional headers to the
        // upgrade response, so we can't tell the client the last event that
        // way. So instead we send an event of type 'info' once the connection
        // is established.
        shed.send(
            JSON.stringify({
                id: self.servers[serverUuid].lastEvent,
                type: 'info'
            })
        );

        socket.on('close', function() {
            self.log.debug(
                {
                    socketId: socketId
                },
                'socket closed, destroying shed'
            );
            shed.destroy();
        });

        socket.on('error', function(e) {
            self.log.debug(
                {
                    err: e,
                    socketId: socketId
                },
                'socket error'
            );
            shed.end();
        });

        shed.on('connectionReset', function() {
            self.log.debug('connection reset');
        });

        shed.on('error', function(e) {
            self.log.debug({err: e}, 'connection error');
        });

        shed.on('end', function() {
            delete self.servers[serverUuid].sheds[socketId];
            self.log.debug({socketId: socketId}, 'shed ended');
        });
    });
};

DummyVminfod.prototype.start = function start(callback) {
    var self = this;
    var config = {};

    config.log = self.log;
    config.acceptable = ['application/json'];
    config.handleUpgrades = false;

    self.restifyServer = restify.createServer(config);

    // Want to not timeout these connections every 2 minutes (the default) while
    // someone's listening on them for events.
    self.restifyServer.server.setTimeout(24 * 60 * 60 * 1000);

    self.setupRoutes();

    self._updateServers(function _onUpdated(updateErr) {
        assert.ifError(updateErr, 'should be able perform initial update');

        self.updateQueue = vasync.queue(function _doUpdate(task, cb) {
            assert.equal(task, 'update', 'unknown task ' + task);
            self._updateServers(cb);
        }, 1);

        // We watch only the serverRoot directory
        self.serverRootWatch = fs.watch(self.serverRoot, {}, function _onEvent(
            _evt
        ) {
            // Called whenever the directory changes (servers added/removed)
            self.queueUpdate();
        });

        self.restifyServer.listen(9090, '127.0.0.1', function() {
            callback();
        });
    });
};

var logLevel = process.env.LOG_LEVEL || 'debug';
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
        throw err;
    }
});

vminfod.start(function _onStarted(err) {
    logger.info({err: err}, 'Startup sequence complete');
});
