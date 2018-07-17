# triton-mockcloud

This repo provides tooling to create a "mockcloud" image. A VM using this
image provisioned on the "admin" network in a dev/test Triton Data Center
(TritonDC) can act as 1 or more mock servers. The goal is to provide
sufficient mocking to load test TritonDC for many CNs.

- Published images: `updates-imgadm -C '*' list name=mockcloud`.
  Note that images before 2018-07 are the old, obsolete mockcloud v1.


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

For now just quick notes. (TODO: create a mockcloud-create-instance tool
to run in a DC headnode GZ.)

```
# Install latest mockcloud image (experimental builds for now).
img=$(updates-imgadm -C experimental list name=mockcloud --latest -H -o uuid)
sdc-imgadm import -S https://updates.joyent.com?channel=experimental $img

# Create a mockcloud zone.
#
# Change `server` if you want to use a different server. E.g. for
server=$(sysinfo | json UUID)
mockcloudNumServers=5
ufdsAdminUuid=$(bash /lib/sdc/config.sh -json | json ufds_admin_uuid)
latestAliasN=$(sdc-vmapi "/vms?owner_uuid=$ufdsAdminUuid&alias=mockcloud" | json -Ha alias | cut -c10- | sort -n | tail -1 || echo "0")
alias=mockcloud$(( $latestAliasN + 1 ))
sdc-vmadm create <<EOP
{
    "alias": "$alias",
    "brand": "joyent-minimal",
    "owner_uuid": "$(bash /lib/sdc/config.sh -json | json ufds_admin_uuid)",
    "billing_id": "$(sdc-papi /packages?name=sample-4G | json -H 0.uuid)",
    "networks": [
        {"uuid": "$(sdc-napi /networks?name=admin | json -H 0.uuid)"}
    ],
    "server_uuid": "$server",
    "image_uuid": "$(sdc-imgadm list name=mockcloud --latest -H -o uuid)",
    "delegate_dataset": true,
    "customer_metadata": {
        "user-script": "/opt/smartdc/boot/setup.sh",
        "ufdsAdmin": "$(sdc-sapi /applications?name=sdc | json -H 0.metadata.ufds_admin_uuid)",
        "dnsDomain": "$(sdc-sapi /applications?name=sdc | json -H 0.metadata.dns_domain)",
        "mockcloudNumServers": $mockcloudNumServers
    }
}
EOP
```

