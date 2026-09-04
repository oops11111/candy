# Candy control plane

English | [中文](candy-control-plane.zh.md)

The [control-plane group](../../packages/control-plane) is what turns a request from an untrusted client into one provider process that can only spend one tenant's money in one tenant's directory. It is ten packages and no running Cordis service: every package is imported directly, and the OAuth, device pairing, and account store that would make it a service belong to the [proposed multi-tenant runtime plan](../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.md), not to this repository yet.

That absence is the reason this page exists. The packages compose in exactly one order, each step's output is the next step's only tenant-specific input, and nothing in the repository performs the sequence outside its tests. This page is that sequence. [Candy Runtime Boundaries](../candy-runtime-boundaries.md) owns the trust boundaries and abuse cases the design answers to.

## The order of operations

| Step | Package | What it decides |
|---|---|---|
| Mint | [`dsh-execution-assertion`](../../packages/control-plane/execution-assertion) | that the control plane authorized this run, for this tenant, for this long |
| Admit | [`dsh-run-admission`](../../packages/control-plane/run-admission) | that the assertion is genuine, the allowance is not spent, the nonce is fresh, and the credential opens |
| Open | [`dsh-run-ledger`](../../packages/control-plane/run-ledger) | that the run holds an allowance nothing else can hand out twice |
| Place | [`dsh-runtime-pool`](../../packages/control-plane/runtime-pool) | that the directory the invocation runs in exists and is private to the account this runtime runs as |
| Bind | [`dsh-claude-cli-binding`](../../packages/control-plane/claude-cli-binding) | the home, working directory, key, and ceiling one provider invocation runs under |
| Charge | [`dsh-run-ledger`](../../packages/control-plane/run-ledger) | what the invocation consumed, and whether the run may make another |
| Close | [`dsh-run-ledger`](../../packages/control-plane/run-ledger) | what the run cost, and what returns to whoever delegated it |

[`dsh-control-plane`](../../packages/control-plane/control-plane) supplies the branded ids every step names a tenant with, [`dsh-credential-vault`](../../packages/control-plane/credential-vault) seals and opens what admission hands over, [`dsh-runtime-pool`](../../packages/control-plane/runtime-pool) also derives the key and root that admission resolves before Place creates them, [`dsh-run-budget`](../../packages/control-plane/run-budget) is the reservation arithmetic the ledger records against, and [`dsh-run-replay`](../../packages/control-plane/run-replay) is the single-use record behind the nonce admission spends. [`dsh-provider-accounts`](../../packages/control-plane/provider-accounts) owns the user-visible account metadata a tenant configures before any of this runs.

## What a deployment must supply

Two of the three stores `admitRun` takes as ports do not exist in this repository, and all three stay ports so that a run cannot start until a deployment has answered them:

- **`findBudget`** — the allowance this run is started against. For a root run that is the tenant's remaining allowance; for a run whose claims carry a `parentRunId` it is that **parent's** remaining allowance, read from the ledger. Answering the tenant's budget for a child defeats the check: the child would pass here and be refused only when its share is reserved, after its single-use nonce was spent.
- **`spendNonce`** — whether this assertion's nonce had been seen; nothing here retries a spent one. [`dsh-run-replay`](../../packages/control-plane/run-replay) answers it for one process: the decision is one synchronous step, so two concurrent copies of a token cannot both pass, and a record is held exactly while its assertion stays admissible. A deployment running more than one runtime process needs a durable store satisfying the same three obligations.
- **`findCredential`** — the sealed envelope for the tenant and account the assertion names.

The pool directory is opened rather than derived: `openRuntimePool` creates one pool root and makes it private to the account this runtime runs as, applying the mode with an explicit change so it is true of a root that already existed. It never creates the pool base — a base that is absent means the deployment never provisioned its storage — and it refuses anything but a real directory in the pool's place, because `chmod` follows a symlink and a link to another tenant's pool root is owned by the same account. What it cannot do is tell a directory a stranger created from one an earlier run left, so provisioning the base privately stays with the deployment.

Two things a deployment still owns outright: the pool base's own permissions, and the clock that calls `RunLedger.expire`, which is a call rather than a timer.

## Why the order is the contract

Each step is placed where the cost of being wrong is lowest.

The **assertion is verified first**, so nothing downstream ever sees an unauthenticated claim. The **allowance is read second**: it is the one denial a caller can fix and retry — top up, present the same still-valid assertion — so checking it after the nonce would burn a single-use token on a recoverable refusal. It also touches no secret. The **nonce is spent third**, where its job is to serialize concurrent duplicates so two copies of one token cannot both reach a credential. The **credential opens fourth**, under the binding the claims carry. The **pool resolves last**, because it needs no secret.

Identity cannot be substituted anywhere along it. `RunRequest` carries only a token; the credential binding and the pool identity are both read from the admitted claims, so a scheduler cannot open one tenant's credential for a run that authenticated as another. That pairing is not refused — it cannot be expressed.

## What each step guarantees, and what it does not

**Admission answers authority, not sizing.** Its budget check asks whether the run has anything at all to spend, before the size of any request is known. A parent with one token left admits a child that `RunLedger.openChild` then refuses; that residue is unavoidable, because the child's requested share is not part of the assertion.

**The ledger records, and does not stop anything.** A charge is never refused — a provider bills what it billed, and a charge declined for not fitting would leave the ledger reporting an allowance the run has already used. It reports which dimensions are exhausted instead, and stopping the run is the caller's. A lease is a hold rather than a deadline: expiry releases what a lost run held and does not cancel the work, which belongs to whoever started it.

**The binding confines one invocation.** The CLI enforces its ceiling per invocation, so the allowance is a parameter rather than a field of the run: a caller holding a ledger record passes that record's remaining allowance, and passing the admitted budget every time would give a run a per-call limit instead of a per-run one. Credential isolation is always required, never configurable — every run reaching the binding was admitted for exactly one tenant.

## What is checked rather than asserted

The isolation claim is exercised against an operating system rather than against objects. [`tests/tenant-isolation.spec.ts`](../../packages/control-plane/claude-cli-binding/tests/tenant-isolation.spec.ts) mints, admits, binds, and spawns a real process whose stand-in executable reports the `HOME`, working directory, key, and ceiling it was actually handed: two tenants get two homes, neither process can see the other's secret, and an ambient `CLAUDE_CODE_USE_BEDROCK` does not reach the child while an ordinary ambient variable does. The same file checks that cancelling or abandoning a run reaps both the CLI and a process it started.

[`tests/run-accounting.spec.ts`](../../packages/control-plane/claude-cli-binding/tests/run-accounting.spec.ts) closes the loop the other way — open, launch, charge with the usage and cost the process reported, settle — and [`tests/delegation.spec.ts`](../../packages/control-plane/claude-cli-binding/tests/delegation.spec.ts) runs a child through admission and reservation together.

## Related documentation

- [Candy Runtime Boundaries](../candy-runtime-boundaries.md) — the accepted trust boundaries and abuse cases this group answers to.
- [Multi-tenant CLI agent runtime](../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.md) — the R1–R6 delivery plan, and what remains unbuilt.
- [LLM streaming](llm-streaming.md) — the `TokenUsage` a charge is derived from, including the provider-reported cost.
