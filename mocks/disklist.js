#!/usr/node/bin/node

var fs = require('fs');
var mode;
var sysinfo_file;

if (!process.env['MOCKCN_SERVER_UUID']) {
    console.error('Missing MOCKCN_SERVER_UUID');
    process.exit(1);
}

if (process.argv.length > 3) {
    mode = 'fail';
} else {
    switch (process.argv[2]) {
        case '-a':
            mode = 'a';
            break;
        case '-n':
            mode = 'n';
            break;
        case '-r':
            mode = 'r';
            break;
        case '-s':
            mode = 's';
            break;
        default:
            mode = 'fail';
            break;
    }
}

if (mode === 'fail') {
    console.error('disklist: Usage: ' + process.argv[1] + ': [-anr]');
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
    disks.forEach (function _outputDisk(disk) {
        switch (mode) {
            case 'a':
                process.stdout.write(' ' + disk.name);
                if (disks.indexOf(disk) === (disks.length - 1)) {
                    // last disk gets newline
                    process.stdout.write('\n');
                }
								break;
            case 'r':
                if (disks.indexOf(disk) === (disks.length - 1)) {
                    // last disk gets newline
                    process.stdout.write('\n');
                }
								break;
            case 'n':
                process.stdout.write(disk.name + ' ');
                if (disks.indexOf(disk) === (disks.length - 1)) {
                    // last disk gets newline
                    process.stdout.write('\n');
                }
								break;
            case 's':
                console.log(disk.name + '=' + disk.size);
								break;
        }
    });
});
