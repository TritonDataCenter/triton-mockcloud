/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2015 Joyent, Inc.
 *
 * `mockcloudadm server delete ...`
 */

var assert = require('assert-plus');
var vasync = require('vasync');

var common = require('../common');
var errors = require('../errors');

function do_delete(subcmd, opts, args, cb) {
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length !== 1) {
        cb(new errors.UsageError('incorrect number of args'));
        return;
    }

    var uuid = args[0];

    var MOCKCLOUD;
    vasync.waterfall([
        function (next) {
            common.createMockCloudClient(function (err, client) {
                MOCKCLOUD = client;
                next();
            });
        },
        function (next) {
            MOCKCLOUD.del('/servers/' + uuid, onDelete);
            function onDelete(err, req, res, info) {
                next(err);
            }
        }
    ], function (err) {
        cb(err);
    });
}

do_delete.help = (
    /* BEGIN JSSTYLED */
    'Delete a mock compute node.\n' +
    '\n' +
    'Usage:\n' +
    '    {{name}} delete <uuid>'
    /* END JSSTYLED */
);

do_delete.helpOpts = {
    maxHelpCol: 18
};

module.exports = do_delete;
