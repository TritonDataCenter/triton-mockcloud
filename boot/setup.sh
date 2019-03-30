#!/usr/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# Copyright (c) 2019, Joyent, Inc.
#

export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
set -o errexit
set -o pipefail
set -o xtrace

# Include common utility functions (then run the boilerplate)
source /opt/smartdc/boot/lib/util.sh

# Hack around the fact that download_metadata is not optional and mockcloud
# doesn't need a SAPI service
function download_metadata
{
    return 0
}

sdc_common_setup

# Actual mockcloud zone setup is handled by the 'mockcloud-setup'
# service. Ensure that is imported.
if ! svcs -Ho fmri mockcloud-setup >/dev/null 2>&1; then
    svccfg import /opt/triton/mockcloud/smf/manifests/mockcloud-setup.xml
fi

exit 0
