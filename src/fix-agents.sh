#!/bin/bash

set -o xtrace
set -o errexit

# uninstall agents we're not going to mock out yet
for agent in amon-agent amon-zoneevents amon-relay cabase cainstsvc \
    firewaller hagfish-watcher marlin smartlogin zonetracker; do

    /opt/smartdc/agents/bin/apm uninstall ${agent}
done

cp /opt/smartdc/mockcn/bin/amqp-config \
    /opt/smartdc/agents/bin/amqp-config

for fmri in svc:/smartdc/agent/provisioner:default \
    svc:/smartdc/agent/heartbeater:default; do

    cp /opt/smartdc/mockcn/bin/heartbeater.js \
        /opt/smartdc/agents/lib/node_modules/heartbeater/bin/heartbeater.js
    cp /opt/smartdc/mockcn/provisioner-tasks/* \
        /opt/smartdc/agents/lib/node_modules/provisioner/lib/tasks/
    svccfg -s ${fmri} setenv MOCKCN_SERVER_UUID ${MOCKCN_SERVER_UUID}
    svccfg -s ${fmri} refresh
    svcadm clear ${fmri} || /bin/true
    svcadm restart ${fmri}
done
