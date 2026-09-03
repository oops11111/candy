# Agent Note: The join between admission and the process it authorizes

Status: implemented

English | [中文](2026-09-03-admitted-run-to-claude-cli-launch.zh.md)

## Problem

`dsh-run-admission` ends by handing back an `AdmittedRun`: verified claims, an opened credential, a pool key, the directory that pool owns, and the budget the run may spend. `dsh-llm-claude-cli` starts by asking for a home directory, an API key, a spend ceiling, and whether to require credential isolation. The two were written against the same design and fit exactly, and nothing connected them.

The gap is not a missing feature; it is where the mistake would happen. Every field an admission produces has a counterpart in a launch, so a deployment wiring them by hand writes four assignments — and the one that pairs a tenant's pool directory with another tenant's key type-checks perfectly. Admission exists precisely so that pairing cannot be expressed, and stopping one call short of the launch hands it back to whoever writes the last four lines.

## Decision

`bindClaudeCliRun(run, deployment)` is the whole package. Its only run-specific argument is the admitted run, so every tenant-varying value is read from one object that was proven consistent by admission: the pool root becomes `HOME` and the working directory, the opened secret becomes the API key, the budget's `costMicroUsd` becomes the dollar ceiling.

The deployment argument carries what every tenant on a host shares — the executable path and the process-tree termination grace — and nothing else. A field belongs there only if it cannot vary between tenants, which is what keeps the argument from growing back into the hand-wiring it replaced.

### Credential isolation is not configurable here

`ClaudeCliAdapterOptions.requireCredentialIsolation` is a boolean a deployment sets. This binding always sets it. Every run reaching this module was admitted for exactly one tenant, so a run whose CLI reports authenticating with anything other than the injected key is spending a tenant that did not authorize it. That is a security invariant of the multi-tenant case, and the rule against hardcoded tunables exempts exactly those.

### The credential is refused rather than repaired

The vault stores arbitrary bytes, and this is where they first become process environment, so the checks are the environment's own: not empty, valid UTF-8, no NUL, no line break. A value spanning lines reads as two variables wherever an environment is rendered as text; a value with a NUL cannot be one at all.

None of them is fixed by stripping the offending byte. A key silently altered authenticates as nobody, and an operator would meet that as an unexplained provider rejection several layers away instead of a named refusal at the point the byte arrived.

### What is not re-checked, and why

The pool root is not validated. `runtimePoolRoot` refuses a relative base, so an absolute path is a property of every `AdmittedRun` by construction, and a check here would be unreachable code claiming to guard something. The credential is validated because its bytes came out of a sealed envelope on disk — a durable boundary — while the pool root came from a function in the same process.

## Consequences

The path from a token to a running provider process is now continuous: mint, admit, bind, spawn. Each step's output is the next step's only tenant-specific input, and no step in it takes a tenant identity as a separate argument alongside a credential.

Nothing boots this yet. The scheduler that would hold one admitted run per adapter instance is R3 work that has not shipped, and the README says so rather than implying a wired path. What exists is the composition and its tests, which is what makes the next step assembly rather than design.

The isolation claim is checked against an operating system rather than against objects. `tests/tenant-isolation.spec.ts` mints an assertion, admits it, binds it, and spawns a real process through `dsh-subprocess`; a stand-in executable reports the `HOME`, working directory, key, and spend ceiling it was actually handed. Two tenants get two homes and neither process can see the other's secret, and an ambient `CLAUDE_CODE_USE_BEDROCK` or `ANTHROPIC_BASE_URL` does not reach the child while an ordinary ambient variable does — so the tombstoning is observed rather than assumed. Reverting the home to a constant fails two of those cases and turning credential isolation off fails a third, which is what makes them evidence.

The same harness checks that a run leaves nothing behind. A stand-in told to start a child of its own and then hang is cancelled in one case and abandoned mid-stream in another; both the CLI and the process it started must become unaddressable. The two cases pin different mechanisms and fail independently: removing the adapter's `terminate()` on an abandoned generator fails only the abandonment case, and withholding the caller's signal from the spawn fails only the cancellation one. Killing the CLI alone is not enough — a plain child outlives its parent and is reparented, which is checked rather than assumed.

A Codex CLI run will need its own binding. The launch facts differ — that CLI's isolation, budget flag, and credential variable are not these — and the shared part is a shape, not code, so writing one function over both would invent a common launch vocabulary neither adapter has.

## Alternatives considered

**Putting the join inside `dsh-llm-claude-cli`.** It would remove a package, and it would make an LLM adapter depend on the control plane so that a single-tenant deployment carries admission types it never uses. The dependency direction is the argument: an adapter should not know what a tenant is.

**Returning launch facts from `admitRun` directly.** Admission would then know about every provider's process arguments, and adding a provider would change the module that decides whether a run may start. Admission answers authority; a binding answers how one provider is launched under it.

**Letting the deployment override the spend ceiling.** Rejected: it would be a second limit that can disagree with the admitted one, and a disagreement between two ceilings is discovered as a bill. The budget is already the answer to what a run may spend, and dividing it by a million is the whole of the conversion the CLI needs.
