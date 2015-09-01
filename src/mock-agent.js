#!/usr/node/bin/node --abort_on_uncaught_exception

var bunyan = require('bunyan');
var canned_profiles = require('../lib/canned_profiles.json');
var child_process = require('child_process');
var dhcpclient = require('dhcpclient');
var execFile = require('child_process').execFile;
var fs = require('fs');
var path = require('path');
var restify = require('restify');
var sprintf = require('sprintf').sprintf;
var sys = require('sys');
var UrAgent = require('sdc-ur-agent').UrAgent;
var CnAgent = require('cn-agent/lib/app');
var CnAgentHttpServer = require('cn-agent/lib/server');
var libuuid = require('node-uuid');
var vasync = require('vasync');

var log = bunyan.createLogger({name: 'mock-ur-agent', level: 'debug'});
var mockCNs = {};
var mockCnAgents = {};
var agentServer;
var fileCache = {};
var server;
var state;
var CN_PROPERTIES;
var HTTP_LISTEN_IP = '0.0.0.0';
var HTTP_LISTEN_PORT = 31337;
var MOCKCN_DIR = '/mockcn';
var STATE_FILE = '/mockcn.json';

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

/*
 * XXX: TODO: These properties are ignored (they get set for you):
 *
 * 'Boot Parameters' // from CNAPI? or TFTP
 * 'Datacenter Name'
 * 'Setup'
 * 'Zpool*'
 *
 */

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


function instantiateMockCN(uuid) {
    var logname = 'mock-cn-agent' + '/' + uuid;
    var tasklog = '/var/log/' + logname + '/logs';
    log.info('starting instance for mock CN ' + uuid);
    mockCnAgents[uuid] = new CnAgent({
        uuid: uuid,
        log: log,
        tasklogdir: tasklog,
        logname: 'mocked-cn-agent',
        taskspath: path.join(
            __dirname, '..', 'node_modules/cn-agent/lib/tasks'),
        agentserver: agentServer
    });
    mockCnAgents[uuid].start();
    mockCNs[uuid] = new UrAgent({
        sysinfoFile: '/mockcn/' + uuid + '/sysinfo.json',
        setupStateFile: '/mockcn/' + uuid + '/setup.json',
        urStartupFilePath: '/tmp/' + uuid + '.tmp-' + genId(),
        mockCNServerUUID: uuid
    });
}


function monitorMockCNs() {

    function refreshMockCNs() {
        fs.readdir(MOCKCN_DIR, function (err, files) {
            fileCache = {};

            if (err && err.code === 'ENOENT') {
                log.debug('failed to read ' + MOCKCN_DIR + ': does not exist');
                return;
            } else if (err) {
                log.error('failed to refresh MockCNs: ' + err.message);
                return;
            }

            files.forEach(function (file) {
                var logname = 'mock-cn-agent' + '/' + file;
                var tasklog = '/var/log/' + logname + '/logs';

                // XXX HACK
                execFile('/usr/bin/mkdir', ['-p', tasklog], function (execErr) {
                    // XXX DO NOTHING
                });

                fileCache[file] = true;
                if (!mockCNs.hasOwnProperty(file)) {
                    instantiateMockCN(file);
                }
            });

            Object.keys(mockCNs).forEach(function (cn) {
                if (!fileCache.hasOwnProperty(cn)) {
                    // remove instance for this one
                    log.info('removing instance for mock CN ' + cn);
                    mockCNs[cn].shutdown();
                    delete mockCNs[cn];
                }
            });
        });
    }

    /*
     *    // Setup fs.watcher for this DIR to add and remove instances when
     *    fs.watch(MOCKCN_DIR, function () {
     *        // we don't care about *what* event just happened, just that one
     *        // did
     *        refreshMockCNs();
     *    })
     *
     */

    // call refreshMockCNs() to set the initial mock CNs
    refreshMockCNs();
}

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

function loadState(callback) {
    fs.readFile(STATE_FILE, function (error, data) {
        var json = {};

        if (error) {
            if (error.code === 'ENOENT') {
                state = {cn_indexes: {}};
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
                state = json;
                callback();
            } catch (e) {
                log.error(e, 'failed to parse JSON');
                callback(e);
            }
        }
    });
}

function saveState(callback) {
    fs.writeFile(
        STATE_FILE, JSON.stringify(state, null, 2) + '\n',
        function (err) {
            if (err) {
                callback(err);
                return;
            }
            callback();
        });
}

function addMAC(nic, mock_oui, cn_index, nic_index, callback) {
    var index_octets;
    index_octets = sprintf('%04x', cn_index).match(/.{2}/g);

    nic['MAC Address']
        = sprintf('%s:%s:%02x', mock_oui, index_octets.join(':'), nic_index);

    log.debug({nic: nic}, 'NIC');

    callback();
}

function applyDefaults(payload, callback) {
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
            cns = Object.keys(state.cn_indexes);
            cns.forEach(function (v) {
                if (state.cn_indexes[v].cn_index >= next_index) {
                    next_index++;
                }
            });

            cn_index = next_index;
            // reserve the index so we don't reuse this index
            state.cn_indexes[payload['UUID']] = {cn_index: cn_index};
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
}

function createMockServer(payload, callback) {
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
            applyDefaults(payload, function (err, data) {
                if (!err) {
                    mockserver = data;
                    log.debug({payload: server}, 'after applying defaults');
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
                            ? server['Disks'][d]['VID'] : 'HITACHI',
                    pid: mockserver['Disks'][d]['PID']
                            ? server['Disks'][d]['PID'] : 'HUC109060CSS600',
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

                cb(err);
            });
        }, function (cb) {
            // write out the global state file
            saveState(cb);
        }, function (cb) {
            uuid = payload['UUID'];

            instantiateMockCN(uuid);
            cb();
        }
    ], callback);
}

function getServers(req, res, next) {
    res.send(mockCNs);
    next();
}

function getServer(req, res, next) {
    var uuid = req.params.uuid;

    if (!uuid || !mockCNs[uuid]) {
        next(restify.ResourceNotFoundError('no such server'));
        return;
    }

    res.send(mockCNs[uuid]);
    next();
}

function deleteServer(req, res, next) {
    var uuid = req.params.uuid;

    if (!uuid || !mockCNs[uuid]) {
        next(restify.ResourceNotFoundError('no such server'));
        return;
    }

    // XXX need to actually delete

    res.send(204);
    next();
}

function createServer(req, res, next) {
    var payload = req.body;

    log.info({payload: payload, params: req.params}, 'PAYLOAD');

    if (!payload.UUID) {
        payload.UUID = libuuid.v4();
    }
    if (mockCNs[payload.UUID]) {
        next(restify.ConflictError('CN already exists'));
        return;
    }

    createMockServer(payload, function (err) {
        if (err) {
            next(err);
            return;
        }

        res.send(201);
        next();
    });
}

loadState(function (e) {
    if (e) {
        throw (e);
    }

    /* XXX this should change to just a startup load */
    monitorMockCNs();

    log.warn('got here');
    agentServer = new CnAgentHttpServer({
        bindip: '0.0.0.0',
        log: log
    });
    agentServer.start();

    function respond(req, res, next) {
      res.send('hello ' + req.params.name);
      next();
    }

    server = restify.createServer();
    server.use(restify.queryParser());
    server.use(restify.bodyParser());
    server.on('after', restify.auditLogger({ log: log }));

    server.get('/servers', getServers);
    server.get('/servers/:uuid', getServer);
    server.post('/servers', createServer);
    server.del('/servers/:uuid', deleteServer);

    server.listen(HTTP_LISTEN_PORT, HTTP_LISTEN_IP, function () {
        console.log('%s listening at %s', server.name, server.url);
    });
});
