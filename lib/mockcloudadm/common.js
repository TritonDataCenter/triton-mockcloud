/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2015 Joyent, Inc.
 */

var restify = require('restify');
var MOCKCLOUD_URL = (process.env.MOCKCLOUD_URL);

function createMockCloudClient(callback) {
    var client;
    client = restify.createJsonClient({
        agent: false,
        url: MOCKCLOUD_URL
    });
    callback(null, client);
}


function getProfiles(callback) {
    var profilesJson;

    try {
        profilesJson = require('../canned_profiles.json');
    } catch (e) {
        callback(e);
        return;
    }

    var profiles = Object.keys(profilesJson).map(function (pk) {
        var profile = profilesJson[pk];
        profile.name = pk;
        return profile;
    });

    callback(null, profiles);
}

module.exports = {
    createMockCloudClient: createMockCloudClient,
    getProfiles: getProfiles
};
