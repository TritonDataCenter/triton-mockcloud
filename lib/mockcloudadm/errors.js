/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2015 Joyent, Inc.
 *
 * Error classes that mockcloudadm CLI may produce.
 */

var util = require('util'),
    format = util.format;
var assert = require('assert-plus');
var verror = require('verror'),
    VError = verror.VError,
    WError = verror.WError;



// ---- error classes

/**
 * Base error. Instances will always have a string `message` and
 * a string `code` (a CamelCase string).
 */
function _MockCloudBaseVError(opts) {
    assert.object(opts, 'opts');
    assert.string(opts.message, 'opts.message');
    assert.optionalString(opts.code, 'opts.code');
    assert.optionalObject(opts.cause, 'opts.cause');
    assert.optionalNumber(opts.statusCode, 'opts.statusCode');
    var self = this;

    /*
     * If the given cause has `body.errors` a la
     * https://github.com/joyent/eng/blob/master/docs/index.md#error-handling
     * then lets add text about those specifics to the error message.
     */
    var message = opts.message;
    if (opts.cause && opts.cause.body && opts.cause.body.errors) {
        opts.cause.body.errors.forEach(function (e) {
            message += format('\n    %s: %s', e.field, e.code);
            if (e.message) {
                message += ': ' + e.message;
            }
        });
    }

    var veArgs = [];
    if (opts.cause) veArgs.push(opts.cause);
    veArgs.push(message);
    VError.apply(this, veArgs);

    var extra = Object.keys(opts).filter(
        function (k) { return ['cause', 'message'].indexOf(k) === -1; });
    extra.forEach(function (k) {
        self[k] = opts[k];
    });
}
util.inherits(_MockCloudBaseVError, VError);

/**
 * CLI usage error
 */
function UsageError(cause, message) {
    if (message === undefined) {
        message = cause;
        cause = undefined;
    }
    assert.string(message);
    _MockCloudBaseVError.call(this, {
        cause: cause,
        message: message,
        code: 'Usage',
        exitStatus: 2
    });
}
util.inherits(UsageError, _MockCloudBaseVError);


/*
 * Base error class that doesn't include a 'cause' message in its message.
 * This is useful in cases where we are wrapping errors with
 * onces that should *replace* the error message.
 */
function _MockCloudBaseWError(opts) {
    assert.object(opts, 'opts');
    assert.string(opts.message, 'opts.message');
    assert.optionalString(opts.code, 'opts.code');
    assert.optionalObject(opts.cause, 'opts.cause');
    assert.optionalNumber(opts.statusCode, 'opts.statusCode');
    var self = this;

    var weArgs = [];
    if (opts.cause) weArgs.push(opts.cause);
    weArgs.push(opts.message);
    WError.apply(this, weArgs);

    var extra = Object.keys(opts).filter(
        function (k) { return ['cause', 'message'].indexOf(k) === -1; });
    extra.forEach(function (k) {
        self[k] = opts[k];
    });
}
util.inherits(_MockCloudBaseWError, WError);


function ProfileNotFoundError(cause, msg) {
    if (msg === undefined) {
        msg = cause;
        cause = undefined;
    }
    _MockCloudBaseWError.call(this, {
        cause: cause,
        message: msg,
        code: 'ProfileNotFound',
        exitStatus: 3
    });
}
util.inherits(ProfileNotFoundError, _MockCloudBaseWError);


// ---- exports

module.exports = {
    UsageError: UsageError,
    ProfileNotFoundError: ProfileNotFoundError
};
