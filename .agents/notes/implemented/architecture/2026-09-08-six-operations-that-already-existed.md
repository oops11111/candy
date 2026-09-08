# Agent Note: Six operations that already existed

Status: implemented

English | [中文](2026-09-08-six-operations-that-already-existed.zh.md)

## Problem

Candy needed a provider-account management API: list, create, validate, set-default, revoke, delete. All six operations already existed. `dsh-provider-accounts` creates an account and seals its credential, lists a tenant's accounts, moves the default, validates through a caller-supplied port, revokes and deletes — and every one takes the tenant and refuses an id that tenant does not own, answering `not-found` for another tenant's record and for one that was never issued alike.

What was missing was a transport, and two things it would have to get right that no existing piece could:

The tenant. Every one of those operations takes a `UserId` as a parameter, so whatever calls them decides whose accounts are touched. Nothing yet made that decision unforgeable.

The validator. `validateProviderAccount` takes a `ProviderAccountValidator` port, and the repository had no implementation of it anywhere — checking a credential means talking to that provider, which only an integration for it knows how to do.

## Decision

Two packages: a registry for the port, and a plugin that mounts the six operations on the envelope.

**`dsh-provider-credential-checks`** is the seam for the validator. A management API asks for a verdict and never learns the endpoint, the request or the response body; an integration answers without knowing which tenant or account the secret came from. A provider nothing registered for answers `unsupported-provider` rather than `invalid-credential`, because a deployment that composed no integration has no way to know the credential is bad. The first registration for a provider answers: a second would be two opinions about one fact with no stated rule for choosing.

It is its own package because `dsh-provider-account-api` is a function plugin, and a package cannot both default-export a service and name-export a function plugin — the Loader discards the function plugin's namespace, which this change ran into before splitting them.

**`dsh-provider-account-api`** adds only transport. The tenant reaching every domain call is `actor.userId`, and `dsh-control-plane-api` gives a handler no other source, so honouring a `userId` in a request would require inventing a lookup rather than forgetting a check.

The account id is minted here rather than accepted. An id a caller chose could collide with another tenant's, and the domain refuses a collision as `account-already-exists` — which would report that the other tenant's account exists.

What this layer validates is what the transport is responsible for: the provider is one of the three, the secret is a non-empty string within a cap, `isDefault` is a boolean if present. The secret's cap matters because the secret reaches a sealing operation and nothing else would bound it. The label's rule stays in `dsh-provider-accounts` and is forwarded, because repeating it would be two places to change and one to forget — the domain error's own message is documented as safe to return.

Both the API's operations and the vault's own sealing and opening records reach the acting tenant's trail, successes included: an operator investigating a revoked account needs to see who revoked it. Neither write can fail the operation it describes.

The keyring assembly moved into `dsh-credential-vault` as `assembleKeyring`. Two components read the same variables for the same reason — a runtime that opens a tenant's credential and a management API that seals a new one must agree on which version means which key — and having each build its own was a way for them to disagree.

## Consequences

A signed-in tenant can hold provider accounts, and the properties that matter are pinned rather than asserted. Twenty-six tests boot a Loader composition of the real storage stack, the durable store, the real `dsh-host-webserver` and this plugin, with two tenants present throughout and sessions established through the store exactly as the OAuth callback does.

Among them: the credential never appears in any reply from any operation; two tenants on the same provider see only their own; naming the other tenant's real id answers byte-for-byte what an invented id answers, on all four id-taking operations, and leaves that account untouched; a `userId` planted in a create body changes nothing about whose account is created; a revoked account's envelope no longer opens and every later operation on it refuses; a provider check that throws answers `500` with none of its message; and everything survives a restart with ownership intact.

Mutation checks confirm the tests carry the rules: answering `not-found` distinguishably fails the four cross-tenant cases, and dropping the secret cap fails its own.

What this does not add: no administrator view of another tenant's accounts, no rewrap surface for rotating every sealed envelope onto a current key, no pagination, and — until an integration composes — no provider that `validate` can actually ask.

## Alternatives considered

**Put the credential check behind a config-supplied function.** Simplest, and impossible: a `cordis.yml` cannot carry a function, and a config field naming a module would make the API resolve and trust an arbitrary import.

**Accept the account id from the client.** Common in REST, and rejected: a chosen id can collide with another tenant's, and the collision refusal reports that theirs exists. Minting costs nothing and removes the question.

**Validate the label here as well as in the domain.** Rejected: it is the domain's rule, it already reports a refusal safe to forward, and duplicating it makes the two able to disagree — with this layer's copy being the one nobody updates.

**Use `PUT`/`DELETE` with the id in the path.** More conventional, and rejected for now: the envelope registers exact paths, and an id in a path is published into logs and browser history for no benefit — the session already names the only tenant that can act, and the body carries the id just as well.

**Let each of the two components assemble its own keyring.** Rejected once the second one needed it: they must agree on which version means which key, and two copies of that logic is exactly how they stop agreeing.
