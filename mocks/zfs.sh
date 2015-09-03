#!/bin/bash

#set -o xtrace

log=/var/log/unsupported-mock-zfs.log
date=$(/opt/local/bin/date --rfc-3339=seconds | tr ' ' 'T')
caller=$(pargs -la ${PPID})

echo "${date},MOCKCN_SERVER_UUID=${MOCKCN_SERVER_UUID}" >> ${log}
echo "  \\_ caller is: ${caller}" >> ${log}

if [[ -z ${MOCKCN_SERVER_UUID} ]]; then
    echo "MISSING MOCKCN_SERVER_UUID"
    exit 2
fi
echo "zfs $*" >> ${log}

function unsupported()
{
    echo "UNSUPPORTED[$*]" >> ${log}
    exit 1
}

if [[ "$*" == "list -H -p -t filesystem -o mountpoint,name,quota,type,zoned" ]]; then
    # /zones/0b4bb0bb-2e40-4342-9bbc-d838eaf030f2 zones/0b4bb0bb-2e40-4342-9bbc-d838eaf030f2  26843545600 filesystem  off
    echo "/zones  zones 0 filesystem  off"
    idx=1
    for file in $(ls -1 /mockcn/${MOCKCN_SERVER_UUID}/vms); do
        zonename=$(basename ${file} .json)
        echo "outputing data for ${zonename}" >> ${log}
        idx=$((${idx} + 1));
    done
elif [[ "$*" == "get -Hp -o name,property,value name,used,avail,refer,type,mountpoint,quota,origin,volsize" ]]; then
    total=$(json capacity < /mockcn/${MOCKCN_SERVER_UUID}/pool.json)
    used=$(json usage < /mockcn/${MOCKCN_SERVER_UUID}/pool.json)
    avail=$((${total} - ${used}))
    referenced=$(($RANDOM * $RANDOM))
    echo "zones name  zones"
    echo "zones used  ${used}"
    echo "zones available ${avail}"
    echo "zones referenced  ${referenced}"
    echo "zones type  filesystem"
    echo "zones mountpoint  /zones"
    echo "zones quota 0"
    echo "zones origin  -"
    echo "zones volsize -"

    // XXX implement for zones
elif [[ "$*" == "get -Hp -o name,property,value used,available zones" ]]; then
    total=$(json capacity < /mockcn/${MOCKCN_SERVER_UUID}/pool.json)
    used=$(json usage < /mockcn/${MOCKCN_SERVER_UUID}/pool.json)
    avail=$((${total} - ${used}))
    echo "zones	used	${used}"
    echo "zones	available	${avail}"
elif [[ "$*" =~ "list -H -o name,used,avail,refer,type,mountpoint -t all zones/" && ${caller} =~ "tasks/image_ensure_present" ]]; then
    # For now, always succeed on ensure_image and return hardcoded values
    dataset=${@: -1}
    printf "${dataset}\t193M\t37.5G\t193M\tfilesystem\t/${dataset}\n"
else
    unsupported
fi

exit 0
