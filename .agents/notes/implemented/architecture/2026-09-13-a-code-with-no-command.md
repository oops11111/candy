# Agent Note: A code with no command

Status: implemented

English | [中文](2026-09-13-a-code-with-no-command.zh.md)

## Problem

`dsh-device-binding.pair` could securely exchange and store a pairing code, but it was only a service method. A Windows operator had no shipped process entry that could call it. Mounting another parser into the Web profile would conflict with that application's command grammar, while adding pairing to the launcher would make the launcher own Candy domain behavior.

## Decision

Ship a standalone startup-only `candy-host` profile. Its command parser accepts `pair --server --code`, `status`, and `release`; its runner delegates every operation to the existing `dsh-device-binding` service and exits. The complete tree contains only the local credential provider, device binding, parser, and runner.

Pairing output never contains the code or device token, and the code passes through the parser's in-process service rather than Loader configuration. Unexpected errors are not stringified because network libraries may include request bodies. The profile explicitly starts no Agent, Web surface, file or shell capability, Gateway, WebSocket, retry schedule, or reconnect state.

## Alternatives considered

- Add Candy flags to the Web profile. Rejected because two application parsers would claim one immutable argv and because pairing a Windows Host is not a browser-server startup concern.
- Add a `dsh pair` launcher command. Rejected because the launcher owns profile selection and plugin management, not tenant/device domain operations.
- Call the browser-to-Host Gateway with the device token. Rejected because that transport runs in the opposite direction and would not expose Windows capabilities to Debian.

## Consequences

An operator can now complete, inspect, and deliberately release the local binding with shipped commands, and a packaged CLI resolves the profile without manual plugin installation. The remote-host transport remains unbuilt: the next transport slice must be a DSH capability that consumes this binding at its real connection boundary, not a second Candy WebSocket.
