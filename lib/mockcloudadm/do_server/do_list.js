
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2015 Joyent, Inc.
 *
 * `mockcloudadm server list`
 */

var assert = require('assert-plus');
var vasync = require('vasync');
var tabula = require('tabula');

var common = require('../common');
var errors = require('../errors');

function do_list(subcmd, opts, args, cb) {
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length !== 0) {
        cb(new errors.UsageError('incorrect number of args'));
        return;
    }

    var MOCKCLOUD;
    var servers;
    vasync.waterfall([
        function (next) {
            common.createMockCloudClient(function (err, client) {
                MOCKCLOUD = client;
                next();
            });
        },
        function (next) {
            MOCKCLOUD.get('/servers', function onGet(err, req, res, _servers) {
                if (err) {
                    next(err);
                    return;
                }

                servers = _servers;
                next();
            });
        },
        function (next) {
            var serverList = servers.map(function (s) {
                return {
                    hostname: s.sysinfo['Hostname'],
                    uuid: s.uuid,
                    memory: s.sysinfo['MiB of Memory'],
                    profile: s.sysinfo.name
                };
            });
            var columns = [
                { lookup: 'hostname', name: 'HOSTNAME' },
                { lookup: 'uuid', name: 'UUID' },
                { lookup: 'memory', name: 'MEMORY', align: 'right' },
                { lookup: 'profile', name: 'PROFILE' }
            ];

            tabula(serverList, {
                columns: columns
            });

            next();
        }
    ], function (err) {
        cb(err);
    });
}

do_list.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];

do_list.help = (
    /* BEGIN JSSTYLED */
    'Create mock compute nodes.\n' +
    '\n' +
    'Usage:\n' +
    '    {{name}} list [<options>]' +
    '\n' +
    '{{options}}'
    /* END JSSTYLED */
);

do_list.helpOpts = {
    maxHelpCol: 18
};

module.exports = do_list;
