# Agent Note: A rotation that locked every tenant out

Status: implemented

English | [中文](2026-09-06-a-rotation-that-locked-every-tenant-out.zh.md)

## Problem

`dsh-credential-vault` takes a keyring — a current version and every retained one — precisely so a key can be rotated while envelopes sealed under the old one stay openable. `RunScheduler` built that keyring from one config field and put exactly one key in it.

A probe started a run, rotated the key and version as an operator would, and started another:

`{"beforeRotation":true,"afterRotation":false,"why":{"stage":"credential","reason":"unknown-key","keyVersion":"2026-09-a"}}`

Every envelope names the version it was sealed under, and the runtime no longer held that key. Not one tenant's run, but every tenant's, and not until a queue drained but until the old value was put back. The vault had the mechanism; the composition could not express it.

## Decision

`retiredCredentialKeys` names the versions this runtime still opens beside the current one, each with the environment variable holding its key. The keyring is built from the current key plus those, so a rotation seals under the new version while the old one stays openable.

Two entries fail the boot rather than resolve: a version that is also the current one, and a version retired twice. Either would decide silently which key a version means, and the wrong answer is a tenant whose credential opens with the wrong key or not at all. A retired entry whose variable is unset fails the boot the way every named secret does.

## Consequences

A rotation is a migration rather than an outage.

The negative control — dropping the retired-key loop — fails exactly the four tests that exercise it, and leaves passing the test that pins what a rotation without the old key still does, because that behavior is unchanged and worth keeping pinned.

Nothing rewraps. The retained key is retained until every envelope has been rewrapped under the current one, and driving that pass is the operator's: this package opens envelopes and does not migrate them. A key retired forever is a key never actually retired, which is now the honest limitation in its place.

## Alternatives considered

**Rewrap on open.** The vault's `rewrapCredential` exists and admission already opens the envelope, so a rotation could complete itself. It turns every admission into a store write, and a rewrap that fails mid-rotation needs a story this has no place for yet. The keyring is the blocker; the pass is a separate decision.

**Read the retired keys from one variable.** A single `CANDY_CREDENTIAL_KEYS` holding versions and keys together would keep the config to one field, and it would put two secrets in one variable and invent a parse for them. One entry per key reuses the naming every other secret here already uses.

**Accept an unknown version by trying every key.** It removes the config entirely and destroys what the version is for: a key that opens an envelope it was not sealed with is a key confusion, not a convenience.
