# Agent Note: A trail its own subject could erase

Status: implemented

English | [中文](2026-09-06-a-trail-its-own-subject-could-erase.zh.md)

## Problem

A subject's audit trail is one bounded document, rewritten whole on each append, keeping the most recent `auditRetention` records. Every refused call now files one.

A probe revoked a live run's account and made eight calls against a retention of four:

`{"before":["credential/ok","started/ok"],"after":["refused/CREDENTIAL_REVOKED","refused/CREDENTIAL_REVOKED","refused/CREDENTIAL_REVOKED","refused/CREDENTIAL_REVOKED"]}`

The credential open and the start were gone. The trail an operator would investigate a revoked-credential attack with is the trail the attack erases, and erasing it costs the attacker nothing but repetition — retention records of it.

## Decision

A record identical to the newest in the trail, in every field but its instant, folds into that record: `count` rises and `at` moves to the latest. It is added rather than appended.

Folding happens in `recordAudit`, which is where a trail is appended and trimmed, so it holds for every producer rather than for the refusals that exposed it.

The rule is identity, not category. Two records that differ in outcome, run, tenant or account are two events and stay two; the ones that fold say nothing the trail could have distinguished anyway, because every field it records is the same.

`count` is optional in the stored record and absent means once, so a trail written before this reads back unchanged and no schema version moves.

## Consequences

Repetition can no longer displace a subject's history. A run refused ten thousand times occupies one record saying so.

Two tests changed rather than being kept: they pinned retention and concurrent-append behavior using records that were identical apart from their instant, which is precisely what now folds. Both were rewritten with distinct records, so each still measures what it was written for — the oldest records dropping at the cap, and no concurrent append being lost.

The trail is still a window. A subject whose events genuinely differ still loses its oldest at the cap, and folding does nothing about that.

## Alternatives considered

**Rate-limit the producer.** It needs a rate, which is a number nothing here has evidence for, and it would drop records rather than summarize them — the flood is real activity and an operator wants to know it happened.

**Give refusals their own smaller quota.** It keeps the two kinds from competing, at the cost of a second cap to choose and a trail whose shape depends on which kind of record arrives. Folding needs no number at all.

**Fold only refusals.** The flood is what exposed the defect, but the defect is in how a bounded trail treats repetition, and a repeating credential failure would erase history exactly the same way.
