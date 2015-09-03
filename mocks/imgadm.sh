#!/bin/sh

echo "${MOCKCN_SERVER_UUID}=$*" >> /var/log/unsupported-mock-imgadm.log

echo "Unhandled imgadm command: $*" >&2
exit 1
