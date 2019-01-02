# triton-mockcloud changelog

# 2.3.2

Update component:

 - cn-agent@2.6.1

# 2.2.1

Update components:

 - cn-agent@2.3.2
 - net-agent@2.2.0
 - vm-agent@1.8.0

## 2.2.0

TRITON-863 Add support for dummy cmon-agent.
Add support for `GET /servers/*/vms/<vm_uuid>` in dummy vminfod.
Add simple script tools/add\_externals.sh for adding external interfaces to mock CNs.
Now listens on 127.0.0.1 only.

## 2.1.0

Adds a dummy vminfod for more consistent view of the system for agents.

## 2.0.6

Add restify dependency.

## 2.0.5

Add vm-agent.

## 2.0.4

Update cn-agent to latest/master.

## 2.0.3

Add net-agent.

## 2.0.2

Update cn-agent to b160d04 for delegated dataset support.

## 2.0.1

First instance should be `mockcloud0` not `mockcloud1`. Also ignore deleted
instances when determining next name, and increase setup time to 600s from 30s
to allow more CNs to be created.

## 2.0.0

A re-write of mockcloud to support mocking multiple CNs with a single
instance. The mem usage of one mocked CN per VM instances with v1.0.0
was insufficient for testing with many many CNs. Currently this
supports just a mocked out cn-agent (using its "dummy" backend).

## 1.0.0

The first incarnation of mockcloud that, IIUC, would simulate a single CN
per instance.
