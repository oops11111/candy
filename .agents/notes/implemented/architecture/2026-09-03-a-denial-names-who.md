# Agent Note: A denial that names nobody is not a record

Status: implemented

English | [中文](2026-09-03-a-denial-names-who.zh.md)

## Problem

`RunAdmission`'s own documentation said the denied branch existed so that "a refused token, a replayed nonce, and above all a credential the vault refused to open" would reach an operator. The field beside it said the opposite: `audits` is empty whenever the vault was not reached, which is every replay and every budget denial.

Behind the contradiction was a real hole. `admitRun` verifies the assertion first, so by the time it refuses a replayed nonce it holds the tenant, account, run, and parent run the control plane signed. It returned `{ stage: 'replay', reason: 'nonce-already-spent' }` and dropped all of it. A caller logging that outcome records that some token was replayed, not whose — and it cannot recover the identity, because the claims are on the admitted branch only and re-reading the token outside the gate is the caller-supplied identity this package exists to refuse.

The same held for a budget denial and for an account with no stored credential. Three of the four stages were unattributable, and the replay stage is the one that matters most: presenting a single-use token twice is the clearest attack signal this call can observe.

## Decision

Every `RunRejection` variant past `assertion` carries the verified claims.

They travel on the stage rather than beside the rejection so that reading them is possible exactly where they exist. A single optional field would have made the correlation between stage and identity something a caller had to know rather than something the compiler enforces, and this codebase already switches on `stage`.

The `assertion` stage carries none, and that asymmetry is the decision, not an omission. Nothing was verified when it denied, so the only identity available is the unverified payload — the client-selected tenant the control plane's whole design refuses to repeat. Reporting it would put an attacker's chosen tenant into the operator's log under the same field name that elsewhere means a signed fact.

`audits` was left alone. It holds vault records, the vault produced none, and widening it into an admission-event union would have invented a second audit vocabulary for one stage. The prose was corrected instead: `audits` carries vault operations, and the rejection carries the identity behind every other refusal.

## Consequences

A deployment can now write the tenant-partitioned audit record its boundary document requires for a replayed nonce, an exhausted budget, and a credential lookup that found nothing, from the admission result alone.

`RunRejection` is a wider type. A caller that constructs one — only tests do today — supplies claims for three of the four stages, and a caller that reads one narrows on `stage` before reaching them.

## Alternatives considered

**Return an `AdmissionAuditEvent` union in `audits`.** It makes the two audit sources indistinguishable in one array and forces every consumer of a vault record to narrow past events the vault never produced. The rejection already exists to say why a run was refused; identity belongs with it.

**Put `claims` on the denied branch of `RunAdmission` as an optional field.** The field would be absent for exactly one stage, and nothing but a comment would say which. A reader would have to check it against the tag anyway.

**Leave the behavior and correct only the prose.** That is the cheaper change and the wrong one: the contradiction was the symptom, and the missing attribution was the defect. A caller told plainly that it cannot attribute a replay still cannot attribute a replay.
