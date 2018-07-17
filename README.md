# triton-mockcloud

This repo provides tooling to create a "mockcloud" image. A VM using this
image provisioned on the "admin" network in a dev/test Triton Data Center
(TritonDC) can act as 1 or more mock servers. The goal is to provide
sufficient mocking to load test TritonDC for many CNs.


## Overview

A "mockcloud" image includes the latest cn-agent and uses cn-agent's "dummy"
backend (added in TRITON-381) which supports running a single cn-agent
process that acts as one or more CNs (using data in
`/opt/custom/virtual/servers/$uuid`).

To plan is to add mock support for other GZ agents (config-agent, vm-agent,
etc.) to load test other TritonDC headnode services.


## Considerations / Limitations

- Each mocked CN requires an IP on the admin network. Therefore, to simulate
  a large number of CNs (e.g. 1000s) you'll need a large "admin" network
  range ("admin_network" and "admin_network" in the headnode config). The
  default/typical setup for COAL will be limited to approximately 200 CNs.

- The mocking doesn't have complete coverage. However things like VM
  provisioning *does* work: the VM provisioned is just a JSON file dumped into
  the server data dir under "/opt/customer/virtual/servers/...".


## How to create a mockcloud VM

To deploy a mockcloud VM requires:

- a joyent-minimal VM
- using a mockcloud image
  (List published images via: `updates-imgadm -C '*' list name=mockcloud`.
  Note that images before 2018-07 are the old, obsolete mockcloud v1.)
- with a nic on the "admin" network
- with the following `customer_metadata`:
    - "user-script" - "/opt/smartdc/boot/setup.sh" or the full typical
      Triton core zone user-script (https://github.com/joyent/sdcadm/blob/master/etc/setup/user-script)
      to trigger the [one-time mockcloud zone setup](https://github.com/joyent/triton-mockcloud/blob/TRITON-586/smf/method/mockcloud-setup)
    - "ufdsAdmin" - the "admin" login UUID
    - "dnsDomain" - "dns_domain" from TritonDC config
    - "mockcloudNumServers" - the integer number of servers to mock

There is [a "mockcloud-deploy"
script](https://github.com/joyent/triton-mockcloud/blob/TRITON-586/tools/mockcloud-deploy)
to help deploy these. Usage:

    # prompts for parameters:
    bash -c "$(curl -ksSL https://raw.githubusercontent.com/joyent/triton-mockcloud/TRITON-586/tools/mockcloud-deploy)"

    # or:
    curl -ksSL -O https://raw.githubusercontent.com/joyent/triton-mockcloud/TRITON-586/tools/mockcloud-deploy
    chmod +x ./mockcloud-deploy
    ./mockcloud-deploy [-y] [-i IMAGE] DEPLOY-SERVER NUM-MOCK-SERVERS
