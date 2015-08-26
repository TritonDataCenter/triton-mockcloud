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
 */

var assert = require('assert');
var async = require('/usr/node/node_modules/async');
var bunyan = require('/usr/node/node_modules/bunyan');
var fs = require('fs');
var path = require('path');
var props = require('/usr/vm/node_modules/props');
var utils = require('utils');

// utils
var trim = utils.trim;

/*
 * options can include:
 *
 *  fields: an array of field names we want in this object
 *  log: a bunyan logger (required)
 *  cache: (see comment at top of getZoneData())
 *
 * If any of the members of the 'cache' are not passed in, they will be looked
 * up from the live system. This means that if you want to do multiple lookups
 * and aren't concerned about possible changes in the meantime (or are watching
 * those yourself) the most efficient way to get VM objects is to preload this
 * data using something like:
 *
 *  getZoneData(<uuid>, options, callback(gzd_err, cache) {
 *      if (gzd_err) {
 *          ...
 *          return;
 *      }
 *      options.cache = cache;
 *      getVmobj(<uuid>, options, callback(gv_err, obj) {
 *          ...
 *      });
 *  }):
 *
 * but if you are just doing one lookup, you can skip passing in a 'cache'
 * option and it will be looked up for you.
 *
 */
function getVmobj(uuid, options, callback)
{
    var cache;
    var log;
    var vmobj = {};

    assert(uuid, 'no uuid passed to getVmobj()');
    assert(options.log, 'no logger passed to getVmobj()');
    log = options.log;

    log.trace('<' + process.env.MOCKCN_SERVER_UUID + '> getting vmobj for VM '
        + uuid);

    try {
        vmobj = require('/mockcn/' + process.env.MOCKCN_SERVER_UUID + '/vms/'
            + uuid + '.json');
    } catch (e) {
        // TODO: just on non-ENOENT?
        callback(e);
        return;
    }

    if (options.hasOwnProperty('fields')) {
        Object.keys(vmobj).forEach(function (key) {
            if (!wantField(options, key)) {
                delete vmobj[key];
            }
        });
    }

    callback(null, vmobj);
}

/*
 * getVmobjs is used to lookup the *list* of VMs that match the specified
 * filters. The filter parameter is a function.
 *
 * Starting with an array of all VMs on this node, the VM objects are passed
 * one at a time through the filter function. If the function returns a true
 * value (calls filter_cb(true)), the VM will be included in the result. If it
 * returns a false-y value, it will not.
 *
 * So for example if we start with a list of VMs:
 *
 *   [ A, B, C, D ]
 *
 * filter() will be called with:
 *
 *   filter(vmobj, filter_cb)
 *
 * for *all* VMs. And filter() should call filter_cb(true) if it wants the VM
 * to be in the output and filter_cb(false) if it does not.
 *
 * callback will be called with an error when there is an internal error or an
 * error with your options / match_fields, but not when no VMs match. In that
 * case callback will still be called, but with an empty array as the second
 * argument.
 *
 */
function getVmobjs(filter, options, callback)
{
    var base = path.join('/mockcn', process.env.MOCKCN_SERVER_UUID, '/vms');
    var cache;
    var vmobjs = [];

    assert(typeof (filter) === 'function', 'filter must be a function');

    fs.readdir(base, function (err, files) {
        var vm_files = files;
        var vmobjs = [];

        if (err && err.code === 'ENOENT') {
            //callback(null, []);
            vm_files = [];
        } else if (err) {
            throw (err);
        }

        //callback();
        vm_files.forEach(function _loadFile(vm_file) {
            var data;

            try {
                data = require(path.join(base, vm_file));
                vmobjs.push(data);
            } catch (e) {
                 if (e.code !== 'ENOENT') {
                     throw (e);
                 }
            }
        });

        async.filterSeries(vmobjs, filter, function (results) {
            callback(null, results);
        });
    });
}

/*
 * getZoneData() loads data for zone(s).
 *
 * options can include:
 *
 *  log: bunyan logger (required)
 *  cache: existing cache object (see below)
 *  fields: only load these fields into the cache
 *
 * cache should look similar to the following for both input and the results.
 *
 *  dataset_objects:
 *      {
 *        datasets: {
 *          'zones/01b2c898-945f-11e1-a523-af1afbe22822': {...},
 *          'zones/01b2c898-945f-11e1-a523-af1afbe22822@final': {...},
 *          ...
 *        },
 *        mountpoints: {
 *          '/zones/01b2c898-945f-11e1-a523-af1afbe22822':
 *            'zones/01b2c898-945f-11e1-a523-af1afbe22822',
 *          ...
 *        },
 *        snapshots: {
 *          'zones/01b2c898-945f-11e1-a523-af1afbe22822': {...},
 *          ...
 *        }
 *      }
 *
 *  json_objects:
 *      {
 *        <uuid>: {
 *          customer_metadata: ...,
 *          internal_metadata: ...,
 *          tags: ...,
 *          routes: ...
 *        },
 *        <uuid>: ...
 *      }
 *
 *  last_modified:
 *      {
 *        <uuid>: '2014-02-15T00:42:58.000Z',
 *        <uuid>: ...
 *      }
 *
 *  pids:
 *      {
 *        <uuid>: pid,
 *        <uuid>: pid,
 *        ...
 *      }
 *
 *  sysinfo:
 *      {
 *        'UUID': ...,
 *        'Hostname': ...,
 *        ...
 *      }
 *
 *  zoneadm_objects:
 *      {
 *        <uuid>: {
 *          uuid: ...,
 *          zonename: ...,
 *          state: ...,
 *          ...
 *        }
 *      }
 *
 *  zonexml_objects:
 *      {
 *        <uuid>: {
 *          zonename: '...',
 *          zonepath: '...',
 *          ...
 *        },
 *        <uuid>: {
 *          ...
 *        },
 *        ...
 *      }
 *
 */
function getZoneData(uuid, options, callback)
{
    callback();
    return;
}

module.exports = {
    getVmobj: getVmobj,
    getVmobjs: getVmobjs,
    getZoneData: getZoneData
};
