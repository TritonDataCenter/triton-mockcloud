#!/usr/node/bin/node

var disklayout = require('/usr/node/node_modules/disklayout');
var fs = require('fs');
var disk_file;

if (!process.env['MOCKCN_SERVER_UUID']) {
    console.error('Missing MOCKCN_SERVER_UUID');
    process.exit(1);
}

disk_file = '/mockcn/' + process.env['MOCKCN_SERVER_UUID'] + '/disks.json';
fs.readFile(disk_file, 'utf8', function (err, data) {
    var disks;
    var layout;

    disks = JSON.parse(data);
    layout = disklayout.compute(disks);
    console.log(JSON.stringify(layout, null, 2));
});
