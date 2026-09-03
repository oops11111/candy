/**
 * The last step of a run's admission: turning an `AdmittedRun` into the launch
 * facts that confine a Claude CLI process to the tenant it was admitted for.
 *
 * `dsh-run-admission` answers who a run belongs to, which credential it may
 * open, which pool directory it owns, and what it may spend.
 * `dsh-llm-claude-cli` runs a `claude` process under a home directory, an API
 * key, and a spend ceiling. Nothing joined them, so a deployment wiring the two
 * would have had to pick the home, the key, and the ceiling by hand at the one
 * place where a mistake is a cross-tenant leak rather than a bug.
 *
 * This module makes that join a single call whose only run-specific input is
 * the admitted run itself. Every tenant-varying value comes from the admission
 * — the pool root becomes the CLI's `HOME`, the opened secret becomes its key,
 * the admitted budget becomes its spend ceiling — so a caller cannot pair one
 * tenant's identity with another's credential and still type-check.
 *
 * @module @deepseek-ai/dsh-claude-cli-binding
 */

import type { ClaudeCliAdapterOptions } from '@deepseek-ai/dsh-llm-claude-cli'
import type { AdmittedRun } from '@deepseek-ai/dsh-run-admission'
import { hasRemainingBudget, type RunBudget } from '@deepseek-ai/dsh-run-budget'

/** Micro-USD in one US dollar, the unit `RunBudget.costMicroUsd` counts. */
const MICRO_USD_PER_USD = 1_000_000

/**
 * Deployment facts a run does not carry: where the CLI lives, and how long its
 * process tree may take to die. Both are the same for every tenant on one host,
 * which is why neither is read from the admission.
 */
export interface ClaudeCliDeployment {
  /** Absolute path to the `claude` executable this host runs. */
  readonly executable: string
  /** Process-tree termination grace in milliseconds. */
  readonly graceMs: number
}

/**
 * The launch facts, minus the spawn closure the composing plugin supplies.
 *
 * `spawn` is deliberately absent: starting a process is a capability of the
 * application that boots one, not a property of the run, and requiring it here
 * would make describing a launch depend on a subprocess service.
 */
export type ClaudeCliRunBinding = Omit<ClaudeCliAdapterOptions, 'spawn'>

/**
 * Why an admitted run could not be turned into a launch.
 *
 * The first three name a property of the environment variable an opened
 * credential has to become, not of the key: a variable holds no NUL, a value
 * spanning lines reads as two variables wherever an environment is rendered as
 * text, and bytes that are not UTF-8 have no string form to carry.
 *
 * `no-allowance` is the fourth: an invocation with nothing left to spend has no
 * ceiling the CLI would accept, and the caller has already been told the run is
 * exhausted by whatever it charged.
 */
export type ClaudeCliBindingRejection = 'empty' | 'not-utf8' | 'control-characters' | 'no-allowance'

/** The outcome of binding an admitted run to a Claude CLI launch. */
export type ClaudeCliBindingResult =
  | { readonly bound: true; readonly binding: ClaudeCliRunBinding }
  | { readonly bound: false; readonly rejection: ClaudeCliBindingRejection }

/**
 * Decode one opened credential into the exact string an environment variable
 * carries, or name the reason it cannot be one.
 *
 * The vault stores arbitrary bytes, and this is where they first become process
 * environment. A rejected credential is never repaired: a key silently stripped
 * of a byte authenticates as nobody, and that failure would reach an operator
 * as an unexplained provider rejection instead of a named refusal here.
 */
function decodeCredential(secret: Uint8Array): { key: string } | { rejection: ClaudeCliBindingRejection } {
  if (secret.length === 0) return { rejection: 'empty' }
  let key: string
  try {
    key = new TextDecoder('utf-8', { fatal: true }).decode(secret)
  } catch {
    // TextDecoder throws only its own TypeError for a malformed sequence; the
    // decoder is constructed here and cannot be in any other failing state.
    return { rejection: 'not-utf8' }
  }
  return /[\0\r\n]/.test(key) ? { rejection: 'control-characters' } : { key }
}

/**
 * Bind one admitted run to the Claude CLI launch that runs it.
 *
 * The pool root is used verbatim as both `HOME` and the working directory.
 * `runtimePoolRoot` refuses a relative base, so every admitted run carries an
 * absolute one and this module does not re-check it.
 *
 * @param run - the admitted run, whose pool root and secret supply the tenant
 *   identity this launch runs under.
 * @param deployment - the host facts a run does not carry.
 * @param allowance - what THIS invocation may spend, which becomes the CLI's
 *   own ceiling. A run makes one invocation per model call, and the CLI
 *   enforces the ceiling per invocation, so passing the admitted budget every
 *   time would let one run spend its whole allowance once per call. A caller
 *   holding a `dsh-run-ledger` record passes that record's remaining
 *   allowance; a caller making a run's first and only invocation passes
 *   `run.budget`.
 * @returns the launch facts, or the reason the opened credential cannot be
 *   injected.
 */
export function bindClaudeCliRun(
  run: AdmittedRun,
  deployment: ClaudeCliDeployment,
  allowance: RunBudget,
): ClaudeCliBindingResult {
  // An exhausted allowance is refused here rather than left to become a zero
  // ceiling: `claudeCliArguments` rejects one, so a caller that binds a spent
  // run would meet a `RangeError` from inside the adapter at stream time
  // instead of a named refusal at the point it supplied the allowance.
  if (!hasRemainingBudget(allowance)) return { bound: false, rejection: 'no-allowance' }
  const decoded = decodeCredential(run.secret)
  if ('rejection' in decoded) return { bound: false, rejection: decoded.rejection }
  return {
    bound: true,
    binding: {
      executable: deployment.executable,
      // The pool root is the working directory as well as the home. Under
      // `--bare` the CLI reads nothing from the working directory, so this
      // decides only where a process that ignores its arguments lands, and the
      // tenant's own pool is the one place that cannot reach another tenant's.
      cwd: run.poolRoot,
      isolation: { home: run.poolRoot, apiKey: decoded.key },
      graceMs: deployment.graceMs,
      maxBudgetUsd: allowance.costMicroUsd / MICRO_USD_PER_USD,
      // Not a deployment choice. A run that authenticated with anything but the
      // injected key is spending a tenant that did not authorize it, and every
      // run reaching this module was admitted for exactly one tenant.
      requireCredentialIsolation: true,
    },
  }
}
