#!/usr/node/bin/node

var assert = require('assert');
var async = require('/usr/node/node_modules/async');
var cp = require('child_process');
var execFile = cp.execFile;
var fs = require('fs');
var sprintf = require('/usr/node/node_modules/sprintf').sprintf;

var default_sysinfo = {
    "System Type": "SunOS",
    "SDC Version": "7.0",
    "Manufacturer": "Supermicro",
    "Product": "X9DRD-7LN4F",
    "SKU Number": "",
    "HW Version": "",
    "HW Family": "",
    "Serial Number": "0123456789",
    "VM Capable": true,
    "CPU Type": "Intel(R) Xeon(R) CPU E5-2670 0 @ 2.60GHz",
    "CPU Virtualization": "vmx",
    "CPU Physical Cores": 2,
    "CPU Total Cores": 32,
    "MiB of Memory": "131043",
    "Disks": {
        "c0t5000A7203007B1A9d0": {"Size in GB": 100},
        "c10t5000CCA0160D6E5Dd0": {"Size in GB": 600},
        "c11t5000CCA022019BEDd0": {"Size in GB": 600},
        "c12t5000CCA022008921d0": {"Size in GB": 600},
        "c13t5000CCA01610CA05d0": {"Size in GB": 600},
        "c1t5000CCA02203FAFDd0": {"Size in GB": 600},
        "c2t5000CCA016148695d0": {"Size in GB": 600},
        "c3t5000CCA022016BADd0": {"Size in GB": 600},
        "c4t5000CCA02201A4C5d0": {"Size in GB": 600},
        "c5t5000CCA0220199C1d0": {"Size in GB": 600},
        "c6t5000CCA02200C8C1d0": {"Size in GB": 600},
        "c7t5000CCA02203CA49d0": {"Size in GB": 600},
        "c8t5000CCA016148709d0": {"Size in GB": 600},
        "c9t5000CCA0160EB825d0": {"Size in GB": 600}
    },
    "Boot Parameters": {
        "console": "text",
        "text_mode": "115200,8,n,1,-"
    },
    "Network Interfaces": {
    },
    "Virtual Network Interfaces": {
    },
    "Link Aggregations": {
    }
};

var filename;
var loaded_sysinfo = {};
var final_sysinfo = {};
var added_admin = false;
var nic_types = {'ixgbe': 0, 'igb': 0, 'bnx': 0};

function addNic(sysinfo, callback)
{
    var mac = '06';
    var nic = {};
    var type_idx;
    var type;

    [1, 2, 3, 4, 5].forEach(function (octet) {
        var number = Math.floor(Math.random() * 64);
        mac = mac + ':' + sprintf('%02x', number);
    });

    nic['MAC Address'] = mac;

    if (!added_admin) {
        nic['NIC Names'] = ['admin'];
        nic['Link Status'] = 'up';

        if (!sysinfo['Boot Parameters'].hasOwnProperty('admin_nic')) {
            sysinfo['Boot Parameters']['admin_nic'] = mac;
        }

        added_admin = true;
    } else {
        nic['NIC Names'] = [];
        if (Math.random() < 0.5) {
            nic['Link Status'] = 'down';
        } else {
            nic['Link Status'] = 'up';
        }
    }

    type_idx = Math.floor(Math.random() * Object.keys(nic_types).length);
    type = Object.keys(nic_types)[type_idx];

    sysinfo['Network Interfaces'][type + nic_types[type]] = nic;
    nic_types[type] += 1;

    callback();
}

async.series([
    function (cb) {
        if (process.env['MOCKCN_SERVER_UUID']) {
            filename = '/mockcn/' + process.env['MOCKCN_SERVER_UUID']
                + '/sysinfo.json';
            console.log('USING FILE:' + filename);
            cb();
            return;
        }

        if (process.argv.length !== 3) {
            cb(new Error('Usage: ' + process.argv[1] + ' <filename>'));
            return;
        }

        filename = process.argv[2];
        cb();
    },
    function (cb) {
        fs.readFile(filename, function (err, data) {
            if (err) {
                cb(err);
                return;
            }
            try {
                loaded_sysinfo = JSON.parse(data.toString());
            } catch (e) {
                loaded_sysinfo = {};
            }

            cb();
        });
    }, function (cb) {
        // apply defaults
        final_sysinfo = default_sysinfo;

        Object.keys(loaded_sysinfo).forEach(function (k) {
            final_sysinfo[k] = loaded_sysinfo[k];
        });

        cb();
    }, function (cb) {
        if (final_sysinfo.hasOwnProperty('Live Image')) {
            cb();
            return;
        }

        execFile('/usr/bin/uname', ['-v'], function (err, stdout, stderr) {
            if (err) {
                cb(err);
                return;
            }
            final_sysinfo['Live Image'] = stdout.replace('\n', '').split('_')[1];
            cb();
        });
    }, function (cb) {
        if (!final_sysinfo.hasOwnProperty('Hostname')) {
            final_sysinfo['Hostname'] = 'MOCKCN'
                + Math.floor(Math.random() * 200);
        }
        cb();
    }, function (cb) {
        if (!final_sysinfo.hasOwnProperty('Boot Time')) {
						// sysinfo has 'Boot Time' as a string
            final_sysinfo['Boot Time']
                = Math.floor(new Date().getTime() / 1000).toString();
        }
        cb();
    }, function (cb) {
        if (!final_sysinfo.hasOwnProperty('Datacenter Name')) {
            cb();
            return;
        }
        execFile('/usr/sbin/mdata-get', ['sdc:datacenter_name'],
            function (error, stdout, stderr) {

            if (error) {
                cb(error);
                return;
            }

            final_sysinfo['Datacenter Name'] = stdout.replace('\n', '');
            cb();
        });
        // TODO set rabbitmq in Boot Params
  }, function (cb) {
        var add_nics;

        /*
         * If sysinfo has no network interfaces, we'll generate some
         * new ones. If it already has some we'll assume they knew they
         * need one to have 'admin'.
         *
         */
        if (!final_sysinfo.hasOwnProperty('Network Interfaces')) {
            final_sysinfo['Network Interfaces'] = [];
        }

        if (Object.keys(final_sysinfo['Network Interfaces']).length === 0) {
            add_nics = Math.floor(Math.random() * 6) + 2;

            async.whilst(
                function () { return add_nics > 0; },
                function (callback) {
                    addNic(final_sysinfo, function (err) {
                        if (!err) {
                            add_nics = add_nics - 1;
                        }
                        callback(err);
                    });
                },
                function (err) {
                    cb(err);
                }
            );
        } else {
            cb();
        }
    }, function (cb) {
        // verify we've got required data
        assert(final_sysinfo.hasOwnProperty('UUID'));
        cb();
    }
], function (err) {
    if (err) {
        console.error(err.message);
        process.exit(1);
    }
    console.log(JSON.stringify(final_sysinfo, null, 2));
});
