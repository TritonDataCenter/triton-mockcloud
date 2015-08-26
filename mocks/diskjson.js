#!/usr/node/bin/node

var fs = require('fs');
var sysinfo_file;

if (!process.env['MOCKCN_SERVER_UUID']) {
    console.error('Missing MOCKCN_SERVER_UUID');
    process.exit(1);
}

sysinfo_file = '/mockcn/' + process.env['MOCKCN_SERVER_UUID'] + '/sysinfo.json';
fs.readFile(sysinfo_file, 'utf8', function (err, data) {
    var disks = [];
    var sysinfo;

    sysinfo = JSON.parse(data);

    Object.keys(sysinfo['Disks']).forEach(function (d) {
        var size = sysinfo['Disks'][d]['Size in GB'];
        size = (size * 1000 * 1000 * 1000);
        disks.push({
            type: 'SCSI',
            name: d,
            vid: 'HITACHI',
            pid: 'HUC109060CSS600',
            size: size,
            removable: false,
            solid_state: false
        });
    });
    console.log(JSON.stringify(disks, null, 2));
});
