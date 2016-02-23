/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Integration tests for mock-cloud.
 */

var Logger = require('bunyan');
var restify = require('restify');
var test = require('tape');
var fs = require('fs');
var util = require('util');
var vasync = require('vasync');

var h = require('./helpers');

var CLIENT;
var CNAPI;

test('setup', function (tt) {
    tt.plan(2);

    tt.test('mockcloud client init', function (t) {
        t.plan(1);
        h.createMockCloudClient(function (err, _client) {
            t.ifErr(err, 'mockcloud client init');
            CLIENT = _client;
            t.end();
        });
    });

    tt.test('cnapi client init', function (t) {
        t.plan(1);
        h.createCnapiClient(function (err, _client) {
            t.ifErr(err, 'cnapi client init');
            CNAPI = _client;
            t.end();
        });
    });

    tt.end();
});

test('create a server', function (tt) {
    tt.plan(5);

    var uuids;

    vasync.waterfall([
        // Get the current list of servers from CNAPI
        function (next) {
            CNAPI.get('/servers', function (err, req, res, _servers) {
                tt.ifErr(err, 'fetched cnapi servers');
                uuids = _servers.map(function (server) {
                    return server.uuid;
                });
                tt.comment(util.inspect(uuids, '  ', 2));
                next();
            });
        },
        function (next) {
            var profile;
            var profiles;

            try {
                profiles = JSON.parse(
                    fs.readFileSync(
                        __dirname + '/../lib/canned_profiles.json'));
                profile = profiles['PowerEdge C2100'];
            } catch (e) {
                tt.ifErr(e, 'parsed canned profile');
            }

            CLIENT.post('/servers', profile, function (err, res, req, body) {
                tt.ifErr(err, 'POST /server no errors');
                next();
            });
        },
        function (next) {
            setTimeout(next, 2000);
        },
        // Find new server in list which was not present previously
        function (next) {
            CNAPI.get('/servers', function (err, req, res, _servers) {
                tt.ifErr(err, 'fetched cnapi servers');

                var found = _servers.filter(function (server) {
                    return uuids.indexOf(server.uuid) === -1;
                });
                tt.equal(found.length, 1, 'found one new server');
                next();
            });
        }
    ],
    function (err) {
        tt.ifErr(err);
        tt.end();
    });
});
