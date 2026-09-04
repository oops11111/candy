# Agent Note: The clock nobody wound

Status: implemented

English | [中文](2026-09-04-the-clock-nobody-wound.zh.md)

## Problem

Every piece of a Candy run existed as a library, and nothing owned the state those libraries operate on.

`RunLedger` and `RunReplayStore` are per-runtime objects that must be shared: a parent and its children have to be accounted in one ledger, and a nonce is only spent once if one store sees every admission. Nothing held either, so every caller constructed its own. The admission policy — expectation, secret, keyring, pool base, three ports — was reassembled by hand at each call site, which is where a wrong `findBudget` for a child run would have been easy to write and impossible to notice.

And `RunLedger.expire` was a call nothing made. Its README recorded the consequence plainly: "a deployment that never calls it never releases an abandoned hold". A run that died without settling kept its parent's allowance for as long as the parent lived.

## Decision

`RunScheduler` is a Cordis service holding one ledger and one replay store, composing the admission policy from `ctx.controlPlaneStore`, and running a clock that sweeps both.

The budget port is composed here rather than delegated, because this is the only place the two lifetimes meet: a root run is admitted against its tenant's durable allowance, a child against its parent's in-memory remainder. A tenant with plenty left can have an exhausted parent, so a store answering a child from the tenant's own allowance would defeat the check.

Secrets are named as environment variables rather than written into the composition, following `dsh-llm-claude-cli`. An unset one fails the boot; so does a credential key that is not 32 bytes, because that is what the vault seals with, and a wrong length there would surface later as an envelope that will not open.

`sweep` is public and takes its own `now`. The clock calls it, and a caller holding a decision timestamp can call it directly — which is what the tests do, alongside one fake-timer case proving the interval fires without anyone asking.

It is deliberately not a policy. Whether a tenant may start another run, how many may be live across unrelated trees, and in what order queued requests run are decisions nothing makes yet, and inventing them here would put a tenant-wide cap inside a per-tree accountant.

## Consequences

The composition order runs end to end from a token: the test mints an assertion, and the run reaches a private pool directory with its credential opened, against a real SQLite database.

Live state is still in memory. The store keeps accounts and allowances across a restart; open runs and their holds do not survive one, and nothing folds a run's spend back into the tenant's durable allowance.

## Alternatives considered

**Let each caller keep its own ledger.** It is what the code did, and it is unsound for the reason `dsh-run-ledger` already states: two ledgers each believe they hold the whole allowance, so the delegation cap holds in neither.

**Drive expiry from a timer inside `RunLedger`.** It would make a plain data structure own a clock and a disposal path, and give every test one to stop. The service already has a lifecycle Cordis disposes; the ledger stays a value.

**Take the assertion secret and keyring as config values.** Writing a HMAC key and a vault key into a composition file puts both in whatever holds that file. Naming the variables keeps the secret with the deployment's own secret handling.
