# SDC Mock Cloud

The purpose of Mock Cloud zone and service is to allow creation of very
lightweight simulated servers. These "mocked" servers permit one to execute
common datacenter actions as if they were real compute nodes. These mock
compute nodes may then be used to facilitate the testing of SDC components
without requiring an inordiate amount of real hardware. As much as is
reasonably possible, simulated servers will mimick the behaviour of real
compute nodes running SDC. In this way it is possible to create hundreds or
possibly thousands of mock compute nodes and virtual machines.

The mock cloud zone contains the `mock-agent` service is what ultimate weaves
the illusion to mimic the presence of compute nodes to the rest of the SDC
stack. These mocked servers may be created, destroyed and be used as
provisioning destinations.

Mock Cloud is still under heavy development so behaviours, interfaces and
produced results are subject to change.


# Installation

Copy `bin/create-mockcloud` to the headnode and execute it. This will download
and install the mockcloud zone on your headnode.

Alternatively, if your headnode has external access:

    curl -k https://raw.githubusercontent.com/joyent/sdc-mockcloud/master/bin/create-mockcloud | bash


# Usage

Within the mockcloud zone, run the following command to create a new server.

    curl -v -X POST -d"$(json 'PowerEdge C2100' < lib/canned_profiles.json)" \
        -H 'Content-Type: application/json' http://0.0.0.0/servers


The server can be removed from mockcloud via:

    curl -v -X DELETE http://0.0.0.0/servers/de305d54-75b4-431b-adb2-eb6b9e546014


Within the mockcloud zone, one may also use the `mockcloudadm` tool:

    cd /opt/smartdc/mockcloud


To list possible profiles for mockcloud compute node creation:

    /usr/node/bin/node ./bin/mockcloudadm server list-profiles


To create a compute node:

    /usr/node/bin/node ./bin/mockcloudadm server create "PowerEdge C2100"


To create multiple compute nodes, use the `--count` option:

    /usr/node/bin/node ./bin/mockcloudadm server create --count 5 "PowerEdge C2100"


That server may then be setup as one would any other server (now from the global zone):

    sdc-server setup de305d54-75b4-431b-adb2-eb6b9e546014


At this point it will be possible to use this server as a destination for
provisioning.


# Tests

The tests must be run from the global-zone. To run the tests against coal
(assuming a `coal` entry in your ssh config`):

    make test-coal


Otherwise, running it from the global zone directly:

    /zones/$(vmadm lookup -1 alias=mockcloud0)/root/opt/smartdc/mockcloud/test/runtests 
