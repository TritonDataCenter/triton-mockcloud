/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Test helpers for mock-cloud tests.
 */

var restify = require('restify');

var MOCKCLOUD_URL = (process.env.MOCKCLOUD_URL);
var CNAPI_URL = (process.env.CNAPI_URL);

exports.createMockCloudClient = function (callback) {
    var client;
    client = restify.createJsonClient({
        agent: false,
        url: MOCKCLOUD_URL
    });
    callback(null, client);
};

exports.createCnapiClient = function (callback) {
    var client;
    client = restify.createJsonClient({
        agent: false,
        url: CNAPI_URL
    });
    callback(null, client);
};
