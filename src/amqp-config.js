#!/usr/node/bin/node

var cp = require('child_process');
var execFile = cp.execFile;

execFile('/usr/sbin/mdata-get', ['rabbitmq'], function (err, stdout, stderr) {
    var rabbitmq;
    var rabbit_parts;

    if (err) {
        console.error(err.message);
        process.exit(2);
    }

    rabbitmq = stdout.replace('\n','');
    rabbit_parts = rabbitmq.split(':');

    console.log('amqp_login=' + rabbit_parts[0]);
    console.log('amqp_password=' + rabbit_parts[1]);
    console.log('amqp_host=' + rabbit_parts[2]);
    console.log('amqp_port=' + rabbit_parts[3]);

    process.exit(0);
});
