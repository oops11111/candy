---
description: "The Candy multi-tenant deployment layer over the dsh browser surface: the control plane, the tenant-scoped scheduler, sign-in, provider accounts, and the account page, all configured from the environment."
kind: "package-bundle"
---

# @deepseek-ai/dsh-candy-app

English | [中文](README.zh.md)

## Summary

This layer turns a single-user dsh browser surface into a Candy deployment. It adds the durable control plane, a runtime scheduler that admits and funds each tenant's runs, OIDC sign-in, the six provider-account operations, and the settings page that manages them — and it changes nothing about the surface those sit behind, which is `dsh-web-app`'s.

Every value that differs between one install and the next is read from the environment, not written here. A required variable that is unset resolves to `undefined` and the row that reads it refuses at load, so a misconfigured deployment fails to start rather than starting half-configured.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Apply this layer after `dsh-web-app` and give the process the environment below. The deployment then answers sign-in, the account API and the browser surface on one origin.

### The environment a deployment supplies

Every one of these is required; a Candy process refuses to start without it.

| Variable | What it names |
| --- | --- |
| `CANDY_PUBLIC_ORIGIN` | The exact external origin browsers reach this deployment at, scheme and authority. Requests naming another `Host` are refused. |
| `CANDY_DATABASE_PATH` | The SQLite file holding the control plane. Its directory must be writable by the service user and by nobody else. |
| `CANDY_RUNTIME_POOL_BASE` | The directory each tenant's runtime pool is created under; the deployment provisions it. |
| `CANDY_CONTROL_PLANE_ISSUER` | The control plane whose execution assertions this runtime admits. |
| `CANDY_RUNTIME_AUDIENCE` | This runtime's own identifier. A deployment running several runtimes gives each its own, or one will admit another's assertions. |
| `CANDY_CREDENTIAL_KEY` | The key sealed provider credentials are encrypted with. **Exactly 32 bytes of the variable's own text** — 32 characters, not a 32-byte blob in some encoding. |
| `CANDY_CREDENTIAL_KEY_VERSION` | The keyring version that key is registered under. Every sealed envelope names the version it was sealed with. |
| `CANDY_ASSERTION_SECRET` | The HMAC secret execution assertions are signed and verified with; at least 32 bytes of text. |
| `CANDY_OIDC_ISSUER` | The identity provider's issuer identifier, exactly as it publishes it. |
| `CANDY_OIDC_AUTHORIZATION_ENDPOINT` | Where a browser is sent to sign in. |
| `CANDY_OIDC_TOKEN_ENDPOINT` | Where the callback exchanges its code. |
| `CANDY_OIDC_USERINFO_ENDPOINT` | Where the verified subject is confirmed. |
| `CANDY_OIDC_CLIENT_ID` | This deployment's registered client identifier. |
| `CANDY_OIDC_JWKS_PATH` | A file holding the JSON Web Key Set ID Tokens are verified against. A path rather than inline keys, so rotating the trust anchor is one operator action on one file. |

These are optional:

| Variable | What it names |
| --- | --- |
| `CANDY_OIDC_CLIENT_SECRET_ENV` | The name of the variable holding the OIDC client secret. A public client authenticating with PKCE alone omits it. |
| `CANDY_BOOTSTRAP_ADMIN_SUBJECT` | The provider's exact subject claim for the administrator enrolled at load. |
| `CANDY_BOOTSTRAP_ADMIN_USER_ID` | The Candy user that subject signs in as. |

The bootstrap pair is both-or-neither, and it is for the first install alone. Once an administrator exists and has enrolled everyone else, leaving both unset is the steady state and the directory stands as it is.

### Rotating the credential key

Change `CANDY_CREDENTIAL_KEY` and `CANDY_CREDENTIAL_KEY_VERSION` together, and keep the old version reachable while envelopes sealed under it remain. Without the retired key the runtime cannot open them, and every tenant is locked out of the account they configured until the old value is put back. Retiring a version is what makes a rotation a migration rather than an outage.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Why SQLite is inserted for one domain

The inherited base routes storage through the JSON backend, which has no compare/exchange and answers reads from the snapshot it loaded at open. The control plane needs both to be otherwise: spending an assertion nonce exactly once is a write that must fail on an existing key, and a second Candy process must see the first one's writes. The layer inserts SQLite and routes only `candy_control_plane` to it, so the inherited session domains keep the backend they were tuned for.

### Why the account API and the scheduler share a key version

The API seals a credential; the runtime opens it. A credential sealed under a version the runtime cannot open is an account a tenant configured and no run can use, and nothing between them would report it. One variable feeds both rows.

### Why the layer carries no literals

A bundle that hard-codes an origin, an issuer or a database path is a bundle that has to be edited before it can run, and an edited bundle is no longer the artifact that was tested. Reading the environment keeps the published layer identical on every install, and keeps the deployment's secrets out of a file that is read for other reasons.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-web-app`](../web-app/README.md) — the browser surface this layer is applied over.
- [`dsh-control-plane-store`](../../control-plane/control-plane-store/README.md) — the durable records every row here reads.
- [`dsh-run-scheduler`](../../control-plane/run-scheduler/README.md) — what admits, funds and settles a run.
- [`dsh-oauth-sign-in-web`](../../control-plane/oauth-sign-in-web/README.md) — the sign-in routes and the administrator bootstrap.
- [`dsh-provider-account-api`](../../control-plane/provider-account-api/README.md) — the six account operations the page drives.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the packages this layer composes; each documents its own prompt, schema, tool and result effects.

#### KV Cache effect

None; the layer never assembles or sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These are current constraints of the composition, not a task backlog.

- **One runtime per deployment is assumed by the audience** — `CANDY_RUNTIME_AUDIENCE` is a single value in this layer. Running several runtimes over one control plane means giving each its own layer or its own value; nothing here stops two processes from sharing one.
- **Browser authentication reads the current session from SQLite** — logout reaches the medium and an already-running peer rejects that session on its next request. Separate databases are still required for canaries because schema compatibility and runtime audiences remain deployment boundaries, not as a session-revocation workaround.
- **Only DeepSeek has a credential check** — `deepseek-api` validates through its authenticated HTTP model catalog. CLI providers remain `unsupported-provider`; the account page presents their tenant-owned configured, revoked-only, or absent state without probing or sharing the service user's CLI home.
- **No retired credential key can be configured from here** — the scheduler and the account API both accept retired versions, but a rotation that must retain one needs a further patch layer; a single variable cannot express a list.
- **The runtime pool base's own permissions are the deployment's** — each pool root is created private, but the directory they are created under is provisioned outside this layer.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The layer is a patch file and an inert entry module; it registers nothing and owns no relation to check. Each composed package publishes its own invariants.
