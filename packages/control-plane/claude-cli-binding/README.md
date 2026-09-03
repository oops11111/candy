---
description: "Turns an admitted run into the Claude CLI launch facts that confine one process to one tenant's home, credential, and spend ceiling."
kind: "package-library"
---

# @deepseek-ai/dsh-claude-cli-binding

English | [中文](README.zh.md)

## Summary

`dsh-run-admission` answers who a run belongs to, which credential it may open, which directory it owns, and what it may spend. [`dsh-llm-claude-cli`](../../llm/llm-claude-cli/README.md) runs a `claude` process under a home directory, an API key, and a spend ceiling. The two were built against each other and nothing joined them, so a deployment wiring them together chose the home, the key, and the ceiling by hand — at the one place where a wrong choice is a cross-tenant leak rather than a bug.

This package is that join, as one call whose only run-specific input is the admitted run. The pool root becomes the CLI's `HOME`, the opened secret becomes its key, and the admitted budget becomes its spend ceiling, so a caller cannot pair one tenant's directory with another's credential and still type-check.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Launching an admitted run

```ts
import { bindClaudeCliRun } from '@deepseek-ai/dsh-claude-cli-binding'
import type { ClaudeCliAdapterOptions } from '@deepseek-ai/dsh-llm-claude-cli'
import type { AdmittedRun } from '@deepseek-ai/dsh-run-admission'

declare const run: AdmittedRun
declare const spawn: ClaudeCliAdapterOptions['spawn']

const deployment = { executable: '/opt/candy/bin/claude', graceMs: 5_000 }
const result = bindClaudeCliRun(run, deployment, run.budget)

export const options: ClaudeCliAdapterOptions | undefined = result.bound
  ? { ...result.binding, spawn }
  : undefined
```

The deployment supplies only what every tenant on the host shares — the executable path and the termination grace. Everything that differs between tenants is read from the run.

The third argument is what *this invocation* may spend. A run makes one invocation per model call and the CLI enforces its ceiling per invocation, so a run whose every call carried the admitted budget could spend that budget once per call. A caller holding a [`dsh-run-ledger`](../run-ledger/README.md) record passes that record's remaining allowance; a run's first invocation passes `run.budget`.

### The credential is refused, never repaired

A binding fails only when the opened secret cannot be an environment variable: it is empty, it is not UTF-8, or it carries a NUL or a line break. The rejection names which, and no launch is produced. Stripping the offending byte would inject a key that authenticates as nobody, and an operator would meet that as an unexplained provider rejection instead of a named refusal here.

### Credential isolation is not a deployment choice

The binding always sets `requireCredentialIsolation`, so a run whose CLI reports authenticating with anything other than the injected key fails. Every run reaching this package was admitted for exactly one tenant; a run that reached some other credential is spending a tenant that did not authorize it.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `bindClaudeCliRun`, `ClaudeCliDeployment`, `ClaudeCliRunBinding`, and the credential rejections |
| [`tests/tenant-isolation.spec.ts`](tests/tenant-isolation.spec.ts) | The chain end to end: mint, admit, bind, and run a real process that reports the environment it was handed, then check that cancelling or abandoning the run reaps it and the process it started |
| — | No runtime invariant companion is published; this pure module owns no event stream or mutable runtime data, and the values it assembles are enforced by unit tests. |

### Why the pool root is the working directory as well as the home

`HOME` is what separates one tenant's CLI state from another's, and the working directory decides where a process that ignores its arguments would land. Under `--bare` the CLI reads nothing from the working directory, so pointing it at the tenant's own pool costs nothing and removes the one directory a launch could otherwise inherit from whatever started it.

The pool root is absolute by construction: `runtimePoolRoot` refuses a relative base, so every admitted run carries an absolute one and this module does not re-check it.

### Why the spend ceiling is derived rather than configured

`RunBudget.costMicroUsd` is what may be spent, in integer micro-USD; the CLI's `--max-budget` is US dollars. Dividing at this one place keeps the integer arithmetic in the budget and the dollar figure at the process argument. A deployment-configured ceiling would be a second limit that could disagree with the admitted one, and the disagreement would be discovered as a bill.

The allowance is a parameter rather than a field of the run because the run's admitted budget is only correct for its first invocation. The CLI applies its ceiling to one invocation, so the ceiling has to fall as the run spends; a caller that never charges is left with a per-call limit instead of a per-run one, which the README says here rather than leaving to be discovered.

An admitted run always has money left: admission denies an exhausted budget, so `costMicroUsd` is at least 1 and the ceiling is never zero.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-run-admission`](../run-admission/README.md) — the admission that produces the run this package binds.
- [`dsh-llm-claude-cli`](../../llm/llm-claude-cli/README.md) — the adapter these launch facts configure.
- [`dsh-runtime-pool`](../runtime-pool/README.md) — the pool key and the directory that becomes the CLI's home.
- [`dsh-run-budget`](../run-budget/README.md) — the allowance the spend ceiling is derived from.
- [Multi-tenant CLI agent runtime](../../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.md) — the R1–R6 delivery plan this join belongs to.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

These are current package constraints, not a task backlog.

- **Nothing creates or verifies the pool directory** — the binding names it as the CLI's home, and a launch into a directory nobody created fails at spawn. Creating it with the right owner and mode, and proving no other tenant can read it, belongs to the deployment that owns the filesystem.
- **The credential's lifetime stays with the caller** — the binding copies the opened secret into a string that lives as long as the adapter does. Zeroing the caller's `Uint8Array` afterwards does not reach that copy.
- **No consumer wires this yet** — nothing in the repository boots a per-run Claude CLI adapter, because the scheduler that would hold one admitted run per process is R3 work that has not shipped.
- **Claude CLI only** — a Codex CLI run needs its own binding against its own launch facts, which cannot be written until that adapter exists.
- **No Cordis service** — nothing here registers on a `Context`; it is imported directly.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
