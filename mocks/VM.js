/*
 * CDDL HEADER START
 *
 * The contents of this file are subject to the terms of the
 * Common Development and Distribution License, Version 1.0 only
 * (the "License").  You may not use this file except in compliance
 * with the License.
 *
 * You can obtain a copy of the license at http://smartos.org/CDDL
 *
 * See the License for the specific language governing permissions
 * and limitations under the License.
 *
 * When distributing Covered Code, include this CDDL HEADER in each
 * file.
 *
 * If applicable, add the following below this CDDL HEADER, with the
 * fields enclosed by brackets "[]" replaced with your own identifying
 * information: Portions Copyright [yyyy] [name of copyright owner]
 *
 * CDDL HEADER END
 *
 * Copyright (c) 2015, Joyent, Inc. All rights reserved.
 *
 * Experimental functions, expect these interfaces to be unstable and
 * potentially go away entirely:
 *
 * create_snapshot(uuid, snapname, options, callback)
 * delete_snapshot(uuid, snapname, options, callback)
 * install(uuid, callback)
 * receive(target, options, callback)
 * reprovision(uuid, payload, options, callback)
 * rollback_snapshot(uuid, snapname, options, callback)
 * send(uuid, where, options, callback)
 * getSysinfo(args, callback)
 * validate(brand, action, payload, callback)
 * waitForZoneState(payload, state, options, callback)
 *
 * Exported functions:
 *
 * console(uuid, callback)
 * create(properties, callback)
 * delete(uuid, callback)
 * flatten(vmobj, key)
 * info(uuid, types, callback)
 * load([zonename|uuid], callback)
 * lookup(match, callback)
 * reboot(uuid, options={[force=true]}, callback)
 * start(uuid, extra, callback)
 * stop(uuid, options={[force=true]}, callback)
 * sysrq(uuid, req=[nmi|screenshot], options={}, callback)
 * update(uuid, properties, callback)
 *
 * Exported variables:
 *
 * logname - you can set this to a string [a-zA-Z_] to use as log name
 * logger - you can set this to a node-bunyan log stream to capture the logs
 * INFO_TYPES - list of supported types for the info command
 * SYSRQ_TYPES - list of supported requests for sysrq
 *
 * IMPORTANT: Per OS-2427, this file is for the exlusive use of vmadmd and
 *            vmadm. If you are using this and you are not one of those two,
 *            please switch to calling vmadm instead.
 *
 */

// Ensure we're using the platform's node
require('/usr/node/node_modules/platform_node_version').assert();

var assert = require('assert');
var async = require('/usr/node/node_modules/async');
var bunyan = require('/usr/node/node_modules/bunyan');
var cp = require('child_process');
var dladm = require('/usr/vm/node_modules/dladm');
var lock = require('/usr/vm/node_modules/locker').lock;
var EventEmitter = require('events').EventEmitter;
var exec = cp.exec;
var execFile = cp.execFile;
var expat = require('/usr/node/node_modules/node-expat');
var fs = require('fs');
var fw = require('/usr/fw/lib/fw');
var fwlog = require('/usr/fw/lib/util/log');
var http = require('http');
var ipaddr = require('/usr/vm/node_modules/ip');
var libuuid = require('/usr/node/node_modules/uuid');
var mkdirp = require('/usr/vm/node_modules/mkdirp');
var net = require('net');
var OpenOnErrorLogger = require('./openonerrlogger');
var path = require('path');
var properties = require('./props');
var Qmp = require('/usr/vm/node_modules/qmp').Qmp;
var spawn = cp.spawn;
var sprintf = require('/usr/node/node_modules/sprintf').sprintf;
var tty = require('tty');
var util = require('util');
var utils = require('./utils');
var vmload = require('vmload');

// pull in stuff from generated props (originating in proptable.js)
var BRAND_OPTIONS = properties.BRAND_OPTIONS;
var PAYLOAD_PROPERTIES = properties.PAYLOAD_PROPERTIES;
var FLATTENABLE_ARRAYS = properties.FLATTENABLE_ARRAYS;
var FLATTENABLE_ARRAY_HASH_KEYS = properties.FLATTENABLE_ARRAY_HASH_KEYS;
var FLATTENABLE_HASH_KEYS = properties.FLATTENABLE_HASH_KEYS;
var KEEP_ZERO_PROPERTIES = properties.KEEP_ZERO_PROPERTIES;
var KVM_MEM_OVERHEAD = properties.KVM_MEM_OVERHEAD;
var UPDATABLE_DISK_PROPS = properties.UPDATABLE_DISK_PROPS;
var UPDATABLE_NIC_PROPS = properties.UPDATABLE_NIC_PROPS;

// re-export these
exports.FLATTENABLE_ARRAYS = FLATTENABLE_ARRAYS;
exports.FLATTENABLE_ARRAY_HASH_KEYS = FLATTENABLE_ARRAY_HASH_KEYS;
exports.FLATTENABLE_HASH_KEYS = FLATTENABLE_HASH_KEYS;
exports.KVM_MEM_OVERHEAD = KVM_MEM_OVERHEAD;

// global handle for the zoneevent watcher
var zoneevent;

/*
 * zone states from libzonecfg/common/zonecfg_impl.h
 *
 * #define ZONE_STATE_STR_CONFIGURED       "configured"
 * #define ZONE_STATE_STR_INCOMPLETE       "incomplete"
 * #define ZONE_STATE_STR_INSTALLED        "installed"
 * #define ZONE_STATE_STR_READY            "ready"
 * #define ZONE_STATE_STR_MOUNTED          "mounted"
 * #define ZONE_STATE_STR_RUNNING          "running"
 * #define ZONE_STATE_STR_SHUTTING_DOWN    "shutting_down"
 * #define ZONE_STATE_STR_DOWN             "down"
 *
 */

var DEFAULT_MAX_MSG_IDS = 4096;
var DEFAULT_MAX_SEM_IDS = 4096;
var DEFAULT_MAX_SHM_IDS = 4096;
var DEFAULT_MDATA_TIMEOUT = 300;
var DISABLED = 0;
var MAX_HOSTVOL_FILE_BYTES = (10 * 1024 * 1024);
var MAX_SNAPNAME_LENGTH = 64;
var MINIMUM_MAX_SWAP = 256;
var PROVISION_TIMEOUT = 300;
var STOP_TIMEOUT = 60;
var VM = this;

VM.log = null;
VM.fw_log = null;

// can be (re)set by loader before we start.
exports.logger = null;
exports.loglevel = 'debug';

// Avoid typing utils.xxx every time
var addString = utils.addString;
var assertSafeZonePath = utils.assertSafeZonePath;
var fixBoolean = utils.fixBoolean;
var fixBooleanLoose = utils.fixBooleanLoose;
var generateMAC = utils.generateMAC;
var isCIDR = utils.isCIDR;
var isPrivateIP = utils.isPrivateIP;
var isUUID = utils.isUUID;
var ltrim = utils.ltrim;
var rtrim = utils.rtrim;
var trim = utils.trim;
var vrrpMAC = utils.vrrpMAC;

// For keeping track of used trace names
var trace_seen_names = {};

function assertMockCnUuid()
{
    assert(process.env.MOCKCN_SERVER_UUID, 'missing MOCKCN_SERVER_UUID');
}


// This function should be called by any exported function from this module.
// It ensures that a logger is setup. If side_effects is true, we'll start
// writing log messages to the file right away. If not, we'll only start
// logging after we hit a message error or higher. This is intended such that
// things that are expected to change the state or modify VMs on the system:
// eg. create, start, stop, delete should have this set true.  It should be
// set false when the action should not cause changes to the system:
// eg.: load, lookup, info, console, &c.
function ensureLogging(side_effects)
{
    side_effects = !!side_effects; // make it boolean (undef === false)

    var filename;
    var logname;
    var req_id;
    var streams = [];

    if (VM.log) {
        // We're already logging, don't break things.
        return;
    }

    function start_logging() {
        VM.log = OpenOnErrorLogger.createLogger({
            additional_streams: streams,
            filename: filename,
            immediate: side_effects,
            logname: logname,
            req_id: req_id
        });
    }

    if (process.env.REQ_ID) {
        req_id = process.env.REQ_ID;
    } else if (process.env.req_id) {
        req_id = process.env.req_id;
    } else {
        req_id = libuuid.create();
    }

    if (VM.hasOwnProperty('logname')) {
        logname = VM.logname.replace(/[^a-zA-Z\_]/g, '');
    }
    if (!logname || logname.length < 1) {
        logname = 'VM';
    }

    if (VM.hasOwnProperty('logger') && VM.logger) {
        // Use concat, in case someone's sneaky and makes more than one logger.
        // We don't officially support that yet though.
        streams = streams.concat(VM.logger);
    }

    // For debugging we allow VMADM_DEBUG_LEVEL to be set to a bunyan log level
    // which will send output to STDERR. You can additionally set
    // VMADM_DEBUG_FILE to write to a file instead.
    if (process.env.VMADM_DEBUG_LEVEL) {
        if (process.env.VMADM_DEBUG_FILE) {
            streams.push({
                path: process.env.VMADM_DEBUG_FILE,
                level: process.env.VMADM_DEBUG_LEVEL
            });
        } else {
            streams.push({
                stream: process.stderr,
                level: process.env.VMADM_DEBUG_LEVEL
            });
        }
    }

    try {
        if (!fs.existsSync('/var/log/vm')) {
            fs.mkdirSync('/var/log/vm');
        }
        if (!fs.existsSync('/var/log/vm/logs')) {
            fs.mkdirSync('/var/log/vm/logs');
        }
    } catch (e) {
        // We can't ever log to a file in /var/log/vm/logs if we can't create
        // it, so we just log to ring buffer (above).
        start_logging();
        return;
    }

    filename = '/var/log/vm/logs/' + Date.now(0) + '-'
        + sprintf('%06d', process.pid) + '-' + process.env.MOCKCN_SERVER_UUID
        + '-' + logname + '.log';

    start_logging();
}

exports.DISK_MODELS = [
    'virtio',
    'ide',
    'scsi'
];

exports.VGA_TYPES = [
    'cirrus',
    'std',
    'vmware',
    'qxl',
    'xenfb'
];

exports.INFO_TYPES = [
    'all',
    'block',
    'blockstats',
    'chardev',
    'cpus',
    'kvm',
    'pci',
    'spice',
    'status',
    'version',
    'vnc'
];

exports.SYSRQ_TYPES = [
    'nmi',
    'screenshot'
];

exports.COMPRESSION_TYPES = [
    'on',
    'off',
    'gzip',
    'gzip-1',
    'gzip-2',
    'gzip-3',
    'gzip-4',
    'gzip-5',
    'gzip-6',
    'gzip-7',
    'gzip-8',
    'gzip-9',
    'lz4',
    'lzjb',
    'zle'
];

var VIRTIO_TXTIMER_DEFAULT = 200000;
var VIRTIO_TXBURST_DEFAULT = 128;

function traceAddStack(evtname, log)
{
    var new_stack;
    var stack;

    if (log.fields.stack) {
        stack = log.fields.stack;
    } else if (log.fields.name) {
        stack = path.basename(log.fields.name);
    } else {
        stack = '';
    }

    if (stack.length > 0) {
        new_stack = stack + '.' + evtname;
    } else {
        new_stack = evtname;
    }

    log = log.child({stack: new_stack});
    return (log);
}

function traceUniqueName(evtname)
{
    var candidate;
    var idx = 0;

    candidate = evtname;

    while (trace_seen_names[candidate]) {
        candidate = evtname + '-' + (idx++).toString();
    }

    trace_seen_names[candidate] = true;
    return (candidate);
}

function traceExec(cmd, log, evtname, cb)
{
    if (!process.env.EXPERIMENTAL_VMJS_TRACING) {
        log.debug({cmd: cmd}, 'exec');
        exec(cmd, cb);
        return;
    }

    evtname = traceUniqueName(evtname);
    log = traceAddStack(evtname, log);

    log.info({
        evt: {name: evtname, ph: 'b'},
        cmd: cmd
    }, 'executing command');

    exec(cmd, function (e, out, err) {
        var code = 0;
        if (e) {
            if (e.code) {
                code = e.code;
            } else {
                code = -1;
            }
        }
        log.info({
            evt: {name: evtname, ph: 'e', result: code},
            cmd: cmd
        }, 'executed command');
        cb(e, out, err);
    });
}

function traceExecFile(cmd, args, opts, log, evtname, cb)
{
    if (arguments.length === 5) {
        cb = evtname;
        evtname = log;
        log = opts;
        opts = {};
    }

    if (!process.env.EXPERIMENTAL_VMJS_TRACING) {
        log.debug({cmd: cmd, args: args, opts: opts}, 'execFile');
        execFile(cmd, args, opts, cb);
        return;
    }

    evtname = traceUniqueName(evtname);
    log = traceAddStack(evtname, log);

    log.info({
        args: args,
        cmd: cmd,
        evt: {name: evtname, ph: 'b'},
        opts: opts
    }, 'executing command');

    execFile(cmd, args, opts, function (e, out, err) {
        var code = 0;
        if (e) {
            if (e.code) {
                code = e.code;
            } else {
                code = -1;
            }
        }
        log.info({
            args: args,
            cmd: cmd,
            evt: {name: evtname, ph: 'e', result: code},
            opts: opts
        }, 'executed command');
        cb(e, out, err);
    });
}

/*
 * Use like:
 *
 * tracers_obj = traceUntilCallback('hello', log, callback);
 * callback = tracers_obj.callback;
 * log = tracers_obj.log;
 *
 * which will immediately call log.begin('hello'). Then whenever you call
 * callback (instead of original callback())... we do log.end() with a result
 * code of:
 *
 *  * 0     if arguments[0] to callback is not an Error object
 *  * -1    if arguments[0] is an Error but does not contain a .code
 *  * .code if arguments[0] is an Error and has a .code property
 *
 */
function traceUntilCallback(key, log, callback)
{
    var args = {};
    var evtname;

    if (typeof (key) !== 'string') {
        key = key.name;
        if (key.args) {
            args = key.args;
        }
    }

    evtname = traceUniqueName(key);
    log = traceAddStack(evtname, log);

    log.info({evt: {args: args, ph: 'b', name: evtname}});

    return ({
        log: log,
        callback: function _callback(err) {
            if (err instanceof Error) {
                if (err.code) {
                    args.result = err.code;
                } else {
                    args.result = -1;
                }
            } else {
                args.result = 0;
            }

            log.info({evt: {args: args, ph: 'e', name: evtname}});
            callback.apply(null, arguments);
        }
    });
}

function getZpools(log, callback)
{
    var args = ['list', '-H', '-p', '-o', 'name'];
    var cmd = '/usr/sbin/zpool';
    var idx;
    var raw = [];
    var zpools = [];

    assert(log, 'no logger passed to getZpools()');

    traceExecFile(cmd, args, log, 'zpool-list',
        function (error, stdout, stderr) {

        if (error) {
            log.error('Unable to get list of zpools');
            callback(error, {'stdout': stdout, 'stderr': stderr});
        } else {
            // strip out any empty values (last one).
            raw = stdout.split('\n');
            for (idx in raw) {
                if (raw[idx].length > 0) {
                    zpools.push(raw[idx]);
                }
            }
            callback(null, zpools);
        }
    });
}

function validateProperty(brand, prop, value, action, data, errors, log)
{
    var allowed;
    var k;

    assert(log, 'no logger passed to validateProperty()');

    if (!data.hasOwnProperty('zpools')) {
        data.zpools = [];
    }

    assert(BRAND_OPTIONS.hasOwnProperty(brand), 'unsupported brand: ' + brand);

    if (BRAND_OPTIONS[brand].hasOwnProperty('allowed_properties')) {
        allowed = BRAND_OPTIONS[brand].allowed_properties;
    } else {
        allowed = {};
    }

    if (!errors.hasOwnProperty('bad_values')) {
        errors.bad_values = [];
    }
    if (!errors.hasOwnProperty('bad_properties')) {
        errors.bad_properties = [];
    }

    if (!allowed.hasOwnProperty(prop)) {
        // thie BRAND_OPTIONS doesn't have this property at all
        if (errors.bad_properties.indexOf(prop) === -1) {
            log.debug('bad property ' + prop + ' because: missing from '
                + 'allowed_properties');
            errors.bad_properties.push(prop);
        }
    } else if (!Array.isArray(allowed[prop])
        || allowed[prop].indexOf(action) === -1) {

        // here we've ether got no actions allowed for this value,
        // or just not this one
        if (errors.bad_properties.indexOf(prop) === -1) {
            log.debug('bad property ' + prop + ' because: missing from: '
                + 'allowed[' + action + ']');
            errors.bad_properties.push(prop);
        }
    }

    if (PAYLOAD_PROPERTIES.hasOwnProperty(prop)) {
        switch (PAYLOAD_PROPERTIES[prop].pr_type) {
        case 'uuid':
            if (typeof (value) === 'string' && !isUUID(value)
                && errors.bad_values.indexOf(prop) === -1) {

                errors.bad_values.push(prop);
            }
            break;
        case 'boolean':
            if (value === 1 || value === '1') {
                log.warn('DEPRECATED: payload uses 1 instead of '
                    + 'true for ' + prop + ', use "true" instead.');
            } else if (typeof (fixBoolean(value)) !== 'boolean'
                && errors.bad_values.indexOf(prop) === -1) {

                errors.bad_values.push(prop);
            }
            break;
        case 'string':
            if (value === undefined || value === null
                || trim(value.toString()) === '') {
                // if set empty/false we'll keep since this is used to unset
                break;
            } else if (typeof (value) !== 'string'
                && errors.bad_values.indexOf(prop) === -1) {

                errors.bad_values.push(prop);
            }
            break;
        case 'integer':
            var nval;

            if (value === undefined || value === null
                || trim(value.toString()) === '') {
                // if set empty/false we'll keep since this is used to unset
                break;
            }

            if (value === true || value === false) {
                errors.bad_values.push(prop);
                break;
            }

            if (typeof (value) !== 'number') {
                nval = Number(value);
            } else {
                nval = value;
            }

            if (isNaN(nval) || Math.floor(nval) !== nval) {
                errors.bad_values.push(prop);
                break;
            }

            if (PAYLOAD_PROPERTIES[prop].hasOwnProperty('pr_min')) {
                if (nval < PAYLOAD_PROPERTIES[prop].pr_min) {
                    errors.bad_values.push(prop);
                    break;
                }
            }

            if (PAYLOAD_PROPERTIES[prop].hasOwnProperty('pr_max')) {
                if (nval > PAYLOAD_PROPERTIES[prop].pr_max) {
                    errors.bad_values.push(prop);
                    break;
                }
            }
            break;
        case 'zpool':
            if ((typeof (value) !== 'string'
                || data.zpools.indexOf(value) === -1)
                && errors.bad_values.indexOf(prop) === -1) {

                errors.bad_values.push(prop);
            }
            break;
        case 'object':
            if (typeof (value) !== 'object'
                && errors.bad_values.indexOf(prop) === -1) {

                errors.bad_values.push(prop);
            }
            break;
        case 'flat-object':
            if (typeof (value) !== 'object'
                && errors.bad_values.indexOf(prop) === -1) {

                errors.bad_values.push(prop);
            }
            for (k in value) {
                if (typeof (value[k]) !== 'string'
                    && typeof (value[k]) !== 'number'
                    && typeof (value[k]) !== 'boolean') {

                    if (errors.bad_values.indexOf(prop) === -1) {
                        errors.bad_values.push(prop);
                    }
                    break;
                }
            }
            break;
        case 'list':
            if (Array.isArray(value)) {
                for (k in value) {
                    if (typeof (value[k]) !== 'string'
                        && typeof (value[k]) !== 'number') {

                        // TODO: log something more useful here telling them
                        // the type is invalid.
                        if (errors.bad_values.indexOf(prop) === -1) {
                            errors.bad_values.push(prop);
                        }
                        break;
                    }

                    // if a validator was defined, pass value through that
                    if (PAYLOAD_PROPERTIES[prop]
                        .hasOwnProperty('pr_valueValidator')) {

                        if (!PAYLOAD_PROPERTIES[prop]
                            .pr_valueValidator(value[k])) {

                            if (errors.bad_values.indexOf(prop) === -1) {
                                errors.bad_values.push(prop);
                            }
                            break;
                        }
                    }

                    // if this is an array, it can't have commas in the
                    // values. (since we might stringify the list and
                    // we'd end up with something different.
                    if (value[k].toString().indexOf(',') !== -1
                        && errors.bad_values.indexOf(prop) === -1) {

                        errors.bad_values.push(prop);
                    }
                }
            } else {
                // not a valid type
                if (errors.bad_values.indexOf(prop) === -1) {
                    errors.bad_values.push(prop);
                }
            }
            break;
        case 'object-array':
            if (!Array.isArray(value)) {
                if (errors.bad_values.indexOf(prop) === -1) {
                    errors.bad_values.push(prop);
                }
                break;
            }
            for (k in value) {
                if (typeof (value[k]) !== 'object') {
                    if (errors.bad_values.indexOf(prop) === -1) {
                        errors.bad_values.push(prop);
                    }
                    break;
                }
            }
            break;
        default:
            // don't know what type of prop this is, so it's invalid
            if (errors.bad_properties.indexOf(prop) === -1) {
                log.debug('bad property ' + prop + ' because: type is '
                    + PAYLOAD_PROPERTIES[prop].pr_type);
                errors.bad_properties.push(prop);
            }
            break;
        }
    }
}

/*
 * image properties:
 *
 *  size (optional, only used by zvols)
 *  type ('zvol' or 'zone-dataset')
 *  uuid
 *  zpool
 *
 */
function validateImage(image, log, callback)
{
    var args;
    var cmd = '/usr/sbin/imgadm';

    args = ['get', '-P', image.zpool, image.uuid];

    // on any error we fail closed (assume the image does not exist)
    traceExecFile(cmd, args, log, 'imgadm-get',
        function (error, stdout, stderr) {

        var data;
        var e;

        if (error) {
            error.stdout = stdout;
            error.stderr = stderr;
            error.whatFailed = 'EEXECFILE';
            log.error(error);
            callback(error);
            return;
        }

        try {
            data = JSON.parse(stdout.toString());
        } catch (err) {
            data = {};
        }

        if (data.hasOwnProperty('manifest')) {
            if (image.types.indexOf(data.manifest.type) === -1) {
                // image is wrong type
                e = new Error('image ' + image.uuid + ' is type '
                    + data.manifest.type + ', must be one of: '
                    + JSON.stringify(image.types));
                e.whatFailed = 'EBADTYPE';
                log.error(e);
                callback(e);
                return;
            }
            log.info('image ' + image.uuid + ' found in imgadm');

            // If image_size is missing, add it. If it's wrong, error.
            if (data.manifest.hasOwnProperty('image_size')) {
                if (image.hasOwnProperty('size')) {
                    if (image.size !== data.manifest.image_size) {
                        e = new Error('incorrect image_size value for image'
                            + ' ' + image.uuid + ' passed: '
                            + image.size + ' should be: '
                            + data.manifest.image_size);
                        e.whatFailed = 'EBADSIZE';
                        log.error(e);
                        callback(e);
                        return;
                    }
                } else {
                    // image doesn't have size, manifest does, add it.
                    image.size = data.manifest.image_size;
                }
            }
            // everything ok
            callback();
        } else {
            e = new Error('cannot find \'manifest\' for image '
                + image.uuid);
            e.whatFailed = 'ENOENT';
            log.error(e);
            callback(e);
            return;
        }
    });
}

// Ensure if image_uuid is passed either at top level or for disks.*.image_uuid
// that image_uuid exists on the system according to imgadm.
//
// NOTE: if image_size is missing from payload, but found in imgadm it is added
// to the payload here.
//
function validateImages(payload, brand, errors, log, callback)
{
    var check_images = [];
    var disk_idx;
    var pool;
    var tracers_obj;
    var zoneroot_types = ['zone-dataset'];

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('validate-images', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    if (BRAND_OPTIONS[brand].features.zoneroot_image_types) {
        zoneroot_types = BRAND_OPTIONS[brand].features.zoneroot_image_types;
    }

    if (payload.hasOwnProperty('image_uuid') && isUUID(payload.image_uuid)) {
        if (payload.hasOwnProperty('zpool')) {
            pool = payload.zpool;
        } else {
            pool = 'zones';
        }

        check_images.push({
            'property': 'image_uuid',
            'target': payload,
            'types': zoneroot_types,
            'uuid': payload.image_uuid,
            'zpool': pool
        });
    }

    ['disks', 'add_disks'].forEach(function (d) {
        if (payload.hasOwnProperty(d)) {
            disk_idx = 0;
            payload[d].forEach(function (disk) {
                if (disk.hasOwnProperty('image_uuid')) {
                    if (disk.hasOwnProperty('zpool')) {
                        pool = disk.zpool;
                    } else {
                        pool = 'zones';
                    }
                    check_images.push({
                        'property_prefix': d + '.' + disk_idx,
                        'property': d + '.' + disk_idx + '.image_uuid',
                        'target': disk,
                        'types': ['zvol'],
                        'uuid': disk.image_uuid,
                        'zpool': pool
                    });
                }
                disk_idx++;
            });
        }
    });

    async.forEachSeries(check_images, function (image, cb) {

        var i;
        var idx;

        i = {
            uuid: image.uuid,
            types: image.types,
            zpool: image.zpool
        };

        if (image.target.hasOwnProperty('image_size')) {
            i.size = image.target.image_size;
        }

        validateImage(i, log, function (err) {
            if (err) {
                switch (err.whatFailed) {
                    case 'EBADSIZE':
                        // image.size is wrong (vs. manifest)
                        errors.bad_values.push(image.property_prefix
                            + '.image_size');
                        break;
                    case 'ENOENT':
                        // image.uuid not found in imgadm
                        errors.bad_values.push(image.property);
                        break;
                    case 'EBADTYPE':
                        // image.type is wrong
                        errors.bad_values.push(image.property);
                        break;
                    default:
                        // unknown error, fail closed
                        errors.bad_values.push(image.property);
                        break;
                }
            } else {
                // no errors, so check if size was added
                if (i.hasOwnProperty('size')) {
                    if (!image.target.hasOwnProperty('image_size')) {
                        image.target.image_size = i.size;
                        // Remove error that would have been added earlier
                        // when we didn't have image_size
                        idx = errors.missing_properties.indexOf(
                            image.property_prefix + '.image_size');
                        if (idx !== -1) {
                            errors.missing_properties.splice(idx, 1);
                        }
                    }
                }
            }

            cb();
        });
    }, function () {
        callback();
    });
}

// This is for allowed_ips which accepts IPv4 and IPv6 addresses or CIDR
// addresses in the form IP/MASK where MASK is 1-32 for IPv4 and 1-128 for
// IPv6.
function validateIPlist(list) {
    var invalid = [];

    list.forEach(function (ip) {
        var matches;

        if (net.isIPv4(ip) || net.isIPv6(ip)) {
            return;
        }

        matches = ip.split('/');
        if (matches.length !== 2) {
            invalid.push(ip);
            return;
        }

        if (net.isIPv4(matches[0])) {
            if (Number(matches[1]) > 32 || (Number(matches[1])) < 1) {
                invalid.push(ip);
            }
        } else if (net.isIPv6(matches[0])) {
            if (Number(matches[1]) > 128 || (Number(matches[1])) < 1) {
                invalid.push(ip);
            }
        } else {
            invalid.push(ip);
        }


    });

    if (invalid.length !== 0) {
        throw new Error('invalid allowed_ips: ' + invalid.join(', '));
    }

    if (list.length > 13) {
        throw new Error('Maximum of 13 allowed_ips per nic');
    }
}

exports.validate = function (brand, action, payload, options, callback)
{
    var errors = {
        'bad_values': [],
        'bad_properties': [],
        'missing_properties': []
    };
    var log;
    var prop;
    var tracers_obj;

    assertMockCnUuid();
    throw new Error('UNIMPLEMENTED: validate');

    // options is optional
    if (arguments.length === 4) {
        callback = arguments[3];
        options = {};
    }

    ensureLogging(false);
    if (options.hasOwnProperty('log')) {
        log = options.log;
    } else {
        log = VM.log.child({action: 'validate'});
    }

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('validate', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    if (!BRAND_OPTIONS.hasOwnProperty(brand)) {
        if (!brand) {
            brand = 'undefined';
        }
        callback({'bad_brand': brand});
        return;
    }

    // wrap the whole thing with getZpools so we have the list of pools if we
    // need them.
    getZpools(log, function (err, zpools) {
        var disk_idx;
        var idx;
        var prefix;
        var required;
        var subprop;
        var subprop_action = '';
        var value;

        if (err) {
            /*
             * this only happens when the zpool command fails which should be
             * very rare, but when it does happen, we continue with an empty
             * zpool list in case they don't need to validate zpools. If they
             * do, every zpool will be invalid which is also what we want since
             * nothing else that uses zpools is likely to work either.
             *
             */
            zpools = [];
        }

        // loop through and weed out ones we don't allow for this action.
        for (prop in payload) {
            validateProperty(brand, prop, payload[prop], action,
                {zpools: zpools}, errors, log);

            // special case for complex properties where we want to check
            // foo.*.whatever
            if (PAYLOAD_PROPERTIES.hasOwnProperty(prop)
                && PAYLOAD_PROPERTIES[prop].pr_type === 'object-array'
                && Array.isArray(payload[prop])) {

                if (PAYLOAD_PROPERTIES[prop].hasOwnProperty('pr_check_as')) {
                    prefix = PAYLOAD_PROPERTIES[prop].pr_check_as + '.*.';
                    if (prop.match(/^add_/)) {
                        subprop_action = 'add';
                    } else if (prop.match(/^update_/)) {
                        subprop_action = 'update';
                    }
                } else {
                    // here we've got something like 'disks' which is an add
                    prefix = prop + '.*.';
                    subprop_action = 'add';
                }

                for (idx in payload[prop]) {
                    if (typeof (payload[prop][idx]) === 'object') {
                        // subprop will be something like 'nic_tag'
                        for (subprop in payload[prop][idx]) {
                            value = payload[prop][idx][subprop];
                            validateProperty(brand, prefix + subprop, value,
                                subprop_action, {zpools: zpools}, errors, log);
                        }
                    } else if (errors.bad_values.indexOf(prop) === -1) {
                        // this is not an object so bad value in the array
                        errors.bad_values.push(prop);
                    }
                }
            }
        }

        // special case: if you have disks you must specify either image_uuid
        // and image_size *or* size and block_size is only allowed when you use
        // 'size' and image_name when you don't.
        if (BRAND_OPTIONS[brand].hasOwnProperty('allowed_properties')
            && BRAND_OPTIONS[brand].allowed_properties
            .hasOwnProperty('disks')) {

            function validateDiskSource(prop_prefix, disk) {

                if (disk.hasOwnProperty('media') && disk.media !== 'disk') {
                    // we only care about disks here, not cdroms.
                    return;
                }

                if (disk.hasOwnProperty('image_uuid')) {
                    // with image_uuid, size is invalid and image_size is
                    // required, additionally block_size is not allowed.

                    if (!disk.hasOwnProperty('image_size')) {
                        errors.missing_properties.push(prop_prefix
                            + '.image_size');
                    }
                    if (disk.hasOwnProperty('size')) {
                        errors.bad_properties.push(prop_prefix + '.size');
                    }
                    if (disk.hasOwnProperty('block_size')) {
                        errors.bad_properties.push(prop_prefix
                            + '.block_size');
                    }
                } else {
                    // without image_uuid, image_size and image_name are invalid
                    // and 'size' is required.

                    if (!disk.hasOwnProperty('size')) {
                        errors.missing_properties.push(prop_prefix + '.size');
                    }
                    if (disk.hasOwnProperty('image_name')) {
                        errors.bad_properties.push(prop_prefix + '.image_name');
                    }
                    if (disk.hasOwnProperty('image_size')) {
                        errors.bad_properties.push(prop_prefix + '.image_size');
                    }
                }
            }

            if (payload.hasOwnProperty('disks')) {
                for (disk_idx in payload.disks) {
                    validateDiskSource('disks.' + disk_idx,
                        payload.disks[disk_idx]);
                }
            }
            if (payload.hasOwnProperty('add_disks')) {
                for (disk_idx in payload.add_disks) {
                    validateDiskSource('add_disks.' + disk_idx,
                        payload.add_disks[disk_idx]);
                }
            }
        }

        if (BRAND_OPTIONS[brand].hasOwnProperty('required_properties')) {
            required = BRAND_OPTIONS[brand].required_properties;
            for (prop in required) {
                if (required[prop].indexOf(action) !== -1
                    && !payload.hasOwnProperty(prop)) {

                    errors.missing_properties.push(prop);
                }
            }
        }

        // make sure any images in the payload are also valid
        // NOTE: if validateImages() finds errors, it adds to 'errors' here.
        validateImages(payload, brand, errors, log, function () {

            // we validate disks.*.refreservation here because image_size might
            // not be populated yet until we return from validateImages()
            ['disks', 'add_disks'].forEach(function (d) {
                var d_idx = 0;
                if (payload.hasOwnProperty(d)) {
                    payload[d].forEach(function (disk) {
                        if (disk.hasOwnProperty('refreservation')) {
                            if (disk.refreservation < 0) {
                                errors.bad_values.push(d + '.' + d_idx
                                    + '.refreservation');
                            } else if (disk.size
                                && disk.refreservation > disk.size) {

                                errors.bad_values.push(d + '.' + d_idx
                                    + '.refreservation');
                            } else if (disk.image_size
                                && disk.refreservation > disk.image_size) {

                                errors.bad_values.push(d + '.' + d_idx
                                    + '.refreservation');
                            }
                        }
                        d_idx++;
                    });
                }
            });

            if (errors.bad_properties.length > 0 || errors.bad_values.length > 0
                || errors.missing_properties.length > 0) {

                callback(errors);
                return;
            }

            callback();
        });
    });
};

function setQuota(dataset, quota, log, callback)
{
    var newval;

    assert(log, 'no logger passed to setQuota()');

    if (!dataset) {
        callback(new Error('Invalid dataset: "' + dataset + '"'));
        return;
    }

    if (quota === 0 || quota === '0') {
        newval = 'none';
    } else {
        newval = quota.toString() + 'g';
    }

    zfs(['set', 'quota=' + newval, dataset], log, function (err, fds) {
        if (err) {
            log.error('setQuota() cmd failed: ' + fds.stderr);
            callback(new Error(rtrim(fds.stderr)));
        } else {
            callback();
        }
    });
}

exports.flatten = function (vmobj, key)
{
    var index;
    var tokens = key.split('.');

    assertMockCnUuid();

    // NOTE: VM.flatten() currently doesn't produce any logs

    if (tokens.length === 3
        && VM.FLATTENABLE_ARRAY_HASH_KEYS.indexOf(tokens[0]) !== -1) {

        if (!vmobj.hasOwnProperty(tokens[0])) {
            return undefined;
        }
        if (!vmobj[tokens[0]].hasOwnProperty(tokens[1])) {
            return undefined;
        }
        return vmobj[tokens[0]][tokens[1]][tokens[2]];
    }

    if (tokens.length === 2
        && VM.FLATTENABLE_HASH_KEYS.indexOf(tokens[0]) !== -1) {

        if (!vmobj.hasOwnProperty(tokens[0])) {
            return undefined;
        }
        return vmobj[tokens[0]][tokens[1]];
    }

    if (tokens.length === 2
        && VM.FLATTENABLE_ARRAYS.indexOf(tokens[0]) !== -1) {

        index = Number(tokens[1]);

        if (!vmobj.hasOwnProperty(tokens[0])) {
            return undefined;
        }

        if (index === NaN || index < 0
            || !vmobj[tokens[0]].hasOwnProperty(index)) {

            return undefined;
        }
        return vmobj[tokens[0]][index];
    }

    return vmobj[key];
};

exports.load = function (uuid, options, callback)
{
    var log;
    var load_opts = {};
    var tracers_obj;

    // This is a wrapper so that other internal functions here (such as lookup)
    // can do smart things like check the quota for each VM with a separate call
    // to zfs get.
    
    assertMockCnUuid();

    // options is optional
    if (arguments.length === 2) {
        callback = arguments[1];
        options = {};
    }

    ensureLogging(false);
    if (options.hasOwnProperty('log')) {
        log = options.log;
    } else {
        log = VM.log.child({action: 'load', vm: uuid});
    }

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('load', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    load_opts.log = log;
    if (options.hasOwnProperty('fields')) {
        load_opts.fields = options.fields;
    }

    vmload.getVmobj(uuid, load_opts, function (err, vmobj) {
        if (err) {
            callback(err);
            return;
        }
        callback(null, vmobj);
    });
};

function fixMac(str)
{
    var fixed = [];
    var octet;
    var octets = str.split(':');

    for (octet in octets) {
        if (octets.hasOwnProperty(octet)) {
            octet = parseInt(octets[octet], 16);
            if (octet === 'nan') {
                octet = 0;
            }
            fixed.push(sprintf('%02x', octet));
        }
    }

    return fixed.join(':');
}

// zonecfg requires removing leading 0's in MACs like 01:02:03:04:05:06
// This function takes a MAC in normal form and puts it in the goofy form
// zonecfg wants.
function ruinMac(mac)
{
    var part;
    var parts;
    var out = [];

    parts = mac.split(':');

    for (part in parts) {
        part = ltrim(parts[part], '0');
        if (part.length === 0) {
            part = '0';
        }
        out.push(part);
    }

    return (out.join(':'));
}

function matcher(zone, search)
{
    var fields;
    var found;
    var i;
    var key;
    var parameters_matched = 0;
    var regex;
    var target;

    function find_match(k, targ) {
        var value = VM.flatten(zone, k);

        if (!regex && k.match(/^nics\..*\.mac$/)) {
            // Fix for broken SmartOS MAC format
            targ = fixMac(targ);
        }

        if (regex && (value !== undefined) && value.toString().match(targ)) {
            found = true;
        } else if ((value !== undefined)
            && value.toString() === targ.toString()) {
            found = true;
        }
    }

    for (key in search) {
        found = false;
        regex = false;

        target = search[key];
        if (target[0] === '~') {
            regex = true;
            target = new RegExp(target.substr(1), 'i');
        }

        fields = key.split('.');
        if (fields.length === 3 && fields[1] === '*'
            && zone.hasOwnProperty(fields[0])
            && VM.FLATTENABLE_ARRAY_HASH_KEYS.indexOf(fields[0]) !== -1) {

            // Special case: for eg. nics.*.ip, we want to loop through all nics
            for (i = 0; i < zone[fields[0]].length; i++) {
                fields[1] = i;
                find_match(fields.join('.'), target);
            }
        } else {
            find_match(key, target);
        }

        if (!found) {
            return false;
        } else {
            parameters_matched++;
        }
    }

    if (parameters_matched > 0) {
        // we would have returned false from the loop had any parameters not
        // matched and we had at least one that did.
        return true;
    }

    return false;
}

exports.lookup = function (search, options, callback)
{
    var log;
    var lookup_opts = {};
    var key;
    var matches;
    var need_fields = [];
    var results = [];
    var tracers_obj;
    var transform;

    assertMockCnUuid();

    // options is optional
    if (arguments.length === 2) {
        callback = arguments[1];
        options = {};
    }

    ensureLogging(false);
    if (options.hasOwnProperty('log')) {
        log = options.log;
    } else {
        log = VM.log.child({action: 'lookup', search: search});
    }

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('lookup', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    // XXX the 'transform' option is not intended to be public yet and should
    // only be used by tools willing to be rewritten if this is removed or
    // changed.
    if (options.hasOwnProperty('transform')) {
        transform = options.transform;
    }

    // keep separate variable because we can have some fields we add below that
    // we need for searching, but shouldn't be in the output.
    if (options.hasOwnProperty('fields')) {
        need_fields = options.fields.slice(0);

        // We only add needed fields here if we were limiting fields in the
        // first place. If we weren't limiting fields, we'll already have them
        // all.
        for (key in search) {
            // To be able to search on a field, that field needs to be added to
            // the objects, if user requested a set of fields missing the one
            // they're searching for, add it.
            matches = key.match(/^([^.]+)\./);
            if (matches) {
                if (need_fields.indexOf(matches[1]) == -1) {
                    need_fields.push(matches[1]);
                }
            } else {
                if (need_fields.indexOf(key) == -1) {
                    need_fields.push(key);
                }
            }
        }
    }

    // This is used when you've specified fields to remove those that might
    // have been added as a group but are not wanted, or were added as
    // dependencies for looking up wanted fields, or for search.
    function filterFields(res) {
        res.forEach(function (result) {
            Object.keys(result).forEach(function (k) {
                if (options.fields.indexOf(k) === -1) {
                    delete result[k];
                }
            });
        });
    }

    function lookupFilter(vmobj, cb) {
        if (transform) {
            // apply transform here for purposes of matching
            transform(vmobj);
        }
        if (Object.keys(search).length === 0 || matcher(vmobj, search)) {
            cb(true);
        } else {
            cb(false);
        }
        return;
    }

    lookup_opts = {log: log, fields: need_fields};
    vmload.getVmobjs(lookupFilter, lookup_opts, function gotVMs(err, vmobjs) {
        var r;
        var short_results = [];

        if (err) {
            callback(err);
            return;
        }

        if (transform) {
            async.each(vmobjs, function applyTransform(obj, cb) {
                transform(obj);
                cb();
            });
        }

        if (options.full) {
            callback(null, vmobjs);
        } else if (options.fields && need_fields.length > 0) {
            if (options.hasOwnProperty('fields')) {
                filterFields(vmobjs);
            }
            callback(null, vmobjs.filter(function (res) {
                // filter out empty objects
                if (typeof (res) === 'object') {
                    return (Object.keys(res).length > 0);
                } else {
                    return true;
                }
            }));
        } else {
            for (r in vmobjs) {
                short_results.push(results[r].uuid);
            }
            callback(null, short_results);
        }
    });
};

// Ensure we've got all the datasets necessary to create this VM
//
// IMPORTANT:
//
// On SmartOS, we assume a provisioner or some other external entity has already
// loaded the dataset into the system. This function just confirms that the
// dataset actually exists.
//
function checkDatasets(payload, log, callback)
{
    var checkme = [];
    var d;
    var disk;
    var tracers_obj;

    assert(log, 'no logger passed to checkDatasets()');

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('check-datasets', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    } else {
        log.debug('Checking for required datasets.');
    }

    // build list of datasets we need to download (downloadme)
    for (disk in payload.add_disks) {
        if (payload.add_disks.hasOwnProperty(disk)) {
            d = payload.add_disks[disk];
            if (d.hasOwnProperty('image_uuid')) {
                checkme.push(payload.zpool + '/'
                    + d.image_uuid);
            }
        }
    }

    function checker(dataset, cb) {
        zfs(['list', '-o', 'name', '-H', dataset], log, function (err, fds) {
            if (err) {
                log.error({'err': err, 'stdout': fds.stdout,
                    'stderr': fds.stderr}, 'zfs list ' + dataset + ' '
                    + 'exited with' + ' code ' + err.code + ': ' + err.message);
                cb(new Error('unable to find dataset: ' + dataset));
            } else {
                cb();
            }
        });
    }

    // check that we have all the volumes
    async.forEachSeries(checkme, checker, function (err) {
        if (err) {
            log.error(err, 'checkDatasets() failed to find required '
                + 'volumes');
            callback(err);
        } else {
            // progress(100, 'we have all necessary datasets');
            callback();
        }
    });
}

function lookupConflicts(macs, ips, ipNics, vrids, log, callback) {
    var load_fields;
    var load_opts;
    var tracers_obj;

    load_fields = ['brand', 'state', 'nics', 'uuid', 'zonename', 'zone_state'];
    load_opts = {fields: load_fields, log: log};

    assert(log, 'no logger passed to lookupConflicts()');

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('lookup-conflicts', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    log.debug('checking for conflicts with '
        + JSON.stringify(macs) + ', ' + JSON.stringify(ips) + ' and '
        + JSON.stringify(vrids));

    if (macs.length === 0 && ips.length === 0 && vrids.length === 0) {
        log.debug('returning from conflict check (nothing to check)');
        callback(null, false);
        return;
    }

    vmload.getVmobjs(function (vm, cb) {
        // This is the filter. We either call cb(true) which includes this VM
        // in results, or cb(false) which does not.
        var conflict = false;
        var ip;
        var mac;
        var ipMatcher;
        var vrid;

        if (vm.state === 'failed' && vm.zone_state !== 'running') {
            // Ignore zones that are failed unless they're 'running' which they
            // shouldn't be because they get stopped on failure.
            cb(false);
            return;
        }

        for (ip in ips) {
            ipMatcher = {
                'nics.*.ip': ips[ip],
                'nics.*.nic_tag': ipNics[ip].nic_tag
            };

            if (ipNics[ip].hasOwnProperty('vlan_id')) {
                ipMatcher['nics.*.vlan_id'] = ipNics[ip].vlan_id;
            }

            if (ips[ip] !== 'dhcp' && matcher(vm, ipMatcher)) {
                log.error('Found conflict: ' + vm.uuid + ' already has IP '
                    + ips[ip] + ' on nic tag ' + ipNics[ip].nic_tag);
                conflict = true;
            }
        }

        for (mac in macs) {
            if (matcher(vm, {'nics.*.mac': macs[mac]})) {
                log.error('Found conflict: ' + vm.uuid + ' already has MAC '
                    + macs[mac]);
                conflict = true;
            }
        }

        for (vrid in vrids) {
            if (matcher(vm, {'nics.*.vrrp_vrid': vrids[vrid]})) {
                log.error('Found conflict: ' + vm.uuid + ' already has VRID '
                    + vrids[vrid]);
                conflict = true;
            }
        }

        cb(conflict);
    }, load_opts, function (err, results) {
        if (err) {
            callback(err);
        } else {
            log.debug('returning from conflict check');
            callback(null, (results.length > 0) ? true : false);
        }
    });
}

function lookupInvalidNicTags(nics, log, callback) {
    var args, i;
    var tracers_obj;

    assert(log, 'no logger passed to lookupInvalidNicTags()');

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('lookup-invalid-nictags', log,
            callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    if (!nics || nics.length === 0) {
        callback();
        return;
    }

    args = ['exists', '-l'];
    for (i = 0; i < nics.length; i++) {
        if (!('nic_tag' in nics[i])) {
            continue;
        }
        args.push(nics[i]['nic_tag']);
    }

    /* If we found no tags, there's nothing for us to validate */
    if (args.length === 2) {
        callback();
        return;
    }

    execFile('/usr/bin/nictagadm', args, function (error, stdout, stderr) {
        var err, tags;
        if (error) {
            tags = stderr.toString().split('\n');
            err = '';
            for (i = 0; i < tags.length; i++) {
                if (tags[i] === '') {
                    continue;
                }
                if (err !== '') {
                    err = err + '\n';
                }
                err = err + 'Invalid nic tag "' + tags[i] + '"';
            }
            callback(new Error(err));
            return;
        }
        callback();
        return;
    });
}

function lookupInvalidNicTagMTUs(nics, log, callback) {
    var args = ['list', '-p', '-d', ','];
    var foundTag = false;
    var i, nic;
    var idx = {};
    var macs = {};
    var mtus = {};

    assert(log, 'no logger passed to lookupInvalidNicTagMTUs()');

    if (!nics || nics.length === 0) {
        callback();
        return;
    }

    // Go through all of the nic tags and find the minimum MTU for a nic
    // on that tag, so we can validate that this is not below the MTU for
    // a given tag type below.
    for (i = 0; i < nics.length; i++) {
        nic = nics[i];
        if (nic.hasOwnProperty('nic_tag')) {
            foundTag = true;

            if (nic.hasOwnProperty('mtu')) {
                if (!mtus.hasOwnProperty(nic.nic_tag)) {
                    idx[nic.nic_tag] = i;
                    mtus[nic.nic_tag] = nic.mtu;
                    macs[nic.nic_tag] = nic.mac;
                }

                if (nic.mtu < mtus[nic.nic_tag]) {
                    idx[nic.nic_tag] = i;
                    mtus[nic.nic_tag] = nic.mtu;
                    macs[nic.nic_tag] = nic.mac;
                }
            }
        }
    }

    if (!foundTag) {
        log.debug({ nics: nics }, 'No nic tags found: not validating');
        callback();
        return;
    }

    execFile('/usr/bin/nictagadm', args, function (error, stdout, stderr) {
        var err = '';
        var fields, lines, tag, type;

        if (error) {
            log.error({ err: err, stdout: stdout, stderr: stderr },
                'Error running nictagadm');
            callback(new Error('Error validating nic tags: ' + error.message));
            return;
        }

        lines = stdout.toString().split('\n');
        for (i = 0; i < lines.length; i++) {
            fields = lines[i].split(',');
            tag = fields[0];
            type = fields[3];

            if (tag === '-') {
                log.warn({ line: lines[i], stdout: stdout, stderr: stderr },
                    'Invalid tag found in nictagadm');
                continue;
            }

            if (mtus.hasOwnProperty(tag) && type === 'normal'
                    && mtus[tag] < 1500) {
                if (err !== '') {
                    err = err + '\n';
                }

                err = err + util.format(
                    'nic %d (%s): MTU is below the supported MTU (1500) '
                    + 'of nic tag "%s"', idx[tag], macs[tag], tag);
            }
        }

        if (err.length !== 0) {
            callback(new Error(err));
            return;
        }

        callback();
        return;
    });
}

function validateNicTags(nics, log, callback) {
    lookupInvalidNicTags(nics, log, function (err) {
        if (err) {
            callback(err);
            return;
        }

        lookupInvalidNicTagMTUs(nics, log, callback);
        return;
    });
}

function destroyVolume(volume, log, callback)
{
    var args;

    if (!volume || !volume.name) {
        log.warn({volume: volume}, 'volume missing "name", cannot destroy');
        return;
    }

    args = ['destroy', volume.name];

    zfs(args, log, function (e, fds) {
        if (e) {
            log.error({
                err: e,
                stdout: fds.stdout,
                stderr: fds.stdout,
                volume_name: volume.name
            }, 'zfs destroy failed');
            callback(e);
            return;
        }
        log.debug({
            err: e,
            stdout: fds.stdout,
            stderr: fds.stderr,
            volume_name: volume.name
        }, 'zfs destroyed ' + volume.name);
        callback();
    });
}

// create a new zvol for a VM
function createVolume(volume, log, callback)
{
    var refreserv;
    var size;
    var snapshot;
    var tracers_obj;

    assert(log, 'no logger passed for createVolume()');

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('create-volume', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    log.debug('creating volume ' + JSON.stringify(volume));

    if (volume.hasOwnProperty('image_size')) {
        size = volume.image_size;
    } else if (volume.hasOwnProperty('size')) {
        size = volume.size;
    } else {
        callback(new Error('FATAL: createVolume(' + JSON.stringify(volume)
            + '): ' + 'has no size or image_size'));
        return;
    }

    if (volume.hasOwnProperty('refreservation')) {
        refreserv = volume.refreservation;
    } else {
        log.debug('defaulting to refreservation = ' + size);
        refreserv = size;
    }

    async.series([
        function (cb) {
            // Ensure we've got a snapshot if we're going to make a clone
            if (volume.hasOwnProperty('image_uuid')) {
                snapshot = volume.zpool + '/' + volume.image_uuid + '@final';
                zfs(['get', '-Ho', 'value', 'name', snapshot], log,
                    function (err, fds) {

                    if (err) {
                        if (fds.stderr.match('dataset does not exist')) {
                            // no @final, so we'll make a new snapshot @<uuid>
                            snapshot = volume.zpool + '/' + volume.image_uuid
                                + '@' + volume.uuid;

                            zfs(['snapshot', snapshot], log, function (e) {
                                cb(e);
                            });
                        } else {
                            cb(err);
                        }
                    } else {
                        // @final is here!
                        cb();
                    }
                });
            } else {
                cb();
            }
        }, function (cb) {
            var args;
            var target;

            // We write to volume.zfs_filesystem here so that the caller knows
            // what name we gave the newly-created volume.
            volume.zfs_filesystem = volume.zpool + '/' + volume.uuid;
            target = volume.zfs_filesystem;
            if (volume.hasOwnProperty('image_uuid')) {
                // This volume is from a template/dataset/image so we create
                // it as a clone of a the @final snapshot on the original.
                // we already set 'snapshot' to the correct location above.
                args = ['clone', '-F'];
                if (volume.hasOwnProperty('compression')) {
                    args.push('-o', 'compression='
                        + volume.compression);
                }
                if (volume.hasOwnProperty('block_size')) {
                    args.push('-o', 'volblocksize='
                        + volume.block_size);
                }
                args.push('-o', 'refreservation=' + refreserv + 'M');
                args.push(snapshot, target);
                zfs(args, log, function (e) {
                    if (e) {
                        cb(e);
                    } else {
                        volume.path = '/dev/zvol/rdsk/' + target;
                        cb();
                    }
                });
            } else {
                // This volume is not from a template/dataset/image so we create
                // a blank new zvol for it.
                args = ['create'];
                if (volume.hasOwnProperty('compression')) {
                    args.push('-o', 'compression='
                        + volume.compression);
                }
                if (volume.hasOwnProperty('block_size')) {
                    args.push('-o', 'volblocksize='
                        + volume.block_size);
                }
                args.push('-o', 'refreservation=' + refreserv + 'M', '-V',
                    size + 'M', target);
                zfs(args, log, function (err, fds) {
                    if (err) {
                        cb(err);
                    } else {
                        volume.path = '/dev/zvol/rdsk/' + target;
                        cb();
                    }
                });
            }
        }
    ], function (err, results) {
        if (err) {
            log.error({err: err, volume: volume}, 'failed to create volume');
        } else {
            log.debug({volume: volume}, 'successfully created volume');
        }
        callback(err);
    });
}

/*
 * This is used by docker VMs to setup mounts for:
 *
 *  * /etc/resolv.conf
 *  * /etc/hosts
 *  * /etc/hostname
 *
 */
function createHostConfFileMounts(vmobj, opts, log, callback) {
    var dnssearch = [];
    var fake_payload = {uuid: vmobj.uuid, add_filesystems: []};
    var hosts = [
        ['127.0.0.1', 'localhost'],
        ['::1', 'localhost ip6-localhost ip6-loopback'],
        ['fe00::0', 'ip6-localnet'],
        ['ff00::0', 'ip6-mcastprefix'],
        ['ff02::1', 'ip6-allnodes'],
        ['ff02::2', 'ip6-allrouters']
    ];
    var hostsContents = '';
    var hostLinkContents = '';
    var hostsFile = '/etc/hosts';
    var hostname = vmobj.hostname || vmobj.uuid;
    var hostnameContents = hostname + '\n';
    var hostnameFile = '/etc/hostname';
    var resolvers = vmobj.resolvers || [];
    var resolvConfContents = '';
    var resolvConfFile = '/etc/resolv.conf';
    var tracers_obj;

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('create-hostconf-mounts', log,
            callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    // HACK: since smartos images currently don't have the HostsFile attribute
    // and SmartOS images put /etc/hosts as a symlink to /etc/inet/hosts, we
    // need to work around this by setting /etc/inet/hosts as default.
    if (vmobj.brand === 'joyent-minimal') {
        hostsFile = '/etc/inet/hosts';
    }

    if (vmobj.hasOwnProperty('internal_metadata')) {
        if (vmobj.internal_metadata['docker:hostsFile']) {
            hostsFile = path.normalize(vmobj
                .internal_metadata['docker:hostsFile']);
        }
        if (vmobj.internal_metadata['docker:hostnameFile']) {
            hostnameFile = path.normalize(vmobj
                .internal_metadata['docker:hostnameFile']);
        }
        if (vmobj.internal_metadata['docker:resolvConfFile']) {
            resolvConfFile = path.normalize(vmobj
                .internal_metadata['docker:resolvConfFile']);
        }
        if (vmobj.internal_metadata['docker:dnssearch']) {
            try {
                dnssearch
                    = JSON.parse(vmobj.internal_metadata['docker:dnssearch']);
            } catch (e) {
                log.error({err: e}, 'Ignoring invalid docker:dnssearch');
            }
        }
        if (vmobj.internal_metadata['docker:linkHosts']) {
            hostLinkContents = vmobj.internal_metadata['docker:linkHosts'];
        }
    }

    // add the hostname attached with the primary IP
    if (vmobj.nics && vmobj.nics.length) {
        vmobj.nics.forEach(function (n) {
            if (n.primary) {
                hosts.unshift([n.ip, hostname]);
            }
        });
    }

    hosts.forEach(function (h) {
        hostsContents = hostsContents + h[0] + '\t' + h[1] + '\n';
    });
    hostsContents += hostLinkContents;

    resolvers.forEach(function (r) {
        resolvConfContents = resolvConfContents + 'nameserver ' + r + '\n';
    });
    if (dnssearch.length > 0) {
        resolvConfContents = resolvConfContents + 'search '
            + dnssearch.join(' ') + '\n';
    }

    function _createEmptyFile(filename, cb) {
        var dir;

        log.info('creating empty file for mountpoint: ' + filename);
        dir = path.dirname(filename);
        mkdirp(dir, function (err) {
            if (err) {
                log.error({err: err}, 'failed to mkdirp(%s)', dir);
                cb(err);
                return;
            }
            log.info('created dir: %s', dir);
            try {
                fs.closeSync(fs.openSync(filename, 'a'));
            } catch (e) {
                log.error({err: e}, 'failed to create ' + filename);
                cb(e);
                return;
            }

            cb();
        });
    }

    // In order to mount via lofs, the target needs to exist. If it doesn't
    // exist from the image, we create it so we can mount over it.
    function _createConfFileTarget(f, cb) {
        fs.lstat(f, function (error, stats) {
            if (error) {
                if (error.code === 'ENOENT') {
                    _createEmptyFile(f, cb);
                    return;
                } else {
                    log.error({err: error}, 'failed to lstat ' + f);
                    cb(error);
                    return;
                }
            }

            if (stats.isFile()) {
                // it's a file! great. We can mount over it.
                cb();
                return;
            } else if (stats.isSymbolicLink()) {
                fs.unlinkSync(f);
                _createEmptyFile(f, cb);
            } else {
                log.error({stats: stats}, f + ' is not a file');
                cb(new Error(f + ' is not a file'));
                return;
            }
        });
    }

    async.each([ {
        contents: resolvConfContents,
        filename: resolvConfFile,
        raw_filename: vmobj.zonepath + '/config/resolv.conf'
    }, {
        contents: hostsContents,
        filename: hostsFile,
        raw_filename: vmobj.zonepath + '/config/hosts'
    }, {
        contents: hostnameContents,
        filename: hostnameFile,
        raw_filename: vmobj.zonepath + '/config/hostname'
    }], function _createConfFile(d, cb) {
        _createConfFileTarget(path.normalize(vmobj.zonepath + '/root/'
            + d.filename), function (create_err) {

            if (create_err) {
                cb(create_err);
                return;
            }

            fs.writeFile(d.raw_filename, d.contents, function (err) {
                if (err) {
                    cb(err);
                    return;
                }

                fake_payload.add_filesystems.push({
                    source: d.raw_filename,
                    target: d.filename,
                    type: 'lofs',
                    options: ['rw']
                });

                cb();
            });
        });
    }, function (err) {
        var zcfg;

        if (err) {
            callback(err);
            return;
        }

        if (opts.onlyUpdateFileContents) {
            // The files have been updated, that's all that was asked for.
            callback();
            return;
        }

        zcfg = buildFilesystemZonecfg({}, fake_payload);

        zonecfgFile(zcfg, ['-z', vmobj.zonename], log,
            function (zcfg_err, fds) {
                if (zcfg_err) {
                    log.error({
                        err: zcfg_err,
                        zcfg: zcfg,
                        stdout: fds.stdout,
                        stderr: fds.stderr
                    }, 'failed to modify zonecfg');
                    callback(zcfg_err);
                    return;
                }

                log.debug({stdout: fds.stdout, stderr: fds.stderr},
                    'modified zonecfg');
                callback();
            }
        );
    });
}

function copyFilesystemData(payload, filesystem, log, callback)
{
    var args = [];
    var cmd = '/usr/bin/rsync';
    var existing;
    var skip_copy = false;
    var target = filesystem.target;
    var test_path;
    var tracers_obj;
    var zonepath = payload.zonepath;

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('copy-filesystem-data', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    if (!payload.zonepath) {
        callback(new Error('missing zonepath in payload'));
        return;
    }
    if (!filesystem.target) {
        callback(new Error('missing target in filesystem'));
        return;
    }

    existing = path.join(zonepath, '/root/' + target);
    test_path = existing;

    async.whilst(function () {
        if ((test_path.length > (zonepath + '/root').length) && !skip_copy) {
            return (true);
        }
        return (false);
    }, function (cb) {
        var msg;

        log.debug('checking: ' + test_path);
        fs.lstat(test_path, function (err, stats) {
            if (err) {
                if (err.code === 'ENOENT') {
                    log.info(test_path + ' does not exist in image, not '
                        + 'copying');
                    skip_copy = true;
                    cb();
                    return;
                }
                log.error({err: err, path: test_path},
                    'lstat() failed, cannot copy files from image');
                cb(err);
                return;
            }
            // must be a directory, not a symlink
            if (!stats.isDirectory()) {
                msg = test_path + ' is not a directory, not copying files';
                log.info(msg);
                cb(new Error(msg));
                return;
            }

            test_path = path.dirname(test_path);
            cb();
        });
    }, function (err) {
        if (err) {
            callback(err);
            return;
        }

        if (skip_copy) {
            callback();
            return;
        }

        // Need to add the trailing '/' in so we copy only the *contents* of the
        // dir instead of the dir itself.
        args = ['-aq', existing + '/', filesystem.source];
        log.info({
            cmd: cmd,
            args: args,
            from: existing,
            to: filesystem.source
        }, 'copying files to fileystem');

        traceExecFile(cmd, args, log, 'rsync', function (e, stdout, stderr) {
            if (e) {
                e.stdout = stdout;
                e.stderr = stderr;
                log.error({err: e, cmd: cmd, args: args}, 'rsync failed');
                callback(e);
                return;
            }

            log.debug({
                stdout: stdout,
                stderr: stderr,
                from: existing,
                to: filesystem.source
            }, 'copied files');
            callback();
        });
    });
}

// When creating a VM with *new* filesystems, we need to create those
// filesystems separately after the zone is installed but before it is booted.
function createFilesystems(payload, filesystems, log, callback)
{
    var create_volume_root = false;
    var fake_payload = {};
    var tracers_obj;
    var zcfg;

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('create-filesystems', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    /*jsl:ignore*/
    dirmode = 0755;
    /*jsl:end*/

    // we only need to create zfs_filesystem/volumes if we have data volumes
    filesystems.forEach(function (f) {
        /* JSSTYLED */
        if (f.source.match(/\/volumes\//)) {
            create_volume_root = true;
        }
    });

    // fake payload only includes the set of filesystems we're creating, not
    // those that we expect to pre-exist.
    fake_payload.add_filesystems = filesystems;
    fake_payload.uuid = payload.uuid;

    zcfg = buildFilesystemZonecfg({}, fake_payload, {include_created: true});

    log.debug({payload: payload, zcfg: zcfg, filesystems: filesystems},
        'creating filesystems');

    function _createParents(cb) {
        if (create_volume_root) {
            zfs([
                'create',
                payload.zfs_filesystem + '/volumes'
            ], log, function (vols_err, vols_fds) {
                if (vols_err
                    && !vols_fds.stderr.match(/dataset already exists$/)) {

                    cb(vols_err);
                    return;
                }

                cb();
            });
        } else {
            cb();
        }
    }

    _createParents(function (error) {
        if (error) {
            callback(error);
            return;
        }

        async.each(filesystems, function (filesystem, cb) {
            /* JSSTYLED */
            if (filesystem.source.match(/^https?:\/\//)) {
                cb();
                return;
            /* JSSTYLED */
            } else if (filesystem.source.match(/\/volumes\//)) {
                zfs([
                    'create',
                    filesystem.source.slice(1) // skip leading '/'
                ], log, function (err, fds) {
                    if (err) {
                        log.error({
                            err: err,
                            stdout: fds.stdout,
                            stderr: fds.stderr
                        }, 'failed to create volume');
                        cb(err);
                        return;
                    }
                    copyFilesystemData(payload, filesystem, log, cb);
                });
            } else {
                cb(new Error('createFilesystems() do not recognize source'));
            }
        }, function (err) {
            // send the zonecfg data we just generated as a file to zonecfg,
            // this will create the zone.
            zonecfgFile(zcfg, ['-z', payload.zonename], log,
                function (zcfg_err, fds) {
                    if (zcfg_err) {
                        log.error({
                            err: zcfg_err,
                            zcfg: zcfg,
                            stdout: fds.stdout,
                            stderr: fds.stderr
                        }, 'failed to modify zonecfg');
                        callback(zcfg_err);
                        return;
                    }

                    log.debug({stdout: fds.stdout, stderr: fds.stderr},
                        'modified zonecfg');
                    callback();
                }
            );
        });
    });
}

// Create all the KVM volumes for a given VM property set
function createVolumes(payload, log, callback)
{
    var createme = [];
    var d;
    var disk;
    var disk_idx = 0;
    var tracers_obj;
    var used_disk_indexes = [];

    assert(log, 'no logger passed to createVolumes()');

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('create-volumes', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    log.debug('creating volumes: ' + JSON.stringify(payload.add_disks));

    if (payload.hasOwnProperty('used_disk_indexes')) {
        used_disk_indexes = payload.used_disk_indexes;
    }

    for (disk in payload.add_disks) {
        if (payload.add_disks.hasOwnProperty(disk)) {
            d = payload.add_disks[disk];

            // we don't create CDROM devices or disk devices which have the
            // nocreate: true property.
            if (d.media !== 'cdrom' && !d.nocreate) {
                // skip to the next unused one.
                while (used_disk_indexes.indexOf(disk_idx) !== -1) {
                    disk_idx++;
                }

                d.index = disk_idx;
                d.uuid = payload.uuid + '-disk' + disk_idx;
                used_disk_indexes.push(Number(disk_idx));
                if (!d.hasOwnProperty('zpool')) {
                    d.zpool = payload.zpool;
                }
                createme.push(d);
            }
        }
    }

    function _loggedCreateVolume(volume, cb) {
        return createVolume(volume, log, cb);
    }

    function _loggedDeleteVolume(volume, cb) {
        return deleteVolume(volume, log, cb);
    }

    // create all the volumes we found that we need.
    async.forEachSeries(createme, _loggedCreateVolume, function (err) {
        if (err) {
            // On error, we want to destroy these volumes. (we ignore errors
            // here since we're already handling error)
            log.warn('creation failed for one or more volumes, will attempt to '
                + 'destroy those successfully created');
            async.forEachSeries(createme, _loggedDeleteVolume, function () {
                callback(err);
            });
        } else {
            callback();
        }
    });
}

function writeAndRename(log, name, destfile, file_data, callback)
{
    var tempfile = destfile + '.new';
    var tracers_obj;

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback({
            args: {filename: destfile},
            name: 'write-and-rename'
        }, log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    log.debug('writing ' + name + ' to ' + tempfile);

    fs.writeFile(tempfile, file_data, function (err) {
        if (err) {
            callback(err);
            return;
        }

        log.debug('wrote ' + name + ' to ' + tempfile);
        log.debug('renaming from ' + tempfile + ' to ' + destfile);

        fs.rename(tempfile, destfile, function (_err) {
            if (_err) {
                callback(_err);
                return;
            }

            log.debug('renamed from ' + tempfile + ' to ' + destfile);
            callback();
        });
    });
}

// writes a Zone's metadata JSON to /zones/<uuid>/config/metadata.json
// and /zones/<uuid>/config/tags.json.
function updateMetadata(vmobj, payload, log, callback)
{
    var cmdata = {};
    var imdata = {};
    var key;
    var mdata = {};
    var mdata_filename;
    var tags = {};
    var tags_filename;
    var tracers_obj;
    var zonepath;

    assert(log, 'no logger passed to updateMetadata()');

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('update-metadata', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    if (vmobj.hasOwnProperty('zonepath')) {
        zonepath = vmobj.zonepath;
    } else if (vmobj.hasOwnProperty('zpool')
        && vmobj.hasOwnProperty('zonename')) {

        zonepath = '/' + vmobj.zpool + '/' + vmobj.zonename;
    } else {
        callback(new Error('unable to find zonepath for '
            + JSON.stringify(vmobj)));
        return;
    }

    // paths are under zonepath but not zoneroot
    mdata_filename = zonepath + '/config/metadata.json';
    tags_filename = zonepath + '/config/tags.json';

    // customer_metadata
    for (key in vmobj.customer_metadata) {
        if (vmobj.customer_metadata.hasOwnProperty(key)) {
            cmdata[key] = vmobj.customer_metadata[key];
            if (payload.hasOwnProperty('remove_customer_metadata')
                && payload.remove_customer_metadata.indexOf(key) !== -1) {

                // in the remove_* list, don't load it.
                delete cmdata[key];
            }
        }
    }

    for (key in payload.set_customer_metadata) {
        if (payload.set_customer_metadata.hasOwnProperty(key)) {
            cmdata[key] = payload.set_customer_metadata[key];
        }
    }

    // internal_metadata
    for (key in vmobj.internal_metadata) {
        if (vmobj.internal_metadata.hasOwnProperty(key)) {
            imdata[key] = vmobj.internal_metadata[key];
            if (payload.hasOwnProperty('remove_internal_metadata')
                && payload.remove_internal_metadata.indexOf(key) !== -1) {

                // in the remove_* list, don't load it.
                delete imdata[key];
            }
        }
    }

    for (key in payload.set_internal_metadata) {
        if (payload.set_internal_metadata.hasOwnProperty(key)) {
            imdata[key] = payload.set_internal_metadata[key];
        }
    }

    // same thing for tags
    for (key in vmobj.tags) {
        if (vmobj.tags.hasOwnProperty(key)) {
            tags[key] = vmobj.tags[key];
            if (payload.hasOwnProperty('remove_tags')
                && payload.remove_tags.indexOf(key) !== -1) {

                // in the remove_* list, don't load it.
                delete tags[key];
            }
        }
    }

    for (key in payload.set_tags) {
        if (payload.set_tags.hasOwnProperty(key)) {
            tags[key] = payload.set_tags[key];
        }
    }

    mdata = {'customer_metadata': cmdata, 'internal_metadata': imdata};

    async.series([
        function (next) {
            writeAndRename(log, 'metadata', mdata_filename,
                JSON.stringify(mdata, null, 2), next);
        },
        function (next) {
            writeAndRename(log, 'tags', tags_filename,
                JSON.stringify(tags, null, 2), next);
        }
    ], callback);
}

function saveMetadata(payload, log, callback)
{
    var protovm = {};
    var tracers_obj;

    assert(log, 'no logger passed to saveMetadata()');

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('save-metadata', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    if (!payload.hasOwnProperty('zonepath')
        || !payload.hasOwnProperty('zpool')
        || !payload.hasOwnProperty('zonename')) {

        callback(new Error('saveMetadata payload is missing zone '
            + 'properties.'));
        return;
    }

    protovm.zonepath = payload.zonepath;
    protovm.zpool = payload.zpool;
    protovm.zonename = payload.zonename;
    protovm.customer_metadata = {};
    protovm.tags = {};

    if (payload.hasOwnProperty('tags')) {
        payload.set_tags = payload.tags;
        delete payload.tags;
    }
    if (payload.hasOwnProperty('customer_metadata')) {
        payload.set_customer_metadata = payload.customer_metadata;
        delete payload.customer_metadata;
    }
    if (payload.hasOwnProperty('internal_metadata')) {
        payload.set_internal_metadata = payload.internal_metadata;
        delete payload.internal_metadata;
    }

    updateMetadata(protovm, payload, log, callback);
}

// writes a zone's metadata JSON to /zones/<uuid>/config/routes.json
function updateRoutes(vmobj, payload, log, callback)
{
    var filename;
    var key;
    var routes = {};
    var tracers_obj;
    var zonepath;

    assert(log, 'no logger passed to updateRoutes()');

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('update-routes', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    if (vmobj.hasOwnProperty('zonepath')) {
        zonepath = vmobj.zonepath;
    } else if (vmobj.hasOwnProperty('zpool')
        && vmobj.hasOwnProperty('zonename')) {

        zonepath = '/' + vmobj.zpool + '/' + vmobj.zonename;
    } else {
        callback(new Error('unable to find zonepath for '
            + JSON.stringify(vmobj)));
        return;
    }

    // paths are under zonepath but not zoneroot
    filename = zonepath + '/config/routes.json';

    for (key in vmobj.routes) {
        if (vmobj.routes.hasOwnProperty(key)) {
            routes[key] = vmobj.routes[key];
            if (payload.hasOwnProperty('remove_routes')
                && payload.remove_routes.indexOf(key) !== -1) {

                // in the remove_* list, don't load it.
                delete routes[key];
            }
        }
    }

    for (key in payload.set_routes) {
        if (payload.set_routes.hasOwnProperty(key)) {
            routes[key] = payload.set_routes[key];
        }
    }

    fs.writeFile(filename, JSON.stringify(routes, null, 2),
        function (err) {
            if (err) {
                callback(err);
            } else {
                log.debug('wrote routes to ' + filename);
                callback();
            }
        });
}

function saveRoutes(payload, log, callback)
{
    var protovm = {};
    var tracers_obj;

    assert(log, 'no logger passed to saveRoutes()');

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('save-routes', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    if (!payload.hasOwnProperty('zonepath')
        || !payload.hasOwnProperty('zpool')
        || !payload.hasOwnProperty('zonename')) {

        callback(new Error('saveRoutes payload is missing zone '
            + 'properties.'));
        return;
    }

    protovm.zonepath = payload.zonepath;
    protovm.zpool = payload.zpool;
    protovm.zonename = payload.zonename;

    if (payload.hasOwnProperty('routes')) {
        payload.set_routes = payload.routes;
        delete payload.routes;
    }

    updateRoutes(protovm, payload, log, callback);
}

function createVM(payload, log, callback)
{
    var tracers_obj;

    assert(log, 'no logger passed to createVM()');

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('createVM', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    async.series([
        function (cb) {
            if (!payload.create_only) {
                // progress(2, 'checking required datasets');
                checkDatasets(payload, log, cb);
            } else {
                cb();
            }
        }, function (cb) {
            if (!payload.create_only) {
                // progress(29, 'creating volumes');
                createVolumes(payload, log, cb);
            } else {
                cb();
            }
        }, function (cb) {
            // progress(51, 'creating zone container');
            createZone(payload, log, cb);
        }
    ], function (err, results) {
        if (err) {
            callback(err);
        } else {
            callback(null, results);
        }
    });
}

function fixZoneinitMetadataSock(zoneroot, log, callback)
{
    var mdata_00;
    var tracers_obj;

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('fix-zoneinit-mdata-sock', log,
            callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    // ensure we're safe to touch these files, zone should not be running here
    // so this just guards against malicious datasets.
    ['/var/zoneinit/includes', '/root/zoneinit.d'].forEach(function (dir) {
        assertSafeZonePath(zoneroot, dir, {type: 'dir', enoent_ok: true});
    });

    function replaceData(filename, cb) {
        fs.readFile(filename, 'utf8', function (error, data) {
            if (error) {
                log.error(error, 'failed to load 00-mdata.sh for replacement');
                cb(error);
                return;
            }

            data = data.replace(/\/var\/run\/smartdc\/metadata.sock/g,
                '/.zonecontrol/metadata.sock');

            log.trace('writing [' + data + '] to ' + filename);
            fs.writeFile(filename, data, 'utf8', function (err) {
                if (err) {
                    log.error(err, 'failed to write ' + filename);
                }
                cb(err);
            });
        });
    }

    // try /var/zoneinit/includes/00-mdata.sh first, since that's in new images
    mdata_00 = path.join(zoneroot, '/var/zoneinit/includes/00-mdata.sh');
    fs.exists(mdata_00, function (exists1) {
        if (exists1) {
            log.info('fixing socket in /var/zoneinit/includes/00-mdata.sh');
            replaceData(mdata_00, callback);
        } else {
            // didn't exist, so try location it exists in older images eg. 1.6.3
            mdata_00 = path.join(zoneroot, '/root/zoneinit.d/00-mdata.sh');
            fs.exists(mdata_00, function (exists2) {
                if (exists2) {
                    log.info('fixing socket in /root/zoneinit.d/00-mdata.sh');
                    replaceData(mdata_00, callback);
                } else {
                    log.info('no 00-mdata.sh to cleanup in zoneinit');
                    callback();
                }
            });
        }
    });
}

function fixMdataFetchStart(zonepath, log, callback)
{
    // svccfg validates zonepath
    var mdata_fetch_start = '/lib/svc/method/mdata-fetch';

    svccfg(zonepath, ['-s', 'svc:/smartdc/mdata:fetch', 'setprop', 'start/exec',
        '=', mdata_fetch_start], log, function (error, stdio) {

        if (error) {
            log.error(error, 'failed to set mdata:fetch start method');
        } else {
            log.info('successfully set mdata:fetch start method');
        }

        callback(error);
    });
}

function cleanupMessyDataset(zonepath, brand, log, callback)
{
    var command;
    var tracers_obj;
    var zoneroot = path.join(zonepath, '/root');

    assert(log, 'no logger passed to cleanupMessyDataset()');

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('cleanup-messy-dataset', log,
            callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    try {
        ['/var/adm', '/var/svc/log', '/var/svc/manifest', '/root/zoneinit.d']
            .forEach(function (dir) {

            // This will ensure these are safe if they exist.
            assertSafeZonePath(zoneroot, dir, {type: 'dir', enoent_ok: true});
        });
    } catch (e) {
        log.error(e, 'Unable to cleanup dataset: ' + e.message);
        callback(e);
        return;
    }

    // We've verified the directories here exist, and have no symlinks in the
    // path (or don't exist) so rm -f <dir>/<file> should be safe regardless of
    // the type of <file>

    command = 'rm -f '
        + zoneroot + '/var/adm/utmpx '
        + zoneroot + '/var/adm/wtmpx '
        + zoneroot + '/var/svc/log/*.log '
        + zoneroot + '/var/svc/mdata '
        + zoneroot + '/var/svc/manifest/mdata.xml ';

    if (! BRAND_OPTIONS[brand].features.zoneinit) {
        // eg. joyent-minimal (don't need zoneinit)
        command = command + zoneroot + '/root/zoneinit.xml '
            + zoneroot + '/root/zoneinit '
            + '&& rm -rf ' + zoneroot + '/root/zoneinit.d ';
    }
    command = command + '&& touch ' + zoneroot + '/var/adm/wtmpx';

    traceExec(command, log, 'rm-junk', function (error, stdout, stderr) {
        log.debug({err: error, stdout: stdout, stderr: stderr},
            'returned from cleaning up dataset');
        if (error || !BRAND_OPTIONS[brand].features.zoneinit) {
            // either we already failed or this zone doesn't use zoneinit so
            // we don't need to bother fixing zoneinit's scripts.
            callback(error);
        } else {
            fixZoneinitMetadataSock(zoneroot, log, function (err) {
                // See OS-2314, currently we assume all zones w/ zoneinit also
                // have broken mdata:fetch when images are created from them.
                // Attempt to fix that too.
                fixMdataFetchStart(zonepath, log, callback);
            });
        }
    });
}

// Helper for unlinking and replacing a file that you've already confirmed
// has no symlinks. Throws error when fs.writeFileSync does, or when
// fs.unlinkSync throws non ENOENT.
function replaceFile(zoneroot, filename, data) {
    // first delete, in case file itself is a link
    try {
        fs.unlinkSync(path.join(zoneroot, filename));
    } catch (e) {
        if (e.code !== 'ENOENT') {
            throw e;
        }
    }

    fs.writeFileSync(path.join(zoneroot, filename), data);
}

// NOTE: we write these out initially before the zone is started, but after that
// rely on mdata-fetch in the zone to do the updates since we can't safely write
// these files in the zones.
function writeZoneNetfiles(payload, log, callback)
{
    var hostname;
    var n;
    var nic;
    var primary_found = false;
    var tracers_obj;
    var zoneroot;

    assert(log, 'no logger passed to writeZoneNetfiles()');
    assert(payload.hasOwnProperty('zonepath'), 'no .zonepath in payload');

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('write-zone-netfiles', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    zoneroot = payload.zonepath + '/root';

    try {
        assertSafeZonePath(zoneroot, '/etc', {type: 'dir', enoent_ok: true});
    } catch (e) {
        log.error(e, 'Unable to write zone net files: ' + e.message);
        callback(e);
        return;
    }

    log.info('Writing network files to zone root');

    try {
        for (nic in payload.add_nics) {
            if (payload.add_nics.hasOwnProperty(nic)) {
                n = payload.add_nics[nic];

                if (n.ip != 'dhcp') {
                    replaceFile(zoneroot, '/etc/hostname.'
                        + n.interface, n.ip + ' netmask ' + n.netmask
                        + ' up' + '\n');
                }

                if (n.hasOwnProperty('primary') && !primary_found) {
                    // only allow one primary network
                    primary_found = true;
                    if (n.hasOwnProperty('gateway')) {
                        replaceFile(zoneroot, '/etc/defaultrouter',
                            n.gateway + '\n');
                    }
                    if (n.ip == 'dhcp') {
                        replaceFile(zoneroot, '/etc/dhcp.' + n.interface, '');
                    }
                }
            }
        }

        // It's possible we don't have zonename or hostname set because of the
        // ordering of adding the UUID. In any case, we'll have at least a uuid
        // here.
        if (payload.hasOwnProperty('hostname')) {
            hostname = payload.hostname;
        } else if (payload.hasOwnProperty('zonename')) {
            hostname = payload.zonename;
        } else {
            hostname = payload.uuid;
        }

        replaceFile(zoneroot, '/etc/nodename', hostname + '\n');
    } catch (e) {
        log.error(e, 'Unable to write zone networking files: ' + e.message);
        callback(e);
        return;
    }

    callback();
}

/*
 * NOTE: once we no longer support old datasets that need the 'zoneconfig' file,
 * this function and calls to it can be removed.
 *
 * This writes out the zoneconfig file that is used by the zoneinit service in
 * joyent branded zones' datasets.
 *
 */
function writeZoneconfig(payload, log, callback)
{
    var data;
    var hostname;
    var n;
    var nic;
    var tracers_obj;
    var zoneroot;

    assert(log, 'no logger passed to writeZoneconfig()');
    assert(payload.hasOwnProperty('zonepath'), 'no .zonepath in payload');

    zoneroot = payload.zonepath + '/root';

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('write-zoneconfig', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    } else {
        log.info('Writing config for zoneinit');
    }

    if (payload.hasOwnProperty('hostname')) {
        hostname = payload.hostname;
    } else {
        hostname = payload.zonename;
    }

    data = 'TEMPLATE_VERSION=0.0.1\n'
        + 'ZONENAME=' + payload.zonename + '\n'
        + 'HOSTNAME=' + hostname + '.' + payload.dns_domain + '\n'
        + 'TMPFS=' + payload.tmpfs + 'm\n';

    if (payload.hasOwnProperty('add_nics') && payload.add_nics[0]) {

        if (payload.add_nics[0] && payload.add_nics[0].ip != 'dhcp') {
            data = data + 'PUBLIC_IP=' + payload.add_nics[0].ip + '\n';
        }
        if (payload.add_nics[1] && payload.add_nics[1].ip != 'dhcp') {
            data = data + 'PRIVATE_IP=' + payload.add_nics[1].ip + '\n';
        } else if (payload.add_nics[0] && payload.add_nics[0].ip != 'dhcp') {
            // zoneinit uses private_ip for /etc/hosts, we want to
            // make that same as public, if there's no actual private.
            data = data + 'PRIVATE_IP=' + payload.add_nics[0].ip + '\n';
        }
    }

    if (payload.hasOwnProperty('resolvers')) {
        // zoneinit appends to resolv.conf rather than overwriting, so just
        // add to the zoneconfig and let zoneinit handle it
        data = data + 'RESOLVERS="' + payload.resolvers.join(' ') + '"\n';
    }

    for (nic in payload.add_nics) {
        if (payload.add_nics.hasOwnProperty(nic)) {
            n = payload.add_nics[nic];
            data = data + n.interface.toUpperCase() + '_MAC=' + n.mac + '\n'
                + n.interface.toUpperCase() + '_INTERFACE='
                + n.interface.toUpperCase() + '\n';

            if (n.ip != 'dhcp') {
                data = data + n.interface.toUpperCase() + '_IP=' + n.ip + '\n'
                    + n.interface.toUpperCase() + '_NETMASK='
                    + n.netmask + '\n';
            }
        }
    }

    try {
        assertSafeZonePath(zoneroot, '/var/svc/log/system-zoneinit:default.log',
            {type: 'file', enoent_ok: true});
        assertSafeZonePath(zoneroot, '/root/zoneconfig',
            {type: 'file', enoent_ok: true});

        replaceFile(zoneroot, '/var/svc/log/system-zoneinit:default.log', '');

        log.debug('writing zoneconfig ' + JSON.stringify(data) + ' to '
            + zoneroot);

        replaceFile(zoneroot, '/root/zoneconfig', data);
        callback();
    } catch (e) {
        log.error(e, 'Unable to write zoneconfig files: ' + e.message);
        callback(e);
        return;
    }
}

function zonecfg(args, log, callback)
{
    var cmd = '/usr/sbin/zonecfg';

    assert(log, 'no logger passed to zonecfg()');

    traceExecFile(cmd, args, log, 'zonecfg', function (error, stdout, stderr) {
        if (error) {
            callback(error, {'stdout': stdout, 'stderr': stderr});
        } else {
            callback(null, {'stdout': stdout, 'stderr': stderr});
        }
    });
}

function zonecfgFile(data, args, log, callback)
{
    var tmpfile = '/tmp/zonecfg.' + process.pid + '.tmp';
    var tracers_obj;

    assert(log, 'no logger passed to zonecfgFile()');

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('zonecfg-file', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    log.debug({data: data}, tmpfile + ' contents');

    fs.writeFile(tmpfile, data, function (err, result) {
        if (err) {
            // On failure we don't delete the tmpfile so we can debug it.
            callback(err);
        } else {
            args.push('-f');
            args.push(tmpfile);

            zonecfg(args, log, function (e, fds) {
                if (e) {
                    // keep temp file around for investigation
                    callback(e, fds);
                } else {
                    fs.unlink(tmpfile, function () {
                        callback(null, fds);
                    });
                }
            });
        }
    });
}

function zoneadm(args, log, callback)
{
    var cmd = '/usr/sbin/zoneadm';
    var evtname = 'zoneadm';

    assert(log, 'no logger passed to zoneadm()');

    if (args[2]) {
        evtname = evtname + '-' + args[2];
    }

    traceExecFile(cmd, args, log, evtname, function (error, stdout, stderr) {
        if (error) {
            callback(error, {'stdout': stdout, 'stderr': stderr});
        } else {
            callback(null, {'stdout': stdout, 'stderr': stderr});
        }
    });
}

function zfs(args, log, callback)
{
    var cmd = '/usr/sbin/zfs';
    var evtname = 'zfs.' + args[0];

    assert(log, 'no logger passed to zfs()');

    traceExecFile(cmd, args, log, evtname, function (error, stdout, stderr) {
        if (error) {
            callback(error, {'stdout': stdout, 'stderr': stderr});
        } else {
            callback(null, {'stdout': stdout, 'stderr': stderr});
        }
    });
}

exports.getSysinfo = function (args, options, callback)
{
    var cmd = '/usr/bin/sysinfo';
    var log;

    assertMockCnUuid();
    throw new Error('UNIMPLEMENTED: getSysinfo');

    // we used to allow just one argument (callback) and we also allow 2 args
    // (args, callback) so that options is optional.
    if (arguments.length === 1) {
        callback = arguments[0];
        args = [];
        options = {};
    }
    if (arguments.length === 2) {
        callback = arguments[1];
        options = {};
    }

    ensureLogging(false);
    if (options.hasOwnProperty('log')) {
        log = options.log;
    } else {
        log = VM.log.child({action: 'getSysinfo'});
    }

    traceExecFile(cmd, args, log, 'sysinfo', function (error, stdout, stderr) {
        var sysinfo;

        if (error) {
            callback(error, {'stdout': stdout, 'stderr': stderr});
        } else {
            try {
                sysinfo = JSON.parse(stdout.toString());
            } catch (e) {
                sysinfo = {};
            }
            callback(null, sysinfo);
        }
    });
};

/*
 * This watches zone transitions and calls callback when specified
 * state is reached.  Optionally you can set a timeout which will
 * call your callback when the timeout occurs whether the transition
 * has happened or not.
 *
 * payload needs to have at least .zonename and .uuid
 *
 */
exports.waitForZoneState = function (payload, state, options, callback)
{
    var log;
    var sysevent_state;
    var timeout;
    var timeout_secs = PROVISION_TIMEOUT;
    var tracers_obj;
    var watcher;

    assertMockCnUuid();
    throw new Error('UNIMPLEMENTED: waitForZoneState');

    // options is optional
    if (arguments.length === 3) {
        callback = arguments[2];
        options = {};
    }

    ensureLogging(false);
    if (options.hasOwnProperty('log')) {
        log = options.log;
    } else {
        log = VM.log.child({action: 'waitForZoneState', vm: payload.uuid});
    }

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('wait-for-zone-state', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    if (options.hasOwnProperty('timeout')) {
        timeout_secs = options.timeout;
    }

    sysevent_state = state;
    if (state === 'installed') {
        // Apparently the zone status 'installed' equals sysevent status
        // 'uninitialized'
        sysevent_state = 'uninitialized';
    }

    function done() {
        if (timeout) {
            clearTimeout(timeout);
            timeout = null;
        }
    }

    function handler(err, obj) {
        if (err) {
            done();
            callback(err);
            return;
        }
        log.trace('handler got: ' + JSON.stringify(obj));
        if (obj.zonename !== payload.zonename) {
            return;
        }

        if (obj.newstate === sysevent_state) {
            // Load again to confirm
            VM.lookup({'zonename': obj.zonename},
                {fields: ['zone_state'], log: log},
                function (error, res) {
                    var handler_retry;

                    if (error) {
                        watcher.cleanup();
                        done();
                        callback(error);
                        return;
                    }

                    if (res.length !== 1) {
                        watcher.cleanup();
                        done();
                        callback(new Error('lookup could no find VM '
                            + obj.zonename));
                        return;
                    }

                    if (res[0].hasOwnProperty('zone_state')
                        && res[0].zone_state === state) {

                        // found the state we're looking for, success!
                        log.debug('saw zone go to ' + obj.newstate + ' ('
                            + state + ') calling callback()');
                        watcher.cleanup();
                        done();
                        callback();
                    } else if (timeout) {
                        // we saw a state change to a state we don't care about
                        // so if we've not timed out try reloading again in a
                        // second.
                        if (!handler_retry) {
                            handler_retry = setTimeout(function () {
                                if (timeout) {
                                    // try again if wait timeout is still set
                                    handler(null, obj);
                                }
                                handler_retry = null;
                            }, 1000);
                            log.debug('zone state after lookup: '
                                + res[0].zone_state + ', still waiting');
                        } else {
                            log.debug('zone in wrong state but we already'
                                + ' have a handler running');
                        }
                    } else {
                        // no timeout set and we're not at the correct state
                        log.error('failed to reach state: ' + state);
                        callback(new Error('failed to reach state: ' + state));
                    }
                }
            );
        }
    }

    watcher = watchZoneTransitions(handler, log);

    timeout = setTimeout(function () {
        var err;

        done();
        watcher.cleanup();
        err = new Error('timed out waiting for zone to transition to ' + state);
        err.code = 'ETIMEOUT';
        callback(err);
    }, timeout_secs * 1000);

    // after we've started the watcher (if we checked before there'd be a race)
    // we check whether we're already in the target state, if we are close it
    // down and return.
    VM.load(payload.uuid, {fields: ['zone_state'], log: log},
        function (err, obj) {

        if (err) {
            watcher.cleanup();
            done();
            callback(err);
        } else if (obj.hasOwnProperty('zone_state')
            && obj.zone_state === state) {

            watcher.cleanup();
            done();
            log.info('VM is in state ' + state);
            callback(); // at correct state!
        }
    });
};

// handler() will be called with an object describing the transition for any
// transitions seen (after any filtering).  The only filtering here is to remove
// duplicate events.  Other filtering should be done by the caller.
function watchZoneTransitions(handler, log) {
    var buffer = '';
    var chunks;
    var cleanup;
    var watcher;
    var watcher_pid;

    assert(log, 'no logger passed to watchZoneTransitions()');

    if (!zoneevent) {

        zoneevent = new EventEmitter();

        log.debug('/usr/vm/sbin/zoneevent');
        watcher = spawn('/usr/vm/sbin/zoneevent', [],
            {'customFds': [-1, -1, -1]});
        log.debug('zoneevent running with pid ' + watcher.pid);
        watcher_pid = watcher.pid;

        watcher.stdout.on('data', function (data) {
            var chunk;
            var obj;
            var prev_msg;

            buffer += data.toString();
            chunks = buffer.split('\n');
            while (chunks.length > 1) {
                chunk = chunks.shift();
                obj = JSON.parse(chunk);

                if (obj === prev_msg) {
                    // Note: sometimes sysevent emits multiple events for the
                    // same status, we only want the first one here because just
                    // because sysevent does it, doesn't make it right.
                    log.debug('duplicate zoneevent message! '
                        + JSON.stringify(obj));
                } else if (zoneevent) {
                    zoneevent.emit('zoneevent', null, obj);
                }
            }
            buffer = chunks.pop();
        });

        // doesn't take input.
        watcher.stdin.end();

        watcher.on('exit', function (code) {
            log.warn('zoneevent watcher ' + watcher_pid + ' exited: ',
                JSON.stringify(code));
            // tell all the listeners of this zoneevent (if there are any) that
            // we exited.  Then null it out so next time we'll make a new one.
            zoneevent.emit('zoneevent', new Error('zoneevent watcher exited '
                + 'prematurely with code: ' + code));
            zoneevent = null;
        });
    }

    cleanup = function () {
        var listeners;

        if (zoneevent) {
            listeners = zoneevent.listeners('zoneevent');

            log.debug('cleanup called w/ listeners: '
                + util.inspect(listeners));
            zoneevent.removeListener('zoneevent', handler);
            if (zoneevent.listeners('zoneevent').length === 0) {
                log.debug('zoneevent watcher ' + watcher_pid
                    + ' cleanup called');
                zoneevent = null;
                if (watcher) {
                    watcher.stdout.destroy(); // so we don't send more 'data'
                    watcher.stderr.destroy();
                    watcher.removeAllListeners('exit'); // so don't fail on kill
                    log.debug('killing watcher');
                    watcher.kill();
                    watcher = null;
                }
            }
        } else if (watcher) {
            watcher.stdout.destroy(); // so we don't send more 'data'
            watcher.stderr.destroy();
            watcher.removeAllListeners('exit'); // so don't fail on our kill
            log.debug('killing watcher (no zoneevent)');
            watcher.kill();
            watcher = null;
        }
    };

    zoneevent.on('zoneevent', handler);

    return ({'cleanup': cleanup});
}

function fixPayloadMemory(payload, vmobj, log)
{
    var brand;
    var max_locked;
    var max_phys;
    var min_overhead;
    var ram;

    assert(log, 'no logger passed to fixPayloadMemory()');

    if (vmobj.hasOwnProperty('brand')) {
        brand = vmobj.brand;
    } else if (payload.hasOwnProperty('brand')) {
        brand = payload.brand;
    }

    if (BRAND_OPTIONS[brand].features.default_memory_overhead
        && payload.hasOwnProperty('ram')
        && !payload.hasOwnProperty('max_physical_memory')) {

        // For now we add overhead to the memory caps for KVM zones, this
        // is for the qemu process itself.  Since customers don't have direct
        // access to zone memory, this exists mostly to protect against bugs.
        payload.max_physical_memory = (payload.ram
            + BRAND_OPTIONS[brand].features.default_memory_overhead);
    } else if (payload.hasOwnProperty('ram')
        && !payload.hasOwnProperty('max_physical_memory')) {

        payload.max_physical_memory = payload.ram;
    }

    if (payload.hasOwnProperty('max_physical_memory')) {
        if (!payload.hasOwnProperty('max_locked_memory')) {
            if (vmobj.hasOwnProperty('max_locked_memory')
                && vmobj.hasOwnProperty('max_physical_memory')) {

                // we don't have a new value, so first try to keep the same
                // delta that existed before btw. max_phys and max_locked
                payload.max_locked_memory = payload.max_physical_memory
                    - (vmobj.max_physical_memory - vmobj.max_locked_memory);
            } else {
                // existing obj doesn't have max_locked, add one now
                payload.max_locked_memory = payload.max_physical_memory;
            }
        }

        if (!payload.hasOwnProperty('max_swap')) {
            if (vmobj.hasOwnProperty('max_swap')
                && vmobj.hasOwnProperty('max_physical_memory')) {

                // we don't have a new value, so first try to keep the same
                // delta that existed before btw. max_phys and max_swap
                if (vmobj.max_swap === MINIMUM_MAX_SWAP
                    && vmobj.max_swap <= MINIMUM_MAX_SWAP
                    && payload.max_physical_memory >= MINIMUM_MAX_SWAP) {
                    // in this case we artificially inflated before to meet
                    // minimum tie back to ram.
                    payload.max_swap = payload.max_physical_memory;
                } else {
                    payload.max_swap = payload.max_physical_memory
                        + (vmobj.max_swap - vmobj.max_physical_memory);
                }
            } else {
                // existing obj doesn't have max_swap, add one now
                payload.max_swap = payload.max_physical_memory;
            }

            // never add a max_swap less than MINIMUM_MAX_SWAP
            if (payload.max_swap < MINIMUM_MAX_SWAP) {
                payload.max_swap = MINIMUM_MAX_SWAP;
            }
        }
    }

    // if we're updating tmpfs it must be lower than our new max_physical or
    // if we're not also changing max_physical, it must be lower than the
    // current one.
    if (payload.hasOwnProperty('tmpfs')) {
        if (payload.hasOwnProperty('max_physical_memory')
            && (Number(payload.tmpfs)
                > Number(payload.max_physical_memory))) {

            log.info(payload.tmpfs + ' (requested tmpfs) > '
                + payload.max_physical_memory + ' (max_physical_memory), '
                + 'clamping to ' + payload.max_physical_memory);
            payload.tmpfs = payload.max_physical_memory;
        } else if (Number(payload.tmpfs)
            > Number(vmobj.max_physical_memory)) {

            log.info(payload.tmpfs + ' (requested tmpfs) > '
                + vmobj.max_physical_memory + ' (max_physical_memory), '
                + 'clamping to ' + vmobj.max_physical_memory);
            payload.tmpfs = vmobj.max_physical_memory;
        }
    }

    if (payload.hasOwnProperty('max_physical_memory')
        && BRAND_OPTIONS[brand].features.use_tmpfs
        && !payload.hasOwnProperty('tmpfs')) {

        if (vmobj.hasOwnProperty('max_physical_memory')
            && vmobj.hasOwnProperty('tmpfs')) {

            // change tmpfs to be the same ratio of ram as before
            payload.tmpfs = ((vmobj.tmpfs / vmobj.max_physical_memory)
                * payload.max_physical_memory);
            payload.tmpfs = Number(payload.tmpfs).toFixed();
        } else {
            // tmpfs must be < max_physical_memory, if not: pretend it was
            payload.tmpfs = payload.max_physical_memory;
        }
    }

    // Set additional resource controls for shared memory

    if (payload.hasOwnProperty('max_physical_memory')) {
        if (!vmobj.hasOwnProperty('max_shm_memory')
            && !payload.hasOwnProperty('max_shm_memory')) {

            payload.max_shm_memory = payload.max_physical_memory;
        }

        if (!vmobj.hasOwnProperty('max_msg_ids')
            && !payload.hasOwnProperty('max_msg_ids')) {

            payload.max_msg_ids = DEFAULT_MAX_MSG_IDS;
        }
        if (!vmobj.hasOwnProperty('max_sem_ids')
            && !payload.hasOwnProperty('max_sem_ids')) {

            payload.max_sem_ids = DEFAULT_MAX_SEM_IDS;
        }
        if (!vmobj.hasOwnProperty('max_shm_ids')
            && !payload.hasOwnProperty('max_shm_ids')) {

            payload.max_shm_ids = DEFAULT_MAX_SHM_IDS;
        }
    }

    // now that we've possibly adjusted target values, lower/raise values to
    // satisify max/min.

    min_overhead = BRAND_OPTIONS[brand].features.min_memory_overhead;
    if (min_overhead) {
        ram = payload.hasOwnProperty('ram') ? payload.ram : vmobj.ram;
        max_phys = payload.hasOwnProperty('max_physical_memory')
            ? payload.max_physical_memory : vmobj.max_physical_memory;
        max_locked = payload.hasOwnProperty('max_locked_memory')
            ? payload.max_locked_memory : vmobj.max_locked_memory;

        if ((ram + min_overhead) > max_phys) {
            payload.max_physical_memory = (ram + min_overhead);
        }
        if ((ram + min_overhead) > max_locked) {
            payload.max_locked_memory = (ram + min_overhead);
        }
    }

    if (payload.hasOwnProperty('max_locked_memory')) {
        if (payload.hasOwnProperty('max_physical_memory')) {
            if (payload.max_locked_memory > payload.max_physical_memory) {
                log.warn('max_locked_memory (' + payload.max_locked_memory
                    + ') > max_physical_memory (' + payload.max_physical_memory
                    + ') clamping to ' + payload.max_physical_memory);
                payload.max_locked_memory = payload.max_physical_memory;
            }
        } else if (vmobj.hasOwnProperty('max_physical_memory')) {
            // new payload doesn't have a max_physical, so clamp to vmobj's
            if (payload.max_locked_memory > vmobj.max_physical_memory) {
                log.warn('max_locked_memory (' + payload.max_locked_memory
                    + ') > vm.max_physical_memory (' + vmobj.max_physical_memory
                    + ') clamping to ' + vmobj.max_physical_memory);
                payload.max_locked_memory = vmobj.max_physical_memory;
            }
        }
    }

    if (payload.hasOwnProperty('max_swap')) {
        if (payload.hasOwnProperty('max_physical_memory')) {
            if (payload.max_swap < payload.max_physical_memory) {
                log.warn('max_swap (' + payload.max_swap
                    + ') < max_physical_memory (' + payload.max_physical_memory
                    + ') raising to ' + payload.max_physical_memory);
                payload.max_swap = payload.max_physical_memory;
            }
        } else if (vmobj.hasOwnProperty('max_physical_memory')) {
            // new payload doesn't have a max_physical, so raise to vmobj's
            if (payload.max_swap < vmobj.max_physical_memory) {
                log.warn('max_swap (' + payload.max_swap
                    + ') < vm.max_physical_memory (' + vmobj.max_physical_memory
                    + ') raising to ' + vmobj.max_physical_memory);
                payload.max_swap = vmobj.max_physical_memory;
            }
        }
    }
}

// generate a new UUID if payload doesn't have one (also ensures that this uuid
// does not already belong to a zone).
function createZoneUUID(payload, log, callback)
{
    var tracers_obj;

    assert(log, 'no logger passed to createZoneUUID()');

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('create-zone-uuid', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    /*
     * Checks if the UUID already exists on a VM, if so: callback() is called
     * with an error object as the first argument. If the UUID is unused,
     * callback(null, <uuid>) is called.
     *
     */
    function _assertUUIDUnique(uuid) {
        var lookup_opts = {log: log, fields: ['uuid']};

        vmload.getVmobjs(function (vmobj, cb) {
            if (vmobj.uuid === uuid) {
                cb(true);
            } else {
                cb(false);
            }
        }, lookup_opts, function gotVMs(err, vmobjs) {
            if (err) {
                callback(err);
                return;
            }

            if (vmobjs.length > 0) {
                callback(new Error('VM with UUID ' + uuid + ' already exists'));
                return;
            }

            // if we got here, no other VM has this UUID so we'll use it.
            callback(null, uuid);
        });
    }

    if (payload.hasOwnProperty('uuid')) {
        // Ensure that the uuid is not already used.
        _assertUUIDUnique(payload.uuid);
    } else {
        traceExecFile('/usr/bin/uuid', ['-v', '4'], log, 'uuid',
            function (err, stdout, stderr) {
                var uuid;

                if (err) {
                    callback(err);
                    return;
                }

                // chomp trailing spaces and newlines
                uuid = stdout.toString().replace(/\s+$/g, '');
                payload.uuid = uuid;
                log.info('generated uuid ' + uuid + ' for new VM');

                _assertUUIDUnique(payload.uuid);
            }
        );
    }
}

function applyZoneDefaults(payload, log)
{
    var allowed;
    var disk;
    var disks;
    var n;
    var nic;
    var nics;
    var zvol;

    assert(log, 'no logger passed to applyZoneDefaults()');

    log.debug('applying zone defaults');

    if (!payload.hasOwnProperty('owner_uuid')) {
        // We assume that this all-zero uuid can be treated as 'admin'
        payload.owner_uuid = '00000000-0000-0000-0000-000000000000';
    }

    if (!payload.hasOwnProperty('autoboot')) {
        payload.autoboot = true;
    }

    if (!payload.hasOwnProperty('brand')) {
        payload.brand = 'joyent';
    }

    if (!payload.hasOwnProperty('zpool')) {
        payload.zpool = 'zones';
    }

    if (!payload.hasOwnProperty('dns_domain')) {
        payload.dns_domain = 'local';
    }

    if (!payload.hasOwnProperty('cpu_shares')) {
        payload.cpu_shares = 100;
    } else {
        if (payload.cpu_shares > 65535) {
            log.info('capping cpu_shares at 64k (was: '
                + payload.cpu_shares + ')');
            payload.cpu_shares = 65535; // max is 64K
        }
    }

    if (!payload.hasOwnProperty('zfs_io_priority')) {
        payload.zfs_io_priority = 100;
    }

    if (!payload.hasOwnProperty('max_lwps')) {
        payload.max_lwps = 2000;
    }

    // We need to set the RAM here because we use it as the default for
    // the max_physical_memory below. If we've set max_phys and we're not
    // KVM, we'll use that instead of ram anyway.
    if (!payload.hasOwnProperty('ram')) {
        payload.ram = 256;
    }

    fixPayloadMemory(payload, {}, log);

    allowed = BRAND_OPTIONS[payload.brand].allowed_properties;
    if (allowed.hasOwnProperty('vcpus') && !payload.hasOwnProperty('vcpus')) {
        payload.vcpus = 1;
    }

    if (BRAND_OPTIONS[payload.brand].features.use_tmpfs
        && (!payload.hasOwnProperty('tmpfs')
            || (Number(payload.tmpfs) > Number(payload.max_physical_memory)))) {

        payload.tmpfs = payload.max_physical_memory;
    }

    if (!payload.hasOwnProperty('limit_priv')) {
        // note: the limit privs are going to be added to the brand and
        // shouldn't need to be set here by default when that's done.
        if (BRAND_OPTIONS[payload.brand].features.limit_priv) {
            payload.limit_priv
                = BRAND_OPTIONS[payload.brand].features.limit_priv;
        } else {
            payload.limit_priv = ['default'];
        }
    }

    if (!payload.hasOwnProperty('quota')) {
        payload.quota = '10'; // in GiB
    }

    if (!payload.hasOwnProperty('billing_id')) {
        payload.billing_id = '00000000-0000-0000-0000-000000000000';
    }

    if (payload.hasOwnProperty('add_disks')) {
        // update
        disks = payload.add_disks;
    } else if (payload.hasOwnProperty('disks')) {
        disks = payload.disks;
    } else {
        // no disks at all
        disks = [];
    }

    for (disk in disks) {
        if (disks.hasOwnProperty(disk)) {
            zvol = disks[disk];
            if (!zvol.hasOwnProperty('model')
                && payload.hasOwnProperty('disk_driver')) {

                zvol.model = payload.disk_driver;
            }
            if (!zvol.hasOwnProperty('media')) {
                zvol.media = 'disk';
            }
        }
    }

    if (payload.hasOwnProperty('add_nics')) {
        // update
        nics = payload.add_nics;
    } else if (payload.hasOwnProperty('nics')) {
        nics = payload.nics;
    } else {
        // no disks at all
        nics = [];
    }

    for (nic in nics) {
        if (nics.hasOwnProperty(nic)) {
            n = nics[nic];
            if (!n.hasOwnProperty('model')
                && payload.hasOwnProperty('nic_driver')) {

                n.model = payload.nic_driver;
            }
        }
    }
}

function validRecordSize(candidate)
{
    if (candidate < 512) {
        // too low
        return (false);
    } else if (candidate > 131072) {
        // too high
        return (false);
    } else if ((candidate & (candidate - 1)) !== 0) {
        // not a power of 2
        return (false);
    }

    return (true);
}

// This function gets called for both create and update to check that payload
// properties are reasonable. If vmobj is null, create is assumed, otherwise
// update is assumed.
function checkPayloadProperties(payload, vmobj, log, callback)
{
    var array_fields = [
        'add_nics', 'update_nics', 'remove_nics',
        'add_disks', 'update_disks', 'remove_disks',
        'add_filesystems', 'update_filesystems', 'remove_filesystems'
    ];
    var brand;
    var changed_nics = [];
    var current_ips = [];
    var current_macs = [];
    var current_primary_ips = [];
    var current_vrids = [];
    var disk;
    var dst;
    var field;
    var filesys;
    var i;
    var ips = [];
    var ipNics = [];    // The nics that the ips array matches
    var is_nic = false;
    var limit;
    var live_ok;
    var mac;
    var macs = [];
    var m;
    var n;
    var nic;
    var nics_result = {};
    var nics_result_ordered = [];
    var nic_fields = ['add_nics', 'update_nics'];
    var only_vrrp_nics = true;
    var primary_nics;
    var prop;
    var props;
    var ram;
    var route;
    var routes_result = {};
    var tracers_obj;
    var vrids = [];
    var zvol;

    assert(log, 'no logger passed to checkPayloadProperties()');

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('check-payload-properties', log,
            callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    if (vmobj) {
        brand = vmobj.brand;
    } else if (payload.hasOwnProperty('brand')) {
        brand = payload.brand;
    } else {
        callback(new Error('unable to determine brand for VM'));
    }

    /* check types of fields that should be arrays */
    for (field in array_fields) {
        field = array_fields[field];
        if (payload.hasOwnProperty(field) && ! Array.isArray(payload[field])) {
            callback(new Error(field + ' must be an array.'));
            return;
        }
    }

    if (!vmobj) {
        // This is a CREATE

        // These should have already been enforced
        if (payload.max_locked_memory > payload.max_physical_memory) {
            callback(new Error('max_locked_memory must be <= '
                + 'max_physical_memory'));
            return;
        }
        if (payload.max_swap < payload.max_physical_memory) {
            callback(new Error('max_swap must be >= max_physical_memory'));
            return;
        }

        // We used to use zone_path instead of zonepath, so accept that too.
        if (payload.hasOwnProperty('zone_path')
            && !payload.hasOwnProperty('zonepath')) {

            payload.zonepath = payload.zone_path;
            delete payload.zone_path;
        }
    } else {
        // This is an UPDATE

        // can't update disks of a running VM
        if (payload.hasOwnProperty('add_disks')
            || payload.hasOwnProperty('remove_disks')) {

            if ((vmobj.state !== 'stopped')
                || (vmobj.state === 'provisioning'
                && vmobj.zone_state !== 'installed')) {

                callback(new Error('updates to disks are only allowed when '
                    + 'state is "stopped", currently: ' + vmobj.state + ' ('
                    + vmobj.zone_state + ')'));
                return;
            }
        }

        // For update_disks we can update refreservation and compression values
        // while running. If there are other parameters to update though we'll
        // reject.
        if (payload.hasOwnProperty('update_disks')) {
            if ((vmobj.state !== 'stopped')
                || (vmobj.state === 'provisioning'
                && vmobj.zone_state !== 'installed')) {

                live_ok = true;

                payload.update_disks.forEach(function (d) {
                    var key;
                    var keys = Object.keys(d);

                    while ((keys.length > 0) && live_ok) {
                        key = keys.pop();
                        if ([
                            'compression',
                            'path',
                            'refreservation'
                            ].indexOf(key) === -1) {

                            // this key is not allowed!
                            live_ok = false;
                        }
                    }
                });

                if (!live_ok) {
                    callback(new Error('at least one specified update to disks '
                        + 'is only allowed when state is "stopped", currently: '
                        + vmobj.state + ' (' + vmobj.zonestate + ')'));
                    return;
                }
            }
        }

        // if there's a min_overhead we ensure values are higher than ram.
        if (BRAND_OPTIONS[brand].features.min_memory_overhead) {
            if (payload.hasOwnProperty('ram')) {
                ram = payload.ram;
            } else {
                ram = vmobj.ram;
            }

            // ensure none of these is < ram
            if (payload.hasOwnProperty('max_physical_memory')
                && payload.max_physical_memory < ram) {

                callback(new Error('vm.max_physical_memory ('
                    + payload.max_physical_memory + ') cannot be lower than'
                    + ' vm.ram (' + ram + ')'));
                return;
            }
            if (payload.hasOwnProperty('max_locked_memory')
                && payload.max_locked_memory < ram) {

                callback(new Error('vm.max_locked_memory ('
                    + payload.max_locked_memory + ') cannot be lower than'
                    + ' vm.ram (' + ram + ')'));
                return;
            }
            // This should not be allowed anyway because max_swap will be raised
            // to match max_physical_memory if you set it lower.
            if (payload.hasOwnProperty('max_swap')) {
                if (payload.max_swap < ram) {
                    callback(new Error('vm.max_swap ('
                        + payload.max_swap + ') cannot be lower than'
                        + ' vm.ram (' + ram + ')'));
                    return;
                } else if (payload.max_swap < MINIMUM_MAX_SWAP) {
                    callback(new Error('vm.max_swap ('
                        + payload.max_swap + ') cannot be lower than '
                        + MINIMUM_MAX_SWAP + 'MiB'));
                    return;
                }
            }
        }

        /*
         * keep track of current IPs/MACs so we can make sure they're not being
         * duplicated.
         *
         */
        for (nic in vmobj.nics) {
            nic = vmobj.nics[nic];
            if (nic.hasOwnProperty('ip') && nic.ip !== 'dhcp') {
                current_ips.push(nic.ip);
            }
            if (nic.hasOwnProperty('mac')) {
                current_macs.push(nic.mac);
            }
            if (nic.hasOwnProperty('vrrp_vrid')) {
                current_vrids.push(nic.vrrp_vrid);
            }
            if (nic.hasOwnProperty('vrrp_primary_ip')) {
                current_primary_ips.push(nic.vrrp_primary_ip);
            }

            if (nic.hasOwnProperty('mac') || nic.hasOwnProperty('vrrp_vrid')) {
                mac = nic.hasOwnProperty('mac') ? nic.mac
                    : vrrpMAC(nic.vrrp_vrid);
                if (!nics_result.hasOwnProperty(mac)) {
                    nics_result[mac] = nic;
                    nics_result_ordered.push(nic);
                }
            }
        }

        // Keep track of route additions / deletions, to make sure that
        // we're not setting link-local routes against nics that don't exist
        for (route in vmobj.routes) {
            routes_result[route] = vmobj.routes[route];
        }
    }

    if (payload.hasOwnProperty('add_disks')) {
        for (disk in payload.add_disks) {
            if (payload.add_disks.hasOwnProperty(disk)) {
                zvol = payload.add_disks[disk];

                // path is only allowed in 2 cases when adding a disk:
                //
                // 1) for cdrom devices
                // 2) when nocreate is specified
                //
                if (zvol.hasOwnProperty('path')) {
                    if (zvol.media !== 'cdrom' && !zvol.nocreate) {
                        callback(new Error('you cannot specify a path for a '
                            + 'disk unless you set nocreate=true'));
                        return;
                    }
                }

                // NOTE: We'll have verified the .zpool argument is a valid
                // zpool using VM.validate() if it's set.

                if (zvol.hasOwnProperty('block_size')
                    && !validRecordSize(zvol.block_size)) {

                    callback(new Error('invalid .block_size(' + zvol.block_size
                        + '), must be 512-131072 and a power of 2.'));
                    return;
                }

                if (zvol.hasOwnProperty('block_size')
                    && zvol.hasOwnProperty('image_uuid')) {

                    callback(new Error('setting both .block_size and '
                        + '.image_uuid on a volume is invalid'));
                }

                if (zvol.hasOwnProperty('compression')) {
                    if (VM.COMPRESSION_TYPES.indexOf(zvol.compression) === -1) {
                        callback(new Error('invalid compression setting for '
                            + 'disk, must be one of: '
                            + VM.COMPRESSION_TYPES.join(', ')));
                    }
                }

                if (!zvol.hasOwnProperty('model')
                    || zvol.model === 'undefined') {

                    if (vmobj && vmobj.hasOwnProperty('disk_driver')) {
                        zvol.model = vmobj.disk_driver;
                        log.debug('set model to ' + zvol.model
                            + ' from disk_driver');
                    } else if (vmobj && vmobj.hasOwnProperty('disks')
                        && vmobj.disks.length > 0 && vmobj.disks[0].model) {

                        zvol.model = vmobj.disks[0].model;
                        log.debug('set model to ' + zvol.model + ' from disk0');
                    } else {
                        callback(new Error('missing .model option for '
                            + 'disk: ' + JSON.stringify(zvol)));
                        return;
                    }
                } else if (VM.DISK_MODELS.indexOf(zvol.model) === -1) {
                    callback(new Error('"' + zvol.model + '"'
                        + ' is not a valid disk model. Valid are: '
                        + VM.DISK_MODELS.join(',')));
                    return;
                }
            }
        }
    }

    if (payload.hasOwnProperty('update_disks')) {
        for (disk in payload.update_disks) {
            if (payload.update_disks.hasOwnProperty(disk)) {
                zvol = payload.update_disks[disk];

                if (zvol.hasOwnProperty('compression')) {
                    if (VM.COMPRESSION_TYPES.indexOf(zvol.compression) === -1) {
                        callback(new Error('invalid compression type for '
                            + 'disk, must be one of: '
                            + VM.COMPRESSION_TYPES.join(', ')));
                    }
                }

                if (zvol.hasOwnProperty('block_size')) {
                    callback(new Error('cannot change .block_size for a disk '
                        + 'after creation'));
                    return;
                }
            }
        }
    }

    // If we're receiving, we might not have the filesystem yet
    if (!payload.hasOwnProperty('transition')
        || payload.transition.transition !== 'receiving') {

        for (filesys in payload.filesystems) {
            filesys = payload.filesystems[filesys];
            if (!fs.existsSync(filesys.source)) {
                callback(new Error('missing requested filesystem: '
                    + filesys.source));
                return;
            }
        }
    }

    if (payload.hasOwnProperty('default_gateway')
        && payload.default_gateway !== '') {

        log.warn('DEPRECATED: default_gateway should no longer be used, '
            + 'instead set one NIC primary and use nic.gateway.');
    }

    primary_nics = 0;
    for (field in nic_fields) {
        field = nic_fields[field];
        if (payload.hasOwnProperty(field)) {
            for (nic in payload[field]) {
                if (payload[field].hasOwnProperty(nic)) {
                    n = payload[field][nic];

                    if (n.hasOwnProperty('vrrp_vrid')) {
                        if (current_vrids.indexOf(n.vrrp_vrid) !== -1
                            || vrids.indexOf(n.vrrp_vrid) !== -1) {
                            callback(new Error('Cannot add multiple NICs with '
                                + 'the same VRID: ' + n.vrrp_vrid));
                            return;
                        }
                        vrids.push(n.vrrp_vrid);
                    }

                    // MAC will always conflict in update, since that's the key
                    if (field === 'add_nics' && n.hasOwnProperty('mac')) {
                        if ((macs.indexOf(n.mac) !== -1)
                            || current_macs.indexOf(n.mac) !== -1) {

                            callback(new Error('Cannot add multiple NICs with '
                                + 'the same MAC: ' + n.mac));
                            return;
                        }
                        macs.push(n.mac);
                    }

                    if (field === 'add_nics' || field === 'update_nics') {
                        if (n.hasOwnProperty('primary')) {
                            if (n.primary !== true) {
                                callback(new Error('invalid value for NIC\'s '
                                    + 'primary flag: ' + n.primary + ' (must be'
                                    + ' true)'));
                                return;
                            }
                            primary_nics++;
                        }
                        changed_nics.push(n);
                    }

                    if (n.hasOwnProperty('ip') && n.ip != 'dhcp') {
                        if (ips.indexOf(n.ip) !== -1
                            || current_ips.indexOf(n.ip) !== -1) {

                            callback(new Error('Cannot add multiple NICs with '
                                + 'the same IP: ' + n.ip));
                            return;
                        }
                        ips.push(n.ip);
                        ipNics.push(n);
                    }

                    if (field === 'add_nics'
                        && n.hasOwnProperty('vrrp_vrid')
                        && n.mac !== vrrpMAC(n.vrrp_vrid)) {
                        callback(
                            new Error('Cannot set both mac and vrrp_vrid'));
                        return;
                    }

                    if (n.hasOwnProperty('vrrp_primary_ip')) {
                        current_primary_ips.push(n.vrrp_primary_ip);
                    }

                    if (BRAND_OPTIONS[brand].features.model_required
                        && field === 'add_nics'
                        && (!n.hasOwnProperty('model') || !n.model
                        || n.model === 'undefined' || n.model.length === 0)) {


                        if (vmobj && vmobj.hasOwnProperty('nic_driver')) {
                            n.model = vmobj.nic_driver;
                            log.debug('set model to ' + n.model
                                + ' from nic_driver');
                        } else if (vmobj && vmobj.hasOwnProperty('nics')
                            && vmobj.nics.length > 0 && vmobj.nics[0].model) {

                            n.model = vmobj.nics[0].model;
                            log.debug('set model to ' + n.model + ' from nic0');
                        } else {
                            callback(new Error('missing .model option for NIC: '
                                + JSON.stringify(n)));
                            return;
                        }
                    }

                    if (field === 'add_nics' && n.ip !== 'dhcp'
                        && (!n.hasOwnProperty('netmask')
                        || !net.isIPv4(n.netmask))) {

                        callback(new Error('invalid or missing .netmask option '
                            + 'for NIC: ' + JSON.stringify(n)));
                        return;
                    }

                    if ((field === 'add_nics' || field === 'update_nics')
                        && n.hasOwnProperty('ip') && n.ip !== 'dhcp'
                        && !net.isIPv4(n.ip)) {

                        callback(new Error('invalid IP for NIC: '
                            + JSON.stringify(n)));
                        return;
                    }

                    if (field === 'add_nics' && (!n.hasOwnProperty('nic_tag')
                        || !n.nic_tag.match(/^[a-zA-Z0-9\_\/]+$/))) {

                        callback(new Error('invalid or missing .nic_tag option '
                            + 'for NIC: ' + JSON.stringify(n)));
                        return;
                    }

                    if (field === 'update_nics' && n.hasOwnProperty('model')
                        && (!n.model || n.model === 'undefined'
                        || n.model.length === 0)) {

                        callback(new Error('invalid .model option for NIC: '
                            + JSON.stringify(n)));
                        return;
                    }

                    if (field === 'update_nics' && n.hasOwnProperty('netmask')
                        && (!n.netmask || !net.isIPv4(n.netmask))) {

                        callback(new Error('invalid .netmask option for NIC: '
                            + JSON.stringify(n)));
                        return;
                    }

                    if (field === 'update_nics' && n.hasOwnProperty('nic_tag')
                        && !n.nic_tag.match(/^[a-zA-Z0-9\_]+$/)) {

                        callback(new Error('invalid .nic_tag option for NIC: '
                            + JSON.stringify(n)));
                        return;
                    }

                    if (n.hasOwnProperty('mac')
                        || n.hasOwnProperty('vrrp_vrid')) {
                        mac = n.hasOwnProperty('mac') ? n.mac
                            : vrrpMAC(n.vrrp_vrid);
                        if (nics_result.hasOwnProperty(mac)) {
                            var p;
                            for (p in n) {
                                nics_result[mac][p] = n[p];
                            }

                            nics_result_ordered.forEach(function (on) {
                                if (on.hasOwnProperty('mac') && on.mac == mac) {
                                    for (p in n) {
                                        on[p] = n[p];
                                    }
                                }
                            });
                        } else {
                            nics_result[mac] = n;
                            nics_result_ordered.push(n);
                        }
                    }

                    if ((field === 'add_nics' || field === 'update_nics')
                        && n.hasOwnProperty('allowed_ips')) {
                        try {
                            validateIPlist(n.allowed_ips);
                        } catch (ipListErr) {
                            callback(ipListErr);
                            return;
                        }
                    }

                }
            }
        }
    }

    if (payload.hasOwnProperty('remove_nics')) {
        for (m in payload.remove_nics) {
            m = payload.remove_nics[m];
            n = nics_result[m];
            if (!n) {
                continue;
            }
            if (n.hasOwnProperty('ip') && n.ip != 'dhcp') {
                i = ips.indexOf(n.ip);
                if (i !== -1) {
                    ips.splice(i, 1);
                    ipNics.splice(i, 1);
                }
                i = current_ips.indexOf(n.ip);
                if (i !== -1) {
                    current_ips.splice(i, 1);
                }
            }
            delete nics_result[m];

            for (i in nics_result_ordered) {
                n = nics_result_ordered[i];
                if (n.hasOwnProperty('mac') && n.mac == m) {
                    nics_result_ordered.splice(i, 1);
                    break;
                }
            }
        }
    }

    // nics_result now has the state of the nics after the update - now check
    // properties that depend on each other or on other nics
    for (n in nics_result) {
        n = nics_result[n];
        if (n.hasOwnProperty('vrrp_vrid')) {
            if (n.hasOwnProperty('ip')
                && current_primary_ips.indexOf(n.ip) !== -1) {
                callback(
                    new Error(
                        'Cannot set vrrp_primary_ip to the IP of a VRRP nic'));
                return;
            }

            if (!n.hasOwnProperty('vrrp_primary_ip')) {
                callback(new Error(
                    'vrrp_vrid set but not vrrp_primary_ip'));
                return;
            }
        } else {
            only_vrrp_nics = false;
        }
    }

    if (only_vrrp_nics && Object.keys(nics_result).length !== 0) {
        callback(new Error('VM cannot contain only VRRP nics'));
        return;
    }

    for (i in current_primary_ips) {
        i = current_primary_ips[i];
        if ((current_ips.indexOf(i) === -1)
            && (ips.indexOf(i) === -1)) {
            callback(new Error(
                'vrrp_primary_ip must belong to the same VM'));
            return;
        }
    }

    // Since we always need a primary nic, don't allow a value other than true
    // for primary flag. Also ensure we're not trying to set primary for more
    // than one nic.
    if (primary_nics > 1) {
        callback(new Error('payload specifies more than 1 primary NIC'));
        return;
    }

    if (payload.hasOwnProperty('vga')
        && VM.VGA_TYPES.indexOf(payload.vga) === -1) {

        callback(new Error('Invalid VGA type: "' + payload.vga
            + '", supported types are: ' + VM.VGA_TYPES.join(',')));
        return;
    }

    function validLocalRoute(r) {
        var nicIdx = r.match(/nics\[(\d+)\]/);
        if (!nicIdx) {
            is_nic = false;
            return false;
        }
        is_nic = true;

        if (nics_result_ordered.length === 0) {
            return false;
        }

        nicIdx = Number(nicIdx[1]);
        if (!nics_result_ordered[nicIdx]
            || !nics_result_ordered[nicIdx].hasOwnProperty('ip')
            || nics_result_ordered[nicIdx].ip === 'dhcp') {
            return false;
        }

        return true;
    }

    props = [ 'routes', 'set_routes' ];
    for (prop in props) {
        prop = props[prop];
        if (payload.hasOwnProperty(prop)) {
            for (dst in payload[prop]) {
                var src = payload[prop][dst];

                if (!net.isIPv4(dst) && !isCIDR(dst)) {
                    callback(new Error('Invalid route destination: "' + dst
                        + '" (must be IP address or CIDR)'));
                    return;
                }

                if (!net.isIPv4(src) && !validLocalRoute(src)) {
                    callback(new Error(
                        is_nic ? 'Route gateway: "' + src
                            + '" refers to non-existent or DHCP nic'
                        : 'Invalid route gateway: "' + src
                            + '" (must be IP address or nic)'));
                    return;
                }

                routes_result[dst] = src;
            }
        }
    }

    if (payload.hasOwnProperty('remove_routes')) {
        for (dst in payload.remove_routes) {
            dst = payload.remove_routes[dst];
            delete routes_result[dst];
        }
    }

    // Now that we've applied all updates to routes, make sure that all
    // link-local routes refer to a nic that still exists
    for (dst in routes_result) {
        if (!net.isIPv4(routes_result[dst])
            && !validLocalRoute(routes_result[dst])) {
            callback(new Error('Route gateway: "' + routes_result[dst]
                + '" refers to non-existent or DHCP nic'));
            return;
        }
    }

    // Ensure password is not too long
    if (payload.hasOwnProperty('vnc_password')
        && payload.vnc_password.length > 8) {

        callback(new Error('VNC password is too long, maximum length is 8 '
            + 'characters.'));
        return;
    }

    props = ['zfs_root_recsize', 'zfs_data_recsize'];
    for (prop in props) {
        prop = props[prop];
        if (payload.hasOwnProperty(prop)) {
            if (payload[prop] === 0 || payload[prop] === '') {
                // this is the default, so set it back to that.
                payload[prop] = 131072;
            } else if (!validRecordSize(payload[prop])) {
                callback(new Error('invalid ' + prop + ' (' + payload[prop]
                    + '), must be 512-131072 and a power of 2. '
                    + '(0 to disable)'));
                return;
            }
        }
    }
    props = ['zfs_root_compression', 'zfs_data_compression'];
    for (prop in props) {
        prop = props[prop];

        if (payload.hasOwnProperty(prop)) {
            if (VM.COMPRESSION_TYPES.indexOf(payload[prop]) === -1) {
                callback(new Error('invalid compression type for '
                    + payload[prop] + ', must be one of: '
                    + VM.COMPRESSION_TYPES.join(', ')));
            }
        }
    }
    props = ['zfs_filesystem_limit', 'zfs_snapshot_limit'];
    for (prop in props) {
        prop = props[prop];
        if (payload.hasOwnProperty(prop)) {
            if (payload[prop] === undefined) {
                payload[prop] = 'none';
            } else {
                limit = Number(payload[prop]);
                if (isNaN(limit) || (limit < 0)) {
                    callback(new Error('invalid ' + prop + ' (' + payload[prop]
                        + '), must be a number >= 0 (or \'\' to disable)'));
                    return;
                }
            }
        }
    }

    // Ensure MACs and IPs are not already used on this vm
    // NOTE: can't check other nodes yet.

    async.series([
        function (cb) {
            lookupConflicts(macs, ips, ipNics, vrids, log,
                    function (error, conflict) {
                if (error) {
                    cb(error);
                } else {
                    if (conflict) {
                        cb(new Error('Conflict detected with another '
                            + 'vm, please check the MAC, IP, and VRID'));
                    } else {
                        log.debug('no conflicts');
                        cb();
                    }
                }
            });
        }, function (cb) {
            validateNicTags(changed_nics, log, function (e) {
                if (e) {
                    cb(e);
                } else {
                    cb();
                }
            });
        }
    ], function (err) {
        log.trace('leaving checkPayloadProperties()');
        callback(err);
    });
}

function createDelegatedDataset(payload, log, callback)
{
    var args;
    var ds;
    var tracers_obj;
    var zcfg = '';

    assert(log, 'no logger passed to createDelegatedDataset()');

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('create-delegated-dataset', log,
            callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    if (payload.delegate_dataset) {
        log.info('creating delegated dataset.');
        if (!payload.hasOwnProperty('zfs_filesystem')) {
            callback(new Error('payload missing zfs_filesystem'));
            return;
        }
        ds = path.join(payload.zfs_filesystem, '/data');

        args = ['create'];
        if (payload.hasOwnProperty('zfs_data_compression')) {
            args.push('-o', 'compression=' + payload.zfs_data_compression);
        }
        if (payload.hasOwnProperty('zfs_data_recsize')) {
            args.push('-o', 'recsize=' + payload.zfs_data_recsize);
        }
        args.push(ds);

        zfs(args, log, function (err) {
            if (err) {
                callback(err);
                return;
            }

            zcfg = zcfg + 'add dataset; set name=' + ds + '; end\n';
            zonecfg(['-u', payload.uuid, zcfg], log, function (e, fds) {
                if (e) {
                    log.error({'err': e, stdout: fds.stdout,
                        stderr: fds.stderr}, 'unable to add delegated dataset '
                        + ds + ' to ' + payload.uuid);
                    callback(e);
                } else {
                    log.debug({stdout: fds.stdout, stderr: fds.stderr},
                        'added delegated dataset ' + ds);
                    callback();
                }
            });
        });
    } else {
        callback();
    }
}

function buildAddRemoveList(vmobj, payload, type, key, updatable)
{
    var add = [];
    var add_key;
    var field;
    var newobj;
    var oldobj;
    var plural = type + 's';
    var remove = [];
    var remove_key;
    var update_key;

    // initialize some plurals
    add_key = 'add_' + plural;
    remove_key = 'remove_' + plural;
    update_key = 'update_' + plural;

    // There's no way to update properties on a disk or nic with zonecfg
    // currently.  Yes, really.  So any disks/nics that should be updated, we
    // remove then add with the new properties.
    if (payload.hasOwnProperty(update_key)) {
        for (newobj in payload[update_key]) {
            newobj = payload[update_key][newobj];
            for (oldobj in vmobj[plural]) {
                oldobj = vmobj[plural][oldobj];

                if (oldobj[key] === newobj[key]) {
                    // This is the one to update: remove and add.
                    remove.push(oldobj[key]);

                    // only some fields make sense to update.
                    for (field in updatable) {
                        field = updatable[field];
                        if (newobj.hasOwnProperty(field)) {
                            oldobj[field] = newobj[field];
                        }
                    }

                    add.push(oldobj);
                }
            }
        }
    }

    if (payload.hasOwnProperty(remove_key)) {
        for (newobj in payload[remove_key]) {
            newobj = payload[remove_key][newobj];
            remove.push(newobj);
        }
    }

    if (payload.hasOwnProperty(add_key)) {
        for (newobj in payload[add_key]) {
            newobj = payload[add_key][newobj];
            add.push(newobj);
        }
    }

    return ({'add': add, 'remove': remove});
}

function buildDatasetZonecfg(vmobj, payload)
{
    var zcfg = '';

    payload.datasets.forEach(function (ds) {
        zcfg = zcfg + 'add dataset; set name="' + ds + '"; end\n';
    });

    return (zcfg);
}

function buildDiskZonecfg(vmobj, payload)
{
    var add = [];
    var disk;
    var lists;
    var remove = [];
    var zcfg = '';

    lists = buildAddRemoveList(vmobj, payload, 'disk', 'path',
        UPDATABLE_DISK_PROPS);
    remove = lists.remove;
    add = lists.add;

    // remove is a list of disk paths, add a remove for each now.
    for (disk in remove) {
        disk = remove[disk];
        zcfg = zcfg + 'remove -F device match=' + disk + '\n';
    }

    for (disk in add) {
        disk = add[disk];

        zcfg = zcfg + 'add device\n'
            + 'set match=' + disk.path + '\n'
            + 'add property (name=boot, value="'
            + (disk.boot ? 'true' : 'false') + '")\n'
            + 'add property (name=model, value="' + disk.model + '")\n';

        if (disk.hasOwnProperty('media')) {
            zcfg = zcfg
                + 'add property (name=media, value="'
                + disk.media + '")\n';
        }

        if (disk.hasOwnProperty('image_size')) {
            zcfg = zcfg
                + 'add property (name=image-size, value="'
                + disk.image_size + '")\n';
        } else if (disk.hasOwnProperty('size')) {
            zcfg = zcfg + 'add property (name=size, value="'
                + disk.size + '")\n';
        }

        if (disk.hasOwnProperty('image_uuid')) {
            zcfg = zcfg
                + 'add property (name=image-uuid, value="'
                + disk.image_uuid + '")\n';
        }

        if (disk.hasOwnProperty('image_name')) {
            zcfg = zcfg + 'add property (name=image-name, value="'
                + disk.image_name + '")\n';
        }

        zcfg = zcfg + 'end\n';
    }

    return zcfg;
}

function buildNicZonecfg(vmobj, payload, log)
{
    var add;
    var brand;
    var interface_prefix;
    var lists;
    var matches;
    var n;
    var new_nics = [];
    var new_primary;
    var nic;
    var nic_idx = 0;
    var old_primary;
    var re;
    var remove;
    var used_nic_indexes = [];
    var zcfg = '';

    if (vmobj && vmobj.hasOwnProperty('brand')) {
        brand = vmobj.brand;
    } else {
        brand = payload.brand;
    }

    if (BRAND_OPTIONS[brand].features.interface_prefix) {
        interface_prefix = BRAND_OPTIONS[brand].features.interface_prefix;
    } else {
        interface_prefix = 'net';
    }

    if (vmobj.hasOwnProperty('nics')) {
        // check whether we're adding or updating to set the primary flag. If we
        // are also find the existing NIC with the primary flag. If that's not
        // being removed, update it to remove the primary flag.
        if (payload.hasOwnProperty('add_nics')) {
            for (nic in payload.add_nics) {
                nic = payload.add_nics[nic];
                if (nic.hasOwnProperty('primary') && nic.primary) {
                    new_primary = nic.mac;
                }
                new_nics.push(nic.mac);
            }
        }
        if (payload.hasOwnProperty('update_nics')) {
            for (nic in payload.update_nics) {
                nic = payload.update_nics[nic];
                if (nic.hasOwnProperty('primary') && nic.primary) {
                    new_primary = nic.mac;
                }
            }
        }

        // add existing NICs that we're keeping to new_nics
        vmobj.nics.forEach(function (obj_nic) {
            if (!(payload.remove_nics
                && payload.remove_nics.indexOf(obj_nic.mac) !== -1)) {

                // not removing this one, so include in the list
                new_nics.push(obj_nic.mac);
            }
        });

        /*
         * If we're removing the current primary and we're not adding a new
         * primary, we attempt to pick a new primary. The selection order is:
         *
         *  1) the lowest indexed member that *doesn't* match isPrivateIP()
         *  2) if all match isPrivateIP(), the lowest index that is not being
         *     removed.
         */
        if (payload.hasOwnProperty('remove_nics') && !new_primary) {
            payload.remove_nics.forEach(function (mac) {
                var public_candidate;
                var private_candidate;
                var should_choose = false;

                vmobj.nics.forEach(function (old_nic) {
                    if (old_nic.mac === mac && old_nic.primary) {
                        log.debug('removing primary NIC and no successor passed'
                            + ', choosing one.');

                        should_choose = true;
                        old_primary = old_nic.mac;
                    } else {
                        if (payload.remove_nics.indexOf(old_nic.mac) == -1) {
                            // this is not being removed, so if it's private and
                            // we've not found a private at a lower index it's
                            // our private candidate. Do the same for
                            // public_candidate if it's not a private IP.
                            if (!private_candidate && isPrivateIP(old_nic.ip)) {
                                log.debug('choosing ' + old_nic.mac + ' as '
                                    + 'private candidate');
                                private_candidate = old_nic.mac;
                            } else if (!public_candidate
                                && !isPrivateIP(old_nic.ip)) {

                                log.debug('choosing ' + old_nic.mac + ' as '
                                    + 'public candidate');
                                public_candidate = old_nic.mac;
                            }
                        }
                    }
                });

                if (should_choose) {
                    if (public_candidate) {
                        new_primary = public_candidate;
                        log.info('new primary will be ' + new_primary);
                    } else if (private_candidate) {
                        new_primary = private_candidate;
                        log.info('new primary will be ' + new_primary);
                    } else {
                        log.warn('no worthy candidates for new primary to '
                            + 'replace outgoing primary ' + old_primary);
                    }
                }
            });
        }
    } else {
        // if we didn't already have nics, new_primary becomes whichever nic is
        // set primary in the add_nics payload.
        if (payload.hasOwnProperty('add_nics')) {
            payload.add_nics.forEach(function (add_nic) {
                if (add_nic.primary) {
                    new_primary = add_nic.mac;
                }
                new_nics.push(add_nic.mac);
            });
        }
    }

    lists = buildAddRemoveList(vmobj, payload, 'nic', 'mac',
        UPDATABLE_NIC_PROPS);
    remove = lists.remove;
    add = lists.add;

    // create a list of used indexes so we can find the free ones
    if (vmobj.hasOwnProperty('nics')) {
        re = new RegExp('^' + interface_prefix + '(\\d+)$');
        for (n in vmobj.nics) {
            if (vmobj.nics[n].hasOwnProperty('interface')) {
                matches = vmobj.nics[n].interface.match(re);
                if (matches) {
                    used_nic_indexes.push(Number(matches[1]));
                }
            }
        }
    }

    // assign next available interface for nics without one
    for (nic in add) {
        nic = add[nic];
        if (!nic.hasOwnProperty('interface')) {
            while (used_nic_indexes.indexOf(nic_idx) !== -1) {
                nic_idx++;
            }
            nic.interface = interface_prefix + nic_idx;
            used_nic_indexes.push(Number(nic_idx));
        }

        // Changing the VRID changes the MAC address too, since the VRID is
        // encoded in the MAC. This can't be done until after
        // buildAddRemoveList above, since mac is used as the key to figure
        // out which nic is which
        if (nic.hasOwnProperty('vrrp_vrid')) {
            nic.mac = vrrpMAC(nic.vrrp_vrid);
        }
    }

    // remove is a list of nic macs, add a remove for each now.
    for (nic in remove) {
        nic = remove[nic];
        zcfg = zcfg + 'remove net mac-addr=' + ruinMac(nic) + '\n';
    }

    // properties that don't require any validation - add them if they're
    // present:
    var nicProperties = ['ip', 'netmask', 'network_uuid', 'model',
        'dhcp_server', 'allow_dhcp_spoofing', 'blocked_outgoing_ports',
        'allow_ip_spoofing', 'allow_mac_spoofing', 'allow_restricted_traffic',
        'allow_unfiltered_promisc', 'vrrp_vrid', 'vrrp_primary_ip', 'mtu' ];

    // we add all the properties here except primary, primary gets set below
    // if we're getting a new one.
    for (nic in add) {
        nic = add[nic];

        zcfg = zcfg
            + 'add net\n'
            + 'set physical=' + nic.interface + '\n'
            + 'set mac-addr=' + ruinMac(nic.mac) + '\n';

        if (nic.hasOwnProperty('nic_tag')) {
            zcfg = zcfg + 'set global-nic=' + nic.nic_tag + '\n';
        }

        if (nic.hasOwnProperty('gateway') && nic.gateway.length > 0) {
            zcfg = zcfg + 'add property (name=gateway, value="'
                + nic.gateway + '")\n';
        }

        if (nic.hasOwnProperty('vlan_id') && (nic.vlan_id !== '0')) {
            zcfg = zcfg + 'set vlan-id=' + nic.vlan_id + '\n';
        }

        if (nic.hasOwnProperty('allowed_ips')) {
            zcfg = zcfg
                + 'add property (name=allowed_ips, value="'
                + nic.allowed_ips.join(',') + '")\n';
        }

        for (var prop in nicProperties) {
            prop = nicProperties[prop];
            if (nic.hasOwnProperty(prop)) {
                zcfg = zcfg + 'add property (name=' + prop + ', value="'
                    + nic[prop] + '")\n';
            }
        }

        // If we're not setting a new primary, keep the old one
        if (!new_primary && nic.hasOwnProperty('primary') && nic.primary) {
            zcfg = zcfg + 'add property (name=primary, value="true")\n';
        }

        zcfg = zcfg + 'end\n';
    }

    if (new_primary) {
        /*
         * We have a new primary NIC either because:
         *
         *  - we added a new NIC w/ primary: true
         *  - we got an update to set primary: true on an existing NIC
         *  - we removed the primary and selected a new one
         *
         * so what we'll do is append to zcfg an update for each NIC setting
         * primary to true for the primary and false for everybody else.
         */

        new_nics.forEach(function (new_nic) {
            if (new_nic === new_primary) {
                zcfg = zcfg + 'select net mac-addr=' + ruinMac(new_nic) + '; '
                    + 'add property (name=primary,value="true"); '
                    + 'end\n';
            } else {
                // Make sure all non-primary *don't* have the primary flag
                zcfg = zcfg + 'select net mac-addr=' + ruinMac(new_nic) + '; '
                    + 'remove -F property (name=primary,value="true"); '
                    + 'end\n';
            }
        });
    }

    return zcfg;
}

function buildFilesystemZonecfg(vmobj, payload, options)
{
    var add = [];
    var filesystem;
    var lists;
    var opt;
    var remove = [];
    var zcfg = '';

    if (!options) {
        options = {};
    }

    lists = buildAddRemoveList(vmobj, payload, 'filesystem', 'target', []);
    remove = lists.remove;
    add = lists.add;

    // remove is a list of disk paths, add a remove for each now.
    for (filesystem in remove) {
        filesystem = remove[filesystem];
        zcfg = zcfg + 'remove fs match=' + filesystem + '\n';
    }

    for (filesystem in add) {
        filesystem = add[filesystem];

        if ((isUUID(filesystem.source) /* JSSTYLED */
            || filesystem.source.match(/^https?:\/\//))
            && !options.include_created) {

            // When we're creating the filesystem we do that *after* we've built
            // the zonecfg. This is because on initial VM creation the zoneadm
            // install is what creates the root dataset, so we have to create
            // the filesystems after that. But we need the filesystems to create
            // the zone too.
            continue;
        }

        zcfg = zcfg + 'add fs\n' + 'set dir=' + filesystem.target + '\n'
            + 'set special=' + filesystem.source + '\n' + 'set type='
            + filesystem.type + '\n';
        if (filesystem.hasOwnProperty('raw')) {
            zcfg = zcfg + 'set raw=' + filesystem.raw + '\n';
        }
        if (filesystem.hasOwnProperty('options')) {
            for (opt in filesystem.options) {
                opt = filesystem.options[opt];
                zcfg = zcfg + 'add options "' + opt + '"\n';
            }
        }
        zcfg = zcfg + 'end\n';
    }

    return zcfg;
}

function buildZonecfgUpdate(vmobj, payload, log)
{
    var brand;
    var log_driver = 'json-file';
    var tmp;
    var tty_value = undefined;
    var zcfg = '';

    assert(log, 'no logger passed to buildZonecfgUpdate()');

    log.debug({vmobj: vmobj, payload: payload},
        'parameters to buildZonecfgUpdate()');

    if (vmobj && vmobj.hasOwnProperty('brand')) {
        brand = vmobj.brand;
    } else {
        brand = payload.brand;
    }

    // Global properties can just be set, no need to clear anything first.
    if (payload.hasOwnProperty('cpu_shares')) {
        zcfg = zcfg + 'set cpu-shares=' + payload.cpu_shares.toString() + '\n';
    }
    if (payload.hasOwnProperty('limit_priv')) {
        zcfg = zcfg + 'set limitpriv="' + payload.limit_priv + '"\n';
    }
    if (payload.hasOwnProperty('max_lwps')) {
        zcfg = zcfg + 'set max-lwps=' + payload.max_lwps.toString() + '\n';
    }
    if (payload.hasOwnProperty('max_msg_ids')) {
        zcfg = zcfg + 'set max-msg-ids=' + payload.max_msg_ids.toString()
            + '\n';
    }
    if (payload.hasOwnProperty('max_sem_ids')) {
        zcfg = zcfg + 'set max-sem-ids=' + payload.max_sem_ids.toString()
            + '\n';
    }
    if (payload.hasOwnProperty('max_shm_ids')) {
        zcfg = zcfg + 'set max-shm-ids=' + payload.max_shm_ids.toString()
            + '\n';
    }
    if (payload.hasOwnProperty('max_shm_memory')) {
        zcfg = zcfg + 'set max-shm-memory='
            + (payload.max_shm_memory * 1024 * 1024).toString() + '\n';
    }
    if (payload.hasOwnProperty('zfs_io_priority')) {
        zcfg = zcfg + 'set zfs-io-priority='
            + payload.zfs_io_priority.toString() + '\n';
    }

    if (!BRAND_OPTIONS[brand].features.use_vm_autoboot
        && payload.hasOwnProperty('autoboot')) {

        // kvm autoboot is managed by the vm-autoboot attr instead
        zcfg = zcfg + 'set autoboot=' + payload.autoboot.toString() + '\n';
    }

    // Capped Memory properties are special
    if (payload.hasOwnProperty('max_physical_memory')
        || payload.hasOwnProperty('max_locked_memory')
        || payload.hasOwnProperty('max_swap')) {

        // Capped memory parameters need either an add or select first.
        if (vmobj.hasOwnProperty('max_physical_memory')
            || vmobj.hasOwnProperty('max_locked_memory')
            || vmobj.hasOwnProperty('max_swap')) {

            // there's already a capped-memory section, use that.
            zcfg = zcfg + 'select capped-memory; ';
        } else {
            zcfg = zcfg + 'add capped-memory; ';
        }

        if (payload.hasOwnProperty('max_physical_memory')) {
            zcfg = zcfg + 'set physical='
                + payload.max_physical_memory.toString() + 'm; ';
        }
        if (payload.hasOwnProperty('max_locked_memory')) {
            zcfg = zcfg + 'set locked='
                + payload.max_locked_memory.toString() + 'm; ';
        }
        if (payload.hasOwnProperty('max_swap')) {
            zcfg = zcfg + 'set swap='
                + payload.max_swap.toString() + 'm; ';
        }

        zcfg = zcfg + 'end\n';
    }

    // Capped CPU is special
    if (payload.hasOwnProperty('cpu_cap')) {
        if (vmobj.hasOwnProperty('cpu_cap')) {
            zcfg = zcfg + 'select capped-cpu; ';
        } else {
            zcfg = zcfg + 'add capped-cpu; ';
        }

        zcfg = zcfg + 'set ncpus='
            + (Number(payload.cpu_cap) * 0.01).toString() + '; end\n';
    }

    // set to empty string so property is removed when not true or when not
    // false if that's the default for the property.
    if (payload.hasOwnProperty('do_not_inventory')) {
        if (payload.do_not_inventory !== true) {
            // removing sets false as that's the default.
            payload.do_not_inventory = '';
        }
    }

    if (payload.hasOwnProperty('docker')) {
        if (payload.docker !== true) {
            // removing sets false as that's the default.
            payload.docker = '';
        }
    }

    if (payload.hasOwnProperty('archive_on_delete')) {
        if (payload.archive_on_delete !== true) {
            // removing sets false as that's the default.
            payload.archive_on_delete = '';
        }
    }

    if (payload.hasOwnProperty('firewall_enabled')) {
        if (payload.firewall_enabled !== true) {
            // removing sets false as that's the default.
            payload.firewall_enabled = '';
        }
    }

    if (payload.hasOwnProperty('maintain_resolvers')) {
        if (payload.maintain_resolvers !== true) {
            // removing sets false as that's the default.
            payload.maintain_resolvers = '';
        }
    }

    if (payload.hasOwnProperty('restart_init')) {
        if (payload.restart_init === true) {
            // removing sets true as that's the default.
            payload.restart_init = '';
        }
    }

    // Attributes
    function setAttr(attr, attr_name, value) {

        var remove_attr = false;

        if (!value) {
            value = payload[attr_name];
        }

        if (typeof (value) !== 'boolean') {
            if (!value || (trim(value.toString()) === '')) {
                if (KEEP_ZERO_PROPERTIES.indexOf(attr_name) !== -1) {
                    // we keep zero values for this attribute, but not other
                    // false-y values.
                    if (value !== 0) {
                        remove_attr = true;
                    }
                } else {
                    remove_attr = true;
                }
            }
        }

        if (payload.hasOwnProperty(attr_name)) {
            if (remove_attr) {
                // empty values we either remove or ignore.
                if (vmobj.hasOwnProperty(attr_name)) {
                    zcfg = zcfg + 'remove -F attr name=' + attr + ';';
                    // else do nothing, we don't add empty values.
                }
            } else {
                if (attr_name === 'resolvers'
                    && vmobj.hasOwnProperty('resolvers')
                    && vmobj.resolvers.length === 0) {

                    // special case for resolvers: we always have 'resolvers'
                    // in the object, but if it's empty we don't have it in the
                    // zonecfg. Add instead of the usual update.
                    zcfg = zcfg + 'add attr; set name="' + attr + '"; '
                        + 'set type=string; ';

                } else if (attr_name === 'firewall_enabled'
                    && vmobj.hasOwnProperty('firewall_enabled')
                    && !vmobj.firewall_enabled) {

                    // firewall_enabled is similar to resolvers: if it's set
                    // to false, it won't be in the zonecfg, which requires
                    // an add rather than an update.
                    zcfg = zcfg + 'add attr; set name="' + attr + '"; '
                        + 'set type=string; ';

                } else if (vmobj.hasOwnProperty(attr_name)) {
                    zcfg = zcfg + 'select attr name=' + attr + '; ';
                } else {
                    zcfg = zcfg + 'add attr; set name="' + attr + '"; '
                        + 'set type=string; ';
                }
                zcfg = zcfg + 'set value="' + value.toString() + '"; end\n';
            }
        }
    }

    setAttr('billing-id', 'billing_id');
    setAttr('owner-uuid', 'owner_uuid');
    setAttr('package-name', 'package_name');
    setAttr('package-version', 'package_version');
    setAttr('tmpfs', 'tmpfs');
    setAttr('hostname', 'hostname');
    setAttr('dns-domain', 'dns_domain');
    setAttr('default-gateway', 'default_gateway');
    setAttr('do-not-inventory', 'do_not_inventory');
    setAttr('docker', 'docker');
    setAttr('archive-on-delete', 'archive_on_delete');
    setAttr('firewall-enabled', 'firewall_enabled');
    setAttr('restart-init', 'restart_init');
    setAttr('init-name', 'init_name');
    setAttr('disk-driver', 'disk_driver');
    setAttr('nic-driver', 'nic_driver');
    setAttr('maintain-resolvers', 'maintain_resolvers');
    setAttr('kernel-version', 'kernel_version');

    if (payload.hasOwnProperty('resolvers')) {
        assert(Array.isArray(payload.resolvers));
        setAttr('resolvers', 'resolvers', payload.resolvers.join(','));
    }

    if (payload.hasOwnProperty('internal_metadata_namespaces')) {
        assert(Array.isArray(payload.internal_metadata_namespaces));
        setAttr('internal-metadata-namespaces', 'internal_metadata_namespaces',
            payload.internal_metadata_namespaces.join(','));
    }

    /*
     * zlog-mode should always be set for 'docker' VMs.
     *
     * There are 4 cases here:
     *
     *   - tty and json-file
     *       - write to the log in the GZ, zlog-mode=interactive
     *
     *   - tty and any other logdriver
     *       - don't write to the log in the GZ, zlog-mode=nlinteractive
     *
     *   - no tty and json-file
     *       - write to the log in the GZ, zlog-mode=logging
     *
     *   - no tty and any other logdriver
     *       - don't write to the log in the GZ, zlog-mode=nologging
     *
     * When we have one of the "no logging" modes, that just means we're not
     * going to log from the GZ, logging will happen in the zone.
     *
     */
    log.info({payload: payload}, 'checking for docker:tty!');
    if (payload.docker || (vmobj && vmobj.docker)) {
        if (payload.hasOwnProperty('set_internal_metadata')
            && payload.set_internal_metadata.hasOwnProperty('docker:tty')) {

            if (payload.set_internal_metadata['docker:tty']) {
                tty_value = true;
            } else {
                tty_value = false;
            }
        } else if (payload.hasOwnProperty('internal_metadata')
            && payload.internal_metadata.hasOwnProperty('docker:tty')) {

            if (payload.internal_metadata['docker:tty']) {
                tty_value = true;
            } else {
                tty_value = false;
            }
        } else if (payload.hasOwnProperty('remove_internal_metadata')
            && payload.remove_internal_metadata.indexOf('docker:tty') !== -1) {

            tty_value = false;
        }

        if (payload.hasOwnProperty('set_internal_metadata')
            && payload.set_internal_metadata
            .hasOwnProperty('docker:logdriver')) {

            log_driver = payload.set_internal_metadata['docker:logdriver'];

        } else if (payload.hasOwnProperty('internal_metadata')
            && payload.internal_metadata.hasOwnProperty('docker:logdriver')) {

            log_driver = payload.internal_metadata['docker:logdriver'];
        }

        if (tty_value === true) {
            // if we set docker:tty true, we want interactive
            if (log_driver === 'json-file') {
                zcfg = zcfg + 'remove -F attr name=zlog-mode;\n';
                zcfg = zcfg + 'add attr; set name="zlog-mode"; set type=string;'
                    + ' set value="interactive"; end\n';
            } else {
                zcfg = zcfg + 'remove -F attr name=zlog-mode;\n';
                zcfg = zcfg + 'add attr; set name="zlog-mode"; set type=string;'
                    + ' set value="nlinteractive"; end\n';
            }
        } else {
            // if we set docker:tty false, or remove docker:tty we want logging
            // if we never set docker:tty (undefined) we also default to logging
            if (log_driver === 'json-file') {
                zcfg = zcfg + 'remove -F attr name=zlog-mode;\n';
                zcfg = zcfg + 'add attr; set name="zlog-mode"; set type=string;'
                    + ' set value="logging"; end\n';
            } else {
                zcfg = zcfg + 'remove -F attr name=zlog-mode;\n';
                zcfg = zcfg + 'add attr; set name="zlog-mode"; set type=string;'
                    + ' set value="nologging"; end\n';
            }
        }
    }

    if (payload.hasOwnProperty('alias')) {
        tmp = '';
        if (payload.alias) {
            tmp = new Buffer(payload.alias).toString('base64');
        }
        setAttr('alias', 'alias', tmp);
    }

    if (BRAND_OPTIONS[brand].features.use_vm_autoboot) {
        setAttr('vm-autoboot', 'autoboot');
    }

    // XXX Used on KVM but can be passed in for 'OS' too. We only setAttr on KVM
    if (BRAND_OPTIONS[brand].features.type === 'KVM') {
        setAttr('ram', 'ram');
    }

    // NOTE: Thanks to normalizePayload() we'll only have these when relevant
    setAttr('vcpus', 'vcpus');
    setAttr('boot', 'boot');
    setAttr('cpu-type', 'cpu_type');
    setAttr('vga', 'vga');
    setAttr('vnc-port', 'vnc_port');
    setAttr('spice-port', 'spice_port');
    setAttr('virtio-txtimer', 'virtio_txtimer');
    setAttr('virtio-txburst', 'virtio_txburst');

    // We use base64 here for these next five options:
    //
    //  vnc_password
    //  spice_password
    //  spice_opts
    //  qemu_opts
    //  qemu_extra_opts
    //
    // since these can contain characters zonecfg doesn't like.
    //
    if (payload.hasOwnProperty('vnc_password')) {
        if (payload.vnc_password === ''
            && (vmobj.hasOwnProperty('vnc_password')
            && vmobj.vnc_password !== '')) {

            log.warn('Warning: VNC password was removed for VM '
                + vmobj.uuid + ' but VM needs to be restarted for change to'
                + 'take effect.');
        }
        if (payload.vnc_password.length > 0
            && !vmobj.hasOwnProperty('vnc_password')) {

            log.warn('Warning: VNC password was added to VM '
                + vmobj.uuid + ' but VM needs to be restarted for change to'
                + 'take effect.');
        }

        setAttr('vnc-password', 'vnc_password',
            new Buffer(payload.vnc_password).toString('base64'));
    }
    if (payload.hasOwnProperty('spice_password')) {
        if (payload.spice_password === ''
            && (vmobj.hasOwnProperty('spice_password')
            && vmobj.spice_password !== '')) {

            log.warn('Warning: SPICE password was removed for VM '
                + vmobj.uuid + ' but VM needs to be restarted for change to'
                + 'take effect.');
        }
        if (payload.spice_password.length > 0
            && !vmobj.hasOwnProperty('spice_password')) {

            log.warn('Warning: SPICE password was added to VM '
                + vmobj.uuid + ' but VM needs to be restarted for change to'
                + 'take effect.');
        }

        setAttr('spice-password', 'spice_password',
            new Buffer(payload.spice_password).toString('base64'));
    }
    if (payload.hasOwnProperty('spice_opts')) {
        setAttr('spice-opts', 'spice_opts',
            new Buffer(payload.spice_opts).toString('base64'));
    }
    if (payload.hasOwnProperty('qemu_opts')) {
        setAttr('qemu-opts', 'qemu_opts',
            new Buffer(payload.qemu_opts).toString('base64'));
    }
    if (payload.hasOwnProperty('qemu_extra_opts')) {
        setAttr('qemu-extra-opts', 'qemu_extra_opts',
            new Buffer(payload.qemu_extra_opts).toString('base64'));
    }

    // Handle disks
    if (payload.hasOwnProperty('disks')
        || payload.hasOwnProperty('add_disks')
        || payload.hasOwnProperty('update_disks')
        || payload.hasOwnProperty('remove_disks')) {

        zcfg = zcfg + buildDiskZonecfg(vmobj, payload);
    }

    if (payload.hasOwnProperty('fs_allowed')) {
        if (payload.fs_allowed === '') {
            zcfg = zcfg + 'clear fs-allowed\n';
        } else {
            zcfg = zcfg + 'set fs-allowed="' + payload.fs_allowed.join(',')
                + '"\n';
        }
    }

    if (payload.hasOwnProperty('filesystems')
        || payload.hasOwnProperty('add_filesystems')
        || payload.hasOwnProperty('update_filesystems')
        || payload.hasOwnProperty('add_filesystems')) {

        zcfg = zcfg + buildFilesystemZonecfg(vmobj, payload);
    }

    // We only get here with a 'datasets' member on payload if we're doing a
    // recive. So in that case we always want to add to zonecfg input.
    if (payload.hasOwnProperty('datasets')) {
        zcfg = zcfg + buildDatasetZonecfg(vmobj, payload);
    }

    zcfg = zcfg + buildNicZonecfg(vmobj, payload, log);

    return zcfg;
}

// Checks that QMP is responding to query-status and if so passes the boolean
// value of the hwsetup parameter to the callback.
//
// vmobj must have:
//
// zonepath
//
function checkHWSetup(vmobj, log, callback)
{
    var q;
    var socket;
    var tracers_obj;

    assert(log, 'no logger passed to checkHWSetup()');

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('check-hwsetup', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    q = new Qmp(log);
    socket = vmobj.zonepath + '/root/tmp/vm.qmp';

    q.connect(socket, function (error) {
        if (error) {
            log.error(error, 'q.connect(): Error: ' + error.message);
            callback(error);
            return;
        }
        q.command('query-status', null, function (e, result) {
            if (e) {
                log.error(e, 'q.command(query-status): Error: ' + e.message);
                callback(e);
                return;
            }
            q.disconnect();
            callback(null, result.hwsetup ? true : false);
            return;
        });
    });
}

// cb (if set) will be called with an Error if we can't setup the interval loop
// otherwise when the loop is shut down.
//
// vmobj must have:
//
//  brand
//  state
//  uuid
//  zonepath
//
function markProvisionedWhenHWSetup(vmobj, options, cb)
{
    var ival_handle;
    var log;
    var loop_interval = 3; // seconds
    var tracers_obj;
    var zoneroot;

    log = options.log;
    assert(log, 'no logger passed to markProvisionedWenHWSetup()');
    assert(vmobj.hasOwnProperty('zonepath'), 'no zonepath in vmobj');

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('mark-provisioned-when-hwsetup', log,
            cb);
        cb = tracers_obj.callback;
        log = tracers_obj.log;
    }

    zoneroot = path.join(vmobj.zonepath, '/root');

    if (!BRAND_OPTIONS[vmobj.brand].features.wait_for_hwsetup) {
        // do nothing for zones where we don't wait for hwsetup
        cb(new Error('brand ' + vmobj.brand + ' does not support hwsetup'));
        return (null);
    }

    // Ensure the dataset doesn't have unsafe links as /var or /var/svc
    // Since we're checking the 'file' provision_success, this also guarantees
    // that if it already exists, it's not a symlink.
    try {
        assertSafeZonePath(zoneroot, '/var/svc/provision_success',
            {type: 'file', enoent_ok: true});
    } catch (e) {
        cb(e);
        return (null);
    }

    if (!options) {
        options = {};
    }

    // if caller wants they can change the interval
    if (options.hasOwnProperty('interval')) {
        loop_interval = options.interval;
    }

    log.debug('setting hwsetup interval ' + vmobj.uuid);
    ival_handle = setInterval(function () {
        VM.load(vmobj.uuid, {fields: ['transition_expire', 'uuid'], log: log},
            function (err, obj) {

            var timeout_remaining;
            var ival = ival_handle;

            function done() {
                if (ival_handle) {
                    log.debug('clearing hwsetup interval ' + vmobj.uuid);
                    clearInterval(ival);
                    ival = null;
                } else {
                    log.debug('done but no hwsetup interval ' + vmobj.uuid);
                }
            }

            if (err) {
                // If the VM was deleted between calls, nothing much we can do.
                log.error(err, 'Unable to load ' + vmobj.uuid + ' '
                    + err.message);
                done();
                cb(err);
                return;
            }

            // we only do anything if we're still waiting for provisioning
            if (vmobj.state !== 'provisioning') {
                done();
                cb();
                return;
            }

            timeout_remaining =
                (Number(obj.transition_expire) - Date.now(0)) / 1000;

            if (timeout_remaining <= 0) {
                // IMPORTANT: this may run multiple times, must be idempotent

                log.warn('Marking VM ' + vmobj.uuid + ' as "failed" because'
                    + ' timeout expired and we are still "provisioning"');
                VM.markVMFailure(vmobj, {log: log}, function (mark_err) {
                    log.warn(mark_err, 'zoneinit failed, zone is '
                        + 'being stopped for manual investigation.');
                    done();
                    cb();
                });
                return;
            }

            checkHWSetup(vmobj, log, function (check_err, result) {
                if (check_err) {
                    log.debug(check_err, 'checkHWSetup Error: '
                        + check_err.message);
                    return;
                }

                if (result) {
                    log.debug('QMP says VM ' + vmobj.uuid
                        + ' completed hwsetup');
                    VM.unsetTransition(vmobj, {log: log}, function (unset_err) {
                        var provisioning;
                        var provision_success;

                        provisioning = path.join(vmobj.zonepath,
                            '/root/var/svc/provisioning');
                        provision_success = path.join(vmobj.zonepath,
                            '/root/var/svc/provision_success');

                        if (unset_err) {
                            log.error(unset_err);
                        } else {
                            log.debug('cleared transition to provisioning on'
                                + ' ' + vmobj.uuid);
                        }

                        fs.rename(provisioning, provision_success,
                            function (e) {

                            if (e) {
                                if (e.code === 'ENOENT') {
                                    log.debug(e);
                                } else {
                                    log.error(e);
                                }
                            }

                            done();
                            cb();
                            return;
                        });
                    });
                }
            });
        });
    }, loop_interval * 1000);

    return (ival_handle);
}

function archiveVM(uuid, options, callback)
{
    var archive_dirname;
    var dirmode;
    var log;
    var patterns_to_archive = [];
    var tracers_obj;
    var vmobj;

    /*jsl:ignore*/
    dirmode = 0755;
    /*jsl:end*/

    if (options.hasOwnProperty('log')) {
        log = options.log;
    } else {
        log = VM.log;
    }

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('archive-vm', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    log.debug('attempting to archive debug data for VM ' + uuid);

    async.series([
        function (cb) {
            // ensure directory exists
            archive_dirname = path.join('/zones/archive', uuid);

            fs.mkdir(archive_dirname, dirmode, function (e) {
                log.debug(e, 'attempted to create ' + archive_dirname);
                cb(e);
                return;
            });
        }, function (cb) {
            VM.load(uuid, {log: log}, function (err, obj) {
                if (err) {
                    cb(err);
                    return;
                }
                vmobj = obj;
                cb();
            });
        }, function (cb) {
            // write vmobj to archive
            var filename;

            filename = path.join(archive_dirname, 'vm.json');

            fs.writeFile(filename, JSON.stringify(vmobj, null, 2) + '\n',
                function (err, result) {

                if (err) {
                    log.error(err, 'failed to create ' + filename + ': '
                        + err.message);
                } else {
                    log.info('archived data to ' + filename);
                }

                cb(); // ignore error
            });
        }, function (cb) {
            var cmdline = '/usr/sbin/zfs list -t all -o name | grep '
                + vmobj.zonename + ' | xargs zfs get -pH all >'
                + path.join(archive_dirname, 'zfs.dump');

            traceExec(cmdline, log, 'zfs-get-properties',
                function (e, stdout, stderr) {

                if (e) {
                    e.stdout = stdout;
                    e.stderr = stderr;
                    log.error({err: e}, 'failed to create '
                        + path.join(archive_dirname, 'zfs.dump'));
                    cb(e);
                    return;
                }
                log.info('archived data to ' + path.join(archive_dirname,
                    'zfs.dump'));
                cb();
            });
        }, function (cb) {
            patterns_to_archive.push({
                src: path.join('/etc/zones/', vmobj.zonename + '.xml'),
                dst: path.join(archive_dirname, 'zone.xml')
            });
            patterns_to_archive.push({
                src: path.join(vmobj.zonepath, 'config'),
                dst: archive_dirname,
                targ: path.join(archive_dirname, 'config')
            });
            patterns_to_archive.push({
                src: path.join(vmobj.zonepath, 'cores'),
                dst: archive_dirname,
                targ: path.join(archive_dirname, 'cores')
            });

            if (vmobj.brand === 'kvm') {
                patterns_to_archive.push({
                    src: path.join(vmobj.zonepath, 'root/tmp/vm*.log*'),
                    dst: path.join(archive_dirname, 'vmlogs'),
                    create_dst_dir: true
                });
                patterns_to_archive.push({
                    src: path.join(vmobj.zonepath, 'root/startvm'),
                    dst: archive_dirname,
                    targ: path.join(archive_dirname, 'startvm')
                });
            } else if (vmobj.docker) {
                patterns_to_archive.push({
                    src: path.join(vmobj.zonepath,
                        'root/var/log/sdc-dockerinit.log'),
                    dst: path.join(archive_dirname, 'dockerinit'),
                    create_dst_dir: true
                });
            } else {
                patterns_to_archive.push({
                    src: path.join(vmobj.zonepath, 'root/var/svc/log/*'),
                    dst: path.join(archive_dirname, 'svclogs'),
                    create_dst_dir: true
                });
                patterns_to_archive.push({
                    src: path.join(vmobj.zonepath, 'root/var/adm/messages*'),
                    dst: path.join(archive_dirname, 'admmsgs'),
                    create_dst_dir: true
                });
            }

            async.forEachSeries(patterns_to_archive, function (pattern, c) {

                function cpPattern(p, cp_cb) {
                    var cmdline = '/usr/bin/cp -RP ' + p.src + ' ' + p.dst;
                    var targ = p.targ || p.dst;

                    traceExec(cmdline, log, 'cp-to-archive',
                        function (e, stdout, stderr) {

                        if (e) {
                            e.stdout = stdout;
                            e.stderr = stderr;
                            log.error({err: e}, 'failed to archive data to '
                                + targ);
                        } else {
                            log.info('archived data to ' + targ);
                        }
                        // we don't return errors here because on error copying
                        // one pattern we still want to grab the others.
                        cp_cb();
                    });
                }

                if (pattern.create_dst_dir) {
                    fs.mkdir(pattern.dst, dirmode, function (e) {
                        if (!e) {
                            log.info('created ' + pattern.dst);
                        } else {
                            log.error({err: e}, 'failed to create '
                                + pattern.dst);
                        }
                        cpPattern(pattern, c);
                    });
                } else {
                    cpPattern(pattern, c);
                }
            }, function (e) {
                log.info('finished archiving VM ' + vmobj.uuid);
                cb(e);
            });
        }
    ], function () {
        // XXX we ignore errors as failures to archive will not block VM delete.
        callback();
    });
}

// vmobj argument should have:
//
// brand
// transition_to
// uuid
// zonename
// zonepath
//
exports.markVMFailure = function (vmobj, options, callback)
{
    var log;
    var tracers_obj;

    assertMockCnUuid();
    throw new Error('UNIMPLEMENTED: markVMFailure');

    // options is optional
    if (arguments.length === 2) {
        callback = arguments[1];
        options = {};
    }

    if (!vmobj || !vmobj.hasOwnProperty('brand')
        || !vmobj.hasOwnProperty('uuid')
        || !vmobj.hasOwnProperty('zonename')
        || !vmobj.hasOwnProperty('zonepath')) {

        callback(new Error('markVMFailure needs brand, uuid, zonename, '
            + 'zonepath'));
        return;
    }

    ensureLogging(true);
    if (options.hasOwnProperty('log')) {
        log = options.log;
    } else {
        log = VM.log.child({action: 'markVMFailure', vm: vmobj.uuid});
    }

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('mark-vm-failure', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    function dumpDebugInfo(zonename, debug_cb) {
        var errors = {};

        async.series([
            function (ptree_cb) {
                // note: if the zone is not running this returns empty but still
                // exits 0
                traceExecFile('/usr/bin/ptree', ['-z', zonename], log, 'ptree',
                    function (ptree_err, ptree_stdout, ptree_stderr) {

                        if (ptree_err) {
                            log.error(ptree_err, 'unable to get ptree from '
                                + zonename + ': ' + ptree_stderr);
                            errors.ptree_err = ptree_err;
                        } else {
                            log.warn('processes running in ' + zonename
                                + ' at fail time:\n' + ptree_stdout);
                        }

                        ptree_cb(); // don't fail on error here.
                    }
                );
            }, function (svcs_cb) {
                traceExecFile('/usr/bin/svcs', ['-xv', '-z', zonename], log,
                    'svcs', function (svcs_err, svcs_stdout, svcs_stderr) {

                        if (svcs_err) {
                            log.error(svcs_err, 'unable to get svcs from '
                                + zonename + ': ' + svcs_stderr);
                            errors.svcs_err = svcs_err;
                        } else {
                            log.warn('svcs -xv output for ' + zonename
                                + ' at fail time:\n' + svcs_stdout);
                        }

                        svcs_cb(); // don't fail on error here.
                    }
                );
            }, function (kstat_cb) {
                traceExecFile('/usr/bin/kstat', ['-n', zonename.substr(0, 30)],
                    log, 'kstat',
                    function (kstat_err, kstat_stdout, kstat_stderr) {

                        if (kstat_err) {
                            log.error(kstat_err, 'unable to get kstats from '
                                + zonename + ': ' + kstat_stderr);
                            errors.kstat_err = kstat_err;
                        } else {
                            log.warn('kstat output for ' + zonename
                                + ' at fail time:\n' + kstat_stdout);
                        }

                        kstat_cb(); // don't fail on error here.
                    }
                );
            }
        ], function () {
            debug_cb(errors);
        });
    }

    async.series([function (debug_cb) {
        dumpDebugInfo(vmobj.zonename, function (debug_err) {
            // note: we don't treat failure to dump debug info as a fatal error.
            log.warn(debug_err, 'zone setup failed, zone is being stopped '
                + 'for manual investigation.');
            debug_cb();
        });
    }, function (zonecfg_cb) {
        var zcfg;

        // Mark the zone as 'failed'
        zcfg = 'remove -F attr name=failed; add attr; set name=failed; '
            + 'set value="provisioning"; set type=string; end';

        zonecfg(['-u', vmobj.uuid, zcfg], log, function (zonecfg_err, fds) {

            if (zonecfg_err) {
                log.error({err: zonecfg_err, stdout: fds.stdout,
                    stderr: fds.stderr}, 'Unable to set failure flag on '
                    + vmobj.uuid + ': ' + zonecfg_err.message);
            } else {
                log.debug({stdout: fds.stdout, stderr: fds.stderr},
                    'set failure flag on ' + vmobj.uuid);
            }

            // ignore failure, so rest of cleanup runs
            zonecfg_cb();
        });
    }, function (transition_cb) {
        // attempt to remove transition
        VM.unsetTransition(vmobj, {log: log}, function (unset_err) {
            if (unset_err) {
                log.error(unset_err);
            }
            // ignore failure, so rest of cleanup runs
            transition_cb();
        });
    }, function (stop_cb) {
        VM.stop(vmobj.uuid, {force: true, log: log},
            function (stop_err) {
                // only log errors because there's nothing to do

                if (stop_err) {
                    log.error(stop_err, 'failed to stop VM '
                        + vmobj.uuid + ': ' + stop_err.message);
                }

                stop_cb();
            }
        );
    }, function (zoneinit_cb) {
        var zoneinit_log;

        if (! BRAND_OPTIONS[vmobj.brand].features.zoneinit) {
            // no zoneinit here, no need to grab log
            zoneinit_cb();
            return;
        }

        zoneinit_log = path.join(vmobj.zonepath,
            'root/var/svc/log/system-zoneinit:default.log');

        fs.stat(zoneinit_log, function (err, stats) {
            if (err && err.code === 'ENOENT') {
                log.debug(zoneinit_log + ' does not exist.');
            } else if (err) {
                log.error({err: err}, 'exception fs.stating ' + zoneinit_log);
            }

            fs.open(zoneinit_log, 'r', function (open_err, fd) {
                var buffer = new Buffer(4096);
                var startpos;

                if (open_err) {
                    log.error({err: open_err}, 'fs.open error');
                    zoneinit_cb();
                    return;
                }

                // 32k should be enough for anyone...
                startpos = stats.size - (4096 * 8);
                if (startpos < 0) {
                    startpos = 0;
                }

                async.whilst(function () {
                    return ((stats.size - startpos) > 0);
                }, function (cb) {
                    fs.read(fd, buffer, 0, 4096, startpos,
                        function (read_err, bytesRead, buff) {

                        log.info({'zoneinit_log': buff.toString()},
                            'data from ' + zoneinit_log + ' ('
                            + startpos + '/' + stats.size + ')');

                        startpos += bytesRead;
                        cb();
                    });
                }, function (read_err) {
                    if (read_err) {
                        zoneinit_cb(read_err);
                        return;
                    }

                    if ((stats.size - startpos) === 0) {
                        log.debug('read complete');
                    } else {
                        log.debug('read incomplete');
                    }
                    zoneinit_cb();
                });
            });

        });
    }], function (err) {
        callback(err);
    });
};

function svccfg(zonepath, args, log, callback)
{
    var cmd = '/usr/sbin/svccfg';
    var exec_options = {};
    var zoneroot = path.join(zonepath, '/root');

    assert(log, 'no logger passed to svccfg()');

    try {
        assertSafeZonePath(zoneroot, '/etc/svc/repository.db',
            {type: 'file', enoent_ok: false});
    } catch (e) {
        log.error(e, 'Error validating /etc/svc/repository.db: ' + e.message);
        callback(e);
        return;
    }

    exec_options = {
        env: {
            'SVCCFG_CONFIGD_PATH': '/lib/svc/bin/svc.configd',
            'SVCCFG_REPOSITORY':
                path.join(zonepath, 'root', '/etc/svc/repository.db')
        }
    };

    traceExecFile(cmd, args, exec_options, log, 'svccfg',
        function (error, stdout, stderr) {

        if (error) {
            callback(error, {'stdout': stdout, 'stderr': stderr});
        } else {
            callback(null, {'stdout': stdout, 'stderr': stderr});
        }
    });
}

// This calls cb() when /var/svc/provisioning is gone. When this calls cb()
// with an Error object, the provision is considered failed so this should
// only happen when something timed out that is unrelated to the user.
//
// This returns a function that can be called with no arguments to cancel
// all timers and actions pending from this function.  It will also then not
// call the cb().
//
// IMPORTANT: this is only exported to be used by vmadmd. Do not use elsewhere!
//
// vmobj fields:
//
//  brand
//  state
//  transition_expire
//  uuid
//  zonepath
//
exports.waitForProvisioning = function (vmobj, options, cb)
{
    var dirname = path.join(vmobj.zonepath, 'root', '/var/svc');
    var filename = path.join(dirname, 'provisioning');
    var ival_h;
    var log;
    var timeout;
    var timeout_remaining = PROVISION_TIMEOUT; // default to whole thing
    var tracers_obj;
    var watcher;

    assertMockCnUuid();
    throw new Error('UNIMPLEMENTED: waitForProvisioning');

    // options is optional
    if (arguments.length === 2) {
        cb = arguments[1];
        options = {};
    }

    ensureLogging(true);
    if (options.hasOwnProperty('log')) {
        log = options.log;
    } else {
        log = VM.log.child({action: 'waitForProvisioning', vm: vmobj.uuid});
    }

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('wait-for-provisioning', log, cb);
        cb = tracers_obj.callback;
        log = tracers_obj.log;
    }

    function done() {
        if (timeout) {
            log.debug('clearing provision timeout for ' + vmobj.uuid);
            clearTimeout(timeout);
            timeout = null;
        }
        if (watcher) {
            log.debug('closing /var/svc/provisioning watcher for '
                + vmobj.uuid);
            watcher.close();
            watcher = null;
        }
        if (ival_h) {
            log.debug('closing hwsetup check interval for ' + vmobj.uuid);
            clearInterval(ival_h);
            ival_h = null;
        }
    }

    if ((vmobj.state === 'provisioning')
        && (vmobj.hasOwnProperty('transition_expire'))) {

        timeout_remaining =
            (Number(vmobj.transition_expire) - Date.now(0)) / 1000;

        // Always give it at least 1 second's chance.
        if (timeout_remaining < 1) {
            timeout_remaining = 1;
        }
    } else {
        // don't know what to do here we're not provisioning.
        log.warn('waitForProvisioning called when ' + vmobj.uuid
            + ' was not provisioning');
        cb();
        return (null);
    }

    log.debug({
        'transition_expire': Number(vmobj.transition_expire),
        'now': Date.now(0)
    }, 'waiting ' + timeout_remaining + ' sec(s) for provisioning');

    log.debug('setting provision timeout for ' + vmobj.uuid);
    timeout = setTimeout(function () {
        log.warn('Marking VM ' + vmobj.uuid + ' as a "failure" because we '
            + 'hit waitForProvisioning() timeout.');
        VM.markVMFailure(vmobj, {log: log}, function (err) {
            var errstr = 'timed out waiting for /var/svc/provisioning to move'
                + ' for ' + vmobj.uuid;
            if (err) {
                log.warn(err, 'markVMFailure(): ' + err.message);
            }
            log.error(errstr);
            done();
            cb(new Error(errstr));
        });
    }, (timeout_remaining * 1000));

    // this starts a loop that will move provisioning -> provision_success when
    // the hardware of the VM has been initialized the first time.
    if (BRAND_OPTIONS[vmobj.brand].features.wait_for_hwsetup) {
        ival_h = markProvisionedWhenHWSetup(vmobj, {log: log}, function (err) {
            if (err) {
                log.error(err, 'error in markProvisionedWhenHWSetup()');
            }
            done();
            cb(err);
        });
        return (done);
    }

    function whenFileIsRenamed(evt, file) {
        // We only care about 'rename' which also fires when the file is
        // deleted.
        log.debug('watcher.event(' + vmobj.uuid + '): ' + evt);
        if (evt === 'rename') {
            fs.exists(filename, function (exists) {
                if (exists) {
                    // somehow we still have /var/svc/provisioning!
                    log.warn('Marking VM ' + vmobj.uuid + ' as a "failure"'
                        + ' because we still have /var/svc/provisioning after '
                        + 'rename');
                    VM.markVMFailure(vmobj, {log: log}, function (err) {
                        if (err) {
                            log.warn(err, 'markVMFailure(): ' + err.message);
                        }
                        done();
                        cb(new Error('/var/svc/provisioning exists after '
                            + 'rename!'));
                    });
                    return;
                }

                // So long as /var/svc/provisioning is gone, we don't care what
                // replaced it.  Success or failure of user script doesn't
                // matter for the state, it's provisioned now. Caller should
                // now clear the transition.
                done();
                cb();
                return;
            });
        }
    }

    try {
        watcher = fs.watch(filename, whenFileIsRenamed);
    } catch (e) {
        if (e.code === 'ENOENT') {

            function _noop() {
                return;
            }

            /*
             * File was moved before we could even setup the watcher (OS-2966)
             * instead of throwing, we consider this success.
             */
            done();
            cb();
            // return _noop since we called done() already.
            return (_noop);
        } else {
            // some other error, we'll just throw it up
            throw e;
        }
    }

    log.debug('created watcher for ' + vmobj.uuid);
    return (done);
};

/*
 * This function attempts to:
 *
 *  1) create an @indestructible snapshot of <dataset>
 *  2) create a hold with tag 'do_not_destroy' on the @indestructible snapshot
 *
 * it treats either of these already existing as success in order to be
 * idempotent.
 */
function makeIndestructible(dataset, log, callback)
{
    var args;
    var hold_exists_pattern;
    var snap_exists_pattern;
    var snapshot = dataset + '@indestructible';
    var tracers_obj;

    snap_exists_pattern = /cannot create snapshot .* dataset already exists/;
    hold_exists_pattern
        = /cannot hold snapshot .* tag already exists on this dataset/;

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('make-indestructible', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    log.debug('attempting to make dataset %s indestructible', dataset);

    args = ['snapshot', snapshot];
    zfs(args, log, function _makeIndestructibleSnapshot(snap_err, snap_out) {
        if (snap_err && !snap_out.stderr.match(snap_exists_pattern)) {
            callback(snap_err);
            return;
        }

        args = ['hold', 'do_not_destroy', snapshot];
        zfs(args, log, function _makeIndestructibleHold(hold_err, hold_out) {
            if (hold_err && !hold_out.match(hold_exists_pattern)) {
                callback(hold_err);
                return;
            }

            callback();
        });
    });
}

/*
 * This function attempts to:
 *
 *  1) release all zfs holds on the <dataset>@indestructible snapshot
 *  2) destroy the <dataset>@indestructible snapshot
 *
 * it treats the lack of holds or the non-existence of this snapshot as success
 * in order to be idempotent.
 */
function makeDestructible(dataset, log, callback)
{
    var args;
    var hold_missing_pattern;
    var snap_missing_pattern;
    var snapshot = dataset + '@indestructible';
    var tracers_obj;

    hold_missing_pattern = /no such tag on this dataset/;
    snap_missing_pattern = /could not find any snapshots to destroy/;

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('make-destructible', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    log.debug('attempting to make dataset %s destructible', dataset);

    args = ['holds', snapshot];
    zfs(args, log, function _listIndestructibleHolds(holds_err, holds_out) {
        var holds = [];
        var lines;

        function _destroyIndestructibleSnapshot(cb) {
            args = ['destroy', snapshot];
            zfs(args, log, function _destroySnapshot(dest_err, dest_out) {
                if (dest_err && dest_out.stderr.match(snap_missing_pattern)) {
                    // If the snapshot's already gone we'll not fail.
                    cb();
                    return;
                }
                cb(dest_err);
            });
        }

        if (holds_err) {
            callback(holds_err);
            return;
        }

        lines = holds_out.stdout.split('\n');
        if (lines.length === 0) {
            // We should always have at least 1 line, the header
            callback(new Error('empty output from zfs holds'));
            return;
        }

        if (lines[0].match(/^NAME/)) {
            lines = lines.splice(1, lines.length);
        }

        lines.forEach(function (line) {
            var tag;

            if (line.length === 0) {
                return;
            }

            tag = line.split(/\s+/)[1];
            holds.push(tag);
        });

        // no holds? then we should be able to destroy snapshot
        if (holds.length === 0) {
            log.debug(snapshot + ' has no holds, deleting');
            _destroyIndestructibleSnapshot(callback);
            return;
        }

        async.eachSeries(holds, function (tag, cb) {
            args = ['release', tag, snapshot];
            zfs(args, log, function _releaseHold(release_err, release_out) {
                if (release_err) {
                    if (release_out.stderr.match(hold_missing_pattern)) {
                        // If a hold/tag just doesn't exist, that's not an error
                        cb();
                    }
                }
                cb(release_err);
            });
        }, function (err) {
            if (err) {
                callback(err);
                return;
            }

            _destroyIndestructibleSnapshot(callback);
        });
    });
}

// create and install a 'joyent' or 'kvm' brand zone.
function installZone(payload, log, callback)
{
    var load_fields;
    var receiving = false;
    var reprovisioning = false;
    var tracers_obj;
    var vmobj;
    var zoneinit = {};

    assert(log, 'no logger passed to installZone()');

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('install-zone', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    } else {
        log.debug('installZone()');
    }

    load_fields = [
        'brand',
        'docker',
        'firewall_enabled',
        'hostname',
        'missing',
        'nics',
        'owner_uuid',
        'resolvers',
        'routes',
        'state',
        'tags',
        'tmpfs',
        'transition_to',
        'transition_expire',
        'uuid',
        'zonename',
        'zonepath'
    ];

    if (payload.reprovisioning) {
        log.debug('installZone(): reprovisioning');
        reprovisioning = true;
    }

    async.series([
        function (cb) {

            VM.load(payload.uuid, {fields: load_fields, log: log},
                function (err, obj) {

                if (err) {
                    cb(err);
                    return;
                }
                vmobj = obj;
                cb();
            });
        }, function (cb) {
            var thing;
            var missing = false;
            var msg;
            var things = ['datasets', 'filesystems', 'disks'];

            if (vmobj.state === 'receiving') {
                receiving = true;
                msg = 'zone is still missing:';
                for (thing in things) {
                    thing = things[thing];
                    if (vmobj.missing[thing].length !== 0) {
                        msg = msg + ' ' + vmobj.missing[thing].length + ' '
                            + thing + ',';
                        missing = true;
                    }
                }
                msg = rtrim(msg, ',');

                if (missing) {
                    cb(new Error('Unable to complete install for '
                        + vmobj.uuid + ' ' + msg));
                    return;
                }
            }
            cb();
        }, function (cb) {
            // Install the zone.
            // This will create the dataset and mark the zone 'installed'.
            var args;

            if (reprovisioning) {
                // reprovisioning we do *most* of install, but not this.
                cb();
                return;
            }

            args = ['-z', vmobj.zonename, 'install', '-q',
                payload.quota.toString()];

            // For both OS and KVM VMs you can pass an image_uuid at the
            // top-level. This will be your zone's root dataset. On KVM the user
            // is never exposed to this. It's used there for something like
            // SPICE.
            if (payload.hasOwnProperty('image_uuid')) {
                args.push('-t', payload.image_uuid, '-x', 'nodataset');
            }

            zoneadm(args, log, function (err, fds) {
                if (err) {
                    log.error({err: err, stdout: fds.stdout,
                        stderr: fds.stderr}, 'zoneadm failed to install: '
                        + err.message);
                    cb(err);
                } else {
                    log.debug({stdout: fds.stdout, stderr: fds.stderr},
                        'zoneadm installed zone');
                    cb();
                }
            });
        }, function (cb) {
            // Apply compression if set
            var args = [];
            if (payload.hasOwnProperty('zfs_root_compression')) {
                args = ['set', 'compression='
                    + payload.zfs_root_compression, payload.zfs_filesystem];
                zfs(args, log, function (err) {
                    cb(err);
                });
            } else {
                cb();
            }
        }, function (cb) {
            // Apply recsize if set
            var args = [];
            if (payload.hasOwnProperty('zfs_root_recsize')) {
                args = ['set', 'recsize=' + payload.zfs_root_recsize,
                    payload.zfs_filesystem];
                zfs(args, log, function (err) {
                    cb(err);
                });
            } else {
                cb();
            }
        }, function (cb) {
            // Apply zfs_filesystem_limit if set
            var args = [];
            if (payload.hasOwnProperty('zfs_filesystem_limit')) {
                args = ['set', 'filesystem_limit='
                    + payload.zfs_filesystem_limit, payload.zfs_filesystem];
                zfs(args, log, function (err) {
                    cb(err);
                });
            } else {
                cb();
            }
        }, function (cb) {
            // Apply zfs_snapshot_limit if set
            var args = [];
            if (payload.hasOwnProperty('zfs_snapshot_limit')) {
                args = ['set', 'snapshot_limit=' + payload.zfs_snapshot_limit,
                    payload.zfs_filesystem];
                zfs(args, log, function (err) {
                    cb(err);
                });
            } else {
                cb();
            }
        }, function (cb) {
            if (reprovisioning) {
                // reprovisioning we don't change indestructibility state
                cb();
                return;
            }

            if (payload.hasOwnProperty('indestructible_zoneroot')
                && payload.indestructible_zoneroot) {

                makeIndestructible(payload.zfs_filesystem, log, cb);
            } else {
                cb();
            }
        }, function (cb) {
            // Some zones can have an additional 'data' dataset delegated to
            // them for use in the zone.  This will set that up.  If the option
            // is not set, the following does nothing.
            if (!receiving && !reprovisioning) {
                createDelegatedDataset(payload, log, function (err) {
                    if (err) {
                        cb(err);
                    } else {
                        cb();
                    }
                });
            } else {
                cb();
            }
        }, function (cb) {
            // if there's delegated and we want it indestructible, do so now
            if (payload.delegate_dataset
                && payload.hasOwnProperty('indestructible_delegated')) {

                makeIndestructible(payload.zfs_filesystem + '/data', log, cb);
            } else {
                cb();
            }
        }, function (cb) {
            if (receiving || !vmobj.docker) {
                cb();
                return;
            }

            if (payload.hasOwnProperty('internal_metadata')) {
                vmobj.internal_metadata = payload.internal_metadata;
            }

            createHostConfFileMounts(vmobj, {}, log, cb);
        }, function (cb) {
            var host_vols = {};
            var to_create = [];

            // Create any filesystems now that have the 'create' flag set.
            // Note that currently if you reprovision, all these created volumes
            // will be destroyed and recreated as well since they're children of
            // the zoneroot. This only currently works with "docker" VMs.
            if (receiving || !payload.hasOwnProperty('add_filesystems')
                || !vmobj.docker) {

                cb();
                return;
            }

            payload.add_filesystems.forEach(function (filesystem) {
                if (isUUID(filesystem.source)) {
                    filesystem.source = '/' + payload.zfs_filesystem
                        + '/volumes/' + filesystem.source;
                    to_create.push(filesystem);
                /* JSSTYLED */
                } else if (filesystem.source.match(/^https?:\/\//)) {
                    filesystem.url = filesystem.source;
                    filesystem.source = path.normalize('/'
                        + payload.zfs_filesystem + '/hostvolumes/'
                        + filesystem.target);
                    to_create.push(filesystem);

                    host_vols[filesystem.target] = {
                        url: filesystem.url
                    };
                }
            });

            if (Object.keys(host_vols).length > 0) {
                if (!payload.hasOwnProperty('internal_metadata')) {
                    payload.internal_metadata = {};
                }
                payload.internal_metadata['docker:hostvolumes']
                    = JSON.stringify(host_vols);
            }

            if (to_create.length === 0) {
                log.debug('No filesystems to create');
                cb();
                return;
            }

            createFilesystems(payload, to_create, log, cb);
        }, function (cb) {
            // Write out the zone's metadata
            // Note: we don't do this when receiving because dataset will
            // already contain metadata and we don't want to wipe that out.
            if (!receiving && !reprovisioning) {
                saveMetadata(payload, log, function (err) {
                    if (err) {
                        log.error(err, 'unable to save metadata: '
                            + err.message);
                        cb(err);
                    } else {
                        cb();
                    }
                });
            } else {
                cb();
            }
        }, function (cb) {
            // Write out the zone's routes
            // Note: we don't do this when receiving because dataset will
            // already contain routes and we don't want to wipe that out.
            if (!receiving && !reprovisioning) {
                saveRoutes(payload, log, function (err) {
                    if (err) {
                        log.error(err, 'unable to save routes: '
                            + err.message);
                        cb(err);
                    } else {
                        cb();
                    }
                });
            } else {
                cb();
            }
        }, function (cb) {
            // if we were receiving, we're done receiving now
            if (receiving) {
                VM.unsetTransition(vmobj, {log: log}, cb);
            } else {
                cb();
            }
        }, function (cb) {
            // var zoneinit is in installZone() scope

            // when receiving zoneinit is never run.
            if (receiving) {
                cb();
                return;
            }

            getZoneinitJSON(vmobj.zonepath, log, function (zoneinit_err, data) {

                if (zoneinit_err) {
                    // NOTE: not existing is not going to give us a zoneinit_err
                    log.warn(zoneinit_err, 'error in getZoneinitJSON');
                    cb(zoneinit_err);
                    return;
                }

                if (data) {
                    zoneinit = data;
                } else {
                    zoneinit = {};
                }

                cb();
            });
        }, function (cb) {
            // var_svc_provisioning is at installZone() scope

            // If we're not receiving, we're provisioning a new VM and in that
            // case we write the /var/svc/provisioning file which should exist
            // until something in the zone decides provisioning is complete. At
            // that point it will be moved to either:
            //
            //    /var/svc/provision_success
            //    /var/svc/provision_failure
            //
            // to indicate that the provisioning setup has been completed.

            if (receiving) {
                cb();
                return;
            }

            fs.writeFile(path.join(vmobj.zonepath, 'root',
                '/var/svc/provisioning'), '', function (err, result) {

                if (err) {
                    log.error(err, 'failed to create '
                        + '/var/svc/provisioning: ' + err.message);
                } else {
                    log.debug('created /var/svc/provisioning in '
                        + path.join(vmobj.zonepath, 'root'));
                }

                cb(err);
            });
        }, function (cb) {
            // For joyent and joyent-minimal at least, set the timeout for the
            // svc start method to the value specified in the payload, or a
            // default.

            var timeout;

            if (BRAND_OPTIONS[vmobj.brand].features.update_mdata_exec_timeout) {

                if (payload.hasOwnProperty('mdata_exec_timeout')) {
                    timeout = payload.mdata_exec_timeout;
                } else {
                    timeout = DEFAULT_MDATA_TIMEOUT;
                }

                svccfg(vmobj.zonepath, [
                    '-s', 'svc:/smartdc/mdata:execute',
                    'setprop', 'start/timeout_seconds', '=', 'count:', timeout
                    ], log, function (error, stdio) {

                    if (error) {
                        log.error(error, 'failed to set mdata:exec timeout');
                        cb(error);
                        return;
                    }

                    cb();
                });
            } else {
                cb();
            }

        }, function (cb) {
            // This writes out the 'zoneconfig' file used by zoneinit to root's
            // home directory in the zone.
            if (! receiving
                && BRAND_OPTIONS[vmobj.brand].features.zoneinit
                && (! zoneinit.hasOwnProperty('features')
                || zoneinit.features.zoneconfig)) {

                // No 'features' means old dataset.  If we have old dataset or
                // one that really wants a zoneconfig, write it out.

                writeZoneconfig(payload, log, function (err) {
                    cb(err);
                });
            } else {
                cb();
            }
        }, function (cb) {
            if (BRAND_OPTIONS[vmobj.brand].features.write_zone_netfiles
                && !receiving) {

                writeZoneNetfiles(payload, log, function (err) {
                    cb(err);
                });
            } else {
                cb();
            }
        }, function (cb) {
            if (vmobj.hasOwnProperty('zonepath')
                && BRAND_OPTIONS[vmobj.brand].features.cleanup_dataset
                && !receiving) {

                cleanupMessyDataset(vmobj.zonepath, vmobj.brand, log,
                    function (err) {

                    cb(err);
                });
            } else {
                cb();
            }
        }, function (cb) {
            var files = [
                '/root/zoneinit.d/11-files.sh',
                '/var/zoneinit/includes/11-files.sh'
            ];
            var file_to_fix;
            var prepend_patch =
                '# VM.js: tmpfs=0, so we do not want any tmpfs\n'
                    + 'grep -v " /tmp .* tmpfs " /etc/vfstab > /etc/vfstab.new '
                    + '&& mv /etc/vfstab.new /etc/vfstab\n\n';

            /*
             * zoneinit thinks it should always add tmpfs size to /etc/vfstab
             * but it should not if tmpfs == 0, so in that case we have to hack
             * a workaround into zoneinit's script.
             */
            if (!vmobj.hasOwnProperty('tmpfs')
                || (vmobj.tmpfs !== 0)
                || !BRAND_OPTIONS[vmobj.brand].features.zoneinit) {

                cb();
                return;
            }

            files.forEach(function (file) {
                var check_filename;

                if (file_to_fix) {
                    // already know which file we need to fix
                    return;
                }

                assertSafeZonePath(vmobj.zonepath, file,
                    {type: 'file', enoent_ok: true});
                check_filename = path.join(vmobj.zonepath, 'root', file);

                if (fs.existsSync(check_filename)) {
                    log.info(check_filename + ' exists, will attempt to fix.');
                    file_to_fix = check_filename;
                } else {
                    log.debug(check_filename + ' does not exist.');
                }
            });

            if (!file_to_fix) {
                log.warn('did not find 11-files.sh zoneinit file to fix for '
                    + 'tmpfs=0');
                cb();
                return;
            }

            fs.readFile(file_to_fix, 'utf8', function (error, data) {
                if (error) {
                    log.error(error, 'failed to load ' + file_to_fix
                        + 'for replacement');
                    cb(error);
                    return;
                }

                data = prepend_patch + data;
                log.trace('replacing ' + file_to_fix + ' with:\n' + data);

                fs.writeFile(file_to_fix, data, 'utf8', function (err) {
                    if (err) {
                        log.error(err, 'failed to write ' + file_to_fix);
                    }
                    cb(err);
                });
            });
        }, function (cb) {
            // Firewall data has not changed when reprovisioning, so we don't
            // re-run addFirewallData()
            if (reprovisioning) {
                cb();
                return;
            }

            // Add firewall data if it was included
            addFirewallData(payload, vmobj, log, cb);
        }, function (cb) {

            var cancel;
            var calledback = false;
            var prov_wait = true;
            // var_svc_provisioning is at installZone() scope

            // The vm is now ready to start, we'll start if autoboot is set. If
            // not, we also don't want to wait for 'provisioning'.
            if (!payload.autoboot) {
                cb();
                return;
            }

            // In these cases we never wait for provisioning -> running
            if (payload.nowait || receiving || vmobj.state !== 'provisioning') {
                prov_wait = false;
            }

            // most VMs support the /var/svc/provision{ing,_success,_failure}
            // files. For those, if !nowait, we wait for the file to change
            // from provisioning -> either provision_success, or
            // provision_failure.

            if (prov_wait) {
                // wait for /var/svc/provisioning -> provision_success/failure
                cancel = VM.waitForProvisioning(vmobj, {log: log},
                    function (err) {

                    log.debug(err, 'waited for provisioning');

                    if (!err) {
                        log.info('provisioning complete: '
                            + '/var/svc/provisioning is gone');
                        // this will clear the provision transition
                        VM.unsetTransition(vmobj, {log: log},
                            function (unset_err) {

                            if (unset_err) {
                                log.error(unset_err, 'error unsetting '
                                    + 'transition: ' + unset_err.message);
                            }
                            // this and the cb in the VM.start callback might
                            // both run if we don't check this.
                            if (!calledback) {
                                calledback = true;
                                cb(unset_err);
                            }
                        });
                    } else {
                        // failed but might not be able to cb if VM.start's
                        // callback already did.
                        log.error(err, 'error waiting for provisioning: '
                            + err.message);
                        // this and the cb in the VM.start callback might
                        // both run if we don't check this.
                        if (!calledback) {
                            calledback = true;
                            cb(err);
                        }
                    }
                });
            }

            VM.start(payload.uuid, {}, {log: log}, function (err, res) {
                if (err) {
                    // we failed to start so we'll never see provisioning, so
                    // cancel that and return the error.
                    if (cancel) {
                        log.info('cancelling VM.waitForProvisioning');
                        cancel();
                    }
                    // this and the cb in the VM.waitForProvisioning
                    // callback might both run if we don't check this.
                    if (!calledback) {
                        calledback = true;
                        cb(err);
                    }
                    return;
                }
                // if we're waiting for 'provisioning' VM.waitForProvisioning's
                // callback will call cb().  If we're not going to wait, we call
                // it here.
                if (!prov_wait) {
                    // this and the cb in the VM.waitForProvisioning
                    // callback might both run if we don't check this.
                    if (!calledback) {
                        calledback = true;
                        cb();
                    }
                }
            });
        }], function (error) {
            callback(error);
        }
    );
}

function getZoneinitJSON(rootpath, log, cb)
{
    var filename;
    var tracers_obj;
    var zoneroot;

    assert(log, 'no logger passed to getZoneinitJSON()');

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('get-zoneinit-json', log, cb);
        cb = tracers_obj.callback;
        log = tracers_obj.log;
    }

    zoneroot = path.join('/', rootpath, 'root');
    filename = path.join(zoneroot, '/var/zoneinit/zoneinit.json');

    try {
        assertSafeZonePath(zoneroot, '/var/zoneinit/zoneinit.json',
            {type: 'file', enoent_ok: true});
    } catch (e) {
        log.error(e, 'Error validating /var/zoneinit/zoneinit.json: '
            + e.message);
        cb(e);
        return;
    }

    fs.readFile(filename, function (error, data) {
        var zoneinit;

        if (error && (error.code === 'ENOENT')) {
            // doesn't exist, leave empty
            log.debug('zoneinit.json does not exist.');
            cb();
        } else if (error) {
            // error reading: fail.
            cb(error);
        } else {
            // success try to load json
            try {
                zoneinit = JSON.parse(data.toString());
                log.debug({'zoneinit_json': zoneinit},
                    'parsed zoneinit.json');
                cb(null, zoneinit);
            } catch (e) {
                cb(e);
            }
        }
    });
}

function getDatasetMountpoint(dataset, log, callback)
{
    var args;
    var cmd = '/usr/sbin/zfs';
    var mountpoint;

    assert(log, 'no logger passed to getDatasetMountpoint()');

    args = ['get', '-H', '-o', 'value', 'mountpoint', dataset];

    traceExecFile(cmd, args, log, 'zfs-get-mountpoint',
        function (error, stdout, stderr) {

        if (error) {
            log.error(error, 'zfs get failed with: ' + stderr);
            callback(error);
        } else {
            mountpoint = stdout.replace(/\n/g, '');
            log.debug('mountpoint: "' + mountpoint + '"');
            callback(null, mountpoint);
        }
    });
}

// TODO: pull data out of the massive zfs list we pulled earlier
function checkDatasetProvisionable(payload, log, callback)
{
    var dataset;
    var tracers_obj;

    assert(log, 'no logger passed to checkDatasetProvisionable()');

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('check-dataset-provisionable', log,
            callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    if (BRAND_OPTIONS[payload.brand].features.var_svc_provisioning) {
        // when the brand always supports /var/svc/provisioning we don't have to
        // worry about the dataset not supporting it.
        callback(true);
        return;
    }

    if (!payload.hasOwnProperty('zpool')
        || !payload.hasOwnProperty('image_uuid')) {

        log.error('missing properties required to find dataset: '
            + JSON.stringify(payload));
        callback(false);
        return;
    }

    dataset = payload.zpool + '/' + payload.image_uuid;

    getDatasetMountpoint(dataset, log, function (dataset_err, mountpoint) {
        if (dataset_err) {
            log.error('unable to find mount point for ' + dataset);
            callback(false);
            return;
        }

        if (BRAND_OPTIONS[payload.brand].features.type === 'LX') {
            log.warn('XXX temporary hack for lx, assume image supports '
                + '/var/svc/provisioning');
            callback(true);
            return;
        }

        getZoneinitJSON(dataset, log, function (zoneinit_err, zoneinit) {
            var filename_1_6_x;
            var filename_1_8_x;

            if (zoneinit_err) {
                log.error(zoneinit_err, 'getZoneinitJSON() failed, assuming '
                    + 'not provisionable.');
                callback(false);
                return;
            } else if (!zoneinit) {
                log.debug('no data from getZoneinitJSON(), using {}');
                zoneinit = {};
            }

            if (zoneinit.hasOwnProperty('features')) {
                if (zoneinit.features.var_svc_provisioning) {
                    log.info('zoneinit.features.var_svc_provisioning is '
                        + 'set.');
                    callback(true);
                    return;
                }
                // we have features but not var_svc_provisioning === true means
                // we can't provision. Fall through and return false.
            } else {
                // Didn't load zoneinit features, so check for datasets that
                // have // 04-mdata.sh.  For 1.6.x and earlier datasets this was
                // in /root but in 1.8.0 and 1.8.1 it is in /var/zoneinit.  For
                // 1.8.2 and later we'll not get here as the zoneinit.json will
                // exist and we'll use that.
                filename_1_6_x = path.join(mountpoint, 'root',
                    '/root/zoneinit.d/04-mdata.sh');
                filename_1_8_x = path.join(mountpoint, 'root',
                    '/var/zoneinit/includes/04-mdata.sh');

                if (fs.existsSync(filename_1_6_x)) {
                    log.info(filename_1_6_x + ' exists');
                    callback(true);
                    return;
                } else {
                    log.debug(filename_1_6_x + ' does not exist');
                    if (fs.existsSync(filename_1_8_x)) {
                        log.info(filename_1_8_x + ' exists');
                        callback(true);
                        return;
                    } else {
                        log.debug(filename_1_8_x + ' does not exist');
                        // this was our last chance.
                        // Fall through and return false.
                    }
                }
            }

            callback(false);
            return;
        });
    });
}

// create and install a 'joyent' or 'kvm' brand zone.
function createZone(payload, log, callback)
{
    var create_time;
    var n;
    var now = new Date;
    var primary_found;
    var provision_timeout = PROVISION_TIMEOUT;
    var t;
    var timeout_multiplier;
    var tracers_obj;
    var vm_version;
    var zcfg;

    assert(log, 'no logger passed to createZone()');

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('create-zone', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    } else {
        log.debug('createZone()');
    }

    payload.zfs_filesystem = payload.zpool + '/' + payload.zonename;
    payload.zonepath = '/' + payload.zfs_filesystem;

    // we add create-timestamp in all cases except where we're receiving since
    // in that case we want to preserve the original create-timestamp.
    if (!payload.hasOwnProperty('transition')
        || (payload.transition.transition !== 'receiving')
        || !payload.hasOwnProperty('create_timestamp')) {

        create_time = now.toISOString();
    } else {
        create_time = payload.create_timestamp;
    }

    // we add vm-version (property v) in all cases except where we're receiving
    // since in that case we want to preserve the original version.
    if (!payload.hasOwnProperty('transition')
        || (payload.transition.transition !== 'receiving')
        || !payload.hasOwnProperty('v')) {

        vm_version = 1;
    } else {
        vm_version = payload.v;
    }

    // set the properties that can't be updated later here.
    zcfg = 'create -b\n'
        + 'set zonepath=' + payload.zonepath + '\n'
        + 'set brand=' + payload.brand + '\n'
        + 'set uuid=' + payload.uuid + '\n'
        + 'set ip-type=exclusive\n'
        + 'add attr; set name="vm-version"; set type=string; set value="'
        + vm_version + '"; end\n'
        + 'add attr; set name="create-timestamp"; set type=string; set value="'
        + create_time + '"; end\n';

    if (payload.hasOwnProperty('transition')) {
        // IMPORTANT: this is for internal use only and should not be documented
        // as an option for create's payload.  Used for receive.
        t = payload.transition;
        zcfg = zcfg
            + buildTransitionZonecfg(t.transition, t.target, t.timeout) + '\n';
    } else {
        // Assume this is really a new VM, add transition called 'provisioning'
        // only if the machine is going to be booting.
        if (!payload.hasOwnProperty('autoboot') || payload.autoboot) {

            // For large KVM VMs we want a longer timeout as these take longer
            // to boot. We'll set the timeout to provision_timeout for every
            // 4G of 'ram' in the VM.
            if (payload.brand === 'kvm' && payload.ram) {
                timeout_multiplier = Math.floor(payload.ram / 4096) - 1;
                if (timeout_multiplier > 0) {
                    provision_timeout = provision_timeout
                        + (timeout_multiplier * provision_timeout);
                }
            }

            zcfg = zcfg + buildTransitionZonecfg('provisioning', 'running',
                provision_timeout * 1000) + '\n';
        }
    }

    // We call the property 'dataset-uuid' even though the property name is
    // image_uuid because existing VMs in the wild will be using dataset-uuid
    // already, and we are the point where the image becomes a dataset anyway.
    if (payload.hasOwnProperty('image_uuid')) {
        zcfg = zcfg + 'add attr; set name="dataset-uuid"; set type=string; '
            + 'set value="' + payload.image_uuid + '"; end\n';
    }

    if (BRAND_OPTIONS[payload.brand].features.use_vm_autoboot) {
        // we always set autoboot=false for VM zones, since we want vmadmd to
        // boot them and not the zones tools.  Use vm-autoboot to control VMs
        zcfg = zcfg + 'set autoboot=false\n';
    }

    // ensure that we have a primary nic, even if one wasn't specified
    if (payload.hasOwnProperty('add_nics') && payload.add_nics.length != 0) {
        primary_found = false;

        for (n in payload.add_nics) {
            n = payload.add_nics[n];
            if (n.hasOwnProperty('primary') && n.primary) {
                primary_found = true;
                break;
            }
        }
        if (!primary_found) {
            payload.add_nics[0].primary = true;
        }
    }

    // Passing an empty first parameter here, tells buildZonecfgUpdate that
    // we're talking about a new machine.
    zcfg = zcfg + buildZonecfgUpdate({}, payload, log);

    // send the zonecfg data we just generated as a file to zonecfg,
    // this will create the zone.
    zonecfgFile(zcfg, ['-z', payload.zonename], log, function (err, fds) {
        if (err) {
            log.error({err: err, zcfg: zcfg, stdout: fds.stdout,
                stderr: fds.stderr}, 'failed to modify zonecfg');
            callback(err);
            return;
        }

        log.debug({stdout: fds.stdout, stderr: fds.stderr}, 'modified zonecfg');

        if (payload.create_only) {
            callback();
        } else {
            installZone(payload, log, callback);
        }
    });
}

function normalizeNics(payload, vmobj)
{
    var n;
    var nic;

    // ensure all NICs being created/added have a MAC, remove the 'index' if it
    // is passed (that's deprecated), rename 'interface' to 'physical'.
    if (payload.hasOwnProperty('add_nics')) {
        for (n in payload.add_nics) {
            if (payload.add_nics.hasOwnProperty(n)) {
                nic = payload.add_nics[n];

                if (!nic.hasOwnProperty('mac')) {
                    nic.mac = nic.hasOwnProperty('vrrp_vrid') ?
                        vrrpMAC(nic.vrrp_vrid) : generateMAC();
                }
                delete nic.index;
                if (nic.hasOwnProperty('interface')) {
                    nic.physical = nic.interface;
                    delete nic.interface;
                }

                // nics.*.primary only supports true value, unset false. We also
                // handle the case here why they used the deprecated '1' value.
                // We will have already warned them, but still support for now.
                if (nic.hasOwnProperty('primary')) {
                    if (nic.primary || nic.primary === '1'
                        || nic.primary === 1) {

                        nic.primary = true;
                    } else {
                        delete nic.primary;
                    }
                }
            }
        }
    }
}

/*
 * This is called for both create and update, everything here should be safe for
 * both. The vmobj will be set if it's an update.
 *
 */
function normalizePayload(payload, vmobj, log, callback)
{
    var action;
    var allowed;
    var brand;
    var property;
    var set_mdata_prefix = '';
    var tracers_obj;
    var uuid;

    assert(log, 'no logger passed to normalizePayload()');

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('normalize-payload', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    for (property in payload) {
        if (payload.hasOwnProperty(property)) {
            // fix type of arguments that should be numbers, do this here so
            // that fixing memory works correctly later using math.
            if (PAYLOAD_PROPERTIES.hasOwnProperty(property)
                && PAYLOAD_PROPERTIES[property].pr_type === 'integer'
                && payload[property] !== undefined) {
                // undefined is a special case since we use that to unset props
                // treat empty string as undefined too
                if (payload[property] === '') {
                    payload[property] = undefined;
                } else {
                    payload[property] = Number(payload[property]);
                    if (isNaN(payload[property])) {
                        callback(new Error('Invalid value for ' + property
                            + ': ' + JSON.stringify(payload[property]) + ':'
                            + typeof (payload[property])));
                        return;
                    }
                }
            // fix 'list' types to be an array so that validation later
            // can just ensure it's an array.
            } else if (PAYLOAD_PROPERTIES.hasOwnProperty(property)
                && PAYLOAD_PROPERTIES[property].pr_type === 'list'
                && payload[property] !== undefined) {

                if (typeof (payload[property]) === 'string') {
                    payload[property] = payload[property].split(',').filter(
                        function (e) {
                            // remove empty values
                            return (e.length > 0);
                        }
                    );
                }
            }
        }
    }

    if (payload.hasOwnProperty('quota') && payload.quota === undefined) {
        // when unsetting quota we set to 0
        payload.quota = 0;
    }

    if (vmobj) {
        /* update */
        fixPayloadMemory(payload, vmobj, log);
        action = 'update';
    } else {
        /* this also calls fixPayloadMemory() */
        applyZoneDefaults(payload, log);

        if (payload.hasOwnProperty('create_only')
            && payload.transition.transition === 'receiving') {

            action = 'receive';
        } else {
            action = 'create';
        }
    }

    // Should always have a brand after we applied defaults.
    if (vmobj && vmobj.hasOwnProperty('brand')) {
        brand = vmobj.brand;
    } else if (payload.hasOwnProperty('brand')) {
        brand = payload.brand;
    } else {
        callback(new Error('Unable to determine brand for payload'));
        return;
    }

    if (!BRAND_OPTIONS.hasOwnProperty(brand)) {
        callback(new Error('Unsupported brand: ' + brand));
        return;
    }

    // Should always have a uuid.
    if (vmobj && vmobj.hasOwnProperty('uuid')) {
        uuid = vmobj.uuid;
    } else if (payload.hasOwnProperty('uuid')) {
        uuid = payload.uuid;
    } else {
        callback(new Error('Unable to determine uuid for payload'));
        return;
    }

    // Historically we supported dataset_uuid for joyent+joyent-minimal and
    // zone_dataset_uuid for kvm. Now we just support image_uuid so give a
    // deprecation warning and translate if old version specified. This needs
    // to happen before VM.validate because image_uuid is required for most
    // VMs.
    allowed = BRAND_OPTIONS[brand].allowed_properties;
    if ((allowed.hasOwnProperty('dataset_uuid')
            && payload.hasOwnProperty('dataset_uuid'))
        || (allowed.hasOwnProperty('zone_dataset_uuid')
            && payload.hasOwnProperty('zone_dataset_uuid'))) {

        property = (payload.hasOwnProperty('dataset_uuid') ? 'dataset_uuid'
            : 'zone_dataset_uuid');

        if (payload.hasOwnProperty('image_uuid')) {
            log.warn('DEPRECATED option ' + property + ' found, '
                + 'ignoring. In the future use image_uuid only.');
        } else {
            log.warn('DEPRECATED option ' + property + ' found, '
                + 'ignoring. In the future use image_uuid instead.');
            payload.image_uuid = payload[property];
            delete payload.dataset_uuid;
        }
    }

    /*
     * Docker VMs always need to have docker:id due to the fact that they use a
     * 32 byte ID instead of a standard RFC4122 UUID. So we make sure any time
     * we are setting the docker flag, the docker:id is also set to match. This
     * is only done once and is never automatically removed, so setting and
     * unsetting the docker flag multiple times will not change this ID. We also
     * make 'docker:' an internal_metadata_namespace here so that these keys are
     * not modified from within the zone.
     */
    if (payload.docker) {

        // Ensure we're setting 'docker' as an internal_metadata_namespace if it
        // isn't already.
        if (!vmobj
            || !vmobj.hasOwnProperty('internal_metadata_namespaces')
            || vmobj.internal_metadata_namespaces.indexOf('docker') === -1) {

            /*
             * Existing VM doesn't have internal_metadata_namespaces['docker'],
             * so we need to set it.
             */
            if (!payload.hasOwnProperty('internal_metadata_namespaces')) {
                payload.internal_metadata_namespaces = ['docker'];
            } else if (payload.internal_metadata_namespaces
                .indexOf('docker') === -1) {

                payload.internal_metadata_namespaces.push('docker');
            }
        }

        // For 'create' and 'receive', we use 'internal_metadata' and update
        // uses 'set_internal_metadata'.
        if (action === 'update') {
            set_mdata_prefix = 'set_';
        }

        // If we're setting docker=true and restart_init is not false, set it
        // false now. We don't want zoneadmd to try to restart us (OS-3546).
        if ((!vmobj || vmobj.restart_init !== false)
            && (payload.restart_init !== false)) {

            payload.restart_init = false;
        }

        // If we're setting docker=true and init_name is not set, set it
        // now to dockerinit.
        if ((!vmobj || !vmobj.init_name) && !payload.init_name) {
            if (BRAND_OPTIONS[brand].hasOwnProperty('features')
                && BRAND_OPTIONS[brand].features.dockerinit) {

                payload.init_name = BRAND_OPTIONS[brand].features.dockerinit;
            }
        }

        // If we already have a docker id and this is an update setting
        // docker=true, we'll assume it's set to a correct value.
        if (!vmobj
            || !vmobj.internal_metadata
            || !vmobj.internal_metadata['docker:id']) {

            // Existing VM doesn't have 'docker:id', so we'll add one.
            if (!payload[set_mdata_prefix + 'internal_metadata']) {
                payload[set_mdata_prefix + 'internal_metadata'] = {
                    'docker:id': newDockerId(uuid)
                };
            } else if (!payload[set_mdata_prefix
                + 'internal_metadata']['docker:id']) {

                payload[set_mdata_prefix + 'internal_metadata']['docker:id']
                    = newDockerId(uuid);
            }
        }
    }

    // after ZoneDefaults have been applied, we should always have zone. Now
    // we validate the payload properties and remove any that are invalid. If
    // there are bad values we'll just fail.
    VM.validate(brand, action, payload, {log: log}, function (errors) {
        var bad_prop;
        var compound_props = ['disks', 'nics', 'filesystems'];
        var matches;
        var obj;
        var prop;

        if (errors) {
            if (errors.hasOwnProperty('bad_brand')) {
                callback(new Error('Invalid brand while validating payload: '
                    + JSON.stringify(brand)));
                return;
            }
            if (errors.bad_values.length > 0) {
                callback(new Error('Invalid value(s) for: '
                    + errors.bad_values.join(',')));
                return;
            }
            if (errors.missing_properties.length > 0) {
                callback(new Error('Missing required properties: '
                    + errors.missing_properties.join(',')));
                return;
            }
            for (bad_prop in errors.bad_properties) {
                bad_prop = errors.bad_properties[bad_prop];
                log.warn('Warning, invalid ' + action + ' property: ['
                    + bad_prop + '] removing from payload.');

                // for bad properties like nics.*.allow_unfiltered_promisc we
                // need to remove it from add_nics, update_nics, etc.
                for (prop in compound_props) {
                    prop = compound_props[prop];

                    matches = new RegExp('^' + prop
                        + '\\.\\*\\.(.*)$').exec(bad_prop);
                    if (matches) {
                        if (payload.hasOwnProperty(prop)) {
                            for (obj in payload[prop]) {
                                delete payload[prop][obj][matches[1]];
                            }
                        }
                        if (payload.hasOwnProperty('add_' + prop)) {
                            for (obj in payload['add_' + prop]) {
                                delete payload['add_' + prop][obj][matches[1]];
                            }
                        }
                        if (payload.hasOwnProperty('update_' + prop)) {
                            for (obj in payload['update_' + prop]) {
                                delete payload['update_'
                                    + prop][obj][matches[1]];
                            }
                        }
                    }
                }

                delete payload[bad_prop];
            }
        }

        // By the time we got here all the properties in the payload are allowed

        // Now we make sure we've got a zonename (use uuid if not already set)
        if (!payload.hasOwnProperty('zonename')
            || payload.zonename === undefined) {

            payload.zonename = payload.uuid;
        }

        // You use 'disks' and 'nics' when creating, but the underlying
        // functions expect add_disks and add_nics, so we rename them now that
        // we've confirmed we've got the correct thing for this action.
        if (payload.hasOwnProperty('disks')) {
            if (payload.hasOwnProperty('add_disks')) {
                callback(new Error('Cannot specify both "disks" and '
                    + '"add_disks"'));
                return;
            }
            payload.add_disks = payload.disks;
            delete payload.disks;
        }
        if (payload.hasOwnProperty('nics')) {
            if (payload.hasOwnProperty('add_nics')) {
                callback(new Error('Cannot specify both "nics" and '
                    + '"add_nics"'));
                return;
            }
            payload.add_nics = payload.nics;
            delete payload.nics;
        }
        if (payload.hasOwnProperty('filesystems')) {
            if (payload.hasOwnProperty('add_filesystems')) {
                callback(new Error('Cannot specify both "filesystems" and '
                    + '"add_filesystems"'));
                return;
            }
            payload.add_filesystems = payload.filesystems;
            delete payload.filesystems;
        }

        // if there's a zfs_root_* and no zfs_data_*, normally the properties
        // would fall through, we don't want that.
        if (payload.hasOwnProperty('zfs_root_compression')
            && !payload.hasOwnProperty('zfs_data_compression')) {

            if (vmobj && vmobj.hasOwnProperty('zfs_data_compression')) {
                // keep existing value.
                payload.zfs_data_compression = vmobj.zfs_data_compression;
            } else {
                // keep default value.
                payload.zfs_data_compression = 'off';
            }
        }
        if (payload.hasOwnProperty('zfs_root_recsize')
            && !payload.hasOwnProperty('zfs_data_recsize')) {

            if (vmobj && vmobj.hasOwnProperty('zfs_data_recsize')) {
                // keep existing value.
                payload.zfs_data_recsize = vmobj.zfs_data_recsize;
            } else {
                // keep default value.
                payload.zfs_data_recsize = 131072;
            }
        }

        // this will ensure we've got a MAC, etc.
        normalizeNics(payload, vmobj);

        // Fix types for boolean fields in case someone put in 'false'/'true'
        // instead of false/true
        for (property in payload) {
            if (payload.hasOwnProperty(property)) {
                if (PAYLOAD_PROPERTIES.hasOwnProperty(property)
                    && PAYLOAD_PROPERTIES[property].pr_type === 'boolean') {

                    payload[property] = fixBooleanLoose(payload[property]);
                }
            }
        }

        // We used to support zfs_storage_pool_name, but zpool is better.
        if (payload.hasOwnProperty('zfs_storage_pool_name')) {
            if (payload.hasOwnProperty('zpool')) {
                log.warn('DEPRECATED option zfs_storage_pool_name found, '
                    + 'ignoring!');
            } else {
                log.warn('DEPRECATED option zfs_storage_pool_name found, '
                    + 'replacing with zpool!');
                payload.zpool = payload.zfs_storage_pool_name;
                delete payload.zfs_storage_pool_name;
            }
        }

        // When creating a VM with SPICE you need the image_uuid, if you don't
        // pass that, we'll remove any SPICE options.
        if (action === 'create'
            && !payload.hasOwnProperty('image_uuid')) {

            if (payload.hasOwnProperty('spice_opts')
                || payload.hasOwnProperty('spice_password')
                || payload.hasOwnProperty('spice_port')) {

                log.warn('Creating with SPICE options requires '
                    + 'image_uuid, REMOVING spice_*');
                delete payload.spice_opts;
                delete payload.spice_password;
                delete payload.spice_port;
            }
        }

        checkPayloadProperties(payload, vmobj, log, function (e) {
            if (e) {
                callback(e);
            } else {
                callback();
            }
        });
    });
}

function buildTransitionZonecfg(transition, target, timeout)
{
    var cmdline;

    cmdline = 'add attr; set name=transition; set value="'
        + transition + ':' + target + ':' + (Date.now(0) + timeout).toString()
        + '"; set type=string; end';

    return cmdline;
}

// vmobj should have:
//
//  uuid
//  transition_to (if set)
//
exports.unsetTransition = function (vmobj, options, callback)
{
    var log;
    var tracers_obj;

    assertMockCnUuid();
    throw new Error('UNIMPLEMENTED: unsetTransaction');

    // options is optional
    if (arguments.length === 2) {
        callback = arguments[1];
        options = {};
    }

    ensureLogging(true);
    if (options.hasOwnProperty('log')) {
        log = options.log;
    } else {
        log = VM.log.child({action: 'unsetTransition', vm: vmobj.uuid});
    }

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('unset-transition', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    zonecfg(['-u', vmobj.uuid, 'remove -F attr name=transition'], log,
        function (err, fds) {

        if (err) {
            // log at info because this might be because already removed
            log.info({err: err, stdout: fds.stdout, stderr: fds.stderr},
                'unable to remove transition for zone ' + vmobj.uuid);
        } else {
            log.debug({stdout: fds.stdout, stderr: fds.stderr},
                'removed transition for zone ' + vmobj.uuid);
        }

        zonecfg(['-u', vmobj.uuid, 'info attr name=transition'], log,
            function (info_err, info_fds) {

            if (info_err) {
                log.error({err: info_err, stdout: info_fds.stdout,
                    stderr: info_fds.stderr},
                    'failed to confirm transition removal');
                callback(info_err);
                return;
            }

            if (info_fds.stdout !== 'No such attr resource.\n') {
                log.error({stdout: info_fds.stdout, stderr: info_fds.stderr},
                    'unknown error checking transition after removal');
                callback(new Error('transition does not appear to have been '
                    + 'removed zonecfg said: ' + JSON.stringify(info_fds)));
                return;
            }

            // removed the transition, now attempt to start if we're rebooting.
            if (vmobj.transition_to && vmobj.transition_to === 'start') {
                log.debug('VM ' + vmobj.uuid + ' was stopping for reboot, '
                    + 'transitioning to start.');
                VM.start(vmobj.uuid, {}, {log: log}, function (e) {
                    if (e) {
                        log.error(e, 'failed to start when clearing '
                            + 'transition');
                    }
                    callback();
                });
            } else {
                callback();
            }
        });
    });
};

//
// vmobj fields used:
//
// transition
// uuid
//
function setTransition(vmobj, transition, target, timeout, log, callback)
{
    var tracers_obj;

    assert(log, 'no logger passed to setTransition()');

    if (!timeout) {
        callback(new Error('setTransition() requires timeout argument.'));
        return;
    }

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('set-transition', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    async.series([
        function (cb) {
            // unset an existing transition
            if (vmobj.hasOwnProperty('transition')) {
                VM.unsetTransition(vmobj, {log: log}, cb);
            } else {
                cb();
            }
        }, function (cb) {
            var zcfg;

            zcfg = buildTransitionZonecfg(transition, target, timeout);
            zonecfg(['-u', vmobj.uuid, zcfg], log, function (err, fds) {
                if (err) {
                    log.error({err: err, stdout: fds.stdout,
                        stderr: fds.stderr}, 'failed to set transition='
                        + transition + ' for VM ' + vmobj.uuid);
                } else {
                    log.debug({stdout: fds.stdout, stderr: fds.stderr},
                        'set transition=' + transition + ' for vm '
                        + vmobj.uuid);
                }

                cb(err);
            });
        }
    ], function (error) {
        callback(error);
    });
}

function receiveVM(json, log, callback)
{
    var payload = {};
    var tracers_obj;

    assert(log, 'no logger passed to receiveVM()');

    try {
        payload = JSON.parse(json);
    } catch (e) {
        callback(e);
        return;
    }

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('receive-vm', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    payload.create_only = true;

    // adding transition here is considered to be *internal only* not for
    // consumer use and not to be documented as a property you can use with
    // create.
    payload.transition =
        {'transition': 'receiving', 'target': 'stopped', 'timeout': 86400};

    // We delete tags and metadata here becasue this exists in the root
    // dataset which we will be copying, so it would be duplicated here.
    delete payload.customer_metadata;
    delete payload.internal_metadata;
    delete payload.tags;

    // On receive we need to make sure that we don't create new disks so we
    // mark them all as nocreate. We also can't set the block_size of imported
    // volumes, so we remove that.
    if (payload.hasOwnProperty('disks')) {
        var disk_idx;

        for (disk_idx in payload.disks) {
            payload.disks[disk_idx].nocreate = true;

            if (payload.disks[disk_idx].image_uuid) {
                delete payload.disks[disk_idx].block_size;
            }
        }
    }

    VM.create(payload, {log: log}, function (err, result) {
        if (err) {
            callback(err);
        }

        // don't include the special transition in the payload we write out.
        delete payload.transition;

        fs.writeFile('/etc/zones/' + payload.uuid + '-receiving.json',
            JSON.stringify(payload, null, 2), function (e) {

            if (e) {
                callback(e);
                return;
            }

            // ready for datasets
            callback(null, result);
        });
    });
}

function receiveStdinChunk(type, log, callback)
{
    var child;
    var chunk_name = '';
    var chunk_size = 0;
    var json = '';
    var remaining = '';
    var tracers_obj;

    assert(log, 'no logger passed to receiveStdinChunk()');

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('receive-stdin-chunk', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    /*
     * XXX
     *
     * node 0.6.x removed support for arbitrary file descriptors which
     * means we can only handle stdin for now since we need to pass this
     * descriptor directly to the child.  0.8.x is supposed to reintroduce
     * this functionality.  When we do, this should be changed to open
     * the file and set fd to the descriptor, and we should be able to
     * get rid of vmunbundle.
     *
     */

    if (type === 'JSON') {
        log.info('/usr/vm/sbin/vmunbundle json');
        child = spawn('/usr/vm/sbin/vmunbundle', ['json'],
            {customFds: [0, -1, -1]});
    } else if (type === 'DATASET') {
        log.info('/usr/vm/sbin/vmunbundle dataset');
        child = spawn('/usr/vm/sbin/vmunbundle', ['dataset'],
            {customFds: [0, -1, -1]});
    } else {
        callback(new Error('Unsupported chunk type ' + type));
    }

    child.stderr.on('data', function (data) {
        var idx;
        var line;
        var matches;

        remaining += data.toString();

        idx = remaining.indexOf('\n');
        while (idx > -1) {
            line = trim(remaining.substring(0, idx));
            remaining = remaining.substring(idx + 1);

            log.debug('VMUNBUNDLE: ' + line);
            matches = line.match(/Size: ([\d]+)/);
            if (matches) {
                chunk_size = Number(matches[1]);
            }
            matches = line.match(/Name: \[(.*)\]/);
            if (matches) {
                chunk_name = matches[1];
            }

            idx = remaining.indexOf('\n');
        }
    });

    child.stdout.on('data', function (data) {
        json += data.toString();
        log.debug('json size is ' + json.length);
    });

    child.on('close', function (code) {
        log.debug('vmunbundle process exited with code ' + code);
        if (code === 3) {
            log.debug('vmbundle: end of bundle.');
            callback(null, 'EOF');
            return;
        } else if (code !== 0) {
            callback(new Error('vmunbundle exited with code ' + code));
            return;
        }

        // if it was a dataset, we've now imported it.
        // if it was json, we've now got it in the json var.

        if (type === 'DATASET') {
            log.info('Imported dataset ' + chunk_name);
            // delete 'sending' snapshot
            zfs(['destroy', '-F', chunk_name + '@sending'], log,
                function (err, fds) {
                    if (err) {
                        log.warn(err, 'Failed to destroy ' + chunk_name
                            + '@sending: ' + err.message);
                    }
                    callback();
                }
            );
        } else if (type === 'JSON' && chunk_name === 'JSON'
            && json.length <= chunk_size && json.length > 0) {

            receiveVM(json, log, function (e, result) {
                if (e) {
                    callback(e);
                    return;
                }
                log.info('Receive returning: ' + JSON.stringify(result));
                callback(null, result);
            });
        } else {
            log.debug('type: [' + type + ']');
            log.debug('chunk_name: [' + chunk_name + ']');
            log.debug('chunk_size: [' + chunk_size + ']');
            log.debug('json.length: [' + json.length + ']');
            log.warn('Failed to get ' + type + '!');
            callback(new Error('Failed to get ' + type + '!'));
        }
    });
}

exports.receive = function (target, options, callback)
{
    var log;
    var tracers_obj;

    assertMockCnUuid();
    throw new Error('UNIMPLEMENTED: recieve');

    // options is optional
    if (arguments.length === 2) {
        callback = arguments[1];
        options = {};
    }

    ensureLogging(true);

    // We don't know anything about this VM yet, so we don't create a
    // VM.log.child.
    if (options.hasOwnProperty('log')) {
        log = options.log;
    } else {
        log = VM.log;
    }

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('receive', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    log.info('Receiving VM from: ' + JSON.stringify(target));

    if (target.hasOwnProperty('host') && target.hasOwnProperty('port')) {
        // network receive not yet supported either.
        callback(new Error('cannot receive from ' + JSON.stringify(target)));
        return;
    } else if (typeof (target) !== 'string' || target !== '-') {
        callback(new Error('cannot receive from ' + JSON.stringify(target)));
        return;
    }

    receiveStdinChunk('JSON', log, function (error, result) {
        var eof = false;

        if (error) {
            callback(error);
            return;
        }

        if (result && result === 'EOF') {
            callback(new Error('unable to find JSON in stdin.'));
        } else if (result && result.hasOwnProperty('uuid')) {
            // VM started receive, now need datasets

            // We have JSON, so we can log better now if we need one
            if (!options.hasOwnProperty('log')) {
                log = VM.log.child({action: 'receive', vm: result.uuid});
            }

            log.info('Receiving VM ' + result.uuid);
            log.debug('now looking for datasets');

            async.whilst(
                function () { return !eof; },
                function (cb) {
                    receiveStdinChunk('DATASET', log, function (err, res) {
                        if (err) {
                            cb(err);
                            return;
                        }
                        if (res === 'EOF') {
                            eof = true;
                        }
                        cb();
                    });
                }, function (err) {
                    if (err) {
                        callback(err);
                        return;
                    }
                    // no error so we read all the datasets, try an install.
                    log.info('receive calling VM.install: ' + eof);
                    VM.install(result.uuid, {log: log}, function (e) {
                        if (e) {
                            log.warn(e, 'couldn\'t install VM: '
                                + e.message);
                        }
                        callback(e, result);
                    });
                }
            );
        } else {
            callback(new Error('unable to receive JSON'));
        }
    });
};

exports.reprovision = function (uuid, payload, options, callback)
{
    var log;
    var provision_timeout = PROVISION_TIMEOUT;
    var set_transition = false;
    var snapshot;
    var tracers_obj;
    var vmobj;

    assertMockCnUuid();
    throw new Error('UNIMPLEMENTED: reprovision');

    // options is optional
    if (arguments.length === 3) {
        callback = arguments[2];
        options = {};
    }

    ensureLogging(true);
    if (options.hasOwnProperty('log')) {
        log = options.log;
    } else {
        log = VM.log.child({action: 'reprovision', vm: uuid});
    }

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('reprovision', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    log.info('Reprovisioning VM ' + uuid + ', original payload:\n'
            + JSON.stringify(payload, null, 2));

    async.waterfall([
        function (cb) {
            VM.load(uuid, {
                fields: [
                    'brand',
                    'datasets',
                    'hostname',
                    'indestructible_zoneroot',
                    'nics',
                    'quota',
                    'state',
                    'uuid',
                    'zfs_filesystem',
                    'zone_state',
                    'zonename',
                    'zonepath',
                    'zpool'
                ],
                log: log
            }, function (err, obj) {
                if (err) {
                    cb(err);
                    return;
                }
                vmobj = obj;
                log.debug('Loaded VM is: ' + JSON.stringify(vmobj, null, 2));
                cb();
            });
        }, function (cb) {
            if (BRAND_OPTIONS[vmobj.brand].hasOwnProperty('features')
                && BRAND_OPTIONS[vmobj.brand].features.reprovision
                && BRAND_OPTIONS[vmobj.brand].features.brand_install_script) {

                cb();
            } else {
                cb(new Error('brand "' + vmobj.brand + '" does not yet support'
                    + ' reprovision'));
            }
        }, function (cb) {
            // only support image_uuid at top level (for non-KVM currently)
            if (!payload.hasOwnProperty('image_uuid')) {
                cb(new Error('payload is missing image_uuid'));
            } else {
                cb();
            }
        }, function (cb) {
            // If indestructible_zoneroot is set, you must disable that first.
            if (vmobj.indestructible_zoneroot) {
                cb(new Error('indestructible_zoneroot is set, cannot '
                    + 'reprovision'));
            } else {
                cb();
            }
        }, function (cb) {
            if (vmobj.hasOwnProperty('datasets') && vmobj.datasets.length > 1) {
                cb(new Error('cannot support reprovision with multiple '
                    + 'delegated datasets'));
                return;
            } else if (vmobj.hasOwnProperty('datasets')
                && vmobj.datasets.length === 1
                && vmobj.datasets[0] !== vmobj.zfs_filesystem + '/data') {

                cb(new Error('cannot support reprovision with non-standard "'
                    + vmobj.datasets[0] + '" dataset'));
                return;
            }
            cb();
        }, function (cb) {
            var zoneroot_types = ['zone-dataset'];
            // TODO: change here when we support zvols/KVM, add size
            // & change type

            if (BRAND_OPTIONS[vmobj.brand].features.zoneroot_image_types) {
                zoneroot_types
                    = BRAND_OPTIONS[vmobj.brand].features.zoneroot_image_types;
            }

            validateImage({
                types: zoneroot_types,
                uuid: payload.image_uuid,
                zpool: vmobj.zpool
            }, log, function (e) {
                cb(e);
            });
        }, function (cb) {
            // ensure we're stopped before reprovision starts
            if (vmobj.zone_state !== 'installed') {
                VM.stop(uuid, {log: log}, function (e) {
                    if (e) {
                        log.error(e, 'unable to stop VM ' + uuid + ': '
                            + e.message);
                    }
                    cb(e);
                });
            } else {
                cb();
            }
        }, function (cb) {
            // Set transition to provisioning now, we're going for it.
            setTransition(vmobj, 'provisioning', 'running',
                (provision_timeout * 1000), log, function (err) {
                    if (err) {
                        cb(err);
                    } else {
                        set_transition = true;
                        cb();
                    }
                });
        }, function (cb) {
            // we validated any delegated dataset above, so we just need to
            // remove the 'zoned' flag if we've got one.
            if (!vmobj.hasOwnProperty('datasets')
                || vmobj.datasets.length === 0) {

                cb();
                return;
            }
            zfs(['set', 'zoned=off', vmobj.datasets[0]], log,
                function (err, fds) {

                if (err) {
                    log.error({err: err, stdout: fds.stdout,
                        stderr: fds.stderr}, 'Unable to turn off "zoned" for '
                        + vmobj.datasets[0]);
                }
                cb(err);
            });
        }, function (cb) {
            // if we have a delegated dataset, rename zones/<uuid>/data
            //     -> zones/<uuid>-reprovisioning-data
            if (!vmobj.hasOwnProperty('datasets')
                || vmobj.datasets.length === 0) {

                cb();
                return;
            }
            zfs(['rename', '-f', vmobj.datasets[0], vmobj.zfs_filesystem
                + '-reprovisioning-data'], log, function (err, fds) {

                if (err) {
                    log.error({err: err, stdout: fds.stdout,
                        stderr: fds.stderr}, 'Unable to (temporarily) rename '
                        + vmobj.datasets[0]);
                }
                cb(err);
            });
        }, function (cb) {
            // unmount <zonepath>/cores so dataset is not busy
            zfs(['umount', vmobj.zonepath + '/cores'], log,
                function (err, fds) {

                if (err) {
                    if (trim(fds.stderr).match(/not a mountpoint$/)) {
                        log.info('ignoring failure to umount cores which '
                            + 'wasn\'t mounted');
                        cb();
                        return;
                    } else {
                        log.error({err: err, stdout: fds.stdout,
                            stderr: fds.stderr}, 'Unable to umount '
                            + vmobj.zonepath + '/cores');
                    }
                }
                cb(err);
            });
        }, function (cb) {
            // rename <zfs_filesystem> dataset out of the way
            zfs(['rename', '-f', vmobj.zfs_filesystem, vmobj.zfs_filesystem
                + '-reprovisioning-root'], log, function (err, fds) {

                if (err) {
                    log.error({err: err, stdout: fds.stdout,
                        stderr: fds.stderr}, 'Unable to (temporarily) rename '
                        + vmobj.zfs_filesystem);
                }
                cb(err);
            });
        }, function (cb) {
            var snapname = vmobj.zpool + '/' + payload.image_uuid + '@final';

            // ensure we've got our snapshot
            zfs(['get', '-Ho', 'value', 'type', snapname], log,
                function (err, fds) {

                if (!err) {
                    // snapshot already exists, use it
                    log.debug('snapshot "' + snapname + '" exists');
                    snapshot = snapname;
                    cb();
                    return;
                }

                if (fds.stderr.match(/dataset does not exist/)) {
                    // we'll use a different one. (falls throught to next func)
                    cb();
                } else {
                    cb(err);
                }
            });
        }, function (cb) {
            var snapname;

            if (snapshot) {
                // already know which one to use, don't create one
                cb();
                return;
            }

            snapname = vmobj.zpool + '/' + payload.image_uuid
                + '@' + vmobj.uuid;

            // ensure we've got a snapshot
            zfs(['get', '-Ho', 'value', 'type', snapname], log,
                function (err, fds) {

                if (!err) {
                    // snapshot already exists, use it
                    log.debug('snapshot "' + snapname + '" exists');
                    snapshot = snapname;
                    cb();
                    return;
                }

                if (fds.stderr.match(/dataset does not exist/)) {
                    zfs(['snapshot', snapname], log, function (e, snap_fds) {
                        if (e) {
                            e.stdout = snap_fds.stdout;
                            e.stderr = snap_fds.stderr;
                            log.error(e, 'Failed to create snapshot: '
                                + e.message);
                        } else {
                            log.debug('created snapshot "' + snapname + '"');
                            snapshot = snapname;
                        }
                        cb(e);
                    });
                } else {
                    cb(err);
                    return;
                }
            });
        }, function (cb) {
            var args;
            var retry_delay = 1; // second(s) between retries

            // clone the new image creating a new dataset for zoneroot
            assert(snapshot);

            args = ['clone'];
            if (vmobj.hasOwnProperty('quota') && vmobj.quota > 0) {
                args.push('-o');
                args.push('quota=' + vmobj.quota + 'G');
            }
            args.push(snapshot);
            args.push(vmobj.zfs_filesystem);

            function _retryBusy() {
                log.warn('dataset was "busy", retrying');
                setTimeout(function _doRetryBusy() {
                    zfs(['mount', vmobj.zfs_filesystem], log,
                        function (err, fds) {
                            log.warn({err: err, fds: fds},
                                '(retry) mount results');
                            cb(err);
                        }
                    );
                }, retry_delay * 1000);
            }

            zfs(args, log, function (err, fds) {
                if (err) {
                    log.error({err: err, stdout: fds.stdout,
                        stderr: fds.stderr}, 'Unable to create new clone of '
                        + payload.image_uuid);
                    if (err.message.match(
                        /cannot mount .* mountpoint or dataset is busy/)) {

                        /*
                         * See OS-2831, sometimes clone fails to mount but
                         * actually creates the new dataset. Because this
                         * happens frequently, we'll re-try mounting here to
                         * work around the problem if that's what broke us.
                         */

                        _retryBusy(); // will call cb()
                        return;
                    }
                }
                cb(err);
            });
        }, function (cb) {
            var cmd;

            // copy zones/<uuid>-reprovisioning-root/config to
            // zones/<uuid>/config so we keep metadata and ipf rules.
            try {
                fs.mkdirSync(vmobj.zonepath + '/config');
            } catch (e) {
                if (e.code !== 'EEXIST') {
                    e.message = 'Unable to recreate ' + vmobj.zonepath
                        + '/config: ' + e.message;
                    cb(e);
                    return;
                }
            }

            cmd = 'cp -pPR '
                + vmobj.zonepath + '-reprovisioning-root/config/* '
                + vmobj.zonepath + '/config/';

            traceExec(cmd, log, 'cp-config', function (error, stdout, stderr) {
                log.debug({'stdout': stdout, 'stderr': stderr}, 'cp results');
                if (error) {
                    error.stdout = stdout;
                    error.stderr = stderr;
                    cb(error);
                    return;
                } else {
                    cb();
                }
            });
        }, function (cb) {
            // destroy <zonepath>-reprovisioning-root, since it's no longer used
            zfs(['destroy', '-r', vmobj.zfs_filesystem
                + '-reprovisioning-root'], log, function (err, fds) {

                if (err) {
                    log.error({err: err, stdout: fds.stdout,
                        stderr: fds.stderr}, 'Unable to destroy '
                        + vmobj.zfs_filesystem + '-reprovisioning-root: '
                        + err.message);
                }
                cb(err);
            });
        }, function (cb) {
            // remount /zones/<uuid>/cores
            zfs(['mount', vmobj.zpool + '/cores/' + uuid], log,
                function (err, fds) {

                if (err) {
                    log.error({err: err, stdout: fds.stdout,
                        stderr: fds.stderr}, 'Unable to mount ' + vmobj.zonepath
                        + '/cores: ' + err.message);
                }
                cb(err);
            });
        }, function (cb) {
            var args = ['-r', '-R', vmobj.zonepath, '-z', vmobj.zonename];
            var cmd = BRAND_OPTIONS[vmobj.brand].features.brand_install_script;

            // We run the brand's install script here with the -r flag which
            // tells it to do everything that's relevant to reprovision.

            traceExecFile(cmd, args, log, 'brand-install',
                function (error, stdout, stderr) {

                var new_err;

                if (error) {
                    new_err = new Error('Error running brand install script '
                        + cmd);
                    // error's message includes stderr.
                    log.error({err: error, stdout: stdout},
                        'brand install script exited with code ' + error.code);
                    cb(new_err);
                } else {
                    log.debug(cmd + ' stderr:\n' + stderr);
                    cb();
                }
            });
        }, function (cb) {
            // rename zones/<uuid>-reprovision-data -> zones/<uuid>/data
            if (!vmobj.hasOwnProperty('datasets')
                || vmobj.datasets.length === 0) {

                cb();
                return;
            }
            zfs(['rename', '-f', vmobj.zfs_filesystem + '-reprovisioning-data',
                vmobj.datasets[0]], log, function (err, fds) {

                if (err) {
                    log.error({err: err, stdout: fds.stdout,
                        stderr: fds.stderr}, 'Unable to (temporarily) rename '
                        + vmobj.zfs_filesystem);
                }
                cb(err);
            });
        }, function (cb) {
            // set zoned=on for zones/<uuid>/data
            if (!vmobj.hasOwnProperty('datasets')
                || vmobj.datasets.length === 0) {

                cb();
                return;
            }
            zfs(['set', 'zoned=on', vmobj.datasets[0]], log,
                function (err, fds) {

                if (err) {
                    log.error({err: err, stdout: fds.stdout,
                        stderr: fds.stderr}, 'Unable to set "zoned" for: '
                        + vmobj.datasets[0]);
                }
                cb(err);
            });
        }, function (cb) {
            // update zone's image_uuid field
            var zcfg = 'select attr name=dataset-uuid; set value="'
                + payload.image_uuid + '"; end';
            zonecfg(['-u', uuid, zcfg], log, function (err, fds) {
                if (err) {
                    log.error({err: err, stdout: fds.stdout,
                        stderr: fds.stderr}, 'unable to set image_uuid on VM '
                        + uuid);
                }
                cb(err);
            });
        }, function (cb) {
            var p = {
                autoboot: true,
                reprovisioning: true,
                uuid: uuid,
                zonename: vmobj.zonename,
                zonepath: vmobj.zonepath
            };

            // NOTE: someday we could allow mdata_exec_timeout in the original
            // payload to reprovision and then pass it along here.

            // other fields used by installZone()
            [
                'dns_domain',
                'hostname',
                'quota',
                'resolvers',
                'tmpfs',
                'zfs_filesystem',
                'zfs_filesystem_limit',
                'zfs_snapshot_limit',
                'zfs_root_compression',
                'zfs_root_recsize'
            ].forEach(function (k) {
                if (vmobj.hasOwnProperty(k)) {
                    p[k] = vmobj[k];
                }
            });

            // nics needs to be called add_nics here
            if (vmobj.hasOwnProperty('nics')) {
                p.add_nics = vmobj.nics;
            }

            installZone(p, log, function (err) {
                log.debug(err, 'ran installZone() for reprovision');
                cb(err);
            });
        }
    ], function (err) {
        if (err && set_transition) {
            // remove transition now, if we failed.
            VM.unsetTransition(vmobj, {log: log}, function () {
                // err here is original err, we ignore failure to unset because
                // nothing we can do about that..
                callback(err);
            });
        } else {
            callback(err);
        }
    });
};

exports.install = function (uuid, options, callback)
{
    var log;
    var tracers_obj;

    assertMockCnUuid();
    throw new Error('UNIMPLEMENTED: install');

    // options is optional
    if (arguments.length === 2) {
        callback = arguments[1];
        options = {};
    }

    ensureLogging(true);
    if (options.hasOwnProperty('log')) {
        log = options.log;
    } else {
        log = VM.log.child({action: 'install', vm: uuid});
    }

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('install', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    log.info('Installing VM ' + uuid);

    fs.readFile('/etc/zones/' + uuid + '-receiving.json',
        function (err, data) {
            var payload;

            if (err) {
                callback(err);
                return;
            }

            try {
                payload = JSON.parse(data.toString());
            } catch (e) {
                callback(e);
                return;
            }

            // installZone takes a payload
            installZone(payload, log, callback);
        }
    );

};

function getAllDatasets(vmobj)
{
    var datasets = [];
    var disk;

    if (vmobj.hasOwnProperty('zfs_filesystem')) {
        datasets.push(vmobj.zfs_filesystem);
    }

    for (disk in vmobj.disks) {
        disk = vmobj.disks[disk];
        if (disk.hasOwnProperty('zfs_filesystem')) {
            datasets.push(disk.zfs_filesystem);
        }
    }

    return datasets;
}

//
// Headers are 512 bytes and look like:
//
// MAGIC-VMBUNDLE\0
// <VERSION>\0 -- ASCII #s
// <CHECKSUM>\0 -- ASCII (not yet used)
// <OBJ-NAME>\0 -- max length: 256
// <OBJ-SIZE>\0 -- ASCII # of bytes
// <PADDED-SIZE>\0 -- ASCII # of bytes, must be multiple of 512
// ...\0
//
function chunkHeader(name, size, padding)
{
    var header = new Buffer(512);
    var pos = 0;

    header.fill(0);
    pos += addString(header, 'MAGIC-VMBUNDLE', pos);
    pos += addString(header, sprintf('%d', 1), pos);
    pos += addString(header, 'CHECKSUM', pos);
    pos += addString(header, name, pos);
    pos += addString(header, sprintf('%d', size), pos);
    pos += addString(header, sprintf('%d', size + padding), pos);

    return (header);
}

function sendJSON(target, json, log, cb)
{
    var header;
    var pad;
    var padding = 0;

    assert(log, 'no logger passed for sendJSON()');

    if (target === 'stdout') {
        if ((json.length % 512) != 0) {
            padding = 512 - (json.length % 512);
        }
        header = chunkHeader('JSON', json.length, padding);
        process.stdout.write(header);
        process.stdout.write(json, 'utf-8');
        if (padding > 0) {
            pad = new Buffer(padding);
            pad.fill(0);
            process.stdout.write(pad);
        }
        cb();
    } else {
        log.error('Don\'t know how to send JSON to '
            + JSON.stringify(target));
        cb(new Error('Don\'t know how to send JSON to '
            + JSON.stringify(target)));
    }
}

function sendDataset(target, dataset, log, callback)
{
    var header;
    var tracers_obj;

    assert(log, 'no logger passed for sendDataset()');

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('send-dataset', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    if (target === 'stdout') {

        async.series([
            function (cb) {
                // delete any existing 'sending' snapshot
                zfs(['destroy', '-F', dataset + '@sending'], log,
                    function (err, fds) {
                        // We don't expect this to succeed, since that means
                        // something left an @sending around. Warn if succeeds.
                        if (!err) {
                            log.warn('Destroyed pre-existing ' + dataset
                                + '@sending');
                        }
                        cb();
                    }
                );
            }, function (cb) {
                zfs(['snapshot', dataset + '@sending'], log,
                    function (err, fds) {

                    cb(err);
                });
            }, function (cb) {
                header = chunkHeader(dataset, 0, 0);
                process.stdout.write(header);
                cb();
            }, function (cb) {
                var child;

                child = spawn('/usr/sbin/zfs',
                    ['send', '-p', dataset + '@sending'],
                    {customFds: [-1, 1, -1]});
                child.stderr.on('data', function (data) {
                    var idx;
                    var lines = trim(data.toString()).split('\n');

                    for (idx in lines) {
                        log.debug('zfs send: ' + trim(lines[idx]));
                    }
                });
                child.on('close', function (code) {
                    log.debug('zfs send process exited with code '
                        + code);
                    cb();
                });
            }, function (cb) {
                zfs(['destroy', '-F', dataset + '@sending'], log,
                    function (err, fds) {
                        if (err) {
                            log.warn(err, 'Unable to destroy ' + dataset
                                + '@sending: ' + err.message);
                        }
                        cb(err);
                    }
                );
            }
        ], function (err) {
            if (err) {
                log.error(err, 'Failed to send dataset: ' + err.message);
            } else {
                log.info('Successfully sent dataset');
            }
            callback(err);
        });
    } else {
        log.error('Don\'t know how to send datasets to '
            + JSON.stringify(target));
        callback(new Error('Don\'t know how to send datasets to '
            + JSON.stringify(target)));
    }
}

exports.send = function (uuid, target, options, callback)
{
    var datasets;
    var log;
    var tracers_obj;
    var vmobj;

    assertMockCnUuid();
    throw new Error('UNIMPLEMENTED: send');

    // options is optional
    if (arguments.length === 3) {
        callback = arguments[2];
        options = {};
    }

    ensureLogging(true);
    if (options.hasOwnProperty('log')) {
        log = options.log;
    } else {
        log = VM.log.child({action: 'send', vm: uuid});
    }

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('send-vm', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    target = 'stdout';

    log.info('Sending VM ' + uuid + ' to: ' + JSON.stringify(target));
    async.series([
        function (cb) {
            // make sure we *can* send first, to avoid wasting cycles
            if (target === 'stdout' && tty.isatty(1)) {
                log.error('Cannot send VM to a TTY.');
                cb(new Error('Cannot send VM to a TTY.'));
            } else {
                cb();
            }
        }, function (cb) {
            // NOTE: for this load we always load all fields, because we need
            // to send them all to the target machine.
            VM.load(uuid, {log: log}, function (err, obj) {
                if (err) {
                    cb(err);
                } else {
                    vmobj = obj;
                    cb();
                }
            });
        }, function (cb) {
            datasets = getAllDatasets(vmobj);
            if (datasets.length < 1) {
                log.error('Cannot send VM with no datasets.');
                cb(new Error('VM has no datasets.'));
            } else {
                cb();
            }
        }, function (cb) {
            if (vmobj.state !== 'stopped') {
                // In this case we need to stop it and make sure it stopped.
                VM.stop(uuid, {log: log}, function (e) {
                    if (e) {
                        log.error(e, 'unable to stop VM ' + uuid + ': '
                            + e.message);
                        cb(e);
                        return;
                    }
                    VM.load(uuid, {fields: ['zone_state', 'uuid'], log: log},
                        function (error, obj) {

                        if (error) {
                            log.error(error, 'unable to reload VM ' + uuid
                                + ': ' + error.message);
                            return;
                        }
                        if (obj.zone_state !== 'installed') {
                            log.error('after stop attempt, state is '
                                + obj.zone_state + ' != installed');
                            cb(new Error('state after stopping is '
                                + obj.zone_state + ' != installed'));
                            return;
                        }
                        cb();
                    });
                });
            } else {
                // already stopped, good to go!
                cb();
            }
        }, function (cb) {
            // Clean up trash left from broken datasets (see OS-388)
            try {
                fs.unlinkSync(vmobj.zonepath + '/SUNWattached.xml');
            } catch (err) {
                // DO NOTHING, this file shouldn't have existed anyway.
            }
            try {
                fs.unlinkSync(vmobj.zonepath + '/SUNWdetached.xml');
            } catch (err) {
                // DO NOTHING, this file shouldn't have existed anyway.
            }
            cb();
        }, function (cb) {
            // send JSON
            var json = JSON.stringify(vmobj, null, 2) + '\n';
            sendJSON(target, json, log, cb);
        }, function (cb) {
            // send datasets
            async.forEachSeries(datasets, function (ds, c) {
                sendDataset(target, ds, log, c);
            }, function (e) {
                if (e) {
                    log.error('Failed to send datasets');
                }
                cb(e);
            });
        }
    ], function (err) {
        callback(err);
    });
};

exports.create = function (payload, options, callback)
{
    var log;
    var tracers_obj;

    throw new Error('UNIMPLEMENTED: create');

    // options is optional
    if (arguments.length === 2) {
        callback = arguments[1];
        options = {};
    }

    ensureLogging(true);

    if (options.hasOwnProperty('log')) {
        log = options.log;
    } else {
        // default to VM.log until we have a uuid, then we'll switch.
        log = VM.log;
    }

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('create', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    log.info('Creating VM, original payload:\n'
        + JSON.stringify(payload, null, 2));

    async.waterfall([
        function (cb) {
            // We get a UUID first so that we can attach as many log messages
            // as possible to this uuid.  Since we don't have a UUID here, we
            // send VM.log as the logger.  We'll switch to a log.child as soon
            // as we have uuid.
            createZoneUUID(payload, log, function (e, uuid) {
                // either payload will have .uuid or we'll return error here.
                cb(e);
            });
        }, function (cb) {
            // If we got here, payload now has .uuid and we can start logging
            // messages with that uuid if we didn't already have a logger.
            if (!options.hasOwnProperty('log')) {
                log = log.child({action: 'create', vm: payload.uuid});
            }
            cb();
        }, function (cb) {
            normalizePayload(payload, null, log, function (err) {
                if (err) {
                    log.error(err, 'Failed to validate payload: '
                        + err.message);
                } else {
                    log.debug('normalized payload:\n'
                        + JSON.stringify(payload, null, 2));
                }
                cb(err);
            });
        }, function (cb) {
            checkDatasetProvisionable(payload, log, function (provisionable) {
                if (!provisionable) {
                    log.error('checkDatasetProvisionable() says dataset is '
                        + 'unprovisionable');
                    cb(new Error('provisioning dataset ' + payload.image_uuid
                        + ' with brand ' + payload.brand
                        + ' is not supported'));
                    return;
                }
                cb();
            });
        }, function (cb) {
            if (BRAND_OPTIONS[payload.brand].features.type === 'KVM') {
                createVM(payload, log, function (error, result) {
                    if (error) {
                        cb(error);
                    } else {
                        cb(null);
                    }
                });
            } else {
                createZone(payload, log, function (error, result) {
                    if (error) {
                        cb(error);
                    } else {
                        cb(null);
                    }
                });
            }
        }
    ], function (err) {
        var obj = {'uuid': payload.uuid, 'zonename': payload.zonename};
        callback(err, obj);
    });
};

// delete a zvol
function deleteVolume(volume, log, callback)
{
    var args;
    var skip = false;
    var tracers_obj;
    var origin;

    assert(log, 'no logger passed to deleteVolume()');

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('delete-volume', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    if (volume.missing) {
        // this volume doesn't actually exist, so skip trying to delete.
        log.info('volume ' + volume.zfs_filesystem + ' doesn\'t exist, skipping'
            + ' deletion');
        callback();
        return;
    }

    if (!volume.zfs_filesystem) {
        log.warn({volume: volume}, 'missing zfs_filesystem for volume, skipping'
            + ' destroy');
        callback();
        return;
    }

    async.series([
        function (cb) {
            args = ['get', '-Ho', 'value', 'origin', volume.zfs_filesystem];
            zfs(args, log, function (err, fds) {
                if (err && fds.stderr.match('dataset does not exist')) {
                    log.info('volume ' + volume.zfs_filesystem + ' doesn\'t '
                        + 'exist, skipping deletion');
                    skip = true;
                    cb();
                } else {
                    origin = trim(fds.stdout);
                    log.info('found origin "' + origin + '"');
                    cb(err);
                }
            });
        }, function (cb) {
            if (skip) {
                // we decided to skip this deletion
                cb();
                return;
            }
            // use recursive delete to handle possible snapshots on volume
            args = ['destroy', '-rF', volume.zfs_filesystem];
            zfs(args, log, function (err, fds) {
                // err will be non-null if something broke
                if (err) {
                    log.error({
                        err: err,
                        stdout: fds.stdout,
                        stderr: fds.stderr,
                        volume: volume
                    }, 'failed: zfs destroy -rF ' + volume.zfs_filesystem);
                } else {
                    log.info({
                        stdout: fds.stdout,
                        stderr: fds.stderr,
                        volume: volume
                    }, 'success: zfs destroy -rF ' + volume.zfs_filesystem);
                }
                cb(err);
            });
        }, function (cb) {
            if (skip) {
                // we decided to skip this deletion
                cb();
                return;
            }
            // we never delete an @final snapshot, that's the one from recv
            // that imgadm left around for us on purpose.
            if (!origin || origin.length < 1 || origin == '-'
                || origin.match('@final')) {

                cb();
                return;
            }
            args = ['destroy', '-rF', origin];
            zfs(args, log, function (err, fds) {
                // err will be non-null if something broke
                if (err) {
                    log.error({
                        err: err,
                        origin: origin,
                        stdout: fds.stdout,
                        stderr: fds.stderr,
                        volume: volume
                    }, 'failed: zfs destroy -rF ' + origin);
                } else {
                    log.info({
                        origin: origin,
                        stdout: fds.stdout,
                        stderr: fds.stderr,
                        volume: volume
                    }, 'success: zfs destroy -rF ' + origin);
                }
                cb(err);
            });
        }
    ], function (err) {
        callback(err);
    });
}

function deleteZone(uuid, log, callback)
{
    var load_fields;
    var tracers_obj;
    var vmobj;

    assert(log, 'no logger passed to deleteZone()');

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('delete-zone', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    load_fields = [
        'archive_on_delete',
        'disks',
        'docker',
        'filesystems',
        'indestructible_delegated',
        'indestructible_zoneroot',
        'uuid',
        'zonename',
        'zonepath'
    ];

    async.series([
        function (cb) {
            VM.load(uuid, {fields: load_fields, log: log}, function (err, obj) {
                if (err) {
                    cb(err);
                    return;
                }
                vmobj = obj;
                cb();
            });
        }, function (cb) {
            if (vmobj.indestructible_zoneroot) {
                cb(new Error('indestructible_zoneroot is set, cannot delete'));
            } else if (vmobj.indestructible_delegated) {
                cb(new Error('indestructible_delegated is set, cannot delete'));
            } else {
                cb();
            }
        }, function (cb) {
            var data_prefix;
            var data_volumes = [];

            /*
             * We want to prevent docker VMs which have volumes that are shared
             * to other containers from being deleted until those containers
             * using the volume(s) are first deleted. So if any other container
             * is using this container's volumes, we fail the deletion.
             */
            if (!vmobj.docker || ! vmobj.filesystems
                || vmobj.filesystems.length < 0) {

                cb();
                return;
            }

            data_prefix = path.join(vmobj.zonepath, 'volumes') + '/';

            vmobj.filesystems.forEach(function (f) {
                if (f.source.substr(0, data_prefix.length) === data_prefix) {
                    data_volumes.push(f.source);
                }
            });

            if (data_volumes.length === 0) {
                log.debug({uuid: vmobj.uuid}, 'VM has no local data volumes '
                    + 'no need to check other VMs for --volumes-from');
                cb();
                return;
            }

            log.info({uuid: vmobj.uuid, volumes: data_volumes},
                'VM has local data volumes, checking other containers for '
                + '--volumes-from');

            // TODO can we safely limit to the same owner_uuid?

            VM.lookup({}, {fields: [
                'filesystems',
                'uuid'
            ]}, function (err, vmobjs) {
                var volume_users = [];

                if (err) {
                    log.error({err: err, uuid: vmobj.uuid}, 'failed to lookup '
                        + 'potential --volumes-from');
                    cb(err);
                    return;
                }

                if (vmobjs.length > 0) {
                    vmobjs.forEach(function (v) {
                        if (!v.filesystems || v.uuid === vmobj.uuid) {
                            return;
                        }
                        v.filesystems.forEach(function (f) {
                            data_volumes.forEach(function (d) {
                                if (d === f.source) {
                                    log.info({
                                        consumer_vm_uuid: v.uuid,
                                        provider_vm_uuid: vmobj.uuid,
                                        volume: d
                                    }, 'volume is still used by existing VM');

                                    if (volume_users.indexOf(v.uuid) === -1) {
                                        volume_users.push(v.uuid);
                                    }
                                }
                            });
                        });
                    });
                }

                if (volume_users.length === 0) {
                    log.info({uuid: vmobj.uuid}, 'No VMs found using '
                        + '--volumes-from');
                    cb();
                    return;
                }

                log.error({uuid: vmobj.uuid, volume_users: volume_users},
                    'found VMs using --volumes-from, cannot delete');
                cb(new Error('Unable to delete VM ' + vmobj.uuid + ' the '
                    + 'following VMs are sharing its volumes: '
                    + JSON.stringify(volume_users)));
            });
        }, function (cb) {
            log.debug('archive_on_delete is set to '
                + !!vmobj.archive_on_delete);
            if (!vmobj.archive_on_delete) {
                cb();
                return;
            }
            archiveVM(vmobj.uuid, log, function () {
                cb();
            });
        // TODO: replace these next two with VM.stop(..{force: true} ?
        }, function (cb) {
            log.debug('setting autoboot=false');
            zonecfg(['-u', uuid, 'set autoboot=false'], log, function (e, fds) {
                if (e) {
                    log.warn({err: e, stdout: fds.stdout, stderr: fds.stderr},
                        'Error setting autoboot=false');
                } else {
                    log.debug({stdout: fds.stdout, stderr: fds.stderr},
                        'set autoboot=false');
                }
                cb();
            });
        }, function (cb) {
            log.debug('halting zone');
            zoneadm(['-u', uuid, 'halt', '-X'], log, function (e, fds) {
                if (e) {
                    log.warn({err: e, stdout: fds.stdout, stderr: fds.stderr},
                        'Error halting zone');
                } else {
                    log.debug({stdout: fds.stdout, stderr: fds.stderr},
                        'halted zone');
                }
                cb();
            });
        }, function (cb) {
            log.debug('uninstalling zone');
            zoneadm(['-u', uuid, 'uninstall', '-F'], log, function (e, fds) {
                if (e) {
                    log.warn({err: e, stdout: fds.stdout, stderr: fds.stderr},
                        'Error uninstalling zone: ' + e.message);
                } else {
                    log.debug({stdout: fds.stdout, stderr: fds.stderr},
                        'uninstalled zone');
                }
                cb();
            });
        }, function (cb) {
            function _loggedDeleteVolume(volume, callbk) {
                return deleteVolume(volume, log, callbk);
            }

            if (vmobj && vmobj.hasOwnProperty('disks')) {
                async.forEachSeries(vmobj.disks, _loggedDeleteVolume,
                    function (err) {
                        if (err) {
                            log.error(err, 'Unknown error deleting volumes: '
                                + err.message);
                            cb(err);
                        } else {
                            log.info('successfully deleted volumes');
                            cb();
                        }
                    }
                );
            } else {
                log.debug('skipping volume destruction for diskless '
                    + vmobj.uuid);
                cb();
            }
        }, function (cb) {
            if (vmobj.zonename) {
                log.debug('deleting zone');
                // XXX for some reason -u <uuid> doesn't work with delete
                zonecfg(['-z', vmobj.zonename, 'delete', '-F'], log,
                    function (e, fds) {

                    if (e) {
                        log.warn({err: e, stdout: fds.stdout,
                            stderr: fds.stderr}, 'Error deleting VM');
                    } else {
                        log.debug({stdout: fds.stdout, stderr: fds.stderr},
                            'deleted VM ' + uuid);
                    }
                    cb();
                });
            } else {
                cb();
            }
        }, function (cb) {
            VM.load(uuid, {fields: ['uuid'], log: log, missing_ok: true},
                function (err, obj) {

                if (err && err.code === 'ENOENT') {
                    // the zone is gone, that's good.
                    log.debug('confirmed VM is gone.');
                    cb();
                } else if (err) {
                    // there was am unexpected error.
                    cb(err);
                } else {
                    // the VM still exists!
                    err = new Error('VM still exists after delete.');
                    err.code = 'EEXIST';
                    cb(err);
                }
            });
        }, function (cb) {
            // delete the incoming payload if it exists
            fs.unlink('/etc/zones/' + vmobj.uuid + '-receiving.json',
                function (e) {
                    // we can't do anyhing if this fails other than log
                    if (e && e.code !== 'ENOENT') {
                        log.warn(e, 'Failed to delete ' + vmobj.uuid
                            + '-receiving.json (' + e.code + '): ' + e.message);
                    }
                    cb();
                }
            );
        }
    ], function (error) {
        callback(error);
    });
}

exports.delete = function (uuid, options, callback)
{
    var attemptDelete;
    var last_try = 16;
    var log;
    var next_try = 1;
    var tracers_obj;
    var tries = 0;

    assertMockCnUuid();
    throw new Error('UNIMPLEMENTED: delete');

    // options is optional
    if (arguments.length === 2) {
        callback = arguments[1];
        options = {};
    }

    ensureLogging(true);

    if (options.hasOwnProperty('log')) {
        log = options.log;
    } else {
        log = VM.log.child({action: 'delete', vm: uuid});
    }

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('delete', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    log.info('Deleting VM ' + uuid);

    attemptDelete = function (cb) {
        next_try = (next_try * 2);
        deleteZone(uuid, log, function (err) {
            tries++;
            if (err && err.code === 'EEXIST') {
                // zone still existed, try again if we've not tried too much.
                if (next_try <= last_try) {
                    log.info('VM.delete(' + tries + '): still there, '
                        + 'will try again in: ' + next_try + ' secs');
                    setTimeout(function () {
                        // try again
                        attemptDelete(cb);
                    }, next_try * 1000);
                } else {
                    log.warn('VM.delete(' + tries + '): still there after'
                        + ' ' + next_try + ' seconds, giving up.');
                    cb(new Error('delete failed after ' + tries + ' attempts. '
                        + '(check the log for details)'));
                    return;
                }
            } else if (err) {
                // error but not one we can retry from.
                log.error(err, 'VM.delete: FATAL: ' + err.message);
                cb(err);
            } else {
                // success!
                log.debug('VM.delete: SUCCESS');
                cb();
            }
        });
    };

    attemptDelete(function (err) {
        if (err) {
            log.error(err);
        }
        callback(err);
    });
};

// This function needs vmobj to have:
//
// brand
// never_booted
// uuid
// zonename
//
function startZone(vmobj, log, callback)
{
    var set_autoboot = 'set autoboot=true';
    var tracers_obj;
    var uuid = vmobj.uuid;

    assert(log, 'no logger passed to startZone()');

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('start-zone', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    log.debug('startZone starting ' + uuid);

    //
    // We set autoboot (or vm-autoboot) here because we've just intentionally
    // started this vm, so we want it to come up if the host is rebooted.
    //
    if (BRAND_OPTIONS[vmobj.brand].features.use_vm_autoboot) {
        set_autoboot = 'select attr name=vm-autoboot; set value=true; end';
    }

    async.series([
        function (cb) {
            // do the booting
            zoneadm(['-u', uuid, 'boot', '-X'], log, function (err, boot_fds) {
                if (err) {
                    log.error({err: err, stdout: boot_fds.stdout,
                        stderr: boot_fds.stderr}, 'zoneadm failed to boot '
                        + 'VM');
                } else {
                    log.debug({stdout: boot_fds.stdout,
                        stderr: boot_fds.stderr}, 'zoneadm booted VM');
                }
                cb(err);
            });
        }, function (cb) {
            // ensure it booted
            VM.waitForZoneState(vmobj, 'running', {timeout: 30, log: log},
                function (err, result) {

                if (err) {
                    if (err.code === 'ETIMEOUT') {
                        log.info(err, 'timeout waiting for zone to go to '
                            + '"running"');
                    } else {
                        log.error(err, 'unknown error waiting for zone to go'
                            + ' "running"');
                    }
                } else {
                    // zone got to running
                    log.info('VM seems to have switched to "running"');
                }
                cb(err);
            });
        }, function (cb) {
            if (vmobj.docker && vmobj.internal_metadata
                && !vmobj.internal_metadata['docker:restartpolicy']) {

                // no restartpolicy means --restart=no, so we don't set autoboot
                log.info({uuid: vmobj.uuid},
                    'docker VM has no restart policy, not setting autoboot');
                cb();
                return;
            } else if (vmobj.docker && vmobj.internal_metadata) {
                // all other policies currently involve rebooting at least on CN
                // reboot.
                log.info({
                    uuid: vmobj.uuid,
                    policy: vmobj.internal_metadata['docker:restartpolicy']
                }, 'docker VM has restart policy, setting autoboot');
            }

            zonecfg(['-u', uuid, set_autoboot], log,
                function (err, autoboot_fds) {

                if (err) {
                    // The vm is running at this point, erroring out here would
                    // do no good, so we just log it.
                    log.error({err: err, stdout: autoboot_fds.stdout,
                        stderr: autoboot_fds.stderr}, 'startZone(): Failed to '
                        + set_autoboot + ' for ' + uuid);
                } else {
                    log.debug({stdout: autoboot_fds.stdout,
                        stderr: autoboot_fds.stderr}, 'set autoboot');
                }
                cb(err);
            });
        }, function (cb) {
            if (!vmobj.never_booted) {
                cb();
                return;
            }
            zonecfg(['-u', uuid, 'remove attr name=never-booted' ], log,
                function (err, neverbooted_fds) {
                    // Ignore errors here, because we're started.
                    if (err) {
                        log.warn({err: err, stdout: neverbooted_fds.stdout,
                            stderr: neverbooted_fds.stderr}, 'failed to remove '
                            + 'never-booted flag');
                    } else {
                        log.debug({stdout: neverbooted_fds.stdout,
                            stderr: neverbooted_fds.stderr}, 'removed '
                            + 'never-booted flag');
                    }
                    cb();
                }
            );
        }
    ], function (err) {
        if (!err) {
            log.info('Started ' + uuid);
        }
        callback(err);
    });
}

// build the qemu cmdline and start up a VM
//
// vmobj needs any of the following that are defined:
//
// boot
// brand
// cpu_type
// default_gateway
// disks
// hostname
// internal_metadata
// never_booted
// nics
// platform_buildstamp
// qemu_extra_opts
// qemu_opts
// ram
// resolvers
// spice_opts
// spice_password
// spice_port
// state
// uuid
// vcpus
// vga
// virtio_txtimer
// virtio_txburst
// vnc_password
// zone_state
// zonename
// zonepath
//
function startVM(vmobj, extra, log, callback)
{
    var check_path;
    var cmdargs = [];
    var d;
    var defaultgw = '';
    var disk;
    var diskargs = '';
    var disk_idx = 0;
    var found;
    var hostname = vmobj.uuid;
    var mdata;
    var nic;
    var nic_idx = 0;
    var primary_found = false;
    var qemu_opts = '';
    var r;
    var script;
    var smbios_version = '7.x';
    var spiceargs;
    var tracers_obj;
    var uuid = vmobj.uuid;
    var virtio_txburst;
    var virtio_txtimer;
    var vnic_opts;
    var zoneroot;

    assert(log, 'no logger passed to startVM');
    assert(vmobj.hasOwnProperty('zonepath'), 'missing zonepath');

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('start-vm', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    log.debug('startVM(' + uuid + ')');

    if (!vmobj.hasOwnProperty('state')) {
        callback(new Error('Cannot start VM ' + uuid + ' which has no state'));
        return;
    }

    if ((vmobj.state !== 'stopped' && vmobj.state !== 'provisioning')
        || (vmobj.state === 'provisioning'
        && vmobj.zone_state !== 'installed')) {

        callback(new Error('Cannot start VM from state: ' + vmobj.state
            + ', must be "stopped"'));
        return;
    }

    if (vmobj.hasOwnProperty('platform_buildstamp')) {
        smbios_version = vmobj.platform_buildstamp;
    }

    zoneroot = path.join(vmobj.zonepath, '/root');

    // We're going to write to /startvm and /tmp/vm.metadata, we don't care if
    // they already exist, but we don't want them to be symlinks.
    try {
        assertSafeZonePath(zoneroot, '/startvm',
            {type: 'file', enoent_ok: true});
        assertSafeZonePath(zoneroot, '/tmp/vm.metadata',
            {type: 'file', enoent_ok: true});
    } catch (e) {
        log.error(e, 'Error validating files for startVM(): '
            + e.message);
        callback(e);
        return;
    }

    // XXX TODO: validate vmobj data is ok to start

    cmdargs.push('-m', vmobj.ram);
    cmdargs.push('-name', vmobj.uuid);
    cmdargs.push('-uuid', vmobj.uuid);

    if (vmobj.hasOwnProperty('cpu_type')) {
        cmdargs.push('-cpu', vmobj.cpu_type);
    } else {
        cmdargs.push('-cpu', 'qemu64');
    }

    if (vmobj.vcpus > 1) {
        cmdargs.push('-smp', vmobj.vcpus);
    }

    for (disk in vmobj.disks) {
        if (vmobj.disks.hasOwnProperty(disk)) {
            disk = vmobj.disks[disk];
            if (!disk.media) {
                disk.media = 'disk';
            }
            diskargs = 'file=' + disk.path + ',if=' + disk.model
                + ',index=' + disk_idx + ',media=' + disk.media;
            if (disk.boot) {
                diskargs = diskargs + ',boot=on';
            }
            cmdargs.push('-drive', diskargs);
            disk_idx++;
        }
    }

    // extra payload can include additional disks that we want to include only
    // on this one boot.  It can also contain a boot parameter to control boot
    // device.  See qemu http://qemu.weilnetz.de/qemu-doc.html for info on
    // -boot options.
    if (extra.hasOwnProperty('disks')) {
        for (disk in extra.disks) {
            if (extra.disks.hasOwnProperty(disk)) {
                disk = extra.disks[disk];

                // ensure this is either a disk that gets mounted in or a
                // file that's been dropped in to the zonepath
                found = false;
                for (d in vmobj.disks) {
                    if (!found && vmobj.disks.hasOwnProperty(d)) {
                        d = vmobj.disks[d];
                        if (d.path === disk.path) {
                            found = true;
                        }
                    }
                }
                check_path = path.join(vmobj.zonepath, 'root', disk.path);
                if (!found && fs.existsSync(check_path)) {
                    found = true;
                }
                if (!found) {
                    callback(new Error('Cannot find disk: ' + disk.path));
                    return;
                }

                if (!disk.media) {
                    disk.media = 'disk';
                }
                diskargs = 'file=' + disk.path + ',if=' + disk.model
                    + ',index=' + disk_idx + ',media=' + disk.media;
                if (disk.boot) {
                    diskargs = diskargs + ',boot=on';
                }
                cmdargs.push('-drive', diskargs);
                disk_idx++;
            }
        }
    }

    // helpful values:
    // order=nc (network boot, then fallback to disk)
    // once=d (boot on disk once and the fallback to default)
    // order=c,once=d (boot on CDROM this time, but not subsequent boots)
    if (extra.hasOwnProperty('boot')) {
        cmdargs.push('-boot', extra.boot);
    } else if (vmobj.hasOwnProperty('boot')) {
        cmdargs.push('-boot', vmobj.boot);
    } else {
        // order=cd means try harddisk first (c) and cdrom if that fails (d)
        cmdargs.push('-boot', 'order=cd');
    }

    if (vmobj.hasOwnProperty('hostname')) {
        hostname = vmobj.hostname;
    }

    if (vmobj.hasOwnProperty('default_gateway')) {
        defaultgw = vmobj['default_gateway'];
    }

    /*
     * These tunables are set for all virtio vnics on this VM.
     */
    virtio_txtimer = VIRTIO_TXTIMER_DEFAULT;
    virtio_txburst = VIRTIO_TXBURST_DEFAULT;
    if (vmobj.hasOwnProperty('virtio_txtimer')) {
        virtio_txtimer = vmobj.virtio_txtimer;
    }
    if (vmobj.hasOwnProperty('virtio_txburst')) {
        virtio_txburst = vmobj.virtio_txburst;
    }

    for (nic in vmobj.nics) {
        if (vmobj.nics.hasOwnProperty(nic)) {
            nic = vmobj.nics[nic];

            // for virtio devices, we want to be able to set the txtimer and
            // txburst so we use a '-device' instead of a '-net' line.
            if (nic.model === 'virtio') {
                cmdargs.push('-device',
                    'virtio-net-pci,mac=' + nic.mac
                    + ',tx=timer,x-txtimer=' + virtio_txtimer
                    + ',x-txburst=' + virtio_txburst
                    + ',vlan=' + nic_idx);
            } else {
                cmdargs.push('-net',
                    'nic,macaddr=' + nic.mac
                    + ',vlan=' + nic_idx
                    + ',name=' + nic.interface
                    + ',model=' + nic.model);
            }
            vnic_opts = 'vnic,name=' + nic.interface
                + ',vlan=' + nic_idx
                + ',ifname=' + nic.interface;

            if (nic.ip != 'dhcp') {
                vnic_opts = vnic_opts
                    + ',ip=' + nic.ip
                    + ',netmask=' + nic.netmask;
            }

            // The primary network provides the resolvers, default gateway
            // and hostname to prevent vm from trying to use settings
            // from more than one nic
            if (!primary_found) {
                if (nic.hasOwnProperty('primary') && nic.primary) {
                    if (nic.hasOwnProperty('gateway') && nic.ip != 'dhcp') {
                        vnic_opts += ',gateway_ip=' + nic.gateway;
                    }
                    primary_found = true;
                } else if (defaultgw && nic.hasOwnProperty('gateway')
                    && nic.gateway == defaultgw) {

                    /*
                     * XXX this exists here for backward compatibilty.  New VMs
                     *     and old VMs that are upgraded should not use
                     *     default_gateway.  When we've implemented autoupgrade
                     *     this block (and all reference to default_gateway)
                     *     can be removed.
                     */

                    if (nic.ip != 'dhcp') {
                        vnic_opts += ',gateway_ip=' + nic.gateway;
                    }
                    primary_found = true;
                }

                if (primary_found && nic.ip != 'dhcp') {
                    if (hostname) {
                        vnic_opts += ',hostname=' + hostname;
                    }
                    if (vmobj.hasOwnProperty('resolvers')) {
                        /*
                         * We only take the first 4 resolvers here for KVM
                         * per OS-2795. Because qemu only supports up to 4.
                         */
                        for (r in vmobj.resolvers.slice(0, 4)) {
                            vnic_opts += ',dns_ip' + r + '='
                                + vmobj.resolvers[r];
                        }
                    }
                }
            }

            cmdargs.push('-net', vnic_opts);
            nic_idx++;
        }
    }

    cmdargs.push('-smbios', 'type=1,manufacturer=Joyent,'
        + 'product=SmartDC HVM,version=7.' + smbios_version + ','
        + 'serial=' + vmobj.uuid + ',uuid=' + vmobj.uuid + ','
        + 'sku=001,family=Virtual Machine');

    cmdargs.push('-pidfile', '/tmp/vm.pid');

    if (vmobj.hasOwnProperty('vga')) {
        cmdargs.push('-vga', vmobj.vga);
    } else {
        cmdargs.push('-vga', 'std');
    }

    cmdargs.push('-chardev',
        'socket,id=qmp,path=/tmp/vm.qmp,server,nowait');
    cmdargs.push('-qmp', 'chardev:qmp');

    // serial0 is for serial console
    cmdargs.push('-chardev',
        'socket,id=serial0,path=/tmp/vm.console,server,nowait');
    cmdargs.push('-serial', 'chardev:serial0');

    // serial1 is used for metadata API
    cmdargs.push('-chardev',
        'socket,id=serial1,path=/tmp/vm.ttyb,server,nowait');
    cmdargs.push('-serial', 'chardev:serial1');

    if (!vmobj.qemu_opts) {
        if (vmobj.hasOwnProperty('vnc_password')
            && vmobj.vnc_password.length > 0) {

            cmdargs.push('-vnc', 'unix:/tmp/vm.vnc,password');
        } else {
            cmdargs.push('-vnc', 'unix:/tmp/vm.vnc');
        }
        if (vmobj.hasOwnProperty('spice_port')
            && vmobj.spice_port !== -1) {

            spiceargs = 'sock=/tmp/vm.spice';
            if (!vmobj.hasOwnProperty('spice_password')
                || vmobj.spice_password.length <= 0) {

                spiceargs = spiceargs + ',disable-ticketing';

                // Otherwise, spice password is set via qmp, so we don't
                // need to do anything here
            }
            if (vmobj.hasOwnProperty('spice_opts')
                && vmobj.spice_opts.length > 0) {

                spiceargs = spiceargs + ',' + vmobj.spice_opts;
            }
            cmdargs.push('-spice', spiceargs);
        }
        cmdargs.push('-parallel', 'none');
        cmdargs.push('-usb');
        cmdargs.push('-usbdevice', 'tablet');
        cmdargs.push('-k', 'en-us');
    } else {
        qemu_opts = vmobj.qemu_opts.toString();
    }

    if (vmobj.qemu_extra_opts) {
        qemu_opts = qemu_opts + ' ' + vmobj.qemu_extra_opts;
    }

    // This actually creates the qemu process
    script = '#!/usr/bin/bash\n\n'
        + 'exec >/tmp/vm.startvm.log 2>&1\n\n'
        + 'set -o xtrace\n\n'
        + 'if [[ -x /startvm.zone ]]; then\n'
        + '    exec /smartdc/bin/qemu-exec /startvm.zone "'
        + cmdargs.join('" "')
        + '" ' + qemu_opts + '\n'
        + 'else\n'
        + '    exec /smartdc/bin/qemu-exec /smartdc/bin/qemu-system-x86_64 "'
        + cmdargs.join('" "')
        + '" ' + qemu_opts + '\n'
        + 'fi\n\n'
        + 'exit 1\n';

    try {
        fs.writeFileSync(vmobj.zonepath + '/root/startvm', script);
        fs.chmodSync(vmobj.zonepath + '/root/startvm', '0755');
    } catch (e) {
        log.warn(e, 'Unable to create /startvm script in ' + vmobj.uuid);
        callback(new Error('cannot create /startvm'));
        return;
    }

    mdata = {
        'internal_metadata':
            vmobj.internal_metadata ? vmobj.internal_metadata : {}
    };
    fs.writeFile(path.join(vmobj.zonepath, '/root/tmp/vm.metadata'),
        JSON.stringify(mdata, null, 2) + '\n',
        function (err) {
            if (err) {
                log.debug(err, 'FAILED TO write metadata to '
                    + '/tmp/vm.metadata: ' + err.message);
                callback(err);
            } else {
                log.debug('wrote metadata to /tmp/vm.metadata');
                startZone(vmobj, log, callback);
            }
        }
    );
}

// according to usr/src/common/zfs/zfs_namecheck.c allowed characters are:
//
// alphanumeric characters plus the following: [-_.:%]
//
function validSnapshotName(snapname, log)
{
    assert(log, 'no logger passed to validSnapshotName()');

    if (snapname.length < 1 || snapname.length > MAX_SNAPNAME_LENGTH) {
        log.error('Invalid snapname length: ' + snapname.length
            + ' valid range: [1-' + MAX_SNAPNAME_LENGTH + ']');
        return (false);
    }

    if (snapname.match(/[^a-zA-Z0-9\-\_\.\:\%]/)) {
        log.error('Invalid snapshot name: contains invalid characters.');
        return (false);
    }

    return (true);
}

function performSnapshotRollback(snapshots, log, callback)
{
    var tracers_obj;

    assert(log, 'no logger passed to performSnapshotRollback()');

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('snapshot-rollback', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    // NOTE: we assume machine is stopped and snapshots are already validated

    function rollback(snapname, cb) {
        var args;

        args = ['rollback', '-r', snapname];
        zfs(args, log, function (zfs_err, fds) {
            if (zfs_err) {
                log.error({'err': zfs_err, 'stdout': fds.stdout,
                    'stderr': fds.stdout}, 'zfs rollback of ' + snapname
                    + ' failed.');
                cb(zfs_err);
                return;
            }
            log.info('rolled back snapshot ' + snapname);
            log.debug('zfs destroy stdout: ' + fds.stdout);
            log.debug('zfs destroy stderr: ' + fds.stderr);
            cb();
        });
    }

    async.forEachSeries(snapshots, rollback, function (err) {
        if (err) {
            log.error(err, 'Unable to rollback some datasets.');
        }
        callback(err);
    });
}

function updateZonecfgTimestamp(vmobj, callback)
{
    var file;
    var now;

    assert(vmobj.zonename, 'updateZonecfgTimestamp() vmobj must have '
        + '.zonename');

    file = path.join('/etc/zones/', vmobj.zonename + '.xml');
    now = new Date();

    fs.utimes(file, now, now, callback);
}

exports.rollback_snapshot = function (uuid, snapname, options, callback)
{
    var load_fields;
    var log;
    var tracers_obj;

    assertMockCnUuid();
    throw new Error('UNIMPLEMENTED: rollback_snapshot');

    // options is optional
    if (arguments.length === 3) {
        callback = arguments[2];
        options = {};
    }

    ensureLogging(true);
    if (options.hasOwnProperty('log')) {
        log = options.log;
    } else {
        log = VM.log.child({action: 'rollback_snapshot', vm: uuid});
    }

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('rollback-snapshot', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    if (!validSnapshotName(snapname, log)) {
        callback(new Error('Invalid snapshot name'));
        return;
    }

    load_fields = [
        'brand',
        'snapshots',
        'zfs_filesystem',
        'state',
        'uuid'
    ];

    VM.load(uuid, {fields: load_fields, log: log}, function (err, vmobj) {
        var found;
        var snap;
        var snapshot_list = [];

        if (err) {
            callback(err);
            return;
        }

        if (vmobj.brand === 'kvm') {
            callback(new Error('snapshots for KVM VMs currently unsupported'));
            return;
        }

        found = false;
        if (vmobj.hasOwnProperty('snapshots')) {
            for (snap in vmobj.snapshots) {
                if (vmobj.snapshots[snap].name === snapname) {
                    found = true;
                    break;
                }
            }
        }
        if (!found) {
            callback(new Error('No snapshot named "' + snapname + '" for '
                + uuid));
            return;
        }

        snapshot_list = [vmobj.zfs_filesystem + '@vmsnap-' + snapname];

        if (vmobj.state !== 'stopped') {
            VM.stop(vmobj.uuid, {'force': true, log: log}, function (stop_err) {
                if (stop_err) {
                    log.error(stop_err, 'failed to stop VM ' + vmobj.uuid
                        + ': ' + stop_err.message);
                    callback(stop_err);
                    return;
                }
                performSnapshotRollback(snapshot_list, log,
                    function (rollback_err) {

                    if (rollback_err) {
                        log.error(rollback_err, 'failed to '
                            + 'performSnapshotRollback');
                        callback(rollback_err);
                        return;
                    }
                    if (options.do_not_start) {
                        callback();
                    } else {
                        VM.start(vmobj.uuid, {}, {log: log}, callback);
                    }
                    return;
                });
            });
        } else {
            performSnapshotRollback(snapshot_list, log,
                function (rollback_err) {

                if (rollback_err) {
                    log.error(rollback_err, 'failed to '
                        + 'performSnapshotRollback');
                    callback(rollback_err);
                    return;
                }
                if (options.do_not_start) {
                    callback();
                } else {
                    VM.start(vmobj.uuid, {}, {log: log}, callback);
                }
                return;
            });
        }
    });
};

exports.delete_snapshot = function (uuid, snapname, options, callback)
{
    var load_fields;
    var log;
    var tracers_obj;

    assertMockCnUuid();
    throw new Error('UNIMPLEMENTED: delete_snapshot');

    // options is optional
    if (arguments.length === 3) {
        callback = arguments[2];
        options = {};
    }

    ensureLogging(true);
    if (options.hasOwnProperty('log')) {
        log = options.log;
    } else {
        log = VM.log.child({action: 'delete_snapshot', vm: uuid});
    }

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('delete-snapshot', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    if (!validSnapshotName(snapname, log)) {
        callback(new Error('Invalid snapshot name'));
        return;
    }

    load_fields = [
        'brand',
        'snapshots',
        'zfs_filesystem',
        'zonepath',
        'zonename'
    ];

    VM.load(uuid, {fields: load_fields, log: log}, function (err, vmobj) {
        var found;
        var mountpath;
        var mountpoint;
        var snap;
        var zoneroot;

        if (err) {
            callback(err);
            return;
        }

        if (vmobj.brand === 'kvm') {
            callback(new Error('snapshots for KVM VMs currently unsupported'));
            return;
        }

        found = false;
        if (vmobj.hasOwnProperty('snapshots')) {
            for (snap in vmobj.snapshots) {
                if (vmobj.snapshots[snap].name === snapname) {
                    found = true;
                    break;
                }
            }
        }
        if (!found) {
            callback(new Error('No snapshot named "' + snapname + '" for '
                + uuid));
            return;
        }

        zoneroot = vmobj.zonepath + '/root';
        mountpath = '/checkpoints/' + snapname;
        mountpoint = zoneroot + '/' + mountpath;

        async.waterfall([
            function (cb) {
                // Ensure it's safe for us to be doing something in this dir
                try {
                    assertSafeZonePath(zoneroot, mountpath,
                        {type: 'dir', enoent_ok: true});
                } catch (e) {
                    log.error(e, 'Unsafe mountpoint for checkpoints: '
                        + e.message);
                    cb(e);
                    return;
                }
                cb();
            }, function (cb) {
                // umount snapshot
                var argv;
                var cmd = '/usr/sbin/umount';

                argv = [mountpoint];

                traceExecFile(cmd, argv, log, 'umount-snapshot',
                    function (e, stdout, stderr) {

                    if (e) {
                        log.error({err: e}, 'There was an error while '
                            + 'unmounting the snapshot: ' + e.message);
                        // we treat an error here as fatal only if the error
                        // was something other than 'not mounted'
                        if (!stderr.match(/ not mounted/)) {
                            cb(e);
                            return;
                        }
                    } else {
                        log.trace('umounted ' + mountpoint);
                    }
                    cb();
                });
            }, function (cb) {
                // remove the mountpoint directory
                fs.rmdir(mountpoint, function (e) {
                    if (e) {
                        log.error(e);
                    } else {
                        log.trace('removed directory ' + mountpoint);
                    }
                    cb(); // XXX not fatal because might also not exist
                });
            }, function (cb) {
                var args;

                args = ['destroy', vmobj.zfs_filesystem + '@vmsnap-'
                    + snapname];

                zfs(args, log, function (e, fds) {
                    if (e) {
                        log.error({'err': e, 'stdout': fds.stdout,
                            'stderr': fds.stdout}, 'zfs destroy failed.');
                        cb(e);
                        return;
                    }
                    log.debug({err: e, stdout: fds.stdout, stderr: fds.stderr},
                        'zfs destroy ' + vmobj.zfs_filesystem + '@vmsnap-'
                        + snapname);
                    cb();
                });
            }, function (cb) {
                updateZonecfgTimestamp(vmobj, function (e) {
                    if (e) {
                        log.warn(e, 'failed to update timestamp after deleting '
                            + 'snapshot');
                    }
                    // don't pass err because there's no recovery possible
                    // (the snapshot's gone)
                    cb();
                });
            }
        ], function (error) {
            callback(error);
        });
    });
};

exports.create_snapshot = function (uuid, snapname, options, callback)
{
    var load_fields;
    var log;
    var tracers_obj;

    assertMockCnUuid();
    throw new Error('UNIMPLEMENTED: create_snapshot');

    // options is optional
    if (arguments.length === 3) {
        callback = arguments[2];
        options = {};
    }

    ensureLogging(true);

    if (options.hasOwnProperty('log')) {
        log = options.log;
    } else {
        log = VM.log.child({action: 'create_snapshot', vm: uuid});
    }

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('create-snapshot', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    if (!validSnapshotName(snapname, log)) {
        callback(new Error('Invalid snapshot name'));
        return;
    }

    load_fields = [
        'brand',
        'datasets',
        'zone_state',
        'snapshots',
        'zfs_filesystem',
        'zonepath',
        'zonename'
    ];

    VM.load(uuid, {fields: load_fields, log: log}, function (err, vmobj) {
        var full_snapname;
        var mountpath;
        var mountpoint;
        var mount_snapshot = true;
        var snap;
        var snapshot_list = [];
        var zoneroot;

        if (err) {
            callback(err);
            return;
        }

        if (vmobj.brand === 'kvm') {
            callback(new Error('snapshots for KVM VMs currently unsupported'));
            return;
        }

        if (vmobj.hasOwnProperty('datasets') && vmobj.datasets.length > 0) {
            callback(new Error('Cannot currently snapshot zones that have '
                + 'datasets'));
            return;
        }

        if (!vmobj.hasOwnProperty('zfs_filesystem')) {
            callback(new Error('vmobj missing zfs_filesystem, cannot create '
                + 'snapshot'));
            return;
        }

        full_snapname = vmobj.zfs_filesystem + '@vmsnap-' + snapname;

        // Check that name not already used
        if (vmobj.hasOwnProperty('snapshots')) {
            for (snap in vmobj.snapshots) {
                snap = vmobj.snapshots[snap];

                if (snap.name === full_snapname) {
                    callback(new Error('snapshot with name "' + snapname
                        + '" already exists.'));
                    return;
                } else {
                    log.debug('SKIPPING ' + snap.name);
                }
            }
        }

        snapshot_list.push(full_snapname);

        // assert snapshot_list.length > 0

        log.info('Taking snapshot "' + snapname + '" of ' + uuid);

        zoneroot = vmobj.zonepath + '/root';
        mountpath = '/checkpoints/' + snapname;
        mountpoint = zoneroot + '/' + mountpath;

        async.waterfall([
            function (cb) {
                // take the snapshot
                var args;
                args = ['snapshot'].concat(snapshot_list);

                zfs(args, log, function (zfs_err, fds) {
                    if (zfs_err) {
                        log.error({err: zfs_err, stdout: fds.stdout,
                            stderr: fds.stdout}, 'zfs snapshot failed.');
                    } else {
                        log.debug({err: zfs_err, stdout: fds.stdout,
                            stderr: fds.stderr}, 'zfs ' + args.join(' '));
                    }
                    cb(zfs_err);
                });
            }, function (cb) {

                if (vmobj.zone_state !== 'running') {
                    log.info('Not mounting snapshot as zone is in state '
                        + vmobj.zone_state + ', must be: running');
                    mount_snapshot = false;
                    cb();
                    return;
                }

                // Ensure it's safe for us to be doing something in this dir
                try {
                    assertSafeZonePath(zoneroot, mountpath,
                        {type: 'dir', enoent_ok: true});
                } catch (e) {
                    log.error(e, 'Unsafe mountpoint for checkpoints: '
                        + e.message);
                    cb(e);
                    return;
                }
                cb();
            }, function (cb) {
                // Make the mountpoint directory and parent
                var newmode;

                if (mount_snapshot === false) {
                    cb();
                    return;
                }

                /*jsl:ignore*/
                newmode = 0755;
                /*jsl:end*/

                function doMkdir(dir, callbk) {
                    fs.mkdir(dir, newmode, function (e) {
                        if (e && e.code !== 'EEXIST') {
                            log.error({err: e}, 'unable to create mountpoint '
                                + 'for checkpoints: ' + e.message);
                            callbk(e);
                            return;
                        }
                        callbk();
                    });
                }

                doMkdir(path.dirname(mountpoint), function (parent_e) {
                    if (parent_e) {
                        cb(parent_e);
                        return;
                    }
                    doMkdir(mountpoint, function (dir_e) {
                        if (dir_e) {
                            cb(dir_e);
                            return;
                        }

                        log.debug('created ' + mountpoint);
                        cb();
                    });
                });
            }, function (cb) {
                var argv;
                var cmd = '/usr/sbin/mount';
                var snapdir;

                if (mount_snapshot === false) {
                    cb();
                    return;
                }

                snapdir = vmobj.zonepath + '/.zfs/snapshot/vmsnap-' + snapname
                    + '/root';
                argv = [ '-F', 'lofs', '-o', 'ro,setuid,nodevices', snapdir,
                    mountpoint];

                traceExecFile(cmd, argv, log, 'mount-snapshot',
                    function (e, stdout, stderr) {

                    if (e) {
                        log.error({err: e}, 'unable to mount snapshot: '
                            + e.message);
                    }
                    // not fatal becase snapshot was already created.
                    cb();
                });
            }, function (cb) {
                // update timestamp so last_modified gets bumped
                updateZonecfgTimestamp(vmobj, function (e) {
                    if (e) {
                        log.warn(e,
                            'failed to update timestamp after snapshot');
                    }
                    // ignore error since there's no recovery
                    // (snapshot was created)
                    cb();
                });
            }
        ], function (error) {
            callback(error);
        });
    });
};

function getHostvolumeFile(url, target, log, callback) {
    var admin_uuid;
    var cfgfile;
    var hostvolume_uuid;
    var msg;
    var tracers_obj;

    assert(log, 'no logger passed to getHostvolumeFile()');

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('get-hostvolume-file', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    async.series([
        function (cb) {
            fs.exists('/opt/smartdc/config/node.config', function (exists) {
                if (exists) {
                    cfgfile = '/opt/smartdc/config/node.config';
                    log.info('config file is %s', cfgfile);
                    cb();
                    return;
                } else {
                    fs.exists('/usbkey/config', function (hn_exists) {
                        if (hn_exists) {
                            cfgfile = '/usbkey/config';
                            log.info('config file is %s', cfgfile);
                            cb();
                        } else {
                            cb(new Error('Unable to find SDC config file.'));
                        }
                    });
                }
            });
        }, function (cb) {
            fs.readFile(cfgfile, 'utf8', function (err, data) {
                if (err) {
                    log.error({err: err}, 'Unable to load SDC config file.');
                    cb(err);
                    return;
                }

                data.split('\n').forEach(function (line) {
                    /* JSSTYLED */
                    var m = line.match(/^ufds_admin_uuid='?([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})'?/);
                    if (m) {
                        admin_uuid = m[1];
                        log.info('admin UUID is %s', admin_uuid);
                    }
                });

                if (!admin_uuid) {
                    msg = 'Unable to find admin UUID in SDC config.';
                    log.error(msg);
                    cb(new Error(msg));
                    return;
                }

                cb();
            });
        }, function (cb) {
            VM.lookup({
                owner_uuid: admin_uuid,
                state: 'running',
                'tags.smartdc_role': 'hostvolume'
            }, {fields: ['uuid']}, function (err, vmobjs) {
                if (err) {
                    cb(err);
                    return;
                }

                if (vmobjs.length !== 1) {
                    msg = 'Incorrect number of VMs when looking for '
                        + '"hostvolume" zone: expected 1, got: '
                        + vmobjs.length;
                    log.error({vmobjs: vmobjs}, msg);
                    cb(new Error(msg));
                    return;
                }

                hostvolume_uuid = vmobjs[0].uuid;
                log.info('hostvolume UUID is %s', hostvolume_uuid);

                if (!hostvolume_uuid) {
                    msg = 'Unable to find "hostvolume" zone UUID.';
                    log.error({vmobjs: vmobjs}, msg);
                    cb(new Error(msg));
                    return;
                }

                cb();
            });
        }, function (cb) {
            var dir = path.dirname(target);

            mkdirp(dir, function (err) {
                if (err) {
                    log.error({err: err}, 'failed to mkdirp(%s)', dir);
                    cb(err);
                    return;
                }
                log.info('created dir: %s', dir);
                cb();
            });
        }, function (cb) {
            var args = [
                '-Q',
                hostvolume_uuid,
                '/opt/local/bin/curl',
                '-sS',
                '-f',
                '-m', '60',
                '--max-filesize', MAX_HOSTVOL_FILE_BYTES.toString(),
                '-L',
                '--max-redirs', '2',
                '\'' + url.replace(/\'/g, '%27') + '\''
            ];
            var child;
            var cmd = '/usr/sbin/zlogin';
            /*jsl:ignore*/
            var dirmode = 0444;
            /*jsl:end*/
            var stderr = '';

            fs.open(target, 'w', dirmode, function (err, fd) {
                if (err) {
                    log.error({err: err}, 'failed to open %s: %s', target,
                        err.message);
                    cb(err);
                    return;
                }

                log.debug({cmd: cmd, args: args}, 'running command');
                child = spawn(cmd, args, { stdio: ['ignore', fd, 'pipe'] });

                child.on('close', function (code) {
                    if (code !== 0) {
                        if (stderr.length > 0) {
                            msg = trim(stderr);
                        } else {
                            msg = 'Child exited non-zero: ' + code;
                        }
                        log.warn({code: code, stderr: stderr}, msg);
                        cb(new Error(msg));
                        return;
                    }

                    cb();
                });

                child.stderr.on('data', function (data) {
                    log.debug({stderr: data.toString()},
                        'data on stderr of child');
                    stderr = stderr + data.toString();
                });
            });
        }
    ], function (err) {
        if (err) {
            callback(err);
            return;
        }

        callback();
    });
}

function setDockerRestartCount(uuid, filename, options, log, callback)
{
    var lockpath = '/var/run/vm.' + uuid + '.config.lockfile';
    var tracers_obj;
    var unlock;

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('set-docker-restartcount', log,
            callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    function _failed(err) {
        if (unlock) {
            unlock(function (unlock_err) {
                log.error({err: unlock_err}, 'failed ot unlock while handling '
                    + 'error');
                callback(err);
            });
        } else {
            callback(err);
        }
    }

    log.debug('acquiring lock on ' + lockpath);
    lock(lockpath, function (err, _unlock) {
        if (err) {
            log.error('failed to acquire lock on ' + lockpath);
            callback(err);
            return;
        }
        log.debug('acquired lock on ' + lockpath);
        unlock = _unlock;

        fs.readFile(filename, 'utf8', function (error, data) {
            var mdata;
            var msg;
            var tmp_filename;

            if (error) {
                log.error(error, 'failed to load ' + filename);
                _failed(error);
                return;
            }

            try {
                mdata = JSON.parse(data);
            } catch (e) {
                log.error({err: e}, 'failed to parse mdata JSON');
                _failed(e);
                return;
            }

            if (options.hasOwnProperty('value')) {
                mdata.internal_metadata['docker:restartcount'] = options.value;
            } else if (options.hasOwnProperty('increment')) {
                if (mdata.internal_metadata['docker:restartcount']) {
                    mdata.internal_metadata['docker:restartcount'] =
                        Number(mdata.internal_metadata['docker:restartcount'])
                        + options.increment;
                } else {
                    mdata.internal_metadata['docker:restartcount'] = 1;
                }
            } else {
                msg = 'invalid options for setDockerRestartCount()';
                log.error({options: options}, msg);
                _failed(new Error(msg));
            }

            tmp_filename = filename + '.tmp.' + process.pid;
            fs.writeFile(tmp_filename, JSON.stringify(mdata, null, 2), 'utf8',
                function (write_err) {

                if (write_err) {
                    log.error(write_err, 'failed to write ' + tmp_filename);
                    _failed(write_err);
                    return;
                } else {
                    fs.rename(tmp_filename, filename, function (rename_err) {
                        if (rename_err) {
                            log.error(rename_err, 'failed to rename '
                                + tmp_filename + ' to ' + filename);
                            _failed(rename_err);
                            return;
                        }
                        log.debug('releasing lock on ' + lockpath);
                        unlock(function (unlock_err) {
                            if (unlock_err) {
                                log.error(unlock_err, 'failed to unlock');
                                callback(unlock_err);
                                return;
                            }
                            log.debug('released lock on ' + lockpath);
                            callback();
                        });
                    });
                }
            });
        });
    });
}

exports.start = function (uuid, extra, options, callback)
{
    var load_fields;
    var log;
    var kvm_load_fields;
    var tracers_obj;
    var vmobj;

    assertMockCnUuid();
    throw new Error('UNIMPLEMENTED: start');

    load_fields = [
        'brand',
        'docker',
        'filesystems',
        'internal_metadata',
        'nics',
        'state',
        'uuid',
        'zone_state',
        'zonename',
        'zonepath'
    ];

    kvm_load_fields = [
        'boot',
        'brand',
        'cpu_type',
        'default_gateway',
        'disks',
        'hostname',
        'internal_metadata',
        'never_booted',
        'nics',
        'platform_buildstamp',
        'qemu_extra_opts',
        'qemu_opts',
        'ram',
        'resolvers',
        'spice_opts',
        'spice_password',
        'spice_port',
        'state',
        'uuid',
        'vcpus',
        'vga',
        'virtio_txtimer',
        'virtio_txburst',
        'vnc_password',
        'zone_state',
        'zonename',
        'zonepath'
    ];

    // options is optional
    if (arguments.length === 3) {
        callback = arguments[2];
        options = {};
    }

    assert(callback, 'undefined callback!');

    ensureLogging(true);
    if (options.hasOwnProperty('log')) {
        log = options.log;
    } else {
        log = VM.log.child({action: 'start', vm: uuid});
    }

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('start', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    log.info('Starting VM ' + uuid);

    async.series([
        function (cb) {
            /*
             * If we're being called by something that just loaded the object,
             * we can use that instead of loading again ourselves.
             */
            if (options.vmobj && options.vmobj.uuid === uuid) {
                log.info('using cached vmobj that was passed in to VM.start');
                vmobj = options.vmobj;
                cb();
                return;
            }
            VM.load(uuid, {log: log, fields: load_fields}, function (err, obj) {
                if (err) {
                    cb(err);
                } else {

                    if (obj.state === 'running') {
                        err = new Error('VM ' + obj.uuid + ' is already '
                            + '\'running\'');
                        err.code = 'EALREADYRUNNING';
                        cb(err);
                        return;
                    }

                    if ((obj.state !== 'stopped'
                            && obj.state !== 'provisioning')
                        || (obj.state === 'provisioning'
                            && obj.zone_state !== 'installed')) {

                        err = new Error('Cannot to start vm from state "'
                            + obj.state + '", must be "stopped".');
                        log.error(err);
                        cb(err);
                        return;
                    }

                    vmobj = obj;
                    cb();
                }
            });
        }, function (cb) {
            validateNicTags(vmobj.nics, log, function (e) {
                if (e) {
                    cb(e);
                    return;
                }
                cb();
            });
        }, function (cb) {
            var im;
            var to_download = [];

            if (vmobj.docker && vmobj.hasOwnProperty('internal_metadata')
                && vmobj.internal_metadata['docker:hostvolumes']
                && vmobj.filesystems) {

                im = vmobj.internal_metadata;

                vmobj.filesystems.forEach(function (f) {
                    var hv = JSON.parse(im['docker:hostvolumes']);
                    var targ = f.target;

                    if (hv[targ] && hv[targ].url) {
                        log.debug('will try to mount '
                            + JSON.stringify(hv[targ]) + ' to ' + f.source);
                        to_download.push([hv[targ].url, f.source]);
                    }
                });

                if (to_download.length > 0) {
                    async.each(to_download, function (dl, c) {
                        getHostvolumeFile(dl[0], dl[1], log, c);
                    }, function (err) {
                        cb(err);
                    });
                } else {
                    log.debug('no hostvolumes to download');
                    cb();
                    return;
                }
            } else {
                log.debug('no hostvolumes in metadata');
                cb();
                return;
            }
        }, function (cb) {
            if (!vmobj.docker || !vmobj.zonepath) {
                cb();
                return;
            }

            // we're about to restart now, so bump the restart counter if we're
            // restarting from vmadmd, otherwise just set it to 0.
            if (options.increment_restart_count) {
                setDockerRestartCount(vmobj.uuid, vmobj.zonepath
                    + '/config/metadata.json', {increment: 1}, log, cb);
            } else {
                setDockerRestartCount(vmobj.uuid, vmobj.zonepath
                    + '/config/metadata.json', {value: 0}, log, cb);
            }
        }, function (cb) {
            var err;

            if (BRAND_OPTIONS[vmobj.brand].features.type === 'KVM') {
                // when we boot KVM we need a lot more fields, so load again
                // in that case to get the fields we need.
                VM.load(uuid, {
                    log: log,
                    fields: kvm_load_fields
                }, function (error, obj) {
                    if (error) {
                        cb(error);
                        return;
                    }
                    startVM(obj, extra, log, cb);
                });
            } else if (['OS', 'LX']
                .indexOf(BRAND_OPTIONS[vmobj.brand].features.type) !== -1) {

                startZone(vmobj, log, cb);
            } else {
                err = new Error('no idea how to start a vm with brand: '
                    + vmobj.brand);
                log.error(err);
                cb(err);
            }
        }
    ], callback);
};

function setRctl(zonename, rctl, value, log, callback)
{
    var args;

    assert(log, 'no logger passed to setRctl()');

    args = ['-n', rctl, '-v', value.toString(), '-r', '-i', 'zone', zonename];
    traceExecFile('/usr/bin/prctl', args, log, 'prctl',
        function (error, stdout, stderr) {

        if (error) {
            log.error(error, 'setRctl() failed with: ' + stderr);
            callback(error);
        } else {
            callback();
        }
    });
}

function resizeTmp(zonename, newsize, log, callback)
{
    var args;

    // NOTE: this used to update /etc/vfstab in the zone as well, but was
    // changed with OS-920.  Now vfstab is updated by mdata-fetch in the
    // zone instead, so that will happen next boot.  We still do the mount
    // so the property update happens on the running zone.

    assert(log, 'no logger passed to resizeTmp()');

    if (newsize === 0) {
        log.debug('new tmpfs size is 0, not updating mount for running VM.');
        callback();
        return;
    }

    args = [zonename, '/usr/sbin/mount', '-F', 'tmpfs', '-o', 'remount,size='
        + newsize + 'm', '/tmp'];
    traceExecFile('/usr/sbin/zlogin', args, log, 'zlogin-resize-tmp',
        function (err, mnt_stdout, mnt_stderr) {

        if (err) {
            log.error({'err': err, 'stdout': mnt_stdout,
                'stderr': mnt_stderr}, 'zlogin for ' + zonename
                + ' exited with code ' + err.code + ' -- ' + err.message);
            // error here is not fatal as this should be fixed on reboot
        }

        callback();
    });
}

function resizeDisks(disks, updates, log, callback)
{
    var d;
    var disk;
    var resized = 0;
    var tracers_obj;
    var vols = [];

    assert(log, 'no logger passed to resizeDisks()');

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('resize-disks', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    for (disk in updates) {
        disk = updates[disk];
        for (d in disks) {
            d = disks[d];
            if (d.path === disk.path && disk.hasOwnProperty('size')) {
                vols.push({'disk': d, 'new_size': disk.size});
            }
        }
    }

    function resize(vol, cb) {
        var args;
        var dsk = vol.disk;
        var size = vol.new_size;

        if (dsk.hasOwnProperty('zfs_filesystem')) {
            if (dsk.size > size) {
                cb(new Error('cannot resize ' + dsk.zfs_filesystem
                    + ' new size must be greater than current size. ('
                    + dsk.size + ' > ' + dsk.size + ')'));
            } else if (dsk.size === size) {
                // no point resizing if the old+new are the same
                cb();
            } else {
                args = ['set', 'volsize=' + size + 'M', dsk.zfs_filesystem];
                zfs(args, log, function (err, fds) {
                    resized++;
                    cb(err);
                });
            }
        } else {
            cb(new Error('could not find zfs_filesystem in '
                + JSON.stringify(dsk)));
        }
    }

    async.forEachSeries(vols, resize, function (err) {
        if (err) {
            log.error(err, 'Unable to resize disks');
            callback(err);
        } else {
            callback(null, resized);
        }
    });
}

function updateVnicAllowedIPs(uuid, nic, log, callback)
{
    var ips = [];
    var tracers_obj;

    assert(log, 'no logger passed to updateVnicAllowedIPs()');

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('update-vnic-allowed-ips', log,
            callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    if (!uuid || !nic.interface) {
        callback();
        return;
    }

    if (nic.hasOwnProperty('allow_ip_spoofing') && nic.allow_ip_spoofing) {
        dladm.resetLinkProp(uuid, nic.interface, 'allowed-ips', log, callback);
        return;
    }

    if (nic.hasOwnProperty('ip')) {
        ips.push(nic.ip);
    }

    if (nic.hasOwnProperty('vrrp_primary_ip')) {
        ips.push(nic.vrrp_primary_ip);
    }

    if (nic.hasOwnProperty('allowed_ips')) {
        ips = ips.concat(nic.allowed_ips);
    }

    if (!ips.length === 0) {
        dladm.resetLinkProp(uuid, nic.interface, 'allowed-ips', log, callback);
    } else {
        dladm.setLinkProp(uuid, nic.interface, 'allowed-ips', ips, log,
            callback);
    }
}

function updateVnicProperties(uuid, vmobj, payload, log, callback)
{
    var tracers_obj;

    assert(log, 'no logger passed to updateVnicProperties()');

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('update-vnic-properties', log,
            callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    if (vmobj.state != 'running') {
        log.debug('VM not running: not updating vnic properties');
        callback(null);
        return;
    }

    if (!payload.hasOwnProperty('update_nics')) {
        log.debug(
            'No update_nics property: not updating vnic properties');
        callback(null);
        return;
    }

    async.forEach(payload.update_nics, function (nic, cb) {
        var opt;
        var needsUpdate = false;
        var needsIPupdate = false;
        var spoof_opts = {
            'allow_ip_spoofing': 'ip-nospoof',
            'allow_mac_spoofing': 'mac-nospoof',
            'allow_dhcp_spoofing': 'dhcp-nospoof',
            'allow_restricted_traffic': 'restricted'
        };
        var vm_nic;

        // First, determine if we've changed any of the spoofing opts in this
        // update:
        for (opt in spoof_opts) {
            if (nic.hasOwnProperty(opt)) {
                needsUpdate = true;
                break;
            }
        }

        if (nic.hasOwnProperty('vrrp_primary_ip')
            || nic.hasOwnProperty('allowed_ips')
            || nic.hasOwnProperty('allow_ip_spoofing')) {
            needsIPupdate = true;
        }

        for (vm_nic in vmobj.nics) {
            vm_nic = vmobj.nics[vm_nic];
            if (vm_nic.mac == nic.mac) {
                break;
            }
        }

        if (!vm_nic) {
            cb(new Error('Unknown NIC: ' + nic.mac));
            return;
        }

        if (!needsUpdate) {
            log.debug('No spoofing / allowed IP opts updated for nic "'
                + nic.mac + '": not updating');
            if (needsIPupdate) {
                updateVnicAllowedIPs(uuid, vm_nic, log, cb);
            } else {
                cb(null);
            }
            return;
        }

        // Using the updated nic object, figure out what spoofing opts to set
        for (opt in spoof_opts) {
            if (vm_nic.hasOwnProperty(opt) && fixBoolean(vm_nic[opt])) {
                delete spoof_opts[opt];
            }
        }

        if (vm_nic.hasOwnProperty('dhcp_server')
                && fixBoolean(vm_nic.dhcp_server)) {
            delete spoof_opts.allow_dhcp_spoofing;
            delete spoof_opts.allow_ip_spoofing;
        }

        if (Object.keys(spoof_opts).length === 0) {
            dladm.resetLinkProp(uuid, vm_nic.interface, 'protection', log,
                function (err) {
                    if (err) {
                        cb(err);
                        return;
                    }
                    if (needsIPupdate) {
                        updateVnicAllowedIPs(uuid, vm_nic, log, cb);
                        return;
                    }
                    cb();
                    return;
                });
        } else {
            dladm.setLinkProp(uuid, vm_nic.interface, 'protection',
                    Object.keys(spoof_opts).map(function (k) {
                        return spoof_opts[k];
                    }), log,
                function (err) {
                    if (err) {
                        cb(err);
                        return;
                    }
                    if (needsIPupdate) {
                        updateVnicAllowedIPs(uuid, vm_nic, log, cb);
                        return;
                    }
                    cb();
                    return;
                });
        }
    }, function (err) {
        if (err) {
            callback(err);
        } else {
            callback(null);
        }
    });
}

// Ensure that we're logging to the fwadm logs
function ensureFwLogging(action, vmlog) {
    if (VM.fw_log) {
        return VM.fw_log;
    }

    var params = {
        'action': action
    };

    // Pass the VM log's req_id to the fw logger: this allows us to
    // easily link the two logs.
    if (vmlog.fields.hasOwnProperty('req_id')) {
        params.req_id = vmlog.fields.req_id;
    } else if (process.env.REQ_ID) {
        params.req_id = process.env.REQ_ID;
    } else if (process.env.req_id) {
        params.req_id = process.env.req_id;
    } else {
        params.req_id = libuuid.create();
    }

    VM.fw_log = fwlog.create(params);
    return VM.fw_log;
}

// Run a fw.js function that requires all VM records
function firewallVMrun(opts, callback) {
    var cache;
    var cur_vm_uuid = opts.uuid;
    var do_full_lookup = false;
    var enabled_lookup = {
        'fields': [ 'firewall_enabled', 'uuid' ],
        'log': opts.vmlog
    };
    var full_lookup = {
        'fields': fw.VM_FIELDS,
        'log': opts.vmlog
    };
    var log = opts.vmlog;
    var tracers_obj;

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('firewall-vm-run', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    if (opts.cache) {
        enabled_lookup.cache = opts.cache;
        full_lookup.cache = opts.cache;
    }

    // Filters out VMs that don't have firewall_enabled == true
    function fwEnabledFilter(vmobj, cb) {
        if (vmobj.firewall_enabled) {
            cb(true);
            return;
        }

        cb(false);
        return;
    }

    // Return all VMs, but don't include VMs (other than the one we're
    // updating) that are in state 'provisioning': they might not have
    // nics or a ZFS dataset yet.
    function allVmsFilter(vmobj, cb) {
        if (vmobj.hasOwnProperty('state') && vmobj.state == 'provisioning') {
            if (vmobj.hasOwnProperty('uuid') && vmobj.uuid == cur_vm_uuid) {
                cb(true);
                return;
            }

            cb(false);
            return;
        }

        cb(true);
        return;
    }

    async.series([
        // Cache zones that have firewalls enabled.
        function (cb) {
            vmload.getZoneData(null, enabled_lookup, function (err, _cache) {
                if (_cache) {
                    cache = _cache;
                    enabled_lookup.cache = _cache;
                }

                cb(err);
                return;
            });

        // Use the cache to get any VMs with firewalls enabled: if there are
        // none, there is no reason to load the tags for each VM.
        }, function (cb) {
            vmload.getVmobjs(fwEnabledFilter, enabled_lookup,
                function gotEnabled(err, vmobjs) {
                if (err) {
                    cb(err);
                    return;
                }

                if (vmobjs && vmobjs.length > 0) {
                    do_full_lookup = true;
                }

                if (opts.enabling) {
                    do_full_lookup = true;
                }

                if (!do_full_lookup) {
                    log.debug('no VMs with firewall_enabled: not loading tags');
                }

                cb();
                return;
            });

        // Update the cache to add tags for zones, but only if there are zones
        // that have firewall_enabled set.
        }, function (cb) {
            if (!do_full_lookup) {
                cb();
                return;
            }

            vmload.getZoneData(null, full_lookup, function (err, _cache) {
                if (_cache) {
                    cache = _cache;
                    enabled_lookup.cache = _cache;
                }

                cb(err);
                return;
            });

        // If we have zones with firewall_enabled set, get all VMs and run
        // the fw.js function with them.
        }, function (cb) {
            if (!do_full_lookup) {
                cb();
                return;
            }

            vmload.getVmobjs(allVmsFilter, full_lookup,
                function gotAll(err, vmobjs) {
                if (err) {
                    cb(err);
                    return;
                }

                opts.params.log = log;
                opts.params.vms = vmobjs;
                if (opts.params.provisioning) {
                    opts.params.vms.push(opts.params.provisioning);
                    delete opts.params.provisioning;
                }

                opts.func(opts.params, cb);
                return;
            });
        }
    ], function (err) {
        callback(err, cache);
        return;
    });
}

function addFirewallData(payload, vmobj, vmlog, callback)
{
    if (!payload.firewall && (!vmobj.hasOwnProperty('nics')
        || vmobj.nics.length === 0)) {
        vmlog.debug('no firewall or nics for VM: not adding firewall data');
        callback();
        return;
    }

    var firewallOpts = payload.firewall || {};
    var log = ensureFwLogging('add', vmlog);
    var tracers_obj;

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('add-firewall-data', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    // We don't have tags in vmobj at this point, so add them from the
    // payload if present
    if (payload.hasOwnProperty('set_tags')) {
        vmobj.tags = payload.set_tags;
    }
    firewallOpts.localVMs = [vmobj];
    firewallOpts.provisioning = vmobj;

    vmlog.debug({'opts': firewallOpts}, 'Adding firewall data');

    var add_opts = {
        'func': fw.add,
        'log': log,
        'params': firewallOpts,
        'uuid': vmobj.uuid,
        'vmlog': vmlog
    };

    firewallVMrun(add_opts, function (err, res) {
        if (err) {
            // Log an error about the failure, but don't fail to provision
            // because of this
            vmlog.error(err, 'Error adding firewall data');
            callback();
            return;
        }

        callback(null, res);
        return;
    });
}

function updateFirewallData(payload, vmobj, vmlog, callback)
{
    var cache;
    var log = ensureFwLogging('update', vmlog);
    var tracers_obj;

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('update-firewall-data', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    async.series([
        // Updating firewall data
        function (cb) {
            var needUpdate = false;
            var changeParams = ['add_nics', 'remove_nics', 'update_nics',
                'set_tags', 'remove_tags'];
            var p;

            for (p in changeParams) {
                if (payload.hasOwnProperty(changeParams[p])) {
                    needUpdate = true;
                }
            }

            if (!needUpdate) {
                vmlog.debug({'payload': payload},
                    'Not updating firewall data for VM ' + vmobj.uuid);
                cb();
                return;
            }

            var update_opts = {
                'func': fw.update,
                'log': log,
                'params': {'localVMs': [vmobj]},
                'uuid': vmobj.uuid,
                'vmlog': vmlog
            };

            vmlog.debug({'opts': update_opts.params},
                'Updating firewall data for VM ' + vmobj.uuid);

            firewallVMrun(update_opts, function (err, _cache) {
                if (err) {
                    vmlog.error(err, 'Error updating firewall rules');
                    cb(new Error('Error updating firewall rules for VM: '
                        + err.message));
                    return;
                }

                cache = _cache;
                cb();
                return;
            });

        // Enabling or disabling VM's firewall
        }, function (cb) {
            if (!payload.hasOwnProperty('firewall_enabled')) {
                cb();
                return;
            }

            var pfx = 'En';
            var enableFn = fw.enable;

            if (!payload.firewall_enabled) {
                enableFn = fw.disable;
                pfx = 'Dis';
            }

            var enable_opts = {
                'cache': cache,
                'enabling': true,
                'func': enableFn,
                'log': log,
                'params': {'vm': vmobj},
                'uuid': vmobj.uuid,
                'vmlog': vmlog
            };

            vmlog.debug('%sabling firewall for VM %s', pfx, vmobj.uuid);
            firewallVMrun(enable_opts, function (err) {
                if (err) {
                    vmlog.error(err, 'Error %sabling firewall',
                        pfx.toLowerCase());
                    cb(new Error('Error ' + pfx.toLowerCase()
                        + 'abling firewall for VM: ' + err.message));
                    return;
                }

                cb();
                return;
            });
        }
    ], callback);
}

function restartMetadataService(vmobj, payload, log, callback) {
    var args;
    var tracers_obj;

    assert(log, 'no logger passed to restartMetadataService()');

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('restart-metadata', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    if (!BRAND_OPTIONS[vmobj.brand].hasOwnProperty('features')
        || !BRAND_OPTIONS[vmobj.brand].hasOwnProperty('features')
        || !BRAND_OPTIONS[vmobj.brand].features.mdata_restart) {
        log.debug('restarting mdata:fetch service not supported for brand '
            + vmobj.brand);
        callback();
        return;
    }

    // resolvers should not cause an update if the VM doesn't have
    // maintain_resolvers set
    if (vmobj.state !== 'running' || (!payload.hasOwnProperty('resolvers')
        || (payload.hasOwnProperty('resolvers') && !vmobj.maintain_resolvers))
        && !payload.hasOwnProperty('maintain_resolvers')
        && !payload.hasOwnProperty('routes')
        && !payload.hasOwnProperty('set_routes')
        && !payload.hasOwnProperty('remove_routes')
        && !payload.hasOwnProperty('tmpfs')) {
        callback();
        return;
    }

    log.debug('restarting metadata service for: ' + vmobj.uuid);

    args = [vmobj.zonename, '/usr/sbin/svcadm', 'restart',
        'svc:/smartdc/mdata:fetch'];
    traceExecFile('/usr/sbin/zlogin', args, log, 'svcadm-restart-metadata',
        function (err, svc_stdout, svc_stderr) {

        if (err) {
            log.error({'err': err, 'stdout': svc_stdout,
                'stderr': svc_stderr}, 'zlogin for ' + vmobj.zonename
                + ' exited with code' + err.code + err.message);
            // error here is not fatal as this should be fixed on reboot
        }

        callback();
    });
}

function applyUpdates(oldobj, newobj, payload, log, callback)
{
    var changed = false;
    var tracers_obj;

    assert(log, 'no logger passed to applyUpdates()');

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('apply-updates', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    // Note: oldobj is the VM *before* the update, newobj *after*
    log.debug('applying updates to ' + oldobj.uuid);

    if (payload.hasOwnProperty('set_routes')
        || payload.hasOwnProperty('remove_routes')) {
        changed = true;
    }

    async.series([
        function (cb) {
            if (payload.hasOwnProperty('update_disks')
                && oldobj.hasOwnProperty('disks')) {

                resizeDisks(oldobj.disks, payload.update_disks, log,
                    function (err, resized) {
                        // If any were resized, mark that we changed something
                        if (!err && resized > 0) {
                            changed = true;
                        }
                        cb(err);
                    }
                );
            } else {
                cb();
            }
        }, function (cb) {
            if (payload.hasOwnProperty('set_internal_metadata')
                && (oldobj.internal_metadata['docker:linkHosts']
                    !== newobj.internal_metadata['docker:linkHosts'])) {

                log.debug('updating docker link hostnames');
                createHostConfFileMounts(newobj, {onlyUpdateFileContents: true},
                                        log, cb);
            } else {
                cb();
            }
        }, function (cb) {
            if (payload.hasOwnProperty('quota')
                && (Number(payload.quota) !== Number(oldobj.quota))) {

                setQuota(newobj.zfs_filesystem, payload.quota, log,
                    function (err) {

                    if (!err) {
                        changed = true;
                    }
                    cb(err);
                });
            } else {
                cb();
            }
        }, function (cb) {
            // NOTE: we've already validated the value
            if (payload.hasOwnProperty('zfs_root_recsize')
                && (payload.zfs_root_recsize !== oldobj.zfs_root_recsize)) {

                zfs(['set', 'recsize=' + payload.zfs_root_recsize,
                    newobj.zfs_filesystem], log, function (err, fds) {

                    if (err) {
                        log.error(err, 'failed to apply zfs_root_recsize: '
                            + fds.stderr);
                        cb(new Error(rtrim(fds.stderr)));
                    } else {
                        cb();
                    }
                });
            } else {
                cb();
            }
        }, function (cb) {
            if (payload.hasOwnProperty('zfs_filesystem_limit')
                && (payload.zfs_filesystem_limit
                    !== oldobj.zfs_filesystem_limit)) {

                zfs(['set', 'filesystem_limit=' + payload.zfs_filesystem_limit,
                    newobj.zfs_filesystem], log, function (err, fds) {

                    if (err) {
                        log.error(err, 'failed to apply zfs_filesystem_limit: '
                            + fds.stderr);
                        cb(new Error(rtrim(fds.stderr)));
                    } else {
                        cb();
                    }
                });
            } else {
                cb();
            }
        }, function (cb) {
            if (payload.hasOwnProperty('zfs_snapshot_limit')
                && (payload.zfs_snapshot_limit !== oldobj.zfs_snapshot_limit)) {

                zfs(['set', 'snapshot_limit=' + payload.zfs_snapshot_limit,
                    newobj.zfs_filesystem], log, function (err, fds) {

                    if (err) {
                        log.error(err, 'failed to apply zfs_snapshot_limit: '
                            + fds.stderr);
                        cb(new Error(rtrim(fds.stderr)));
                    } else {
                        cb();
                    }
                });
            } else {
                cb();
            }
        }, function (cb) {
            // NOTE: we've already validated the value.
            if (payload.hasOwnProperty('zfs_data_recsize')
                && oldobj.hasOwnProperty('zfs_data_recsize')
                && newobj.hasOwnProperty('datasets')
                && (newobj.datasets.indexOf(newobj.zfs_filesystem
                    + '/data') !== -1)) {

                zfs(['set', 'recsize=' + payload.zfs_data_recsize,
                    newobj.zfs_filesystem + '/data'], log, function (err, fds) {

                    if (err) {
                        log.error(err, 'failed to apply zfs_data_recsize: '
                            + fds.stderr);
                        cb(new Error(rtrim(fds.stderr)));
                    } else {
                        cb();
                    }
                });
            } else {
                cb();
            }
        }, function (cb) {
            // NOTE: we've already validated the value
            if (payload.hasOwnProperty('zfs_root_compression')
                && (payload.zfs_root_compression !==
                    oldobj.zfs_root_compression)) {

                zfs(['set', 'compression=' + payload.zfs_root_compression,
                    newobj.zfs_filesystem], log, function (err, fds) {

                    if (err) {
                        log.error(err, 'failed to apply '
                            + 'zfs_root_compression: ' + fds.stderr);
                        cb(new Error(rtrim(fds.stderr)));
                    } else {
                        cb();
                    }
                });
            } else {
                cb();
            }
        }, function (cb) {
            // NOTE: we've already validated the value
            if (payload.hasOwnProperty('zfs_data_compression')
                && newobj.hasOwnProperty('datasets')
                && (newobj.datasets.indexOf(newobj.zfs_filesystem
                    + '/data') !== -1)) {

                zfs(['set', 'compression=' + payload.zfs_data_compression,
                    newobj.zfs_filesystem + '/data'], log, function (err, fds) {

                    if (err) {
                        log.error(err, 'failed to apply '
                            + 'zfs_data_compression: ' + fds.stderr);
                        cb(new Error(rtrim(fds.stderr)));
                    } else {
                        cb();
                    }
                });
            } else {
                cb();
            }
        }, function (cb) {
            if (payload.hasOwnProperty('indestructible_zoneroot')) {
                if (payload.indestructible_zoneroot) {
                    makeIndestructible(oldobj.zfs_filesystem, log, cb);
                } else {
                    makeDestructible(oldobj.zfs_filesystem, log, cb);
                }
            } else {
                cb();
            }
        }, function (cb) {
            var datasets;
            var delegated;

            datasets = oldobj.datasets;
            delegated = oldobj.zfs_filesystem + '/data';

            // TODO if we allow adding delegated on update in the future, should
            //      also check that both old or new have delegated here.
            if (datasets
                && datasets.indexOf(delegated) !== -1
                && payload.hasOwnProperty('indestructible_delegated')) {

                if (payload.indestructible_delegated) {
                    makeIndestructible(delegated, log, cb);
                } else {
                    makeDestructible(delegated, log, cb);
                }
            } else {
                cb();
            }
        }, function (cb) {
            var d;
            var disk;
            var zfs_updates = [];

            if (payload.hasOwnProperty('update_disks')) {
                // loop through the disks we updated and perform any updates.
                for (disk in payload.update_disks) {
                    disk = payload.update_disks[disk];

                    if (!disk) {
                        continue;
                    }

                    for (d in oldobj.disks) {
                        d = oldobj.disks[d];
                        if (d.path === disk.path
                            && d.hasOwnProperty('zfs_filesystem')) {

                            if (disk.hasOwnProperty('compression')) {
                                zfs_updates.push({
                                    zfs_filesystem: d.zfs_filesystem,
                                    property: 'compression',
                                    value: disk.compression
                                });
                            }

                            if (disk.hasOwnProperty('refreservation')) {
                                zfs_updates.push({
                                    zfs_filesystem: d.zfs_filesystem,
                                    property: 'refreservation',
                                    value: disk.refreservation + 'M'
                                });
                            }
                        }
                    }
                }
                if (zfs_updates.length > 0) {
                    log.debug('applying ' + zfs_updates.length
                        + ' zfs updates');
                    async.each(zfs_updates, function (props, f_cb) {
                        zfs(['set', props.property + '=' + props.value,
                            props.zfs_filesystem], log, function (err, fds) {

                            if (err) {
                                log.error(err, 'failed to set ' + props.property
                                    + '=' + props.value + ' for '
                                    + props.zfs_filesystem);
                            }
                            f_cb(err);
                        });
                    }, function (err) {
                        log.debug({err: err}, 'end of zfs updates');
                        cb(err);
                    });
                } else {
                    log.debug('no zfs updates to apply');
                    cb();
                }
            } else {
                cb();
            }
        }, function (cb) {
            var factor;
            var keys = [];
            var rctl;
            var rctls = {
                'cpu_shares': ['zone.cpu-shares'],
                'zfs_io_priority': ['zone.zfs-io-priority'],
                'max_lwps': ['zone.max-lwps'],
                'max_msg_ids': ['zone.max-msg-ids'],
                'max_physical_memory': ['zone.max-physical-memory',
                    (1024 * 1024)],
                'max_shm_memory': ['zone.max-shm-memory', (1024 * 1024)],
                'max_sem_ids': ['zone.max-sem-ids'],
                'max_shm_ids': ['zone.max-shm-ids'],
                'max_locked_memory': ['zone.max-locked-memory', (1024 * 1024)],
                'max_swap': ['zone.max-swap', (1024 * 1024)],
                'cpu_cap': ['zone.cpu-cap']
            };

            if (!BRAND_OPTIONS[oldobj.brand].features.update_rctls) {
                cb();
                return;
            }

            for (rctl in rctls) {
                keys.push(rctl);
            }

            async.forEachSeries(keys, function (prop, c) {
                rctl = rctls[prop][0];
                if (rctls[prop][1]) {
                    factor = rctls[prop][1];
                } else {
                    factor = 1;
                }

                if (payload.hasOwnProperty(prop)) {
                    setRctl(newobj.zonename, rctl,
                        Number(payload[prop]) * factor, log,
                        function (err) {
                            if (err) {
                                log.warn(err, 'failed to set rctl: ' + prop);
                            }
                            c();
                        }
                    );
                } else {
                    c();
                }
            }, function (err) {
                cb(err);
            });
        }, function (cb) {
            if ((payload.hasOwnProperty('vnc_password')
                && (oldobj.vnc_password !== newobj.vnc_password))
                || (payload.hasOwnProperty('vnc_port')
                    && (oldobj.vnc_port !== newobj.vnc_port))) {

                // tell vmadmd to refresh_password and port (will restart
                // listener)
                postVmadmd(newobj.uuid, 'reload_display', {}, log,
                    function (e) {

                    if (e) {
                        cb(new Error('Unable to tell vmadmd to reload VNC: '
                            + e.message));
                    } else {
                        cb();
                    }
                });
            } else if ((payload.hasOwnProperty('spice_password')
                && (oldobj.spice_password !== newobj.spice_password))
                || (payload.hasOwnProperty('spice_port')
                    && (oldobj.spice_port !== newobj.spice_port))) {

                // tell vmadmd to refresh_password and port (will restart
                // listener)
                postVmadmd(newobj.uuid, 'reload_display', {}, log,
                    function (e) {

                    if (e) {
                        cb(new Error('Unable to tell vmadmd to reload SPICE: '
                            + e.message));
                    } else {
                        cb();
                    }
                });
            } else {
                cb();
            }
        }, function (cb) {
            // we do this last, since we need the memory in the zone updated
            // first if we're growing this.
            if (payload.hasOwnProperty('tmpfs')) {
                if (oldobj.tmpfs === 0) {
                    /*
                     * We can't mount over existing /tmp (on zfs) for a running
                     * VM so we skip update if it's currently not using tmpfs.
                     */
                    log.debug('existing tmpfs size is 0, not updating mount for'
                        + ' running VM.');
                    cb();
                    return;
                } else {
                    resizeTmp(newobj.zonename, payload.tmpfs, log, cb);
                }
            } else {
                cb();
            }
        }, function (cb) {
            var now = new Date();

            // If we changed any properties that don't involve modifying the
            // zone's xml, touch the zone xml file so that last_modified is
            // correct.
            if (changed && newobj.hasOwnProperty('zonename')) {
                fs.utimes('/etc/zones/' + newobj.zonename + '.xml', now, now,
                    function (err) {
                        if (err) {
                            log.warn(err, 'Unable to "touch" xml file for "'
                                + newobj.zonename + '": ' + err.message);
                        } else {
                            log.debug('Touched ' + newobj.zonename
                                + '.xml after datasets were modified.');
                        }
                        // We don't error out if we just couldn't touch because
                        // the actual updates above already did happen.
                        cb();
                    }
                );
            } else {
                cb();
            }
        }

    ], function (err, res) {
        log.debug('done applying updates to ' + oldobj.uuid);
        callback(err);
    });
}

/*
 * This function takes a uuid (16 bytes in RFC4122 format) and appends a new
 * uuid in the same format for a total of 32 bytes. The '-' characters are then
 * removed to put this in the same format docker uses for IDs. The resulting
 * id (64 characters of hex) is returned.
 *
 */
function newDockerId(uuid)
{
    var extra_uuid;
    var result;

    assert(uuid);
    assert(uuid.length === 36);

    extra_uuid = libuuid.create();
    result = (uuid + extra_uuid).replace(/-/g, '');

    assert(result.length === 64);
    return (result);
}

exports.update = function (uuid, payload, options, callback)
{
    var log;
    var new_vmobj;
    var vmobj;
    var unlock;
    var lockpath;
    var tracers_obj;

    assertMockCnUuid();
    throw new Error('UNIMPLEMENTED: update');

    // options parameter is optional
    if (arguments.length === 3) {
        callback = arguments[2];
        options = {};
    }

    ensureLogging(true);
    if (options.hasOwnProperty('log')) {
        log = options.log;
    } else {
        log = VM.log.child({action: 'update', vm: uuid});
    }

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('update', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    log.info('Updating VM ' + uuid + ' with initial payload:\n'
        + JSON.stringify(payload, null, 2));

    async.series([
        function (cb) {
            lockpath = '/var/run/vm.' + uuid + '.config.lockfile';
            log.debug('acquiring lock on ' + lockpath);
            lock(lockpath, function (err, _unlock) {
                log.debug('acquired lock on ' + lockpath);
                if (err) {
                    cb(err);
                    return;
                }
                unlock = _unlock;
                cb();
            });
        },
        function (cb) {
            // for update we currently always load the whole vmobj since the
            // update functions may need to look at bits from the existing VM.
            VM.load(uuid, {log: log}, function (err, obj) {
                if (err) {
                    cb(err);
                    return;
                }
                vmobj = obj;
                cb();
            });
        }, function (cb) {
            normalizePayload(payload, vmobj, log, function (e) {
                log.debug('Used payload:\n'
                    + JSON.stringify(payload, null, 2));
                cb(e);
            });
        }, function (cb) {
            var deletables = [];
            var to_remove = [];
            var n;

            // destroy remove_disks before we add in case we're recreating with
            // an existing name.

            if (payload.hasOwnProperty('remove_disks')) {
                to_remove = payload.remove_disks;
                for (n in vmobj.disks) {
                    if (to_remove.indexOf(vmobj.disks[n].path) !== -1) {
                        deletables.push(vmobj.disks[n]);
                    }
                }
            } else {
                // no disks to remove so all done.
                cb();
                return;
            }

            function _loggedDeleteVolume(volume, callbk) {
                return deleteVolume(volume, log, callbk);
            }

            async.forEachSeries(deletables, _loggedDeleteVolume,
                function (err) {
                    if (err) {
                        log.error(err, 'Unknown error deleting volumes: '
                            + err.message);
                        cb(err);
                    } else {
                        log.info('successfully deleted volumes');
                        cb();
                    }
                }
            );
        }, function (cb) {
            var disks = [];
            var matches;
            var n;
            var p;
            var used_disk_indexes = [];

            // create any new volumes we need.
            if (payload.hasOwnProperty('add_disks')) {
                disks = payload.add_disks;
            }

            // create a list of used indexes so we can find the free ones to
            // use in createVolume()
            if (vmobj.hasOwnProperty('disks')) {
                for (n in vmobj.disks) {
                    matches = vmobj.disks[n].path.match(/^.*-disk(\d+)$/);
                    if (matches) {
                        used_disk_indexes.push(Number(matches[1]));
                    }
                }
            }

            // add the bits of payload createVolumes() needs.
            p = {'add_disks': disks};
            p.uuid = uuid;
            if (vmobj.hasOwnProperty('zpool')) {
                p.zpool = vmobj.zpool;
            }
            p.used_disk_indexes = used_disk_indexes;
            createVolumes(p, log, function (e) {
                cb(e);
            });
        }, function (cb) {
            updateMetadata(vmobj, payload, log, function (e) {
                cb(e);
            });
        }, function (cb) {
            updateRoutes(vmobj, payload, log, function (e) {
                cb(e);
            });
        }, function (cb) {
            var zcfg;
            // generate a payload and send as a file to zonecfg to update
            // the zone.
            zcfg = buildZonecfgUpdate(vmobj, payload, log);
            zonecfgFile(zcfg, ['-u', uuid], log, function (e, fds) {
                if (e) {
                    log.error({err: e, stdout: fds.stdout, stderr: fds.stderr},
                        'unable to update zonecfg');
                } else {
                    log.debug({stdout: fds.stdout, stderr: fds.stderr},
                        'updated zonecfg');
                }
                cb(e);
            });
        }, function (cb) {
            restartMetadataService(vmobj, payload, log, function (e) {
                cb(e);
            });
        }, function (cb) {
            updateVnicProperties(uuid, vmobj, payload, log, function (e) {
                cb(e);
            });
        }, function (cb) {
            // Do another full reload (all fields) so we can compare in
            // applyUpdates() and decide what's changed that we need to apply.
            VM.load(uuid, {log: log}, function (e, newobj) {
                if (e) {
                    cb(e);
                } else {
                    new_vmobj = newobj;
                    cb();
                }
            });
        }, function (cb) {
            applyUpdates(vmobj, new_vmobj, payload, log, function () {
                cb();
            });
        }, function (cb) {
            // Update the firewall data
            updateFirewallData(payload, new_vmobj, log, cb);
        }
    ], function (e) {
        // If we were able to hold the lockfile, and thus have an unlock
        // callback, we must call it before returning, whether or not
        // there was an error.
        if (unlock) {
            log.debug('releasing lock on ' + lockpath);
            unlock(function (unlock_err) {
                if (unlock_err) {
                    log.error(unlock_err,
                        'unlock error! (path ' + lockpath + ')');
                } else {
                    log.debug('released lock on ' + lockpath);
                }
                callback(e);
            });
        } else {
            callback(e);
        }
    });
};

function halt(uuid, log, callback)
{
    var load_fields;
    var tracers_obj;
    var unset_autoboot = 'set autoboot=false';

    assert(log, 'no logger passed to halt()');

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('halt', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    log.info('Killing VM ' + uuid);

    load_fields = [
        'brand',
        'state',
        'transition_to',
        'uuid'
    ];

    /* We load here to ensure this vm exists. */
    VM.load(uuid, {fields: load_fields, log: log}, function (err, vmobj) {
        if (err) {
            callback(err);
            return;
        }

        if (BRAND_OPTIONS[vmobj.brand].features.use_vm_autoboot) {
            unset_autoboot =
                'select attr name=vm-autoboot; set value=false; end';
        }

        zoneadm(['-u', uuid, 'halt', '-X'], log, function (e, fds) {
            var msg = trim(fds.stderr);

            if (msg.match(/zone is already halted$/)) {
                // remove transition marker, since vm is not running now.
                VM.unsetTransition(vmobj, {log: log}, function () {
                    var new_err;

                    new_err = new Error('VM ' + vmobj.uuid + ' is already '
                        + 'not \'running\' (currently: ' + vmobj.state + ')');
                    new_err.code = 'ENOTRUNNING';
                    callback(new_err);
                });
            } else if (e) {
                log.error({err: e, stdout: fds.stdout, stderr: fds.stderr},
                    'failed to halt VM ' + uuid);
                callback(err, msg);
            } else {
                log.debug({stdout: fds.stdout, stderr: fds.stderr},
                    'zoneadm halted VM ' + uuid);
                zonecfg(['-u', uuid, unset_autoboot], log,
                    function (error, unset_fds) {

                    if (error) {
                        // The vm is dead at this point, erroring out here would
                        // do no good, so we just log it.
                        log.error({err: error, stdout: unset_fds.stdout,
                            stderr: unset_fds.stderr}, 'halt(): Failed to '
                            + unset_autoboot);
                    } else {
                        log.debug({stdout: unset_fds.stdout,
                            stderr: unset_fds.stderr}, 'unset autoboot flag');
                    }
                    if (vmobj.state === 'stopping') {
                        // remove transition marker
                        VM.unsetTransition(vmobj, {log: log}, function () {
                            callback(null, msg);
                        });
                    } else {
                        callback(null, msg);
                    }
                });
            }
        });
    });
}

/*
 * Sends signal 'sig' to process with pid 'pid'. The signal must be one of those
 * available in node, but can be specified either as an integer (eg. 9) or a
 * signal name with or without the 'SIG' prefix (eg. SIGHUP or HUP).
 *
 * On success The return value is null.
 * On failure an Error object is returned.
 *
 */
function killSig(pid, sig) {
    var signal = nodeSig(sig);

    if (util.isError(signal)) {
        return (signal);
    }

    try {
        process.kill(pid, signal);
        return (null);
    } catch (e) {
        return (e);
    }
}

/*
 * Returns the 'node' signal name of a given signal. The signal can either be
 * a number, a non-prefixed name (eg. HUP) or a SIG-prefixed name (eg. SIGHUP).
 * The result will be either an Error object or a string which can then be
 * passed into process.kill as the signal.
 */
function nodeSig(sig) {
    var constants = process.binding('constants');
    var signal;

    if ((sig === undefined) || (sig === null)) {
        return ('SIGTERM');
    }

    if ((typeof (sig) !== 'number') && (typeof (sig) !== 'string')) {
        return (new Error('InvalidArgument: sig must be one of "string" or '
            + '"number"'));
    }

    if (sig === 0) {
        // special case for kill -0 (process exists detection)
        signal = 0;
    } else if (typeof (sig) === 'number') {
        for (var key in constants) {
            if ((key.substr(0, 3) === 'SIG') && (constants[key] === sig)) {
                signal = key;
            }
        }
    } else { // typeof(sig) === 'string'
        if ((sig.substr(0, 3) === 'SIG') && (constants.hasOwnProperty(sig))) {
            // eg. SIGHUP
            signal = sig;
        } else {
            // eg. HUP
            if (constants.hasOwnProperty('SIG' + sig)) {
                signal = 'SIG' + sig;
            } else {
                return (new Error('Unknown signal "' + sig + '"'));
            }
        }
    }

    return (signal);
}

exports.kill = function (uuid, options, callback) {
    var load_fields;
    var log;
    var signal;
    var tracers_obj;

    assert(typeof (uuid) === 'string');
    assert(typeof (options) === 'object');
    assert(typeof (callback) === 'function');

    assertMockCnUuid();
    throw new Error('UNIMPLEMENTED: kill');

    load_fields = [
        'brand',
        'pid',
        'state',
        'uuid',
        'zone_state',
        'zonename'
    ];

    ensureLogging(true);
    if (options.hasOwnProperty('log')) {
        log = options.log;
    } else {
        log = VM.log.child({action: 'kill', vm: uuid});
    }

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('kill', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    if (options.signal) {
        signal = options.signal;
    } else {
        signal = 'SIGTERM';
    }

    /* We load here to ensure this vm exists. */
    VM.load(uuid, {log: log, fields: load_fields}, function (err, vmobj) {
        var kill_err;
        var result;

        if (err) {
            log.error(err);
            callback(err);
            return;
        }
        if ((vmobj.zone_state !== 'running') || (!vmobj.pid)) {
            kill_err = new Error('Cannot find running init PID for VM '
                + vmobj.uuid);
            kill_err.code = 'ENOTRUNNING';
            callback(kill_err);
            return;
        }

        if ((typeof (signal) === 'string') && (signal.match(/^[0-9]+$/))) {
            signal = Number(signal);
        }

        result = killSig(vmobj.pid, signal);
        callback(result);
        return;
    });
};

function postVmadmd(uuid, action, args, log, callback)
{
    var arg;
    var url_path = '/vm/' + uuid + '?action=' + action;
    var req;
    var tracers_obj;

    assert(log, 'no logger passed to postVmadmd()');

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('post-vmadmd', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    if (args) {
        for (arg in args) {
            if (args.hasOwnProperty(arg)) {
                url_path = url_path + '&' + arg + '=' + args[arg];
            }
        }
    }

    log.debug('HTTP POST ' + url_path);
    req = http.request(
        { method: 'POST', host: '127.0.0.1', port: '8080', path: url_path },
        function (res) {

            log.debug('HTTP STATUS: ' + res.statusCode);
            log.debug('HTTP HEADERS: ' + JSON.stringify(res.headers));
            res.setEncoding('utf8');
            res.on('data', function (chunk) {
                log.debug('HTTP BODY: ' + chunk);
            });
            res.on('end', function () {
                log.debug('HTTP conversation has completed.');
                callback();
            });
        }
    );
    req.on('error', function (e) {
        log.error(e, 'HTTP error: ' + e.message);
        callback(e);
    });
    req.end();
}

/*
 * Wait for the given PID to exit. When it exits, this will call the callback.
 */
function doPwait(pid, log, callback)
{
    var args = [pid];
    var child;
    var cmd = '/usr/bin/pwait';

    log.debug('executing "pwait ' + args.join(' ') + '"');
    child = spawn(cmd, args, {});
    log.debug('pwait[' + child.pid + '](' + pid.toString() + ') running');
    child.on('close', function (code) {
        log.debug('pwait[' + child.pid + '](' + pid.toString()
            + ') exited with code ' + code);
        callback();
    });

    return (child);
}

function doDockerStop(vmobj, options, callback)
{
    var log = options.log;
    var err;
    var timer;
    var unset_autoboot = 'set autoboot=false';
    var tracers_obj;
    var waiter;

    assert(vmobj.pid);

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('docker-stop', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    log.debug({vmobj_pid: vmobj.pid, timeout: options.timeout}, 'doDockerStop');

    // From options, we use:
    // options.timeout
    function haltZone() {
        zoneadm(['-u', vmobj.uuid, 'halt', '-X'], log, function (e, fds) {
            var msg = trim(fds.stderr);

            if (!e || msg.match(/zone is already halted$/)) {
                // success
                log.info('zone is halted');
                callback();
                return;
            } else if (e) {
                log.error({
                    err: e,
                    stdout: fds.stdout,
                    stderr: fds.stderr
                }, 'failed to halt zone');
                callback(e);
                return;
            }
        });
    }

    zonecfg(['-u', vmobj.uuid, unset_autoboot], log,
        function (zonecfg_err, fds) {

        if (zonecfg_err) {
            log.warn({
                err: zonecfg_err,
                stdout: fds.stdout,
                stderr: fds.stderr
            }, 'Failed to ' + unset_autoboot + ' for ' + vmobj.uuid);
            return;
        }

        // if init has died but zone is still running, pid is reported to
        // be 4294967295 (UINT32_MAX) so if we see that value, just halt the
        // zone.
        if (vmobj.pid === 4294967295) {
            log.warn('PID is 4294967295, halting zone instead of killing init');
            haltZone();
            return;
        }

        // First, send the SIGTERM to the pid for init of the VM
        log.info({vmobj_pid: vmobj.pid}, 'Sending SIGTERM to VM\'s init PID');
        err = killSig(vmobj.pid, 'SIGTERM');
        if (err && err.code === 'ESRCH') {
            // process already doesn't exist
            callback();
            return;
        } else if (err) {
            /*
             * kill(2) says this should be EPERM or EINVAL which are both
             * programmer errors here.
             */
            callback(err);
            return;
        }

        /*
         * We expect the stop to have completed within options.timeout seconds,
         * if it hasn't we'll try SIGKILL and if that fails to kill the zone,
         * we'll do a 'zoneadm halt'.
         */
        timer = setTimeout(function () {
            /*
             * Hit timeout, do kill -KILL, ignore error since either process is
             * gone and doPwait will notice and exit, or we'll timeout a second
             * time.
             */
            log.info({vmobj_pid: vmobj.pid},
                'Sending SIGKILL to VM\'s init PID');
            killSig(vmobj.pid, 'SIGKILL');

            /*
             * Sent kill -KILL, so process really should just exit. In case it
             * doesn't though set one more timer. If that expires, halt the
             * zone.
             */
            timer = setTimeout(function () {
                if (waiter) {
                    waiter.kill();
                    waiter = null;
                }

                log.warn({vmobj_pid: vmobj.pid}, 'SIGKILL does not seem to have'
                    + ' stopped zone, attempting "zoneadm halt"');
                haltZone(); // will call callback();
            }, (10 * 1000));
        }, (options.timeout * 1000));

        /*
         * This 'waiter' watches for the PID to exit and calls _onExit callback
         * when it does. Can be immediately.
         */
        waiter = doPwait(vmobj.pid, log, function _onExit() {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }

            // It's dead Jim!
            log.debug({vmobj_pid: vmobj.pid}, 'pwait reports that init exited');
            callback();
        });
    });
}

function doVmadmdStop(vmobj, options, callback)
{
    var log = options.log;
    var tracers_obj;

    // options.transition_to
    // options.timeout

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('vmadmd-stop', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    async.series([
        function (cb) {
            setTransition(vmobj, 'stopping', options.transition_to,
                (options.timeout * 1000), log, function (err) {

                cb(err);
            });
        }, function (cb) {
            postVmadmd(vmobj.uuid, 'stop', {'timeout': options.timeout}, log,
                function (err) {

                if (err) {
                    log.error(err);
                    err.message = 'Unable to post "stop" to vmadmd:' + ' '
                        + err.message;
                }
                cb(err);
            });
        }, function (cb) {
            // different version for VMs
            var unset_autoboot = 'select attr name=vm-autoboot; '
                + 'set value=false; end';

            zonecfg(['-u', vmobj.uuid, unset_autoboot], log,
                function (err, fds) {
                    if (err) {
                        // The vm is dead at this point, failing
                        // here would do no good, so we just log it.
                        log.error({
                            err: err,
                            stdout: fds.stdout,
                            stderr: fds.stderr
                        }, 'stop(): Failed to ' + unset_autoboot + ' for '
                            + vmobj.uuid + ': ' + err.message);
                    } else {
                        log.info({stdout: fds.stdout, stderr: fds.stderr},
                            'Stopped ' + vmobj.uuid);
                    }
                    cb();
                }
            );
        }
    ], callback);
}

function doShutdownStop(vmobj, options, callback)
{
    var args;
    var log = options.log;
    var tracers_obj;
    var unset_autoboot = 'set autoboot=false';

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('shutdown-stop', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    // joyent brand specific stuff
    args = [vmobj.zonename, '/usr/sbin/shutdown', '-y', '-g', '0', '-i', '5'];

    if (BRAND_OPTIONS[vmobj.brand].features.shutdown_cmd) {
        args = [vmobj.zonename].concat(BRAND_OPTIONS[vmobj.brand]
            .features.shutdown_cmd.split(' '));
    }
    async.series([
        function (cb) {
            traceExecFile('/usr/sbin/zlogin', args, log, 'zlogin-shutdown',
                function (err, stdout, stderr) {

                if (err) {
                    log.error({
                        err: err,
                        stdout: stdout,
                        stderr: stderr
                    }, 'zlogin for ' + vmobj.zonename + ' exited with code '
                        + err.code + ': ' + err.message);
                    cb(err);
                    return;
                }

                log.debug({stdout: stdout, stderr: stderr},
                    'zlogin claims to have worked');
                cb();
            });
        }, function (cb) {
            zonecfg(['-u', vmobj.uuid, unset_autoboot], log,
                function (err, fds) {

                if (err) {
                    /*
                     * The vm is stopped at this point, failing here would do no
                     * good, so we just log the error.
                     */
                    log.warn({
                        err: err,
                        stdout: fds.stdout,
                        stderr: fds.stderr
                    }, 'Failed to ' + unset_autoboot + ' for ' + vmobj.uuid);
                    return;
                }
                log.info({stdout: fds.stdout, stderr: fds.stderr},
                    'Stopped ' + vmobj.uuid);

                cb();
            });
        }
    ], callback);
}

// options parameter is *REQUIRED* for VM.stop()
exports.stop = function (uuid, options, callback)
{
    var load_fields;
    var log;
    var tracers_obj;
    var vmobj;

    assertMockCnUuid();
    throw new Error('UNIMPLEMENTED: stop');

    load_fields = [
        'brand',
        'docker',
        'pid',
        'state',
        'uuid',
        'zone_state',
        'zonename',
        'zonepath'
    ];

    if (!options) {
        options = {};
    }

    if (options.hasOwnProperty('force') && options.force) {
        ensureLogging(true);
        if (options.hasOwnProperty('log')) {
            log = options.log;
        } else {
            log = VM.log.child({action: 'stop-F', vm: uuid});
        }
        halt(uuid, log, callback);
        return;
    } else {
        ensureLogging(true);
        if (options.hasOwnProperty('log')) {
            log = options.log;
        } else {
            log = VM.log.child({action: 'stop', vm: uuid});
        }
    }

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('stop', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    if (!options.transition_to) {
        options.transition_to = 'stopped';
    }

    log.info({
        transition_to: options.transition_to
    }, 'Stopping VM ' + uuid);

    async.series([
        function (cb) {
            /*
             * We load here to ensure this vm exists, and so when docker=true
             * we can handle stop specially. But if we're being called by
             * something that just loaded the object, we can use that instead.
             */
            if (options.vmobj && options.vmobj.uuid === uuid) {
                log.info('using cached vmobj that was passed in to VM.stop');
                vmobj = options.vmobj;
                cb();
                return;
            }
            VM.load(uuid, {log: log, fields: load_fields}, function (err, obj) {
                if (err) {
                    log.error(err);
                    cb(err);
                    return;
                } else {
                    vmobj = obj;
                    cb();
                }
            });
        }, function (cb) {
            var unset_autoboot = 'set autoboot=false';

            // If the user called stop, they want the zone stopped. So in this
            // case we always attempt to set autoboot to false. (halt does this
            // itself.
            if (BRAND_OPTIONS[vmobj.brand].features.use_vm_autoboot) {
                unset_autoboot
                    = 'select attr name=vm-autoboot; set value=false; end';
            }

            log.debug('setting autoboot=false');
            zonecfg(['-u', uuid, unset_autoboot], log, function (e, fds) {
                if (e) {
                    log.warn({err: e, stdout: fds.stdout, stderr: fds.stderr},
                        'Error setting autoboot=false');
                    cb(e);
                    return;
                } else {
                    log.debug({stdout: fds.stdout, stderr: fds.stderr},
                        'set autoboot=false');
                }
                cb();
            });
        }, function (cb) {
            var new_err;

            if (vmobj.state !== 'running') {
                new_err = new Error('VM ' + vmobj.uuid + ' is already '
                    + 'not \'running\' (currently: ' + vmobj.state + ')');
                new_err.code = 'ENOTRUNNING';
                cb(new_err);
            } else {
                cb();
            }
        }, function (cb) {
            if (vmobj.docker) {
                /*
                 * When a zone has the 'docker=true' flag set, we want to stop
                 * it the way docker does.
                 */
                if (!options.timeout) {
                    options.timeout = 10;
                }
                doDockerStop(vmobj, {
                    log: log,
                    timeout: options.timeout
                }, cb);
            } else if (BRAND_OPTIONS[vmobj.brand].features.use_vm_autoboot) {
                /*
                 * When use_vm_autoboot, the VM will use vmadmd to perform the
                 * stop and will not use the 'autoboot' flag in the zonecfg.
                 * Instead we'll use the 'vm-autoboot' attr to determine whether
                 * the zone should be booted or not at GZ reboot.
                 */
                if (!options.timeout) {
                    options.timeout = 180;
                }
                doVmadmdStop(vmobj, {
                    log: log,
                    timeout: options.timeout,
                    transition_to: options.transition_to
                }, cb);
            } else {
                /*
                 * When we're not using vm-autoboot, we go through the 'normal'
                 * process of trying to shut a zone down cleanly. We do this by
                 * calling /usr/sbin/shutdown from within the zone. Note also
                 * that the BRAND_OPTIONS can substitute a different
                 * shutdown_cmd for a specific brand.
                 */
                doShutdownStop(vmobj, {
                    log: log
                }, cb);
            }
        }, function (cb) {
            // Verify it's shut down
            VM.waitForZoneState(vmobj, 'installed', {log: log},
                function (err, result) {

                if (err) {
                    if (err.code === 'ETIMEOUT') {
                        log.info(err, 'timeout waiting for zone to go to '
                            + '"installed"');
                    } else {
                        log.error(err, 'unknown error waiting for zone to go'
                            + ' "installed"');
                    }
                    cb(err);
                } else {
                    // zone got to stopped
                    log.info('VM seems to have switched to "installed"');
                    cb();
                }
            });
        }
    ], function (err) {
        callback(err);
    });
};

// sends several query-* commands to QMP to get details for a VM
exports.info = function (uuid, types, options, callback)
{
    var load_fields;
    var log;
    var tracers_obj;

    assertMockCnUuid();
    throw new Error('UNIMPLEMENTED: info');

    // options is optional
    if (arguments.length === 3) {
        callback = arguments[2];
        options = {};
    }

    ensureLogging(false);
    if (options.hasOwnProperty('log')) {
        log = options.log;
    } else {
        log = VM.log.child({action: 'info', vm: uuid});
    }

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('info', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    load_fields = [
        'brand',
        'state',
        'uuid'
    ];

    // load to ensure we're a VM
    VM.load(uuid, {fields: load_fields, log: log}, function (err, vmobj) {
        var type;

        if (err) {
            callback(err);
            return;
        }

        if (!BRAND_OPTIONS[vmobj.brand].features.runtime_info) {
            //  XXX if support is added to other brands, update this message.
            callback(new Error('the info command is only supported for KVM '
                + 'VMs'));
            return;
        }

        if (vmobj.state !== 'running' && vmobj.state !== 'stopping') {
            callback(new Error('Unable to get info for vm from state "'
                + vmobj.state + '", must be "running" or "stopping".'));
            return;
        }

        if (!types) {
            types = ['all'];
        }

        for (type in types) {
            type = types[type];
            if (VM.INFO_TYPES.indexOf(type) === -1) {
                callback(new Error('unknown info type: ' + type));
                return;
            }
        }

        http.get({ host: '127.0.0.1', port: 8080, path: '/vm/' + uuid + '/info'
            + '?types=' + types.join(',') }, function (res) {

                var data = '';

                if (res.statusCode !== 200) {
                    callback(new Error('Unable to get info from vmadmd, query '
                        + 'returned ' + res.statusCode + '.'));
                } else {
                    res.on('data', function (d) {
                        data = data + d.toString();
                    });
                    res.on('end', function (d) {
                        callback(null, JSON.parse(data));
                    });
                }
            }
        ).on('error', function (e) {
            log.error(e);
            callback(e);
        });
    });
};

function reset(uuid, log, callback)
{
    var load_fields;
    var tracers_obj;

    assert(log, 'no logger passed to reset()');

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('reset', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    log.info('Resetting VM ' + uuid);

    load_fields = [
        'brand',
        'state',
        'uuid'
    ];

    /* We load here to ensure this vm exists. */
    VM.load(uuid, {fields: load_fields, log: log}, function (err, vmobj) {
        if (err) {
            callback(err);
            return;
        }

        if (vmobj.state !== 'running') {
            callback(new Error('Cannot reset vm from state "'
                + vmobj.state + '", must be "running".'));
            return;
        }

        if (BRAND_OPTIONS[vmobj.brand].features.use_vmadmd) {
            postVmadmd(vmobj.uuid, 'reset', {}, log, function (e) {
                if (e) {
                    callback(new Error('Unable to post "reset" to '
                        + 'vmadmd: ' + e.message));
                } else {
                    callback();
                }
            });
        } else {
            zoneadm(['-u', vmobj.uuid, 'reboot', '-X'], log, function (e, fds) {
                if (e) {
                    log.warn({err: e, stdout: fds.stdout, stderr: fds.stderr},
                        'zoneadm failed to reboot VM ' + vmobj.uuid);
                    callback(new Error(rtrim(fds.stderr)));
                } else {
                    log.debug({stdout: fds.stdout, stderr: fds.stderr},
                        'zoneadm rebooted VM ' + vmobj.uuid);
                    callback();
                }
            });
        }
    });
}

/*
 * This handles rebooting docker=true zones.
 */
function doDockerReboot(vmobj, options, callback)
{
    var log = options.log;
    var tracers_obj;

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('docker-reboot', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    log.debug({vmobj_pid: vmobj.pid, timeout: options.timeout},
        'doDockerReboot');

    if (!options.timeout) {
        options.timeout = 10;
    }

    options.vmobj = vmobj;

    async.series([
        function (cb) {
            if (vmobj.state !== 'running') {
                cb();
                return;
            }
            VM.stop(vmobj.uuid, options, cb);
        }, function (cb) {
            VM.start(vmobj.uuid, {}, options, cb);
        }
    ], callback);
}

/*
 * This handles the restart of all zones except docker zones.
 */
function doReboot(vmobj, options, callback)
{
    var cleanup;
    var log = options.log;
    var reboot_async = false;
    var reboot_complete = false;
    var tracers_obj;
    var watcherobj;

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('do-reboot', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    async.series([function (cb) {
        if (!reboot_async) {
            watcherobj = watchZoneTransitions(function (err, ze) {
                if (!err && ze.zonename !== vmobj.zonename) {
                    // not something we need to handle
                    return;
                }

                if (err) {
                    // XXX what should we do here?
                    log.error(err);
                    return;
                }

                log.debug(ze); // TODO move to trace

                if (ze.newstate === 'running' && ze.oldstate !== 'running') {
                    if (watcherobj) {
                        // cleanup our watcher since we found what we're
                        // looking for.
                        if (cleanup) {
                            cleanup();
                            cleanup = null;
                        }
                    }

                    reboot_complete = true;
                }
            }, log);
            cleanup = watcherobj.cleanup;
        }

        cb();
    }, function (cb) {
        var args;

        if (BRAND_OPTIONS[vmobj.brand].features.use_vmadmd) {
            // here we stop the machine and set a transition so vmadmd will
            // start the machine once the stop finished.
            options.transition_to = 'start';
            options.log = log;
            VM.stop(vmobj.uuid, options, function (err) {
                if (err) {
                    cb(err);
                } else {
                    cb();
                }
            });
        } else {
            // non-KVM zones
            args = [vmobj.zonename, '/usr/sbin/shutdown', '-y', '-g', '0',
                '-i', '6'];

            if (BRAND_OPTIONS[vmobj.brand].features.reboot_cmd) {
                args = [vmobj.zonename].concat(BRAND_OPTIONS[vmobj.brand]
                    .features.reboot_cmd.split(' '));
            }

            traceExecFile('/usr/sbin/zlogin', args, log, 'zlogin-shutdown',
                function (err, stdout, stderr) {
                if (err) {
                    log.error({'err': err, 'stdout': stdout,
                        'stderr': stderr}, 'zlogin for ' + vmobj.zonename
                        + ' exited with code' + err.code + ': '
                        + err.message);
                    cb(err);
                } else {
                    cb();
                }
            });
        }
    }, function (cb) {
        var ival;
        var ticks = 0;

        if (reboot_async) {
            cb();
            return;
        } else {
            ticks = 180 * 10; // (180 * 10) 100ms ticks = 3m
            ival = setInterval(function () {
                if (reboot_complete) {
                    log.debug('reboot marked complete, cleaning up');
                    clearInterval(ival);
                    if (cleanup) {
                        cleanup();
                        cleanup = null;
                    }
                    cb();
                    return;
                }
                ticks--;
                if (ticks <= 0) {
                    // timed out
                    log.debug('reboot timed out, cleaning up');
                    clearInterval(ival);
                    if (cleanup) {
                        cleanup();
                        cleanup = null;
                    }
                    cb(new Error('timed out waiting for zone to reboot'));
                    return;
                }
            }, 100);
        }
    }], function (err) {
        if (cleanup) {
            cleanup();
            cleanup = null;
        }
        callback(err);
    });
}

// options is *REQUIRED* for VM.reboot()
exports.reboot = function (uuid, options, callback)
{
    var log;
    var tracers_obj;
    var vmobj;

    assertMockCnUuid();
    throw new Error('UNIMPLEMENTED: reboot');

    if (options.hasOwnProperty('log')) {
        log = options.log;
    }

    if (options.hasOwnProperty('force') && options.force) {
        ensureLogging(true);
        if (!log) {
            log = VM.log.child({action: 'reboot-F', vm: uuid});
        }
        reset(uuid, log, callback);
        return;
    } else {
        ensureLogging(true);
        log = VM.log.child({action: 'reboot', vm: uuid});
    }

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('reboot', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    log.info('Rebooting VM ' + uuid);

    if (!options) {
        options = {};
    }

    async.series([
        function (cb) {
            var load_fields = [
                'brand',
                'docker',
                'nics',
                'pid',
                'state',
                'uuid',
                'zone_state',
                'zonename'
            ];

            VM.load(uuid, {fields: load_fields, log: log},
                function (err, obj) {

                if (err) {
                    cb(err);
                    return;
                }

                if (obj.state !== 'running') {
                    if (obj.docker && obj.state === 'stopped') {
                        // Special case for docker, can restart from stopped
                        log.debug('VM is docker, restarting from state "'
                            + obj.state + '"');
                    } else {
                        cb(new Error('Cannot reboot vm from state "' + obj.state
                            + '", must be "running"'));
                        return;
                    }
                }

                vmobj = obj;
                cb();
            });
        }, function (cb) {
            // If nic tags have disappeared out from under us, don't allow a
            // reboot that will put us into a bad state
            validateNicTags(vmobj.nics, log, function (e) {
                if (e) {
                    cb(new Error('Cannot reboot vm: ' + e.message));
                    return;
                }

                cb();
            });

        }, function (cb) {
            // re-add log in case it was changed
            options.log = log;

            if (vmobj.docker) {
                doDockerReboot(vmobj, options, cb);
            } else {
                doReboot(vmobj, options, cb);
            }
        }
    ], callback);
};

// options is *REQUIRED* for VM.sysrq
exports.sysrq = function (uuid, req, options, callback)
{
    var load_fields;
    var log;
    var tracers_obj;

    assertMockCnUuid();
    throw new Error('UNIMPLEMENTED: sysrq');

    ensureLogging(true);

    if (options.hasOwnProperty('log')) {
        log = options.log;
    } else {
        log = VM.log.child({action: 'sysrq-' + req, vm: uuid});
    }

    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        tracers_obj = traceUntilCallback('sysrq', log, callback);
        callback = tracers_obj.callback;
        log = tracers_obj.log;
    }

    log.info('Sending sysrq "' + req + '" to ' + uuid);

    load_fields = [
        'brand',
        'state',
        'uuid'
    ];

    /* We load here to ensure this vm exists. */
    VM.load(uuid, {fields: load_fields, log: log}, function (err, vmobj) {
        if (err) {
            callback(err);
            return;
        }

        if (vmobj.state !== 'running' && vmobj.state !== 'stopping') {
            callback(new Error('Unable to send request to vm from state "'
                + vmobj.state + '", must be "running" or "stopping".'));
            return;
        }

        if (BRAND_OPTIONS[vmobj.brand].features.type !== 'KVM') {
            callback(new Error('The sysrq command is only supported for KVM.'));
            return;
        }

        if (VM.SYSRQ_TYPES.indexOf(req) === -1) {
            callback(new Error('Invalid sysrq "' + req + '" valid values: '
                + '"' + VM.SYSRQ_TYPES.join('","') + '".'));
            return;
        }

        postVmadmd(vmobj.uuid, 'sysrq', {'request': req}, log, function (e) {
            if (e) {
                callback(new Error('Unable to post "sysrq" to vmadmd: '
                    + e.message));
            } else {
                callback();
            }
        });
    });
};

exports.console = function (uuid, options, callback)
{
    var load_fields;
    var log;

    assertMockCnUuid();
    throw new Error('UNIMPLEMENTED: console');

    // options is optional
    if (arguments.length === 2) {
        callback = arguments[1];
        options = {};
    }

    ensureLogging(false);
    if (options.hasOwnProperty('log')) {
        log = options.log;
    } else {
        log = VM.log.child({action: 'console', vm: uuid});
    }

    load_fields = [
        'brand',
        'state',
        'zonename',
        'zonepath'
    ];

    VM.load(uuid, {fields: load_fields, log: log}, function (err, vmobj) {
        var args;
        var child;
        var cmd;
        var stty;

        if (err) {
            callback(err);
            return;
        }
        if (vmobj.state !== 'running') {
            callback(new Error('cannot connect to console when state is '
                + '"' + vmobj.state + '" must be "running".'));
            return;
        }

        if (BRAND_OPTIONS[vmobj.brand].features.zlogin_console) {
            cmd = '/usr/sbin/zlogin';
            args = ['-C', '-e', '\\035', vmobj.zonename];

            log.debug(cmd + ' ' + args.join(' '));
            child = spawn(cmd, args, {customFds: [0, 1, 2]});
            child.on('close', function (code) {
                log.debug('zlogin process exited with code ' + code);
                callback();
            });
        } else if (BRAND_OPTIONS[vmobj.brand].features.serial_console) {
            async.series([
                function (cb) {
                    cmd = '/usr/bin/stty';
                    args = ['-g'];
                    stty = '';

                    log.debug(cmd + ' ' + args.join(' '));
                    child = spawn(cmd, args, {customFds: [0, -1, -1]});
                    child.stdout.on('data', function (data) {
                        // log.debug('data: ' + data.toString());
                        stty = data.toString();
                    });
                    child.on('close', function (code) {
                        log.debug('stty process exited with code ' + code);
                        cb();
                    });
                }, function (cb) {
                    cmd = '/usr/bin/socat';
                    args = ['unix-client:' + vmobj.zonepath
                        + '/root/tmp/vm.console', '-,raw,echo=0,escape=0x1d'];

                    log.debug(cmd + ' ' + args.join(' '));
                    child = spawn(cmd, args, {customFds: [0, 1, 2]});
                    child.on('close', function (code) {
                        log.debug('zlogin process exited with code ' + code);
                        cb();
                    });
                }, function (cb) {
                    cmd = '/usr/bin/stty';
                    args = [stty];

                    log.debug(cmd + ' ' + args.join(' '));
                    child = spawn(cmd, args, {customFds: [0, -1, -1]});
                    child.on('close', function (code) {
                        log.debug('stty process exited with code ' + code);
                        cb();
                    });
                }
            ], function (e, results) {
                callback(e);
            });
        } else {
            callback(new Error('Cannot get console for brand: ' + vmobj.brand));
        }
    });
};