# Agent Note: The first thing an operator logs

Status: implemented

English | [中文](2026-09-06-the-first-thing-an-operator-logs.zh.md)

## Problem

The delivery plan asks for diagnostics that return no tokens, credential paths, raw environment values, or another tenant's metadata. A probe read every operator-facing surface this runtime has — a tenant's trail, the runtime trail, a denied outcome, a ledger record — and found none of them carrying a secret, a key, a pool path, or another tenant's identity.

The surface that did was the one an operator reaches for first. `JSON.stringify` of a successful start outcome contained the tenant's decrypted provider key, byte by byte: `AdmittedRun.secret` is an ordinary property on an ordinary object, and the run is what `start` returns.

## Decision

`secret` is non-enumerable, and the run carries a `toJSON` that replaces it with `[redacted]`.

Both are needed, and they cover different callers. `JSON.stringify` calls `toJSON`, so that is what makes the redaction visible rather than a silently absent field. `console.log`, `util.inspect`, and every structured logger that walks own properties ignore `toJSON` entirely, and would print the key from a plain property — the non-enumerable definition is what stops them.

Reading `run.secret` is unaffected. That is what a caller launching the provider does, and it is the whole reason the run carries it.

The pool root stays readable. It is a path derived from a digest rather than a secret, an operator asking which pool a run landed in has a real question, and anyone who can read that directory on the host already has more than its path.

## Consequences

The natural diagnostic no longer discloses a credential.

Getting the test set right took a second pass worth recording. The first negative control — removing the non-enumerable definition and keeping `toJSON` — passed, which meant the tests only ever exercised `JSON.stringify` and the enumerability was unpinned. `util.inspect` and `Object.keys` assertions were added, and the control then failed as it should. A mechanism no test distinguishes is a mechanism nobody knows is load-bearing.

Four surfaces came back clean and are pinned that way, so a later change that starts leaking one of them fails rather than passing quietly.

## Alternatives considered

**Redact the pool root too.** The plan names credential paths, and the pool root is the directory the credential is written into. It is also the answer to a legitimate operator question, it is not a secret, and the host access needed to use it already exceeds it. Redacting it would remove real diagnostic value on a weaker rationale than the one that removes the key.

**Hand the credential through a separate call.** `admitRun` would return a run without a secret plus a way to fetch one. It keeps the credential out of the object entirely, at the cost of a second call whose failure modes and lifetime rules are new, and it does not stop a caller logging what that call returns.

**Wrap the credential in a class with a private field.** Its `toString` and `inspect` can be defined to redact, which is stronger than a property flag. It also changes what every consumer holds, and `dsh-claude-cli-binding` decodes the bytes directly; the property definition reaches the same two logging paths without moving the type.
