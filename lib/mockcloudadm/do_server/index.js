/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2015 Joyent, Inc.
 *
 * `mockcloudadm server ...`
 */

var Cmdln = require('cmdln').Cmdln;
var util = require('util');
var tabula = require('tabula');
var common = require('../common');

// ---- CLI class
//
function ServerCLI(top) {
    this.top = top;
    Cmdln.call(this, {
        name: top.name + ' server',
        /* BEGIN JSSTYLED */
        desc: [
            'List, get, create and manage mockcloud servers.'
        ].join('\n'),
        /* END JSSTYLED */
        helpOpts: {
            minHelpCol: 24 /* line up with option help */
        },
        helpSubcmds: [
            'help',
            'create',
            'delete'

//             'list',
//             'get',
//             'delete'
        ]
    });
}
util.inherits(ServerCLI, Cmdln);

ServerCLI.prototype.init = function init(opts, args, cb) {
    this.log = this.top.log;
    Cmdln.prototype.init.apply(this, arguments);
};

ServerCLI.prototype.do_create = require('./do_create');
ServerCLI.prototype.do_delete = require('./do_delete');

ServerCLI.prototype.do_list_profiles =
function do_list_profiles(subcmd, opts, args, cb) {
    var columns = [
        { lookup: 'name', name: 'NAME' },
        { lookup: 'MiB of Memory', name: 'MEMORY', align: 'right' },
        { lookup: 'Manufacturer', name: 'MANUFACTURER' }
    ];

    common.getProfiles(function (err, profiles) {
        if (err) {
            cb(err);
            return;
        }

        tabula(profiles, {
            columns: columns
        });
    });

    cb();
};

ServerCLI.prototype.do_list_profiles.hidden = true;
ServerCLI.prototype.do_list_profiles.help = (
    /* BEGIN JSSTYLED */
    'List compute node profiles available for creation.\n' +
    '\n' +
    'Usage:\n' +
    '    {{name}} list-profiles' +
    '\n' +
    '{{options}}'
    /* END JSSTYLED */
);

module.exports = ServerCLI;
