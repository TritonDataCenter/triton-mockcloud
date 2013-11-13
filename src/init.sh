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

# replace disklayout with our version
mount -F lofs /opt/smartdc/mockcn/bin/disklayout /usr/bin/disklayout

# start ur agent which makes CN show up
svccfg import /opt/smartdc/mockcn/smf/ur.xml

exit 0
