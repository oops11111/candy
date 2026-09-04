# Agent Note: Ports with nothing behind them

Status: implemented

English | [中文](2026-09-04-ports-with-nothing-behind-them.zh.md)

## Problem

`dsh-provider-accounts` defined its account store as a port. `dsh-run-admission` required a credential lookup and a budget lookup as ports, and its own JSDoc said why: "None of them exists in this repository yet, which is why they are parameters rather than services."

Naming them forced a deployment to answer replay and credential lookup before a run could start, which was the right pressure. It also meant no deployment could start a run at all, because nothing held the data. Every caller in the repository supplied a test fake, and the fakes were free to model contracts the real thing could not keep — the replay double keyed by nonce alone was one, and it took a real store to expose it.

## Decision

`ControlPlaneStore` is a Cordis service over one `storage-domain` domain: provider accounts with their sealed credentials, and each tenant's allowance, routed to the SQLite backend. It answers `ProviderAccountStore` whole, and the credential lookup admission requires.

It answers the budget lookup only for a root run, and that split is deliberate. A child is admitted against its *parent's* remainder, which an in-memory `RunLedger` holds; a store that answered a child from the tenant's own allowance would defeat the check the port exists for. The service exposes `tenantBudget` and the composition combines it with the ledger, which is what `dsh-run-admission` already documented as the intended shape.

The stored shapes are not the runtime ones. JSON drops an `undefined` property, so a field the runtime types as `number | undefined` — a never-validated account, a never-rewrapped envelope — returns as an absent key. The schemas declare those `optional` and converters beside them restore the field. Taking the runtime type from `z.infer` would compile and then disagree with itself the first time such an account round-tripped, which is why the converters exist rather than a cast.

The composition test boots the storage hub, the SQLite backend, the domain facility and this service from a test-only `cordis.yml` through the real Loader, against a real database file. Nothing is replaced. One case writes through one boot and reads through a second over the same file, because a restart keeping the data is the entire reason for the package.

## Consequences

Two of admission's three ports have implementations. The third, replay, is deliberately in-process, and this domain would be a reasonable home for a durable one.

A tenant's allowance is what a deployment recorded; nothing decrements it as runs charge. Folding spend into a durable tenant total needs the same crash-safe settlement story durable run records need, and neither is here.

## Alternatives considered

**One table holding accounts and credentials separately.** The envelope is meaningless without the account that names its tenant, and reading them apart invites a lookup that finds one and not the other. `ProviderAccountEntry` already pairs them, so the medium stores the pair.

**Answer `findBudget` whole, taking the ledger as a constructor argument.** It would put an in-memory, per-tree object inside a durable, per-deployment service, and make the store's answer depend on which ledger instance it was handed. The composition is where those two lifetimes meet.

**Infer the runtime types from the zod schemas.** It is the shorter path and it is wrong under `exactOptionalPropertyTypes`: `{ validatedAt?: number }` and `{ validatedAt: number | undefined }` are different types, and the account types are the control plane's, not the medium's.
