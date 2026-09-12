---
description: "One-shot Windows Harness Host device management: pair to Candy, inspect the non-secret binding, or release it without starting another transport."
kind: "package-bundle"
---

# @deepseek-ai/dsh-candy-host

English | [中文](README.zh.md)

## Summary

This standalone profile gives a Windows Harness Host an operator-facing way to consume Candy's existing pairing code. It mounts only the local credential provider, `dsh-device-binding`, a command parser, and a one-shot runner. It starts no Agent, Web server, file tool, shell, Remote Gateway, or reconnect loop.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

Issue a pairing code from the authenticated Candy device API, then enter it on the Windows machine:

```powershell
dsh --profile candy-host pair --server https://candy.example --code ABCD-EFGH-IJKL-MNPQ
dsh --profile candy-host status
```

The first command exchanges the code once and writes the returned token through the existing credential provider. Its output names only the normalized server, tenant, and device; neither the code nor token is printed. `status` reads the same safe view. To deliberately stop this installation serving that identity:

```powershell
dsh --profile candy-host release
```

Every operation is one-shot and exits 0 on success or 1 on refusal/failure. Unexpected network errors are classified without stringifying their request details, so a library diagnostic cannot copy the pairing code into terminal history.

## Understand the implementation

`src/startup.ts` owns the `pair`, `status`, and `release` grammar and publishes one immutable operation. The pairing code moves through that in-process service and never enters Loader configuration. `src/index.ts` invokes only `dsh-device-binding`; the bundle patch supplies the local credential store and those two rows. The shipped `candy-host` profile is startup-only because this process performs one management operation and exits.

No runtime invariant companion is published; the command owns no persistent relation beyond the `dsh-device-binding` operation it calls, and its process-level output and exit contract is covered by the command tests.

This is a management surface, not the missing remote-host transport. The existing DSH Gateway connects a browser client to a Host and cannot be reversed by supplying this token. A future DSH-owned remote Host capability must read the stored binding during its own connection establishment and reconnect operations.

## Further Exploration

- [`dsh-device-binding`](../../control-plane/device-binding/README.md) — the singular durable binding and pairing exchange.
- [`dsh-device-api`](../../control-plane/device-api/README.md) — server-side code issue, exchange, authentication, listing, and revocation.
- [Candy runtime boundaries](../../../docs/candy-runtime-boundaries.md) — Candy/DSH ownership rules.

## Model Experience

None, as this management-only profile neither assembles prompts nor invokes a model.

#### KV Cache effect

None; no provider request is created.

## Known Limitations and Deferred Work

- The profile manages identity only; it does not connect the Host to Candy.
- There is no browser device-management page yet; codes are currently issued through the authenticated API.
- `release` removes only the local binding. Server-side revocation remains a separate tenant action.

### Dev Note

None.
