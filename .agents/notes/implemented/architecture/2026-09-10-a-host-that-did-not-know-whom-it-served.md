# Agent Note: A host that did not know whom it served

Status: implemented

English | [中文](2026-09-10-a-host-that-did-not-know-whom-it-served.zh.md)

## Problem

Pairing produced a device id and a token, handed them to the host once, and the host had nowhere to put them.

The harness has exactly one durable identity, `dsh-anonymous-user-id`, and it is a per-installation UUID designed *not* to identify a person. Nothing in `host/` names a machine reached over a network: it is the local web-GUI half — an HTTP server, an SPA server, a directory picker, a plugin inventory — all of which assume the browser and the harness are the same machine. So a paired host restarted and was unpaired again, and there was no answer to the first question R5's lifecycle asks: which server does this machine serve, and as whom.

The second question the same bullet asks — connection state, offline detection, reconnect — is not missing. `dsh-client-connection` owns a retry schedule with bounded jittered backoff, browser `online`/`offline` events, heartbeats, generations and an explicit `reconnect()`. Building any of that again would be building a second transport, which the boundaries page forbids.

## Decision

Candy records the binding and touches nothing about the connection.

`dsh-device-binding` is a Cordis service holding one record: the deployment's origin, the tenant, the device, the token, and when the pairing happened. It lives in `ctx.credentials` as a `grant` record, because the token is a secret and that seam already owns durable secrets — and because `modifyRecord` is a serialized read-modify-write that holds across processes where the store supports it.

**One binding, by construction.** There is one record key and `bind` refuses to replace a binding that already stands. A machine serving two tenants at once is a machine on which either tenant's work can reach the other's files, so changing who a machine serves is `release` followed by a new pairing — an operator action, not something a stray call does by accident. The exclusion is the credential seam's, which is why two `dsh` processes pairing at the same moment cannot both install one.

**Re-pairing the same host is not a rebind.** The same deployment, tenant and device with a new token replaces the token and keeps `boundAt`, because the machine has served that tenant since it was bound and a rotated credential is not a new relationship.

**The origin is normalized to scheme and authority, lowercased.** A person types a URL with a path, a trailing slash or capitals, and none of those distinguish deployments. Comparing raw text would let a re-pair against the same server read as a different one, which is the exact case `already-bound` exists to refuse.

**The stored payload is validated on the way out.** The seam stores a grant payload as opaque JSON and returns it uninterpreted, so a hand-edited file reaches this boundary as an ordinary possibility. A payload that is not a binding reads as an unpaired host, and does not stand in the way of pairing one.

## Alternatives considered

**Keep the binding in settings and the token in credentials.** Rejected. Two records that must agree can disagree — a settings file restored from backup beside a rotated token names a device whose credential is gone — and the exclusion that makes "one binding" true covers only one of them.

**Give the service a `serverOrigin` config field.** Rejected: it is not a deployment-varying choice a composer makes, it is the outcome of a pairing a person performed. Configuring it would let a config edit silently repoint a paired machine at another deployment.

**Let `bind` replace whatever stands, and rely on operators not to call it twice.** Rejected. The failure is silent and its blast radius is the previous tenant's files; refusing is one branch and makes the mistake impossible rather than unlikely.

**Model connection state here, so a caller reads one object for both.** Rejected as duplicating the inherited transport. `ConnectionController` already owns the retry schedule, the offline signal and the reconnect command, and a second state machine over it would be a second answer to "are we connected" that could disagree with the first.

**Store a normalized `serverOrigin` and the raw URL, so the original text survives.** Rejected: the raw text has no reader. Whatever needs a URL builds one from the origin.

## Consequences

A paired host survives a restart knowing which deployment it answers to and as which device. That is the first half of R5's lifecycle bullet, and the half that did not exist.

It is deliberately inert. Nothing in this repository connects with the binding, presents its token, or asks the server whether it still stands. That is the honest position after this slice: the record exists, and the transport that would use it is the inherited one, which has no notion of a remote host to point at yet.

Learning that a binding is dead still requires asking. The server refuses a revoked device's next run — that landed in the same release — but the host keeps its binding until an operator releases it, because nothing here polls and nothing pushes.

One naming consequence is worth stating: a binding belongs to a credential store, not to a machine. Two installations with different `$DSH_HOME` values are two hosts as far as this record is concerned, which matches every other credential and is not what "one machine, one binding" would suggest.

## Verification

`packages/control-plane/device-binding/tests/device-binding.spec.ts` runs against the real `dsh-credentials-local` provider and a real file rather than a double, because the record has to survive a restart and be singular under concurrency and a double would prove neither. It covers an unpaired host, a binding read back across a second boot over the same file, the view without the token, origin normalization, the two input refusals, refusal of another tenant, another device and another deployment, a re-pair that rotates the token and keeps the instant, two pairings landing at once with exactly one installed, release and rebind, eight unusable stored payloads and a record of the wrong kind, and that the token reaches the credential file and nowhere else — at 100% of the package.

Four mutation controls establish that the cases decide something: replacing whatever binding stands, comparing raw origin text, trusting the stored payload, and resetting the instant on a re-pair each fail at least one case before the implementation is restored.
