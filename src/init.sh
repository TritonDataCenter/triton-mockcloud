#!/bin/bash

set -o errexit
set -o xtrace

/opt/smartdc/mockcn/bin/update-sysinfo

# replace sysinfo with our version
mount -F lofs /opt/smartdc/mockcn/bin/sysinfo /usr/bin/sysinfo

# create disks.json from sysinfo, used by disklayout when doing setup
(
    for uuid in $(ls -1 /mockcn); do
        MOCKCN_SERVER_UUID=${uuid} /opt/smartdc/mockcn/bin/diskjson \
            > /mockcn/${uuid}/disks.json
    done
)

# make config.sh read config from correct place
mkdir -p /opt/smartdc/mockcn/tmp
cp /lib/sdc/config.sh /opt/smartdc/mockcn/tmp/config.sh
/opt/local/bin/patch /opt/smartdc/mockcn/tmp/config.sh <<"EOF"
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
mount -F lofs /opt/smartdc/mockcn/tmp/config.sh /lib/sdc/config.sh

# replace disklayout with our version
mount -F lofs /opt/smartdc/mockcn/bin/disklayout /usr/bin/disklayout

# start ur agent which makes CN show up
svccfg import /opt/smartdc/mockcn/smf/ur.xml

exit 0
