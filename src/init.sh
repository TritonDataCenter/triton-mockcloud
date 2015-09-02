#!/bin/bash

set -o errexit
set -o xtrace

# replace sysinfo with our version
umount -f /usr/bin/sysinfo || /bin/true
mount -F lofs /opt/smartdc/mockcloud/mocks/sysinfo.js /usr/bin/sysinfo

# create disks.json from sysinfo, used by disklayout when doing setup
#(
    #for uuid in $(ls -1 /mockcn); do
        #MOCKCN_SERVER_UUID=${uuid} /opt/smartdc/mockcloud/bin/diskjson \
            #> /mockcn/${uuid}/disks.json
    #done
#)

# Create /opt/smartdc/agents/lib so Ur scripts don't think we're 6.5
mkdir -p /opt/smartdc/agents/lib

# make config.sh read config from correct place
mkdir -p /opt/smartdc/mockcloud/tmp
cp /lib/sdc/config.sh /opt/smartdc/mockcloud/tmp/config.sh

# pretend like agents install is going to work
mkdir -p /opt/smartdc/agents/bin
cp /opt/smartdc/mockcloud/mocks/ping-agent.sh /opt/smartdc/agents/bin/ping-agent

if [[ -z $(grep MOCKCN_SERVER_UUID /lib/sdc/config.sh) ]]; then
/opt/local/bin/patch /opt/smartdc/mockcloud/tmp/config.sh <<"EOF"
--- /lib/sdc/config.sh  2013-11-10 07:48:35.629886000 +0000
+++ config.sh   2013-11-13 21:41:04.651518490 +0000
@@ -26,6 +26,9 @@
 
     # the default
     COMPUTE_NODE_CONFIG_FILENAME="/opt/smartdc/config/node.config"
+    if [[ -n ${MOCKCN_SERVER_UUID} ]]; then
+        COMPUTE_NODE_CONFIG_FILENAME="/mockcn/${MOCKCN_SERVER_UUID}/config/node.config"
+    fi
 
     if [[ -z "${SDC_CONFIG_FILENAME}" ]]; then
         SDC_CONFIG_FILENAME="$(svcprop -p 'joyentfs/usb_copy_path' svc:/system/filesystem/smartdc:default)/config"
@@ -149,6 +152,11 @@
 
     update_cache=0
 
+    if [[ -n ${MOCKCN_SERVER_UUID} ]]; then
+        # don't want caching for mock CN
+        rm -f ${CACHE_FILE_JSON}
+    fi
+
     load_sdc_config_filename
     if [[ ! -f ${CACHE_FILE_JSON} ]]; then
         # no cache file, need update

EOF
mount -F lofs /opt/smartdc/mockcloud/tmp/config.sh /lib/sdc/config.sh
fi

# replace disklayout + disklist with our version
umount -f /usr/bin/disklayout || /bin/true
mount -F lofs /opt/smartdc/mockcloud/mocks/disklayout.js /usr/bin/disklayout
umount -f /usr/bin/disklist || /bin/true
mount -F lofs /opt/smartdc/mockcloud/mocks/disklist.js /usr/bin/disklist

# mock out vmadm required bits
umount -f /usr/bin/onlyif.sh || /bin/true
mount -F lofs /opt/smartdc/mockcloud/mocks/onlyif.js /usr/node/node_modules/onlyif.js
umount -f /usr/vm/node_modules/vmload/index.js
mount -F lofs /opt/smartdc/mockcloud/mocks/vmload.js /usr/vm/node_modules/vmload/index.js
umount -f /usr/vm/node_modules/VM.js
mount -F lofs /opt/smartdc/mockcloud/mocks/VM.js /usr/vm/node_modules/VM.js

# replace zoneevent
umount -f /usr/vm/sbin/zoneevent
mount -F lofs /opt/smartdc/mockcloud/mocks/zoneevent.js /usr/vm/sbin/zoneevent

# replace z* tools with our versions
umount -f /usr/sbin/zoneadm
mount -F lofs /opt/smartdc/mockcloud/mocks/zoneadm.sh /usr/sbin/zoneadm
umount -f /usr/sbin/zfs
mount -F lofs /opt/smartdc/mockcloud/mocks/zfs.sh /usr/sbin/zfs
umount -f /usr/sbin/zpool
mount -F lofs /opt/smartdc/mockcloud/mocks/zpool.sh /usr/sbin/zpool

if [[ -n $(svcs -a | grep mock-agent) ]]; then
    restart="true"
else
    restart="false"
fi

# start mock-agent
svccfg import /opt/smartdc/mockcloud/smf/mock-agent.xml

# restart in case we're re-running to update mounts, etc
if [[ ${restart} == "true" ]]; then
    svcadm restart mock-agent
fi

exit 0
