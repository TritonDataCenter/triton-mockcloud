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

function createDataset()
{
    DATASET=$1
    IMGAPI="imgapi.$(mdata-get sdc:datacenter_name).$(mdata-get sdc:dns_domain)"

    if [[ ! -d /mockcn/${MOCKCN_SERVER_UUID}/images ]]; then
        mkdir -p /mockcn/${MOCKCN_SERVER_UUID}/images
    fi

    echo "creating ${DATASET}" >>${log}
    echo "{}" | json -e "this.manifest=$(curl -4 --connect-timeout 10 -sS -H accept:application/json http://${IMGAPI}/images/${DATASET} | json)" \
        > /mockcn/${MOCKCN_SERVER_UUID}/images/${DATASET}.json.new \
        && mv /mockcn/${MOCKCN_SERVER_UUID}/images/${DATASET}.json.new /mockcn/${MOCKCN_SERVER_UUID}/images/${DATASET}.json
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
elif [[ "$*" == "zfs get -Hp -o value used" ]]; then
    used=$(json usage < /mockcn/${MOCKCN_SERVER_UUID}/pool.json)
    echo "zones	used	${used}"
elif [[ "$*" == "zfs get -Hp -o value available" ]]; then
    total=$(json capacity < /mockcn/${MOCKCN_SERVER_UUID}/pool.json)
    used=$(json usage < /mockcn/${MOCKCN_SERVER_UUID}/pool.json)
    avail=$((${total} - ${used}))
    echo "zones available ${avail}"
#
# During a provision we first check image_ensure_present to ensure the image exists, if not
# We'll pull it with imgadm. Then in machine_create we do the same check. Then we also check
# in imgadm.js to see whether there's a -partial in which case we'll download.
# then we check for -t filesystem of the new zone's uuid to prevent provisioning a
# duplicate uuid.
#
elif [[ "$*" =~ "list -H -o name,used,avail,refer,type,mountpoint -t all zones/" && ${caller} =~ "tasks/image_ensure_present" ]]; then
    dataset=${@: -1}
    dataset_uuid=$(echo ${dataset} | cut -d'/' -f2-)
    printf "${dataset}\t193M\t37.5G\t193M\tfilesystem\t/${dataset}\n"
    ## Also add it here to the CN's list if it
    if [[ ! -f /mockcn/${MOCKCN_SERVER_UUID}/images/${dataset_uuid}.json ]]; then
        createDataset ${dataset_uuid}
    fi
elif [[ "$*" =~ "list -H -o name,used,avail,refer,type,mountpoint -t all zones/" && ${caller} =~ "tasks/machine_create" ]]; then
    dataset=${@: -1}
    dataset_uuid=$(echo ${dataset} | cut -d'/' -f2-)
    if [[ ! -f /mockcn/${MOCKCN_SERVER_UUID}/images/${dataset_uuid}.json ]]; then
        echo "1: saying ${dataset} - ${dataset_uuid} doesn't exist" >> ${log}
        echo "cannot open '${dataset}': dataset does not exist" >&2
        exit 1
    else
        echo "2: saying ${dataset} - ${dataset_uuid} does exist" >> ${log}
        printf "${dataset}\t193M\t37.5G\t193M\tfilesystem\t/${dataset}\n"
    fi
elif [[ "$*" =~ "list -H -o name,used,avail,refer,type,mountpoint -t filesystem zones/" && ${caller} =~ "tasks/machine_create" ]]; then
    dataset=${@: -1}
    dataset_uuid=$(echo ${dataset} | cut -d'/' -f2-)
    if [[ ! -f /mockcn/${MOCKCN_SERVER_UUID}/images/${dataset_uuid}.json ]]; then
        echo "3: saying ${dataset} - ${dataset_uuid} doesn't exist" >> ${log}
        echo "cannot open '${dataset}': dataset does not exist" >&2
        exit 1
    elif [[ -n $(echo "${dataset}" | grep "partial$") ]]; then
        echo "4: saying ${dataset} - ${dataset_uuid} doesn't exist" >> ${log}
        echo "cannot open '${dataset}': dataset does not exist" >&2
        exit 1
    else
        echo "5: saying ${dataset} - ${dataset_uuid} does exist" >> ${log}
        printf "${dataset}\t193M\t37.5G\t193M\tfilesystem\t/${dataset}\n"
    fi
else
    unsupported
fi

exit 0
