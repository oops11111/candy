# Agent Note: A code the host could not spend

Status: implemented

English | [中文](2026-09-12-a-code-the-host-could-not-spend.zh.md)

## Problem

The server issued and exchanged one-time device pairing codes, and the host could store the resulting credential, but no host-side operation joined those two halves. An operator could only complete pairing by writing glue code that posted the code and then called `bind`, leaving response validation and secret transport to every caller.

## Decision

`dsh-device-binding.pair` normalizes the operator-supplied deployment origin, refuses an existing binding before sending the one-time code, posts the code to `dsh-device-api`'s existing exchange route, validates every field of the returned device credential, and installs it through the existing singular `bind` operation.

Pairing-code and Bearer-token requests both set `redirect: 'error'`. A deployment must answer at the origin the operator chose; neither credential may be carried through a redirect. A `400` is the deployment's rejected-code decision, unexpected statuses and malformed credentials are protocol errors, and network failures propagate unchanged for the caller or inherited connection owner to classify.

This method performs one exchange. It does not add a command, settings page, retry schedule, connectivity state, Remote Gateway, or WebSocket protocol.

## Alternatives considered

- Put pairing in a new Candy desktop page. Rejected because DSH owns the settings framework and Candy must not create a second desktop/mobile surface.
- Let each transport caller post the code and call `bind`. Rejected because credential validation and redirect policy must have one owner.
- Hold the credential-store mutation lock across the network request. Rejected because an unavailable server would block unrelated credential work; the remaining two-process race can consume the losing code but cannot install a second binding.

## Consequences

The host has one reusable service entry for completing pairing, and incomplete or redirected replies never reach durable storage. Two simultaneous pair attempts can still both spend their server-side codes before the credential seam chooses one binding; the losing call is refused `already-bound`. A command surface and transport consumption remain explicit R5 work.
