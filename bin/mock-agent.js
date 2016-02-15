#!/usr/node/bin/node --abort_on_uncaught_exception

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */


var bunyan = require('bunyan');
var MockAgent = require('../lib/mock_agent');

main();

function main() {
    var log = bunyan.createLogger({name: 'mock-agent', level: 'debug'});

    var options = {
        log: log
    };

    var agent = new MockAgent(options);
    agent.start();
}
