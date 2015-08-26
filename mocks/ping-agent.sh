#!/bin/bash

#
# Unfortunately the cnapi server-setup job currently has a pingProvisioner task
# which gets run after the agents are setup. This runs:
#
# /opt/smartdc/agents/bin/ping-agent
#
# Through ur on the just-setup CN in order to ensure that it can talk to itself
# via AMQP. Yes this is ridiculous. However, we are working around it for now to
# avoid changing it and breaking something that depends on that behavior.
#
# The workaround is this script which pretends to be ping-agent and pretends to
# succeed.
#

exit 0
