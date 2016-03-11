/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2015 Joyent, Inc.
 *
 * `mockcloudadm server create ...`
 */

var assert = require('assert-plus');
var vasync = require('vasync');

var common = require('../common');
var errors = require('../errors');

function do_create(subcmd, opts, args, cb) {
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length !== 1) {
        cb(new errors.UsageError('incorrect number of args'));
        return;
    }

    var profile = args[0];
    var count = opts.count;

    var MOCKCLOUD;
    vasync.waterfall([
        function (next) {
            common.createMockCloudClient(function (err, client) {
                MOCKCLOUD = client;
                next();
            });
        },
        function (next) {
            common.getProfiles(function (err, profiles) {
                if (err) {
                    next(err);
                    return;
                }

                var foundProfiles = profiles.filter(function (p) {
                    return p.name === args[0];
                });
                profile = foundProfiles[0];

                if (!profile) {
                    next(new errors.ProfileNotFoundError(
                        'unknown profile ' + args[0]));
                    return;
                }

                next();
            });
        },
        function (next) {
            var inputs = [];

            for (var i = 0; i < count; i++) {
                inputs.push(i);
            }

            vasync.forEachPipeline({
                inputs: inputs,
                func: function (item, feNext) {
                    MOCKCLOUD.post('/servers', profile, onPost);
                    function onPost(err, req, res, info) {
                        if (err) {
                            feNext(err);
                            return;
                        }
                        feNext();
                    }
                }
            }, function (err, results) {
                next(err);
            });
        }
    ], function (err) {
        cb(err);
    });
}

do_create.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['profile', 'p'],
        helpArg: 'PROFILE',
        type: 'string',
        help: 'Name of canned server profile to use.'
    },
    {
        names: ['count', 'c'],
        helpArg: 'COUNT',
        type: 'positiveInteger',
        help: 'Number of compute nodes to create.',
        default: 1
    }
];

do_create.help = (
    /* BEGIN JSSTYLED */
    'Create mock compute nodes.\n' +
    '\n' +
    'Usage:\n' +
    '    {{name}} create [<options>]' +
    '\n' +
    '{{options}}'
    /* END JSSTYLED */
);

do_create.helpOpts = {
    maxHelpCol: 18
};

module.exports = do_create;
