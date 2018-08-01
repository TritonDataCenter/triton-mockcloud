# triton-mockcloud changelog

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
