var fs = require('fs');

exports.getMemoryInfo = function (callback)
{
    var sysinfo_file;

    if (!process.env['MOCKCN_SERVER_UUID']) {
        console.error('Missing MOCKCN_SERVER_UUID');
        process.exit(1);
    }
    
    /*
     * XXX TODO:
     *
     * look at the VMs and generate a reasonable amount of usage.
     *
     */

     sysinfo_file = '/mockcn/' + process.env['MOCKCN_SERVER_UUID'] + '/sysinfo.json';
     fs.readFile(sysinfo_file, 'utf8', function (err, data) {
          var sysinfo;
          var total_bytes;

          if (err) {
						  callback(err);
						  return;
				  }

          sysinfo = JSON.parse(data);
				  total_bytes = sysinfo['MiB of Memory'] * 1024 * 1024;
				
          return callback(null, {
              'availrmem_bytes': total_bytes - Math.floor(Math.random() * 100000000),
              'arcsize_bytes': Math.floor(Math.random() * 100000000),
              'total_bytes': total_bytes
          });
    });
};
