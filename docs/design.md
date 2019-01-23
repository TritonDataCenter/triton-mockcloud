# mockcloud design

## Goals

The purpose of this project is to make it possible to create "mock" CNs that are
as indistinguishable as possible from "real" CNs as far as Triton API consumers
are concerned. This means that:

 * These CNs should be able to accept cn-agent tasks from CNAPI and perform
   basic actions such as:
    * create/start/stop/reboot/delete VMs
    * update VMs (metadata, tags, properties, etc)
    * reprovision VMs to a new image
    * install agents
    * create/delete/rollback snapshots
 * It should be possible to create and delete CNs to scale up or down for test
   purposes.
 * Mock CNs should show up as regular CNs in things like:
    * `GET /servers` at CNAPI
    * `sdc-server list`
 * These CNs must have similar networking configuration to real CNs
    * Like all Triton CNs, they should have an "admin" NIC with an IP from the
      admin network/pool. This nic should be allocated by NAPI and consumers
      of the APIs should see the same mapping between NAPI and CN objects that
      they'd see with a real CN.
    * Like all Triton CNs, it should be possible to add and remove NIC tags.
 * Use as much code as possible from the "real agents". I.e. for cn-agent we use
   the same heartbeat code, and try to just mock out the bits that talk to
   SmartOS interfaces (via the dummy backend).

### Motivating factors include:

 * Engineers often need to test behavior of APIs (potentially with proposed
   changes) with many more VMs and CNs than available test hardware allows.
 * Even with VMs, the memory overhead of node.js is such that if we have separate
   node.js processes for each agent and each CN, most Engineers will only be able
   to run a small number of CNs.
 * Helping to identify the actual API between Triton and a CN, so that we can do
   work to make this interface more clearly defined over time. In order for
   mockcloud to work, the APIs must talk to the "CN interface" rather than
   being sneaky and using things like Ur. Things that don't work with mockcloud
   likely need some redesign.

### Important non-goals:

 * There is no intention of supporting Ur agent. In fact, making the whole
   system work without Ur should help toward the long-standing (HEAD-1946) goal
   of purging rabbitmq and Ur from the system.
 * It does not make sense to run `sdc-oneachnode` commands against mockcloud
   CNs.
 * There will be no logging in to mockcloud VMs and no scripts will be run in
   them.


## How it works

We have 4 types of communication between Triton's API layer and components
running on individual CNs:

 1. API -> agent connections
    * cmon -> cmon-agent
    * cnapi -> cn-agent
 2. agent -> API connections
    * config-agent -> sapi
    * firewaller -> fwapi
    * net-agent -> napi
    * vm-agent -> vmapi
 3. Ur agent
    * Ur connects to rabbitmq and waits for commands
    * clients send commands into rabbitmq and hope something gets through to
      some set of CNs
    * clients send some sort of response into rabbitmq and hope someone gets it.
 4. hermes
    * The hermes-actor gets deployed via hermes (from the sdc0 zone) to all CNs
      via Ur.
    * hermes-actor then talks to Manta using the hermes-proxy (in the sdc0 zone)

We're currently ignoring #3 for reasons discussed in the previous section (this
is going away), and #4 because while hermes is a service running in Triton, it's
very different from everything else and not directly used by any of the other
APIs. This leaves us with 6 agents to support, and at this point we actually
don't (yet) support firewaller or config-agent.

### cn-agent

Since cn-agent is the most obvious CN-related agent and the one with the most
impact as far as being able to manage CNs and VMs, it is also the most important
in terms of mockcloud. It's actually possible to have a mostly-functional mock
CN with just a mock cn-agent running.

To make cn-agent work in "mockcloud" mode, the concept of "backends" was added.
This was the biggest part of the work to cn-agent since it required identifying
all the pieces that talked to the system and hiding them behind an interface.
The default backend for cn-agent is the "smartos" backend, this contains all the
logic for interfacing with the SmartOS platform. It talks to imgadm, vmadm, zfs,
zoneadm, etc. and exports functionality through CNAPI using tasks in the
[lib/backends/smartos/tasks](https://github.com/joyent/sdc-cn-agent/tree/master/lib/backends/smartos/tasks)
directory.

The dummy backend uses a set of files to manage all state. There is a tool
[lib/backends/dummy/tools/create-server.js]() that can create a server (it also
talks to NAPI to create the required NIC objects). The result will be a
directory structure that looks like:

 * `SERVER_ROOT/`
 * `SERVER_ROOT/servers/`
 * `SERVER_ROOT/servers/<server_uuid>/`
 * `SERVER_ROOT/servers/<server_uuid>/sysinfo.json`
 * `SERVER_ROOT/servers/<server_uuid>/agents/`
 * `SERVER_ROOT/servers/<server_uuid>/agents/<agent>/`
 * `SERVER_ROOT/servers/<server_uuid>/agents/<agent>/image_uuid`
 * `SERVER_ROOT/servers/<server_uuid>/agents/<agent>/package.json`
 * `SERVER_ROOT/servers/<server_uuid>/agents/<agent>/instance_uuid`

with the agents having been installed from the agentsshar. Later on when
cn-agent is running you'll also see:

 * `SERVER_ROOT/servers/<server_uuid>/logs/`
 * `SERVER_ROOT/servers/<server_uuid>/logs/cn-agent/`
 * `SERVER_ROOT/servers/<server_uuid>/logs/cn-agent/<timestamp>-<task>.log`

with some servers created, the [tasks exposed for these CNs](https://github.com/joyent/sdc-cn-agent/tree/master/lib/backends/dummy/tasks)
to implement various functions can be called by CNAPI. The backend handles
loading sysinfo and other data from the server's directory. When VMs are
created through VMAPI, these will be placed in:

 * `SERVER_ROOT/servers/<server_uuid>/vms/`
 * `SERVER_ROOT/servers/<server_uuid>/vms/<vm_uuid>.json`

with the `<vm_uuid>.json` being a VM object representing each virtual VM.

The cn-agent tasks use the dummy backends in [node-vmadm](https://github.com/joyent/node-vmadm/tree/master/lib).
The `index.dummy.js` and `index.dummy_vminfod.js` backends should work basically
the same, with the `index.dummy_vminfod.js` backend using [a mock version of a
vminfod-like thing](https://github.com/joyent/triton-mockcloud/blob/master/bin/vminfod.js).
These backends both just convert the standard create/delete/etc commands for
vmadm to modifications on the `<vm_uuid>.json` files.

The sdc-cn-agent repo also contains the tools to:

 * [create mock
   CNs](https://github.com/joyent/sdc-cn-agent/blob/master/lib/backends/dummy/tools/create-server.js)
 * [delete mock
   CNs](https://github.com/joyent/sdc-cn-agent/blob/master/lib/backends/dummy/tools/delete-server.js)
 * [run a mockcloud cn-agent instance for all
   servers](https://github.com/joyent/sdc-cn-agent/blob/master/lib/backends/dummy/tools/run-servers.js)


### cmon-agent

Right now the [mock version of
cmon-agent](https://github.com/joyent/triton-mockcloud/blob/master/bin/cmon-agent.js)
is in the triton-mockcloud repo. This just responds with some basic time metrics
for each VM. This way when cmon tries to talk to this mock CN because it
discovered that the VM exists, it will succeed. In the future we might want to
expand this where it's useful for testing large amounts of data.

### config-agent

Unimplemented.

### firewaller

Unimplemented.

### net-agent

Like cn-agent net-agent has a dummy implementation. Unlike cn-agent it doesn't
do this via a "backend" but rather by an alternate top-level file. To start
a mock CN version of net-agent one uses
[dummy/net-agent.js](https://github.com/joyent/sdc-net-agent/blob/master/dummy/net-agent.js).
This will start up a version of all net-agent's FSMs which use a dummy version
of node-vmadm (just like cn-agent) and therefore all operations will be
performed against the mock VM files.

### vm-agent

To run a dummy vm-agent one runs
[bin/run-dummy-vm-agents.js](https://github.com/joyent/sdc-vm-agent/blob/master/bin/run-dummy-vm-agents.js)
which will create a `VmAgent` instance for each mock CN. It will then again use
node-vmadm's dummy backends to watch for changes to the virtual VMs and send
them to VMAPI.

### triton-mockcloud

The triton-mockcloud repo pulls together the components above, and adds some of
its own glue to make it possible to run all of the mocked components in a zone
with minimal effort. It includes things like:

 * a service to create some number of virtual CNs automatically
 * smf manifests to start all the services
 * the dummy vminfod program
 * add external NICs to mockcloud CNs (needed for VMAPI tests)


## What you need to do to add support for mocking a new component

If you wanted to add a mock version of a new component that runs on the CN, the
general process should probably look something like:

 * abstract out all the things that touch the filesystem or other things from
   the GZ environment into a backend.
 * implement a dummy version of the backend that runs on a system other than
   SmartOS that's not running in the Triton install. (I've found this very
   helpful to identify where things were missed)
 * integrate the dummy version into triton-mockcloud so that new mockcloud
   instances will pick up the new dummy agent. Ideally if you reprovision an
   existing mockcloud zone, there'd be some mechanism to add the new agent to
   existing mock CNs.

If the communication for your service is agent -> API, it's likely that there's
not much more to do other than to ensure it has the proper configuration for the
APIs it needs to talk to and the files/directories it needs for the dummy
implementation.

If the communication for your service is API -> agent, instead of agent -> API,
you will also need to have your API know how to talk to the mock version of the
agent. Since this could be running in a zone, on someone's laptop or on a
raspberry pi in someone's closet, cn-agent exposes an additional field on
mockcloud CNs that provides the IP your API should use to talk to agents on that
CN. At the time of this writing the field to use is `CN Agent IP` but this seems
like it might change soon (see "Outstanding Issues" below).

## Differences from real CNs

There are some differences that are incidental and some that are expected to
remain going forward. The main one is the one that can be used to identify
mockcloud CNs which is the `"System Type": "Virtual"` property in sysinfo.

Currently we also set the hostname by default to start with a `VC` prefix, but
this is not guaranteed and should not be depended on.

The final thing worth pointing out here is that the:

```
"SDC Agents": [
```

property in sysinfo is missing from mockcloud CNs as this is something that we'd
like to deprecate. Making this change in mockcloud helps us to ensure that
nothing depends on it for proper functioning.


## Status

### Overall Status

Installing a mockcloud instance using the instructions in the
[README](../README.md) has been working for some time. This will create a
mockcloud0 zone in a Triton setup, and NUM-MOCK-SERVERS mock CNs. You can then
see these servers in CNAPI or `sdc-server list`. You can also provision, though
by default these servers all have only `admin` NICs, so for many things you'll
want to add an external NIC. The script:

```
bash /zones/$(vmadm lookup alias=mockcloud0)/root/opt/triton/mockcloud/tools/add_externals.sh
```

can run and add an external NIC to all your mock CNs that don't have them. At
that point you should also be able to run the VMAPI tests with the VMs being
created all being virtual.


### cmon-agent

The cmon-agent mock really is more of a placeholder than anything useful at this
point. It does serve to prevent problems caused by cmon discovery finding VMs on
these mock CNs and cmon being unable to connect to cmon-agent.

### cn-agent

Many tasks are implemented for mockcloud. The heartbeats and server messages are
also fully working (though the usage data in non-heartbeat messages are
placeholders). Agents register themselves and are able to handle most VM-related
tasks. All those required by VMAPI's test suite at least. There are no known
issues with the mocking other than the dummy data and other unimplement tasks.

### config-agent

Not yet implemented.

### firewaller

Firewaller has not yet been implemented.

### net-agent

The net-agent mock implementation seems to be fairly complete. Since there are
no tests, we've relied on the VMAPI tests and manual testing. But at this point
there are no known issues with the mocking of net-agent.

### vm-agent

All vm-agent functions should be working. There are no known issues.

### mockcloud0 zone

This zone and the related scripts are working as expected. One can reprovision
the mockcloud0 zone with a new mockcloud image and keep ones CNs and VMs.

There is quite a bit here that can probably be refactored, but no major known
issues.


### Successes

 * For the "Scaling" project, we were successfully able to run 2000 cn-agent
   instances all heartbeating to CNAPI as real CNs would. This was invaluable in
   exposing the scaling problems and allowed us to confirm that improvements
   worked as intended.
 * For our "nightly" environments, we've been able to automatically create mock
   CNs after reflash / setup which has significantly increased the capacity
   available for some tests (e.g. VMAPI tests).


### Outstanding Issues

#### Connecting from APIs to Agents

When CNs are created they always get an admin NIC. This is also the NIC which
they'd normally get an IP using DHCP (not yet implemented for mock CNs). Within
the APIs and in things like AdminUI, `sdc-server list` and other tools, it's
important that this NAPI-allocated NIC be shown for the CN. The only things that
need to know differently are those few APIs that actually connect to an agent on
a mock CN.

Obviously if the mockcloud cn-agent instance is running in a remote location, or
on someone's laptop, it's not always going to be possible to plumb all the
interfaces. There might be conflicting networks or other things in the way. So
what we do instead currently is have cn-agent add a `CN Agent IP` to sysinfo
which identifies where things that need to connect to the CN (just CNAPI and
CMON for Triton) should actually connect rather than connecting to the Admin IP
which is just used as a placeholder in NAPI.

There are a few problems with the current setup though. First, it's confusing.
Especially on account of the naming. One option would be that instead of `CN
Agent IP` we could rename this to `Agent IP` so it's clear that's the IP to use
for all communication from APIs to agents. Then we could add a helper function
to [triton-netconfig](https://github.com/joyent/node-triton-netconfig) like
`netconfig.agentIpFromSysinfo` into which you would pass in the CN's sysinfo and
out of which you'd get either `Agent IP` if that's set, or `Admin IP` if it is
not.

Another naming issue is with the port for cn-agent. Since we have multiple
cn-agent instances on the same IP in some cases (e.g. with a mockcloud0 zone),
we can have different ports for each instance. Currently we use `CN Agent Port`
in sysinfo for each instance of cn-agent. And for CMON, we don't care about the
port, so we've not needed to separate these. If we're going to have more APIs
that need to talk to CNs in the future (none are currently foreseen, but it is
possible) we might need a better mechanism here.

Another option would be to drop both `CN Agent IP` and `CN Agent Port` and
instead have something like:

```
    ...
    "Agent Addresses": {
        "cmon-agent": {
            "ip": "X.X.X.X",
            "port": 90210
        },
        "cn-agent": {
            "ip": "X.X.X.X",
            "port": 12345
        }
    }
    ...
```

added instead for mock CNs. Then CNAPI and CMON could look at this and know
which address to talk to. It does mean that any agent we expose, cn-agent would
have to know how to get the list of running IPs/ports. And it would need to be
able to update this if cmon-agent restarted with a different mapping. As such it
feels like a bit over-complicated given how little need there seems to be for
this.

Right now, it seems like just changing to:

```
    ...
    "Agent IP": "X.X.X.X",
    "cn-agent Port": 12345
    ...
```

is probably good enough to limit confusion, and we can worry about a more
complicated implementation later if we ever need it. Right now, it's only 1 file
in each of two projects (triton-cmon and sdc-cnapi) that need small tweaks to
some very simple logic if we change this.

#### Misc

 * need some mechanism to prevent provisioning on a mock CN when something
   actually needs to run in a VM (e.g. some test scenarios)
 * need to fix so we can run again withouth SmartOS zone-specific stuff. With
   mockcloud0 work, some things were changed to depend more on mdata-get and
   other things that are available in a zone. These should be made optional
   again so that we can run in more configurations.


## The Future

 * mock booter that requests DHCP leases
 * integration with API tests, e.g. run a mock cn-agent against a CNAPI and test
   communication between the two without needing a GZ at all (e.g. on an
   Engineer's laptop).
 * different hardware profiles for mock CNs (Simple, just not yet needed. Can
   also be done manually.)
 * ability to "mirror" an existing DC sucking down all CNs + VMs + networks and
   pushing into a mock CN based setup so that setup-dependent issues can be
   investigated in a safe environment.

