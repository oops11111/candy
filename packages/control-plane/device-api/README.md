---
description: "The four device operations over HTTP: three a tenant performs on their browser session, and the pairing exchange a Harness Host completes with a code and no session at all."
kind: "package-reference"
---

# @deepseek-ai/dsh-device-api

English | [中文](README.zh.md)

## Summary

[`dsh-device-registry`](../device-registry/README.md) decides who a device belongs to. This package is how a tenant and a host reach those decisions: three routes on the [authenticated management envelope](../control-plane-api/README.md), and one that a browser session does not authenticate because the caller is not a browser.

A Harness Host completing the exchange has not been anyone yet. The pairing code in its body is the whole of its claim, and the tenant it becomes bound to is the one that issued that code. The exchange is therefore registered through `registerAnonymousRoute`, which hands the handler no `Actor` at all — so the envelope's rule that an `Actor` means an authenticated session survives unchanged, rather than being loosened to admit this caller.

A code and a token each appear in exactly one reply and are never readable again. The medium holds only their digests.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Composing it

```yaml
- id: device-api
  name: '@deepseek-ai/dsh-device-api'
  config:
    publicOrigin: 'https://candy.example'
    pairingCodeTtlMs: 900000
```

`publicOrigin` must be the exact origin sign-in was configured with; a request addressing any other authority is refused before anything else runs. `pairingCodeTtlMs` is how long a person has to carry a code to the machine, from 30 seconds to a day, and defaults to 15 minutes.

### The four operations

| Path | Method | Who may call it |
| --- | --- | --- |
| `/api/candy/devices` | `GET` | A signed-in member, for their own devices and codes |
| `/api/candy/devices/pair` | `POST` | A signed-in member, issuing one code |
| `/api/candy/devices/revoke` | `POST` | A signed-in member, for their own device |
| `/api/candy/devices/exchange` | `POST` | Anyone holding an unspent code |

`pair` answers `{ code, label, expiresAt }`. That reply is the only time the code exists in the clear; a tenant who loses it issues another.

`exchange` answers `{ deviceId, userId, label, token }` once. The host keeps the token and presents it thereafter; a host that loses it is paired to a device it can no longer prove it is, and the fix is a revocation and a new code.

`revoke` answers the device as it now stands. A device belonging to another tenant answers exactly as a device that does not exist.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The plugin: config, code minting, the four route registrations |
| [`src/types.ts`](src/types.ts) | The paths and the request and reply shapes a client reads |
| — | No runtime invariant companion is published; the package registers routes and owns no mutable runtime data, and its refusals are checked by the composition test. |

### Why the exchange carries eighty bits

A pairing code is a bearer credential presented over the public internet with nothing beside it, and no rate limit stands between a guess and an attempt. Sixteen glyphs of five bits each is what makes guessing one within its lifetime impossible rather than merely slow, which is why the length is fixed here rather than configured.

The alphabet is thirty-two glyphs with no `I`, `L`, `O` or `U`. The first three are read back as `1`, `1` and `0` by whoever types the code; the fourth turns a random code into a word often enough to matter. Thirty-two also divides 256 exactly, so masking a random byte selects a glyph without the bias a remainder against a 26- or 36-glyph alphabet would introduce.

### Why the exchange does not require an `Origin`

A session write is checked against `Origin` because a browser attaches the session cookie by itself, and the header is what separates this deployment's own page from a page that merely knows the URL. There is no cookie here and the caller is not a browser: requiring the header would refuse every real client. A page that forges this request must already hold the code, and cannot read the reply.

The `Host` check still applies, exactly as it does to every other route.

### Why the ids are minted here

A host that chose its own device id could name a device of another tenant and overwrite the record binding it. The id and the token are both minted on the server, and the reply is the only place either appears.

### Why an unusable code files no audit record

The three tenant routes are recorded against the session's tenant, successes included: an operator asking why a host is paired needs to see who paired it. A refused exchange names no tenant this deployment may believe — an unknown code resolves to nobody — so it reaches the deployment's log alone rather than a trail it could be used to flood.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-device-registry`](../device-registry/README.md) — every decision this package mounts.
- [`dsh-control-plane-api`](../control-plane-api/README.md) — the envelope, both registrations, and the failure vocabulary.
- [`dsh-provider-account-api`](../provider-account-api/README.md) — the sibling layer, and the template this one follows.
- [Multi-tenant CLI agent runtime](../../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.md) — the R1–R6 delivery plan.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

These are current package constraints, not a task backlog.

- **Nothing caps how many devices or codes a tenant may have** — an authenticated member can issue codes until the medium fills, exactly as they can create provider accounts. A cap belongs with whatever else bounds a tenant's footprint, and nothing yet does.
- **No browser page** — the settings panel has a Candy account page and no device page. A tenant reaches these routes with an HTTP client until one exists.
- **No host client** — nothing in this repository calls the exchange. The Harness Host that will hold a device token is the rest of R5.
- **A code that is never exchanged stays on the medium** — this API issues codes and [`dsh-control-plane-store`](../control-plane-store/README.md) keeps them; neither sweeps the spent and expired ones.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
