/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var bunyan = require('bunyan');
var canned_profiles = require('../lib/canned_profiles.json');
var cp = require('child_process');
var dhcpclient = require('dhcpclient');
var execFile = cp.execFile;
var fs = require('fs');
var path = require('path');
var restify = require('restify');
var sprintf = require('sprintf').sprintf;
var sys = require('sys');
var CnAgentHttpServer = require('cn-agent/lib/server');
var libuuid = require('node-uuid');
var vasync = require('vasync');

var log = bunyan.createLogger({name: 'mock-ur-agent', level: 'debug'});

// var state;
var CN_PROPERTIES;
var HTTP_LISTEN_IP = '0.0.0.0';
var HTTP_LISTEN_PORT = 80;
var MOCKCN_DIR = '/mockcn';
var STATE_FILE = '/mockcn.json';


module.exports = MockAgent;


/*
 * XXX: TODO: These properties are ignored (they get set for you):
 *
 * 'Boot Parameters' // from CNAPI? or TFTP
 * 'Datacenter Name'
 * 'Setup'
 * 'Zpool*'
 *
 */


CN_PROPERTIES = {
    'Boot Time': {validator: isInteger},
    'CPU Physical Cores': {validator: isInteger},
    'CPU Type': {validator: isSimpleString},
    'CPU Virtualization': {validator: isSimpleString},
    'CPU Total Cores': {validator: isInteger},
    'Disks': {validator: isValidDisksObj},
    'Hostname': {validator: isValidHostname},
    'HW Family': {optional: true, validator: isSimpleString},
    'HW Version': {optional: true, validator: isSimpleString},
    'Link Aggregations': {validator: isValidLinkAgg},
    'Live Image': {validator: isPlatformStamp},
    'Manufacturer': {validator: isSimpleString},
    'MiB of Memory': {validator: isInteger}, // XXX convert to string
    'Network Interfaces': {validator: isValidNetObj},
    'Product': {validator: isSimpleString},
    'SDC Version': {validator: isSDCVersion},
    'Serial Number': {validator: isSimpleString},
    'SKU Number': {validator: isSimpleString},
    'System Type': {validator: isSunOS},
    'UUID': {validator: isUUID},
    'Virtual Network Interfaces': {validator: isValidVirtNetObj},
    'VM Capable': {validator: isBoolean}
};


function MockAgent() {
    var self = this;

    self.mockCnAgents = {};

    self.computeNodes = {};

    self.fileCache = {};
    self.agentServer = null;
    self.state = null;
    self.sdc_config = {};
}


MockAgent.prototype.start = function () {
    var self = this;

    vasync.waterfall([
        function (next) {
            self.loadSDCConfig(next);
        },
        function (next) {
            self.loadState(next);
        },
        function (next) {
            self.monitorMockCNs();
            next();
        },
        function (next) {
            self.startHttpServer(next);
        }
    ], function (err) {
    });
};


MockAgent.prototype.loadSDCConfig =
function MockAgentLoadSDCConfig(callback) {
    var self = this;
    vasync.waterfall([
        function (cb) {
            getMetadata('sdc:dns_domain', function (e, val) {
                if (!e) {
                    self.sdc_config.dns_domain = val;
                }
                cb(e);
            });
        }, function (cb) {
            getMetadata('sdc:datacenter_name', function (e, val) {
                if (!e) {
                    log.info('datacenter = %s', val);
                    self.sdc_config.datacenter_name = val;
                }
                cb(e);
            });
        }
    ], function (err) {
        callback(err);
    });
};


MockAgent.prototype.startHttpServer =
function MockAgentStartHttpServeruuid() {
    var server;
    var self = this;

    self.agentServer = new CnAgentHttpServer({
        bindip: '0.0.0.0',
        log: log
    });
    self.agentServer.start();

    server = restify.createServer();
    server.use(restify.queryParser());
    server.use(restify.bodyParser());
    server.on('after', restify.auditLogger({ log: log }));

    server.get('/servers', self.getServers.bind(self));
    server.get('/servers/:uuid', self.getServer.bind(self));
    server.post('/servers', self.createServer.bind(self));
    server.del('/servers/:uuid', self.deleteServer.bind(self));

    server.listen(HTTP_LISTEN_PORT, HTTP_LISTEN_IP, function () {
        console.log('%s listening at %s', server.name, server.url);
    });
};


MockAgent.prototype.instantiateMockCN =
function MockAgentInstantiateMockCN(uuid, callback) {
    var self = this;

    var CnAgent;
    var cpMock;
    var logname = 'mock-cn-agent' + '/' + uuid;
    var mockery = require('mockery');
    var tasklog = '/var/log/' + logname + '/logs';
    var UrAgent;

    log.info('starting instance for mock CN ' + uuid);

    function mkMock(fn) {
        return function () {
            // Make real array from arguments
            var args = Array.prototype.slice.call(arguments);
            log.debug('mocking for ' + uuid);
            args.unshift(uuid);
            return fn.apply(this, args);
        };
    }

    cpMock = {
        exec: mkMock(mockExec),
        execFile: mkMock(mockExecFile),
        fork: mkMock(mockFork),
        spawn: mkMock(mockSpawn)
    };

    mockery.enable({ useCleanCache: true });
    mockery.registerMock('child_process', cpMock);

    UrAgent = require('sdc-ur-agent').UrAgent;
    CnAgent = require('cn-agent/lib/app');

    mockery.deregisterMock('child_process');
    mockery.disable();

    self.mockCnAgents[uuid] = new CnAgent({
        uuid: uuid,
        log: log,
        tasklogdir: tasklog,
        logname: 'mocked-cn-agent',
        taskspath: path.join(
            __dirname, '..', 'node_modules/cn-agent/lib/tasks'),
        agentserver: self.agentServer,
        sdc_config: self.sdc_config
    });

    self.mockCnAgents[uuid].start();

    var sysinfoFilePath = '/mockcn/' + uuid + '/sysinfo.json';
    var sysinfo;
    try {
        sysinfo = JSON.parse(fs.readFileSync(sysinfoFilePath));
    } catch (e) {
        if (callback) {
            callback(e);
        }
        return;
    }

    self.computeNodes[uuid] = {
        sysinfo: sysinfo,
        ur_agent: null,
        cn_agent: null
    };

    self.computeNodes[uuid].ur_agent = new UrAgent({
        sysinfoFile: sysinfoFilePath,
        setupStateFile: '/mockcn/' + uuid + '/setup.json',
        urStartupFilePath: '/tmp/' + uuid + '.tmp-' + genId(),
        mockCNServerUUID: uuid
    });
};


MockAgent.prototype.monitorMockCNs = function MockAgentMonitorMockCNs() {
    var self = this;

    /*
     *    // Setup fs.watcher for this DIR to add and remove instances when
     *    fs.watch(MOCKCN_DIR, function () {
     *        // we don't care about *what* event just happened, just that one
     *        // did
     *        self.refreshMockCNs();
     *    })
     *
     */

    // call refreshMockCNs() to set the initial mock CNs
    self.refreshMockCNs();
};


MockAgent.prototype.refreshMockCNs =
function MockAgenRefreshMonitorMockCNs(callback) {
    var self = this;
    fs.readdir(MOCKCN_DIR, function (readErr, files) {
        self.fileCache = {};

        if (readErr && readErr.code === 'ENOENT') {
            log.debug('failed to read ' + MOCKCN_DIR + ': does not exist');
            return;
        } else if (readErr) {
            log.error('failed to refresh MockCNs: ' + readErr.message);
            return;
        }

        vasync.forEachParallel({
            inputs: files,
            func: function (file, next) {
                var logname = 'mock-cn-agent' + '/' + file;
                var tasklog = '/var/log/' + logname + '/logs';

                // XXX HACK
                execFile('/usr/bin/mkdir', ['-p', tasklog], function (execErr) {
                    // XXX DO NOTHING
                });

                self.fileCache[file] = true;
                if (!self.computeNodes.hasOwnProperty(file)) {
                    self.instantiateMockCN(file, next);
                } else {
                    next();
                }
            }
        }, function (err, results) {
            Object.keys(self.computeNodes).forEach(function (cn) {
                if (!self.fileCache.hasOwnProperty(cn)) {
                    // remove instance for this one
                    log.info('removing instance for mock CN ' + cn);
                    self.computeNodes[cn].ur_agent.shutdown();
                    delete self.computeNodes[cn];
                }
            });

            if (callback) {
                callback(err);
            }
        });
    });
};


function getTarget(url) {
    var urlParts = url.split('/');

    if (urlParts[0] !== '' || urlParts[1] !== 'servers' ||
        urlParts.length > 3) {

        // invalid request
        return null;
    }

    if (urlParts.length === 3) {
        if (isUUID(urlParts[2])) {
            return urlParts[2];
        } else {
            // request was /servers/<junk>
            return null;
        }
    }

    // the request was /servers
    return 'all';
}


function returnError(code, request, res) {
    res.writeHead(code);
    res.end();
}


function validateServer(payload) {
    var invalid = false;
    var validated = {};

    Object.keys(payload).forEach(function (key) {
        if (CN_PROPERTIES.hasOwnProperty(key)) {
            if (CN_PROPERTIES[key].validator(payload[key])) {
                validated[key] = payload[key];
            } else {
                invalid = true;
            }
        } else {
            log.info('Ignoring field ' + key);
        }
    });

    if (invalid) {
        return false;
    }

    return validated;
}

function getMetadata(key, callback) {
    execFile('/usr/sbin/mdata-get', [key], function (err, stdout, stderr) {
        var result;

        if (err) {
            err.stderr = stderr;
            callback(err);
            return;
        }

        result = stdout.split(/\n/)[0];
        callback(null, result);
    });
}

MockAgent.prototype.loadState = function loadState(callback) {
    var self = this;

    fs.readFile(STATE_FILE, function (error, data) {
        var json = {};

        if (error) {
            if (error.code === 'ENOENT') {
                self.state = {cn_indexes: {}};
                callback();
            } else {
                log.error(error,
                          'loadJsonConfig() failed to load ' + STATE_FILE);
                callback(error);
                return;
            }
        } else {
            try {
                json = JSON.parse(data.toString());
                self.state = json;
                callback();
            } catch (e) {
                log.error(e, 'failed to parse JSON');
                callback(e);
            }
        }
    });
};


MockAgent.prototype.saveState = function MockAgentSaveState(callback) {
    var self = this;
    fs.writeFile(
        STATE_FILE, JSON.stringify(self.state, null, 2) + '\n',
        function (err) {
            if (err) {
                callback(err);
                return;
            }
            callback();
        });
};

function addMAC(nic, mock_oui, cn_index, nic_index, callback) {
    var index_octets;
    index_octets = sprintf('%04x', cn_index).match(/.{2}/g);

    nic['MAC Address']
        = sprintf('%s:%s:%02x', mock_oui, index_octets.join(':'), nic_index);

    log.debug({nic: nic}, 'NIC');

    callback();
}

MockAgent.prototype.applyDefaultsToPayload =
function MockAgentApplyDefaults(payload, callback) {
    var self = this;
    var admin_nic;
    var cn_index;
    var mock_oui;
    var tftpdhost;

    if (!payload.hasOwnProperty('Boot Time')) {
        payload['Boot Time'] = genBootTime();
    }

    if (!payload.hasOwnProperty('System Type')) {
        payload['System Type'] = 'SunOS';
    }

    if (!payload.hasOwnProperty('SDC Version')) {
        payload['SDC Version'] = '7.0';
    }

    function addFromMetadata(prop, mdata_key, cb) {
        if (payload.hasOwnProperty(prop)) {
            cb();
            return;
        }
        getMetadata(mdata_key, function (e, val) {
            if (!e) {
                payload[prop] = val;
            }
            cb(e);
            return;
        });
    }

    vasync.waterfall([
        function (cb) {
            addFromMetadata('Datacenter Name', 'sdc:datacenter_name', cb);
        }, function (cb) {
            if (payload.hasOwnProperty('Live Image')) {
                cb();
                return;
            }
            getBuildstamp(function (e, buildstamp) {
                if (!e) {
                     payload['Live Image'] = buildstamp;
                }
                cb(e);
                return;
            });
        }, function (cb) {
            var canned_profile_names;
            var disk_type = {};
            var profile;
            var ssd_type = {};
            var template;

            canned_profile_names = Object.keys(canned_profiles);

            if (payload.hasOwnProperty('Product') &&
                canned_profile_names.indexOf(payload['Product']) !== -1) {

                profile = payload['Product'];
                log.debug('payload had "Product", using profile: ' + profile);
            } else {
                profile = canned_profile_names[genRandomInt(0,
                    (canned_profile_names.length - 1))];
                log.debug('chose random profile: ' + profile);
            }

            template = canned_profiles[profile];

            // If we have 'Disks' in payload, but not VID + PID, try to
            // determine those from profile.
            if (payload.hasOwnProperty('Disks')) {
                Object.keys(template['Disks']).forEach(function (d) {
                    d = template['Disks'][d];
                    if (!ssd_type.hasOwnProperty('PID') &&
                        d.hasOwnProperty('SSD') && d['SSD']) {

                        if (d.hasOwnProperty('PID')) {
                            log.debug('default SSD PID="' + d['PID'] + '"');
                            ssd_type['PID'] = d['PID'];
                        }
                        if (d.hasOwnProperty('VID')) {
                            log.debug('default SSD VID="' + d['VID'] + '"');
                            ssd_type['VID'] = d['VID'];
                        }
                    } else if (!disk_type.hasOwnProperty('PID') &&
                               ! d.hasOwnProperty('SSD')) {

                        if (d.hasOwnProperty('PID')) {
                            log.debug('default disk PID="' + d['PID'] + '"');
                            disk_type['PID'] = d['PID'];
                        }
                        if (d.hasOwnProperty('VID')) {
                            log.debug('default disk VID="' + d['VID'] + '"');
                            disk_type['VID'] = d['VID'];
                        }
                    }
                });

                Object.keys(payload['Disks']).forEach(function (d) {
                    d = payload['Disks'][d];
                    if (d.hasOwnProperty('SSD') && d['SSD']) {
                        if (!d.hasOwnProperty('PID') &&
                            ssd_type.hasOwnProperty('PID')) {

                            d['PID'] = ssd_type['PID'];
                        }
                        if (!d.hasOwnProperty('VID') &&
                            ssd_type.hasOwnProperty('VID')) {

                            d['VID'] = ssd_type['VID'];
                        }
                    } else {
                        if (!d.hasOwnProperty('PID') &&
                            disk_type.hasOwnProperty('PID')) {

                            d['PID'] = disk_type['PID'];
                        }
                        if (!d.hasOwnProperty('VID') &&
                            disk_type.hasOwnProperty('VID')) {

                            d['VID'] = disk_type['VID'];
                        }
                    }
                });
            }

            Object.keys(template).forEach(function (key) {
                if (!payload.hasOwnProperty(key)) {
                    payload[key] = template[key];
                    log.debug('loading ' + key + ' = ' + template[key]);
                }
            });

            cb();
        }, function (cb) {
            var next_index = 0;
            var cns;

            // find index for this CN
            cns = Object.keys(self.state.cn_indexes);
            cns.forEach(function (v) {
                if (self.state.cn_indexes[v].cn_index >= next_index) {
                    next_index++;
                }
            });

            cn_index = next_index;
            // reserve the index so we don't reuse this index
            self.state.cn_indexes[payload['UUID']] = {cn_index: cn_index};
            cb();
        }, function (cb) {
            /*
             * Load the mock_oui, this should be unique for each mockcn VM
             * The generated UUIDs for servers will be:
             *
             *   mock_oui:<cn_index (2 bytes)>:<nic_num (1 byte)>
             *
             */
            getMetadata('mock_oui', function (e, val) {
                if (!e) {
                    mock_oui = val;
                }
                cb(e);
            });
        }, function (cb) {
            var nic_index = 0;
            var nics;

            nics = Object.keys(payload['Network Interfaces']);

            vasync.forEachPipeline({
                inputs: nics,
                func: function (n, c) {
                    var nic = payload['Network Interfaces'][n];
                    addMAC(nic, mock_oui, cn_index, nic_index++, c);
                    if (nic.hasOwnProperty('NIC Names') &&
                        nic['NIC Names'].indexOf('admin') !== -1) {

                        admin_nic = nic;
                    } else if (nic_index === 1 && !admin_nic) {
                        // default to first one in case we don't have specified
                        // one
                        admin_nic = nic;
                    }
                }
            }, function (e) {
                cb(e);
            });
        }, function (cb) {
            // DO DHCP to get IP for admin NIC
            dhcpclient.getIP(admin_nic['MAC Address'], payload['UUID'],
                function (e, result) {

                if (e) {
                    cb(e);
                    return;
                }

                admin_nic['ip4addr'] = result.ip;
                tftpdhost = result.server;

                cb();
                return;
            });
        }, function (cb) {
            getBootParams(admin_nic['MAC Address'], tftpdhost,
                function (err, params) {
                    if (!err) {
                        log.debug('got boot params: ' +
                                  JSON.stringify(params, null, 2));
                        payload['Boot Parameters'] = params;
                    }
                    cb(err);
                });
        }, function (cb) {
            if (payload.hasOwnProperty('Hostname')) {
                cb();
                return;
            }

            // boot params takes priority
            if (payload['Boot Parameters'].hasOwnProperty('hostname')) {
                payload['Hostname'] = payload['Boot Parameters']['hostname'];
                cb();
                return;
            }

            payload['Hostname'] = admin_nic['MAC Address'].replace(/:/g, '-');
            cb();
        }

        // XXX TODO: randomize disk names (eg. c0t37E44117BC62A1E3d0)
    ], function (err) {
        if (err) {
            log.error({err: err}, 'failed!');
        }
        callback(err, payload);
    });
};


MockAgent.prototype.createMockServer =
function MockAgentCreateMockServer(payload, callback) {
    var self = this;

    var mockserver;
    var uuid = payload.UUID;
    var validated;

    log.debug({payload: payload}, 'creating ' + uuid);

    vasync.waterfall([
        function (cb) {
            validated = validateServer(payload);
            if (!validated) {
                cb(restify.BadRequestError('invalid payload'));
                return;
            }
            log.debug({payload: validated}, 'validated payload');
            cb();
        }, function (cb) {
            self.applyDefaultsToPayload(payload, function (err, data) {
                if (!err) {
                    mockserver = data;
                    log.debug({payload: mockserver}, 'after applying defaults');
                }
                cb(err);
            });
        }, function (cb) {
            uuid = mockserver.UUID;

            // make directory
            fs.mkdir('/mockcn', parseInt('0755', 8), function (e) {
                if (e && e.code !== 'EEXIST') {
                    log.error({err: e}, 'Error creating /mockcn');
                    cb(e);
                    return;
                }
                fs.mkdir('/mockcn/' + uuid, parseInt('0755', 8),
                    function (mkdir_uuid_e) {
                        if (mkdir_uuid_e) {
                            log.error(
                                {err: e}, 'Error creating /mockcn/' + uuid);
                            cb(mkdir_uuid_e);
                            return;
                        }

                        cb();
                    });
            });
        }, function (cb) {
            var disks = [];
            uuid = mockserver.UUID;

            // write disks
            Object.keys(mockserver.Disks).forEach(function (d) {
                var size = mockserver.Disks[d]['Size in GB'];

                size = (size * 1000 * 1000 * 1000);
                disks.push({
                    type: 'SCSI',
                    name: d,
                    vid: mockserver['Disks'][d]['VID']
                            ? mockserver['Disks'][d]['VID'] : 'HITACHI',
                    pid: mockserver['Disks'][d]['PID']
                            ? mockserver['Disks'][d]['PID'] : 'HUC109060CSS600',
                    size: size,
                    removable: false,
                    solid_state: mockserver['Disks'][d]['SSD'] ? true : false
                });

                // Some properties only exist until we've written out the
                // disks.json and don't go to sysinfo, we remove those now
                delete mockserver['Disks'][d]['VID'];
                delete mockserver['Disks'][d]['PID'];
                delete mockserver['Disks'][d]['SSD'];
            });

            fs.writeFile('/mockcn/' + uuid + '/disks.json',
                JSON.stringify(disks, null, 2) + '\n', function (err) {

                cb(err);
            });
        }, function (cb) {
            execFile('/usr/sbin/mdata-get', ['sdc:nics'],
                function (error, stdout, stderr) {

                var nics;

                if (error) {
                    cb(error);
                    return;
                }

                // XXX will blow up if this doesn't work
                nics = JSON.parse(stdout);
                nics.forEach(function (n) {
                    if (n.nic_tag === 'admin') {
                        mockserver['Admin IP'] = n.ip;
                    }
                });

                cb();
            });
        }, function (cb) {
            // write sysinfo
            fs.writeFile('/mockcn/' + uuid + '/sysinfo.json',
                JSON.stringify(mockserver, null, 2) + '\n', function (err) {
                self.computeNodes[uuid].sysinfo = mockserver;
                cb(err);
            });
        }, function (cb) {
            // write out the global state file
            self.saveState(cb);
        }, function (cb) {
            uuid = payload['UUID'];

            self.instantiateMockCN(uuid);
            cb();
        }
    ], callback);
};


MockAgent.prototype.getServers = function MockAgentGetServers(req, res, next) {
    var self = this;

    var result = Object.keys(self.computeNodes).map(function (uuid) {
        return {
            uuid: uuid,
            sysinfo: self.computeNodes[uuid].sysinfo
        };
    });

    res.send(result);
    next();
};


MockAgent.prototype.getServer = function MockAgentGetServer(req, res, next) {
    var self = this;
    var uuid = req.params.uuid;

    if (!uuid || !self.compueNodes[uuid]) {
        next(restify.ResourceNotFoundError('no such server'));
        return;
    }

    res.send({ uuid: uuid, payload: self.compueNodes[uuid].payload });
    next();
};


MockAgent.prototype.deleteServer =
function MockAgentDeleteServer(req, res, next) {
    var uuid = req.params.uuid;
    var self = this;

    if (!uuid || !self.computeNodes[uuid]) {
        next(restify.ResourceNotFoundError('no such server'));
        return;
    }

    // XXX need to actually delete

    res.send(204);
    next();
};


MockAgent.prototype.createServer =
function MockAgentCreateServer(req, res, next) {
    var self = this;
    var payload = req.body;

    log.info({payload: payload, params: req.params}, 'PAYLOAD');

    if (!payload.UUID) {
        payload.UUID = libuuid.v4();
    }
    if (self.computeNodes[payload.UUID]) {
        next(restify.ConflictError('CN already exists'));
        return;
    }

    self.computeNodes[payload.UUID] = {};
    self.computeNodes[payload.UUID] = {
        sysinfo: null,
        cn_agent: null,
        ur_agent: null
    };

    self.createMockServer(payload, function (err) {
        if (err) {
            next(err);
            return;
        }

        res.send(201);
        next();
    });
};


// Helper functions


function getBuildstamp(callback) {
    execFile('/usr/bin/uname', ['-v'], function (err, stdout, stderr) {
        var result;

        if (err) {
            err.stderr = stderr;
            callback(err);
            return;
        }

        result = stdout.split(/\n/)[0];
        result = result.split(/_/)[1];
        callback(null, result);
    });
}


function genRandomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}


function genBootTime() {
    // sysinfo has 'Boot Time' as a string
    return Math.floor(new Date().getTime() / 1000).toString();
}


// Generate a hex representation of a random four byte string.
function genId() {
    return Math.floor(Math.random() * 0xffffffff).toString(16);
}


function isBoolean(v) {
    if (v === true || v === false) {
        return true;
    } else {
        return false;
    }
}


function isInteger(v) {
    if (!isNaN(Number(v)) && (Number(v) % 1) === 0) {
        return true;
    } else {
        return false;
    }
}


function isValidLinkAgg(v) {
    // isValidLinkAgg // for now: {}
    return true;
}


function isValidVirtNetObj(v) {
    // same as NetObj + 'Host Interface', 'VLAN'
    return true;
}


function isValidNetObj(v) {
    // key = e1000g0, fields: 'MAC Address', 'ip4addr',
    //       'Link Status', 'NIC Names'
    return true;
}


function isValidDisksObj(v) {
    // key = devicename, fields: 'Size in GB' = int, XXX
    return true;
}


function isValidHostname(v) {
    if (v.match(/^[a-zA-Z0-9]$/)) {
        return true;
    } else {
        return false;
    }
}


function isPlatformStamp(v) {
    if (v.match(/^[0-9]*T[0-9]*Z$/)) {
        return true;
    } else {
        return false;
    }
}


function isSimpleString(v) {
    /* JSSTYLED */
    if (v.match(/^[a-zA-Z0-9\ \.\,\-\_]*$/)) {
        return true;
    } else {
        return false;
    }
}


function isSunOS(v) {
    return v === 'SunOS';
}


function isSDCVersion(v) {
    if (v.match(/^[0-9]*\.[0-9]*$/)) {
        return true;
    }
    return false;
}


// 'borrowed' from VM.js
function isUUID(str) {
    var re = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
    if (str && str.length === 36 && str.match(re)) {
        return true;
    } else {
        return false;
    }
}


function parseBootParams(filename, callback) {
    // XXX we're assuming the first kernel line is the one we want
    fs.readFile('/tmp/menu.lst', function (err, data) {
        var found = false;
        var lines;
        var params = {};
        var variables = {};

        if (err) {
            callback(err);
            return;
        }

        lines = data.toString().split(/\n/);
        lines.forEach(function (line) {
            var matches;
            var opts;

            if (found) {
                return;
            }

            /* JSSTYLED */
            matches = line.match(/^variable (.*) (.*)/);
            if (matches) {
                variables[matches[1]] = matches[2];
                return;
            }
            Object.keys(variables).forEach(function (key) {
                var pattern = new RegExp('\\$\\{' + key + '\\}', 'g');
                line = line.replace(pattern, variables[key]);
            });
            matches = line.match(/^\ *kernel.* ([^\ ]*)$/);
            if (matches) {
                /* JSSTYLED */
                opts = matches[1].match(/([^=]+='[^']+"|[^=]+=[^,]+)/g);
                opts.forEach(function (opt) {
                    var chunks = opt.split('=');

                    /* BEGIN JSSTYLED */
                    params[chunks[0].replace(/\-/g, '_').replace(/^,/, '')]
                        = chunks[1].replace(/\"/g, '');
                    /* END JSSTYLED */

                });
                found = true;
                return;
            }
        });

        callback(null, params);
    });
}


function mockExec(uuid, command /* , options, callback */) {
    var callback;
    var options = {
        encoding: 'utf8',
        timeout: 0,
        maxBuffer: 200 * 1024,
        killSignal: 'SIGTERM',
        cwd: null,
        env: null
    };
    var pos = 2;

    while (pos < arguments.length) {
        if (typeof (arguments[pos]) === 'function') {
            callback = arguments[pos];
        } else if (typeof (arguments[pos]) === 'object') {
            options = arguments[pos];
        } else {
            throw new Error('wtf is ' + typeof (arguments[pos])
                + ' doing as arg ' + pos);
        }
        pos++;
    }

    if (!options.env) {
        options.env = {};
    }
    options.env.MOCKCN_SERVER_UUID = uuid;

    log.debug({
        uuid: uuid,
        command: command,
        opt_type: typeof (options),
        opts: options,
        callback: JSON.stringify(callback)
    }, 'gonna exec()');

    return cp.exec(command, options, callback);
}

function mockExecFile(uuid, file /* , args, options, callback */) {
    var args = [];
    var callback;
    var options = {
        encoding: 'utf8',
        timeout: 0,
        maxBuffer: 200 * 1024,
        killSignal: 'SIGTERM',
        cwd: null,
        env: null
    };
    var pos = 2;

    while (pos < arguments.length) {
        if (Array.isArray(arguments[pos])) {
            args = arguments[pos];
        } else if (typeof (arguments[pos]) === 'function') {
            callback = arguments[pos];
        } else if (typeof (arguments[pos]) === 'object') {
            options = arguments[pos];
        } else {
            throw new Error('wtf is ' + typeof (arguments[pos])
                + ' doing as arg ' + pos);
        }
        pos++;
    }

    if (!options.env) {
        options.env = {};
    }
    options.env.MOCKCN_SERVER_UUID = uuid;

    log.debug({
        uuid: uuid,
        file: file,
        args: JSON.stringify(args),
        opt_type: typeof (options),
        opts: options,
        callback: JSON.stringify(callback)
    }, 'gonna execFile()');

    return cp.execFile(file, args, options, callback);
}

function mockSpawn(uuid, command /* , args, options */) {
    var args = [];
    var options = {
        encoding: 'utf8',
        timeout: 0,
        maxBuffer: 200 * 1024,
        killSignal: 'SIGTERM',
        cwd: null,
        env: null
    };
    var pos = 2;

    while (pos < arguments.length) {
        if (Array.isArray(arguments[pos])) {
            args = arguments[pos];
        } else if (typeof (arguments[pos]) === 'object') {
            options = arguments[pos];
        } else {
            throw new Error('wtf is ' + typeof (arguments[pos])
                + ' doing as arg ' + pos);
        }
        pos++;
    }

    if (!options.env) {
        options.env = {};
    }
    options.env.MOCKCN_SERVER_UUID = uuid;

    log.debug({
        uuid: uuid,
        command: JSON.stringify(command),
        args: JSON.stringify(args),
        opt_type: typeof (options),
        opts: options
    }, 'gonna spawn()');

    return cp.spawn(command, args, options);
}

function mockFork(uuid, modulePath /* , args, options */) {
    var args = [];
    var options = {
        encoding: 'utf8',
        timeout: 0,
        maxBuffer: 200 * 1024,
        killSignal: 'SIGTERM',
        cwd: null,
        env: null
    };
    var pos = 2;

    while (pos < arguments.length) {
        if (Array.isArray(arguments[pos])) {
            args = arguments[pos];
        } else if (typeof (arguments[pos]) === 'object') {
            options = arguments[pos];
        } else {
            throw new Error('wtf is ' + typeof (arguments[pos])
                + ' doing as arg ' + pos);
        }
        pos++;
    }

    if (!options.env) {
        options.env = {};
    }
    options.env.MOCKCN_SERVER_UUID = uuid;

    log.debug({
        uuid: uuid,
        modulePath: JSON.stringify(modulePath),
        args: JSON.stringify(args),
        opt_type: typeof (options),
        opts: options
    }, 'gonna fork()');

    return cp.fork(modulePath, args, options);
}

// FINISH REPLACING ALL OF CHILD_PROCESS


function getBootParams(mac, tftphost, callback) {
    var args;
    var cmd = '/opt/local/bin/tftp';
    var filename = 'menu.lst.01' + mac.replace(/:/g, '').toUpperCase();

    args = [tftphost, '-c', 'get', filename, '/tmp/menu.lst'];

    log.debug('cmd: ' + cmd + ' ' + args.join(' '));

    execFile(cmd, args, function (err, stdout, stderr) {
        if (err) {
            err.stderr = stderr;
            callback(err);
            return;
        }

        parseBootParams('/tmp/menu.lst', callback);
    });
}
