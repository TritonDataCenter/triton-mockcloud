#!/bin/bash
#
# This script is a hack, but it's designed to be run in the GZ on the
# HN to add an "external" nic tag to the second NIC (dnet1) for all
# your mockcloud CNs that don't already have it. This is required if
# for example you want to run the VMAPI tests.
#
# It does almost no error checking.
#

servers=$(sdc-cnapi /servers | json -Ha uuid)
srv_count=$(wc -w <<<${servers} | tr -d ' ')

count=0
for server in $(cat <<<${servers}); do
    printf "Checking ${server} [$((count++))/${srv_count}]           \r"
    srv=$(sdc-cnapi /servers/${server} | json -H)
    systype=$(json sysinfo."System Type" <<<${srv})

    if [[ ${systype} == "Virtual" ]]; then
        dnet1=$(json sysinfo."Network Interfaces".dnet1 <<<${srv})
        mac=$(json "MAC Address" <<<${dnet1});
        external=$(json "NIC Names" <<<${dnet1} | grep "external")
        if [[ -z ${external} ]]; then
            echo ""
            echo "${server} is missing external, adding"
            result=$(sdc-cnapi /servers/${server}/nics \
                -X PUT -d"{\"action\": \"update\", \"nics\": [ { \"mac\": \"${mac}\", \"nic_tags_provided\": [ \"external\" ] } ] }" | json -H)

            job=$(json job_uuid <<<${result})
            if [[ -n ${job} ]]; then
                sdc-waitforjob ${job}
            else
                echo "failed to find job in response for ${server}"
            fi
        fi
    fi
done
