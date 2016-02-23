
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * The `mockcloudadm` CLI class.
 */

var assert = require('assert-plus');
var bunyan = require('bunyan');
var child_process = require('child_process'),
    spawn = child_process.spawn,
    exec = child_process.exec;
var cmdln = require('cmdln'),
    Cmdln = cmdln.Cmdln;
var util = require('util'),
    format = util.format;
var path = require('path');
var vasync = require('vasync');

var common = require('./common');
var errors = require('./errors');



// ---- globals

var pkg = require('../../package.json');


var OPTIONS = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Print this help and exit.'
    },
    {
        name: 'version',
        type: 'bool',
        help: 'Print version and exit.'
    },
    {
        names: ['verbose', 'v'],
        type: 'bool',
        help: 'Verbose/debug output.'
    }
];

function CLI() {
    Cmdln.call(this, {
        name: 'mockcloudadm',
        desc: pkg.description,
        options: OPTIONS,
        helpOpts: {
            includeEnv: true,
            minHelpCol: 30
        },
        helpSubcmds: [
            'help',
            'server'
        ],
        helpBody: [
            /* BEGIN JSSTYLED */
            'Exit Status:',
            '    0   Successful completion.',
            '    1   An error occurred.',
            '    2   Usage error.',
            '    3   "ResourceNotFound" error. Returned when an instance, image,',
            '        package, etc. with the given name or id is not found.'
            /* END JSSTYLED */
        ].join('\n')
    });
}
util.inherits(CLI, Cmdln);


CLI.prototype.init = function (opts, args, callback) {
    this.opts = opts;

    this.log = bunyan.createLogger({
        name: this.name,
        serializers: bunyan.stdSerializers,
        stream: process.stderr,
        level: 'warn'
    });
    if (opts.verbose) {
        this.log.level('trace');
        this.log.src = true;
        this.showErrStack = true;
    }

    if (opts.version) {
        console.log(this.name, pkg.version);
        callback(false);
        return;
    }

    // Cmdln class handles `opts.help`.
    Cmdln.prototype.init.apply(this, arguments);
};


CLI.prototype.fini = function fini(subcmd, err, cb) {
    this.log.trace({err: err, subcmd: subcmd}, 'cli fini');
    cb(err, subcmd);
};


// Sub commands
CLI.prototype.do_server = require('./do_server');


// ---- mainline

function main(argv) {
    if (!argv) {
        argv = process.argv;
    }

    var cli = new CLI();
    cli.main(argv, function (err, subcmd) {
        var exitStatus = (err ? err.exitStatus || 1 : 0);
        var showErr = (cli.showErr !== undefined ? cli.showErr : true);

        if (err && showErr) {
            var code = (err.body ? err.body.code : err.code) || err.restCode;
            if (code === 'NoCommand') {
                /* jsl:pass */
            } else if (err.message !== undefined) {
                /*
                 * If the err has `body.errors` then append a one-line summary
                 * for each error object.
                 */
                var bodyErrors = '';
                if (err.body && err.body.errors) {
                    err.body.errors.forEach(function (e) {
                        bodyErrors += format('\n    %s: %s', e.field, e.code);
                        if (e.message) {
                            bodyErrors += ': ' + e.message;
                        }
                    });
                }

                console.error('%s%s: error%s: %s%s',
                    cli.name,
                    (subcmd ? ' ' + subcmd : ''),
                    (code ? format(' (%s)', code) : ''),
                    (cli.showErrStack ? err.stack : err.message),
                    bodyErrors);

                // If this is a usage error, attempt to show some usage info.
                if (['Usage', 'Option'].indexOf(code) !== -1 && subcmd) {
                    var help = cli.helpFromSubcmd(subcmd);
                    if (help && typeof (help) === 'string') {
                        var usageIdx = help.indexOf('\nUsage:');
                        if (usageIdx !== -1) {
                            help = help.slice(usageIdx);
                        }
                        console.error(help);
                    }
                }
            }
        }

        /*
         * We'd like to NOT use `process.exit` because that doesn't always
         * allow std handles to flush (e.g. all logging to complete). However
         * I don't know of another way to exit non-zero.
         */
        if (exitStatus !== 0) {
            process.exit(exitStatus);
        }
    });
}


// ---- exports

module.exports = {
    CLI: CLI,
    main: main
};
