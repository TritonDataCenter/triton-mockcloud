#!/bin/bash

#set -o xtrace

log=/var/log/unsupported-mock-zoneadm.log

echo "MOCKCN_SERVER_UUID=${MOCKCN_SERVER_UUID}" >> ${log}
if [[ -z ${MOCKCN_SERVER_UUID} ]]; then
    echo "MISSING MOCKCN_SERVER_UUID"
    exit 2
fi
echo "zoneadm $*" >> ${log}

function unsupported()
{
    echo "UNSUPPORTED[$*]" >> ${log}
    exit 1
}

if [[ "$*" == "list -p -c" ]]; then
    # /usr/sbin/zoneadm list -p -c
    echo "outputing data for GZ" >> ${log}
    echo "0:global:running:/::liveimg:shared:0"
    idx=1
    for file in $(ls -1 /mockcn/${MOCKCN_SERVER_UUID}/vms); do
        brand=$(json brand < /mockcn/${MOCKCN_SERVER_UUID}/vms/${file})
        state=$(json zone_state < /mockcn/${MOCKCN_SERVER_UUID}/vms/${file})
        zonename=$(basename ${file} .json)
        echo "outputing data for ${zonename}" >> ${log}

        echo "${idx}:${zonename}:${state}:/zones/${zonename}:${zonename}:${brand}:excl:${idx}"
        idx=$((${idx} + 1));
    done
else
    unsupported
fi

exit 0
