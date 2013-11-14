#!/usr/node/bin/node

var assert = require('assert');
var fs = require('fs');
var vms = {};
var VM_PATH;

assert(process.env['MOCKCN_SERVER_UUID']);
if (process.env['MOCKCN_SERVER_UUID']) {
    VM_PATH = '/mockcn/' + process.env['MOCKCN_SERVER_UUID'] + '/vms';
}

function onAdd(vm, mtime)
{
    console.log('VM ' + vm + ' added');
    watcher = fs.watch(VM_PATH + '/' + vm, function (evt, file) {
        fs.stat(VM_PATH + '/' + vm, function (err, stats) {
            if (err && err.code === 'ENOENT') {
                onDelete(vm, new Date());
            } else if (err) {
                console.error(err.message);
            } else {
                onModify(vm, stats.mtime);
            }
        });
    });
    vms[vm] = {
        mtime: mtime,
        watcher: watcher
    };
}

function onModify(vm, mtime)
{
    console.log('VM ' + vm + ' modified');
    vms[vm].mtime = mtime;
}

function onDelete(vm, mtime)
{
    console.log('VM ' + vm + ' deleted');
    if (vms[vm].hasOwnProperty('watcher')) {
        vms[vm].watcher.close();
    }
    delete vms[vm];
}

function loadVMs(path) {
    fs.readdir(path, function(err, files) {
        var found_this_round = {};

        if (err) {
            console.error(err.message);
            return;
        }

        files.forEach(function (file) {
            found_this_round[file] = true;
            fs.stat(path + '/' + file, function (err, stats) {
                var mtime;
                var watcher;

                if (err) {
                    console.error(err.message);
                    return;
                }
                mtime = stats.mtime.getTime();
                if (vms.hasOwnProperty(file)) {
                    if (vms[file].mtime < mtime) {
                        onModify(file, mtime);
                    } else {
                        //console.log('VM ' + file + ' unmodified');
                    }
                } else {
                    onAdd(file, mtime);
                }
            });
        });
        Object.keys(vms).forEach(function (vm) {
            if (!found_this_round[vm]) {
                onDelete(vm, new Date());
            }
        });
    });
}

loadVMs(VM_PATH);

fs.watch(VM_PATH, function (evt, file) {
    // when anything changes, we'll re-read the directory and add watchers for
    // the files that exist.
    loadVMs(VM_PATH);
});
