#!/usr/node/bin/node
//--abort_on_uncaught_exception

var async = require('/usr/node/node_modules/async');
var bunyan = require('/usr/node/node_modules/bunyan');
var canned_profiles = require('../lib/canned_profiles.json');
var dhcpclient = require('dhcpclient');
var execFile = require('child_process').execFile;
var fs = require('fs');
var http = require('http');
var path = require('path');
var sprintf = require('/usr/node/node_modules/sprintf').sprintf;
var sys = require('sys');
var UrAgent = require('../ur-agent/ur-agent').UrAgent;

var log = bunyan.createLogger({name: 'mock-ur-agent', level: 'debug'});
var mockCNs = {};
var server;
var state;
var CN_PROPERTIES;
var HTTP_LISTEN_IP = '0.0.0.0';
var HTTP_LISTEN_PORT = 31337;
var MOCKCN_DIR = '/mockcn';
var STATE_FILE = '/mockcn.json';

CN_PROPERTIES = {
    "Boot Time": {validator: isInteger},
    "CPU Physical Cores": {validator: isInteger},
    "CPU Type": {validator: isSimpleString},
    "CPU Virtualization": {validator: isSimpleString},
    "CPU Total Cores": {validator: isInteger},
    "Disks": {validator: isValidDisksObj},
    "Hostname": {validator: isValidHostname},
    "HW Family": {optional: true, validator: isSimpleString},
    "HW Version": {optional: true, validator: isSimpleString},
    "Link Aggregations": {validator: isValidLinkAgg},
    "Live Image": {validator: isPlatformStamp},
    "Manufacturer": {validator: isSimpleString},
    "MiB of Memory": {validator: isInteger}, // XXX convert to string
    "Network Interfaces": {validator: isValidNetObj},
    "Product": {validator: isSimpleString},
    "SDC Version": {validator: isSDCVersion},
    "Serial Number": {validator: isSimpleString},
    "SKU Number": {validator: isSimpleString},
    "System Type": {validator: isSunOS},
    "UUID": {validator: isUUID},
    "Virtual Network Interfaces": {validator: isValidVirtNetObj},
    "VM Capable": {validator: isBoolean}
};

/*
 * XXX: TODO: These properties are ignored (they get set for you):
 *
 * "Boot Parameters" // from CNAPI? or TFTP
 * "Datacenter Name"
 * "Setup"
 * "Zpool*"
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
    // key = e1000g0, fields: 'MAC Address', 'ip4addr', 'Link Status', 'NIC Names'
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

// "borrowed" from VM.js
function isUUID(str) {
    var re = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
    if (str && str.length === 36 && str.match(re)) {
        return true;
    } else {
        return false;
    }
}

function getBootParams(mac, tftphost, callback) {
    var filename = 'menu.lst.01' + mac.replace(':', '').toUpperCase();

    execFile('/opt/local/bin/tftp',
        [tftphost, '-c', 'get ' + filename + ' /tmp/menu.lst'],
        function (err, stdout, stderr) {

        if (err) {
            callback(err);
            return;
        }

        fs.readFile('/tmp/menu.lst', function (error, data) {
            if (error) {
                callback(error);
            }

            data.split(/\n/).forEach(function (line) {
                log.debug('tftp line: ' + line);
            });

            callback(null, {});
        });
    });
}

function monitorMockCNs() {

    function refreshMockCNs () {
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
                fileCache[file] = true;
                if (!mockCNs.hasOwnProperty(file)) {
                    // create an instance for this one
                    log.info('starting instance for mock CN ' + file);
                    mockCNs[file] = new UrAgent({
                        sysinfoFile: '/mockcn/' + file + '/sysinfo.json',
                        setupStateFile: '/mockcn/' + file + '/setup.json',
                        urStartupFilePath: '/tmp/' + file + '.tmp-' + genId(),
                        mockCNServerUUID: file
                    });
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
    // Setup fs.watcher for this DIR to add and remove instances when
    fs.watch(MOCKCN_DIR, function () {
        // we don't care about *what* event just happened, just that one did
        refreshMockCNs();
    })
*/

    // call refreshMockCNs() to set the initial mock CNs
    refreshMockCNs();
}

function getTarget(url) {
    var urlParts = url.split('/');

    if (urlParts[0] !== '' || urlParts[1] !== 'servers'
        || urlParts.length > 3) {

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

function validateServer(uuid, cnobj) {
    var invalid = false;
    var validated = {};

    Object.keys(cnobj).forEach(function (key) {
        if (CN_PROPERTIES.hasOwnProperty(key)) {
            if (CN_PROPERTIES[key].validator(cnobj[key])) {
                validated[key] = cnobj[key];
            } else {
                invalid = true;
            }
        } else {
            log.info('Ignoring field ' + key);
        }
    });

    if (cnobj.hasOwnProperty('UUID') && cnobj.UUID !== uuid) {
        log.error('UUID in payload (' + cnobj.UUID + ') does not match target ('
            + uuid + ')');
        return false;
    }

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
                log.error(error, 'loadJsonConfig() failed to load ' + filename);
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
    fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n', function (err) {
        if (err) {
            callback(err);
            return;
        }
        callback();
    });
}

function addMAC(nic, mock_oui, cn_index, nic_index, callback) {
    var index_octets;
    index_octets = sprintf("%04x", cn_index).match(/.{2}/g);

    nic['MAC Address']
        = sprintf("%s:%s:%02x", mock_oui, index_octets.join(':'), nic_index);

    log.debug({nic: nic}, 'NIC');

    callback();
}

function applyDefaults(uuid, cnobj, callback) {
    var admin_nic;
    var cn_index;
    var mock_oui;
    var payload = cnobj;
    var tftpdhost;

    if (!payload.hasOwnProperty('UUID')) {
        payload.UUID = uuid;
    }

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

    async.series([
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
            var profile;
            var template;

            canned_profile_names = Object.keys(canned_profiles);
            profile = canned_profile_names[genRandomInt(0,
                (canned_profile_names.length - 1))];
            log.debug('chose profile ' + profile);
            template = canned_profiles[profile];

            Object.keys(template).forEach(function (key) {
                if (!payload.hasOwnProperty(key)) {
                    payload[key] = template[key];
                    log.debug('loading ' + key + ' = ' + template[key]);
                } else {
                    log.debug('already have ' + key);
                }
            });
            cb();
        }, function (cb) {
            var next_index = 0;
            var vms;

            // find index for this CN
            vms = Object.keys(state.cn_indexes);
            vms.forEach(function (v) {
                if (v.cn_index >= next_index) {
                    cn_index++;
                }
            });

            cn_index = next_index;
            cb();
        }, function (cb) {
            /*
             * Load the mock_oui, this should be unique for each mockcn VM
             * The generated UUIDs for servers will be:
             *
             *   mock_oui:<server_num>:<nic_num>
             *
             *
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

            async.forEach(nics, function (n, c) {
                var nic = payload['Network Interfaces'][n];
                addMAC(nic, mock_oui, cn_index, nic_index++, c);
                if (nic.hasOwnProperty('NIC Names')
                    && nic['NIC Names'].indexOf('admin') !== -1) {

                    admin_nic = nic;
                } else if (nic_index === 1 && !admin_nic) {
                    // default to first one in case we don't have specified one
                    admin_nic = nic;
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
            if (payload.hasOwnProperty('Hostname')) {
                cb();
                return;
            }

            payload['Hostname'] = admin_nic['MAC Address'].replace(/:/g, '-');
            cb();
        }, function (cb) {
            getBootParams(admin_nic['MAC Address'], tftpdhost, function (err, params) {
                if (!err) {
                    log.debug('boot params: ' + JSON.stringify(params, null, 2));
                }
                cb(err);
            });
        }

        // XXX TODO: randomize disk names (eg. c0t37E44117BC62A1E3d0)
    ], function (err) {
        if (err) {
            log.error({err: err}, 'failed!');
        }
        callback(err, payload);
    });
}

function createServer(uuid, cnobj, res) {
    var payload;
    var validated;

    log.debug({cnobj: cnobj}, 'creating ' + uuid + ' original payload');

    async.series([
        function (cb) {
            validated = validateServer(uuid, cnobj);
            if (!validated) {
                returnError(400, {}, res);
                cb(new Error('Validation failed'));
                return;
            }
            log.debug({cnobj: validated}, 'validated payload');
            cb();
        }, function (cb) {
            applyDefaults(uuid, validated, function (err, data) {
                if (!err) {
                    payload = data;
                    log.debug({cnobj: payload}, 'after applying defaults');
                }
                cb(err);
            });
        }, function (cb) {
            var uuid = payload['UUID'];

            // make directory
            fs.mkdir('/mockcn', 0755, function (e) {
                if (e && e.code !== 'EEXIST') {
                    log.error({err: e}, 'Error creating /mockcn');
                    cb(e);
                    return;
                }
                fs.mkdir('/mockcn/' + uuid, 0755, function (mkdir_uuid_e) {
                    if (mkdir_uuid_e) {
                        log.error({err: e}, 'Error creating /mockcn/' + uuid);
                        cb(mkdir_uuid_e);
                        return;
                    }

                    cb();
                });
            });
        }, function (cb) {
            var disks = [];
            var uuid = payload['UUID'];

            // write disks
            Object.keys(payload['Disks']).forEach(function (d) {
                var size = payload['Disks'][d]['Size in GB'];

                size = (size * 1000 * 1000 * 1000);
                disks.push({
                    type: 'SCSI',
                    name: d,
                    vid: payload['Disks'][d]['VID'] ? payload['Disks'][d]['VID'] : 'HITACHI',
                    pid: payload['Disks'][d]['PID'] ? payload['Disks'][d]['PID'] : 'HUC109060CSS600',
                    size: size,
                    removable: false,
                    solid_state: payload['Disks'][d]['SSD'] ? true : false
                });

                // Some properties only exist until we've written out the
                // disks.json and don't go to sysinfo, we remove those now
                delete payload['Disks'][d]['VID'];
                delete payload['Disks'][d]['PID'];
                delete payload['Disks'][d]['SSD'];
            });

            fs.writeFile('/mockcn/' + uuid + '/disks.json',
                JSON.stringify(disks, null, 2) + '\n', function (err) {

                cb(err);
            });
        }, function (cb) {
            // write sysinfo
            fs.writeFile('/mockcn/' + uuid + '/sysinfo.json',
                JSON.stringify(payload, null, 2) + '\n', function (err) {

                cb(err);
            });
        }, function (cb) {
            // write out the global state file
            saveState(cb);
        }, function (cb) {
            var uuid = payload['UUID'];

            // start this guy up
            mockCNs[uuid] = new UrAgent({
                sysinfoFile: '/mockcn/' + uuid + '/sysinfo.json',
                setupStateFile: '/mockcn/' + uuid + '/setup.json',
                urStartupFilePath: '/tmp/' + uuid + '.tmp-' + genId(),
                mockCNServerUUID: uuid
            });

            cb();
        }
    ], function (err) {
        if (err) {
            returnError(500, {}, res);
            return;
        }
        res.writeHead(201, {
            'Content-Type': 'application/json'
        });
        res.end(JSON.stringify(payload) + '\n');
    });
}

function dumpServers(res) {
    res.writeHead(200, {
        'Content-Type': 'application/json'
    });
    res.end(JSON.stringify([]) + '\n');
}

function dumpServer(uuid, res) {
    res.writeHead(200, {
        'Content-Type': 'application/json'
    });
    res.end(JSON.stringify({uuid: uuid}) + '\n');
}

function deleteServer(uuid, res) {
    log.debug('deleting ' + uuid);
    res.writeHead(200, {
        'Content-Type': 'application/json'
    });
    res.end();
}

/*
 * valid HTTP endpoints:
 *
 * GET /servers
 * GET /servers/:uuid
 * POST /servers/:uuid
 * DELETE /servers/:uuid
 *
 */
function handleHTTPRequest(request, res) {
    var urlParts;
    var target;

    if (request.headers.hasOwnProperty('content-type')
        && request.headers['content-type'] !== 'application/json') {

        returnError(400, request, res);
        return;
    }

    target = getTarget(request.url);
    log.info({
        method: request.method,
        target: request.url,
        remote: request.connection.remoteAddress
     }, 'handling request');

    if (target === null) {
        returnError(404, request, res);
        return;
    }

    if (request.method === 'GET') {
        if (target === 'all') {
            dumpServers(res);
            return;
        } else {
            dumpServer(target, res);
            return;
        }
    } else if (request.method === 'POST') {
        var data = '';

        if (target === 'all') {
            returnError(404, request, res);
            return;
        }

        request.on('data', function(chunk) {
            data += chunk;
        });

        request.on('end', function() {
            var cnobj;

            loadState(function (e) {
                if (e) {
                    returnError(500, request, res);
                    return;
                }
                if (data.length == 0) {
                    createServer(target, {}, res);
                } else {
                    try {
                        cnobj = JSON.parse(data);
                    } catch (e) {
                        log.error({err: e}, 'failed to parse POST input');
                        returnError(400, request, res);
                        return;
                    }
                    createServer(target, cnobj, res);
                }
            });
        });
        return;
    } else if (request.method === 'DELETE') {
        if (target === 'all') {
            returnError(404, request, res);
            return;
        }
        loadState(function (e) {
            if (e) {
                returnError(500, request, res);
                return;
            }
            deleteServer(target, res);
            return;
        });
    } else {
        returnError(404, request, res);
        return;
    }
}

/* XXX this should change to just a startup load */
monitorMockCNs();

/* start HTTP server for controlling mock CN instances */
server = http.createServer(handleHTTPRequest);
server.listen(HTTP_LISTEN_PORT, HTTP_LISTEN_IP);
log.info('Server running at http://' + HTTP_LISTEN_IP + ':'
    + HTTP_LISTEN_PORT + '/');

