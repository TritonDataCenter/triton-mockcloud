#!/usr/bin/bash

set -o xtrace
set -o errexit

SYSINFO_FILE=/tmp/sysinfos.$$

mdata-get sysinfo > ${SYSINFO_FILE}
for uuid in $(json -a UUID < ${SYSINFO_FILE}); do
    mkdir -p /mockcn/${uuid}/vms
    json -a -c "this.UUID == '${uuid}'" < ${SYSINFO_FILE} \
        > /mockcn/${uuid}/sysinfo.json.in
    /opt/smartdc/mockcn/bin/sysinfo /mockcn/${uuid}/sysinfo.json.in \
        > /mockcn/${uuid}/sysinfo.json
    rm /mockcn/${uuid}/sysinfo.json.in
done

exit 0
