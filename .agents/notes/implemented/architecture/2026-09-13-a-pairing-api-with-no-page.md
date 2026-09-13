# Agent Note: A pairing API with no page

Status: implemented

English | [中文](2026-09-13-a-pairing-api-with-no-page.zh.md)

## Problem

Candy could issue, list, exchange, authenticate, and revoke device identities, and the `candy-host` profile could consume a pairing code. The only way for a signed-in tenant to start that path was still a raw HTTP call. That left the shipped browser surface unable to perform the Candy-owned identity step even though DSH already supplied its settings shell and responsive layout.

## Decision

Contribute a Devices section through the existing `settings.section` slot in `dsh-client-ui-settings-candy-account`. It uses the same-origin Candy device API with the browser session cookie and the existing double-submit CSRF header. The section issues codes, shows a copyable `candy-host pair` command, lists device and invitation metadata, and revokes a selected device.

The clear-text code exists only in the controller's volatile store. It is cleared when the tenant dismisses it or the section unmounts, and a later roster read contains metadata but never recovers the code. Device tokens are absent from every browser-facing type. The section inherits DSH navigation, theme, and phone-width behavior rather than creating another Candy surface.

## Alternatives considered

- Build a Candy-specific Web or mobile application. Rejected because DSH already owns the browser surface and responsive settings framework.
- Put device management in the Windows profile. Rejected because issuing and revoking a tenant-owned identity requires the signed-in Candy user; the Host owns only code consumption and its local binding.
- Persist or re-fetch the clear-text code. Rejected because a bearer invitation should be disclosed once, and the device API deliberately cannot recover it.
- Fold devices into the provider-account form. Rejected because account credentials and Host identities have different lifecycles and actions; separate settings sections keep those boundaries visible without adding a new shell.

## Consequences

A signed-in tenant can complete the browser half of Windows pairing and revoke devices from the existing desktop or phone settings panel. The page adds no transport or filesystem capability. DSH still needs a remote-Host transport that consumes the stored binding at connection and reconnect time; Candy also still needs a tenant device cap and spent-code cleanup policy.
