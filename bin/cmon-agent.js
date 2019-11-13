/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * A dummy version of cmon-agent.
 *
 * All it does for now is respond to any /metrics request with some basic time
 * metrics that match what we see for a real VM. Or 404 if the VM does not exist
 * in this mockcloud instance.
 *
 */

var child_process = require('child_process');
var path = require('path');

var assert = require('assert-plus');
var bunyan = require('bunyan');
var bunyanSerializers = require('sdc-bunyan-serializers');
var netconfig = require('triton-netconfig');
var restify = require('restify');

var logLevel = process.env.LOG_LEVEL || 'debug';
var logger = bunyan.createLogger({
    name: 'dummy-cmon-agent',
    level: logLevel,
    serializers: bunyanSerializers
});

// GLOBAL
var vminfodClient;

function refreshZoneCache(req, res, next) {
    /*
     * We don't actually have a zone cache any more. This does nothing and can
     * be removed once we've determined it no longer needs to be in the API for
     * compatibility reasons.
     */
    res.send(200);
    next();
}

function getMetrics(req, res, next) {
    res.header('content-type', 'text/plain');
    getVmMetrics(req.params.container, function _sendMetrics(err, strMetrics) {
        var strNotFound = 'container not found';

        if (err) {
            if (err.code === 'ENOTFOUND') {
                logger.warn({container: req.params.container}, strNotFound);
                next(new restify.NotFoundError(strNotFound));
            } else {
                logger.error(err);
                next(new restify.InternalServerError());
            }
            return;
        }

        // ensure we got a string if we didn't have an error
        assert.string(strMetrics, 'strMetrics');

        res.send(strMetrics);
        next();
    });
}

function getVmMetrics(vmUuid, callback) {
    var delta;
    var elapsed;
    var metrics;
    var now = Math.floor(new Date().getTime() / 1000);
    var startTime = process.hrtime();

    getVm(vmUuid, function _gotVm(err, _vmobj) {
        if (err) {
            // This will have err.code === ENOTFOUND if the VM wasn't found
            callback(err);
            return;
        }

        // If we didn't get an error, the VM exists.
        delta = process.hrtime(startTime);
        elapsed = delta[0] + delta[1] / 1e9;

        metrics = [
            '# HELP time_metrics_available_boolean Whether time metrics were available, 0 = false, 1 = true',
            '# TYPE time_metrics_available_boolean gauge',
            'time_metrics_available_boolean 1',
            '# HELP time_metrics_cached_boolean Whether time metrics came from cache, 0 = false, 1 = true',
            '# TYPE time_metrics_cached_boolean gauge',
            'time_metrics_cached_boolean 0',
            '# HELP time_metrics_timer_seconds How long it took to gather the time metrics',
            '# TYPE time_metrics_timer_seconds gauge',
            'time_metrics_timer_seconds ' + elapsed,
            '# HELP time_of_day System time in seconds since epoch',
            '# TYPE time_of_day counter',
            'time_of_day ' + now,
            '' // so we end with a newline
        ].join('\n');

        callback(null, metrics);
    });
}

function getVm(vmUuid, callback) {
    assert.uuid(vmUuid, 'vmUuid');

    var getErr;
    var url = path.join('/servers/*/vms', vmUuid);

    vminfodClient.get(
        {
            agent: false,
            path: url
        },
        function _onGet(err, req, res, obj) {
            if (!err) {
                callback(null, obj);
            } else if (err.restCode === 'ResourceNotFound') {
                getErr = new Error('VM ' + vmUuid + ' not found in vminfod');
                getErr.code = 'ENOTFOUND';
                callback(getErr);
            } else {
                callback(err);
            }
        }
    );
}

function mdataGet(key, callback) {
    assert.string(key, 'key');
    assert.func(callback, 'callback');

    child_process.execFile('/usr/sbin/mdata-get', [key], function _onMdata(
        err,
        stdout,
        _stderr
    ) {
        assert.ifError(err, 'mdata-get should always work');

        callback(null, stdout.trim());
    });
}

function findZoneAdminIp(callback) {
    mdataGet('sdc:nics', function _onMdata(err, nicsData) {
        var adminIp;
        var nics;

        try {
            nics = JSON.parse(nicsData.toString());
        } catch (e) {
            callback(e);
            return;
        }

        if (!err) {
            adminIp = netconfig.adminIpFromNicsArray(nics);

            if (!adminIp) {
                callback(new Error('admin IP not found'));
                return;
            }
        }

        callback(err, adminIp);
    });
}

function main() {
    var config = {};
    var server;

    config.log = logger;

    vminfodClient = restify.createJsonClient({
        url: 'http://127.0.0.1:9090'
    });

    server = restify.createServer(config);

    server.get(
        {
            name: 'GetMetrics',
            path: '/v1/:container/metrics'
        },
        getMetrics
    );

    server.post(
        {
            name: 'InvalidateZoneCache',
            path: '/v1/refresh'
        },
        refreshZoneCache
    );

    findZoneAdminIp(function _gotAdminIp(adminIpErr, adminIp) {
        if (adminIpErr) {
            logger.error({err: adminIpErr}, 'Unable to determine admin IP');
            return;
        }

        server.listen(9163, adminIp, function(listenErr) {
            logger.info({err: listenErr}, 'Startup sequence complete');
        });
    });
}

// kick off the party
main();
