# Agent Note: The deployment nothing composed

Status: implemented

English | [中文](2026-09-09-the-deployment-nothing-composed.zh.md)

## Problem

Candy's control plane was nine packages and no deployment. Every one had a Loader-composition test of its own, and each one composed the two or three rows it needed; nothing composed all of them. The plan note said so in four separate places — "no deployment mounts it yet", "shipped deployment composition ... remain unbuilt" — and the account page shipped in the release before this one with the same admission.

That gap is not a missing file. A composition is where the questions no single package can answer get answered: which medium the control plane's records live on when the inherited base routes storage elsewhere, whether the key the account API seals with is the key the runtime opens with, what an operator has to supply, and what happens when they supply none of it.

## Decision

`packages/bundle/candy-app` is one patch layer over `dsh-web-app`, and it carries no literals. Every value that differs between installs — the public origin, the identity provider, the keys, the database, the pool base — is `!!js process.env.CANDY_*`. A bundle with an origin written into it is a bundle that must be edited before it runs, and an edited bundle is not the artifact that was tested.

That choice is what makes the misconfiguration behavior free rather than built: an unset variable resolves to `undefined`, and the row that reads it refuses at load. Eleven cases pin exactly that, each naming the entry that must do the refusing — without which a boot that crashed for an unrelated reason would satisfy the case.

**SQLite is inserted for one domain.** The inherited base routes storage through the JSON backend, which has no compare/exchange and answers reads from its open-time snapshot. Spending an assertion nonce exactly once is a write that must fail on an existing key, and a second Candy process must see the first one's writes. `routes` sends `candy_control_plane` to SQLite and leaves the inherited session domains on the backend they were tuned for.

**One key version feeds two rows.** The account API seals a credential and the runtime opens it. A credential sealed under a version the runtime cannot open is an account a tenant configured and no run can use, and nothing between them would report it.

Building the layer surfaced a defect the packages could not: **`RunScheduler` exported a `Config` schema that nothing bound.** No `static Config`, so the Loader validated none of it — `issuer`, `audience`, `credentialKeyVersion` and `poolBase` are all `required()` and all were unenforced, and every default in the schema was dead beside a `?? literal` at each of twelve read sites. A runtime whose `audience` was absent would have started and admitted assertions addressed to nobody. The schema is now `static Config`, the constructor resolves through it for callers that construct directly, and the twelve fallbacks are gone: the defaults live in the schema alone.

## Consequences

A Candy deployment is one artifact and one documented environment. Fifteen cases boot the published patch file through the real Loader — `loadOverlayPatches` reads it, the Loader evaluates its `!!js` expressions against a real process environment — over the rows `dsh-base` and `dsh-web-app` supply. Nothing about the composition is restated in the spec, so a row renamed or a variable misspelled fails there rather than on an operator's first install.

Among them: the store, the scheduler and the credential-check registry are present; the account routes answer `401` without a session and `403` from another authority, with sign-in answering `303` on the same one; a nonce spent through the composed store is refused the second time, which is the SQLite routing doing its job; and each of eleven variables, removed one at a time, stops the boot at the entry that reads it.

Mutation confirms they carry the rules: unbinding `static Config` and dropping the constructor's resolve fails ten of the fifteen, including four of the refusal cases.

What this does not add: no systemd unit, Nginx site, health endpoint, backup or rollback procedure — the operator-facing half of the release is the next slice, and it is written against this layer's variable list. No retired credential key can be configured from here, because one variable cannot express a list. Nothing stops two runtime processes from sharing one `CANDY_RUNTIME_AUDIENCE`.

## Alternatives considered

**Write the deployment's values into the patch.** Rejected: the published artifact would differ from the tested one at every install, and the deployment's secrets would live in a file read for other reasons.

**Route every domain to SQLite.** Rejected: the inherited session domains were tuned for the JSON backend and nothing about them needs an atomic exchange. Changing a medium under working code to avoid naming one domain is a larger change than naming it.

**Give the layer its own config schema and validate the environment itself.** Rejected: each row already declares what it requires, and a second schema in front of them would be a second place for the same rule — with this one being the copy nobody updates.

**Leave `RunScheduler` as it was and document the variables as required in the README.** Rejected the moment the composition test asked for it: a README cannot refuse a boot, and "required" that nothing enforces is the shape the bundle exists to remove.
