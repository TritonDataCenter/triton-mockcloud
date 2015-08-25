#!/bin/bash

set -o xtrace
set -o errexit

# uninstall agents we're not going to mock out yet
for agent in amon-agent amon-zoneevents amon-relay cabase cainstsvc \
    firewaller hagfish-watcher marlin smartlogin zonetracker provisioner \
    heartbeater; do

    /opt/smartdc/agents/bin/apm uninstall ${agent}
done

cp /opt/smartdc/mockcloud/bin/amqp-config \
    /opt/smartdc/agents/bin/amqp-config

