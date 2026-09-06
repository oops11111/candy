/**
 * Opens a Candy run for a subagent's in-process delegated child, before the
 * child agent exists.
 *
 * `dsh-subagent`'s `SubagentRuntime.onBeforeDelegate()` extension point exists
 * exactly so a consumer can add a concept the driver carries no notion of — a
 * Candy run — without teaching the driver about tenants, budgets, or
 * assertions. It plays the same role `dsh-agent-presets`' `guard()` plays for
 * [`dsh-tenant-preset-policy`](../../tenant-preset-policy/README.md), a
 * roster with no notion of a tenant until a consumer adds one from outside
 * ([precedent](../../../.agents/notes/implemented/architecture/2026-09-06-a-roster-with-no-notion-of-a-tenant.md)).
 * This plugin is that consumer for delegation: it resolves the delegating
 * parent's own open run through `RunScheduler.startChildRun`, requesting the
 * fixed allowance `config.childBudget` names, and refuses the delegation
 * outright when the parent's run cannot fund it or is not usable — a
 * delegated child never starts unfunded, or past a run the control plane has
 * already flagged as broken, once this plugin is loaded.
 *
 * A parent with no open Candy run at all (a plain `dsh` session, outside
 * Candy) is left alone: this plugin has nothing to enforce for a session the
 * control plane never funded in the first place, matching
 * `dsh-tenant-preset-policy`'s own default for the same case.
 *
 * @module @deepseek-ai/dsh-run-delegation
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { RunBudget } from '@deepseek-ai/dsh-run-budget'
import type { RunStartRejection } from '@deepseek-ai/dsh-run-start'
import type { SessionRunRejection } from '@deepseek-ai/dsh-run-scheduler'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import { assertNever } from '@deepseek-ai/dsh-util-values'

/** The fixed allowance every delegated child is opened with. */
export interface Config {
  /**
   * The fixed `RunBudget` requested for every delegated child, regardless of
   * which tool or provider started the delegation. Refused, never clamped,
   * when the parent's own remaining allowance is short in any dimension.
   */
  readonly childBudget: RunBudget
}

/** Non-negative safe integer, matching `dsh-run-budget`'s own `RunBudget` field constraint. */
const naturalCount = (): z<number> => z.natural().max(Number.MAX_SAFE_INTEGER)

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  childBudget: z.object({
    tokens: naturalCount(),
    wallMs: naturalCount(),
    costMicroUsd: naturalCount(),
    children: naturalCount(),
  }),
})

/** Cordis plugin name used by loader diagnostics. */
export const name = 'run-delegation'

/** Services this plugin reads: the delegation hook, and the scheduler that mints a child's run. */
export const inject = ['subagents', 'runScheduler']

/**
 * Render why the parent's own run could not be resolved to mint a child from.
 * The caller handles `no-open-run` itself before reaching this function.
 */
function describeSessionRejection(rejection: Exclude<SessionRunRejection, { reason: 'no-open-run' }>): string {
  switch (rejection.reason) {
    case 'claimed-by-several':
      return `the delegating session is claimed by ${String(rejection.runIds.length)} open runs, `
        + 'so a child cannot be minted from one'
    case 'account-unusable':
      return `run '${rejection.runId}' account can no longer authorize work, so it cannot fund a child`
    /* v8 ignore next 2 -- the excluded type above leaves only these two variants. */
    default:
      assertNever(rejection, 'run-delegation.describeSessionRejection')
  }
}

/**
 * Render why admission or the ledger refused to fund the minted child run.
 *
 * A minted child's claims are copied from its own parent's already-admitted
 * record and carry a freshly generated run id and nonce, so most of what
 * `RunRejection` and `RunLedgerRejection` name guards a forged, replayed,
 * mismatched, or stale token this call site never produces. Two outcomes are
 * reachable and named exactly: the delegating tenant's own allowance is
 * exhausted, or the parent cannot fund the configured request.
 *
 * Admission's `session` stage is reachable too, through the one child the
 * caller's own already-funded check cannot recognize: a child session that
 * several open runs claim resolves to no single run, so this asks for one
 * more and admission refuses it. The generic tail names that stage rather
 * than pretending it cannot happen.
 */
function describeStartRejection(rejection: RunStartRejection): string {
  /* v8 ignore if -- unreachable from this call site; see the comment above. */
  if (rejection.stage === 'admission' && rejection.rejection.stage !== 'budget') {
    return `admission refused the child run at stage '${rejection.rejection.stage}'`
  }
  if (rejection.stage === 'admission') {
    return `the parent's tenant allowance is ${rejection.rejection.reason} for this delegation`
  }
  /* v8 ignore if -- unreachable from this call site; see the comment above. */
  if (rejection.rejection.reason !== 'parent-exhausted') {
    return `the ledger refused the child run (${rejection.rejection.reason})`
  }
  const { dimension, requested, available } = rejection.rejection.denial
  return `the parent's remaining ${dimension} (${String(available)}) is less than `
    + `the configured child ${dimension} request (${String(requested)})`
}

/**
 * Register the child-run opener against `SubagentRuntime.onBeforeDelegate()`,
 * and the closer against the settlement that ends the epoch it opened.
 * @param ctx - context carrying `subagents` and `runScheduler`.
 * @param config - the fixed allowance a delegated child is opened with.
 */
export function apply(ctx: Context, config: Config): void {
  // Closing belongs after publication, where opening could not: the run this
  // settles is the one this plugin opened, and holding it until the lease
  // lapsed would keep the parent's allowance and one of its concurrency slots
  // for minutes after the child stopped using them — a parent delegating in
  // sequence would run out of slots no child still holds.
  ctx.on('subagent/end', (info) => {
    /* v8 ignore next 3 -- the settlement's own durable write is what fails here;
     * the scheduler leaves the run open for its next sweep either way, so this
     * reports rather than retries, as that sweep's own failure already does. */
    void ctx.runScheduler.closeSessionRun(info.id).catch((error: unknown) => {
      ctx.logger.warn(`run-delegation: closing the run of settled child '${info.id}' failed: ${String(error)}`)
    })
  }, { global: true })
  ctx.effect(() => ctx.subagents.onBeforeDelegate(async (parent: Agent, childId: SessionId) => {
    // A continuable child is prepared on every residency epoch, and one that
    // resumes before its previous run's lease lapses still has that run. A
    // second run for one session is refused at admission, so the funded child
    // is left with the run it already has.
    if (ctx.runScheduler.tenantOf(childId) !== undefined) return
    const result = await ctx.runScheduler.startChildRun(parent.id, childId, () => config.childBudget)
    if (!result.ok) {
      // No Candy run governs this parent at all: nothing here to enforce.
      if (result.rejection.reason === 'no-open-run') return
      throw new Error(`delegation refused: ${describeSessionRejection(result.rejection)}`)
    }
    if (!result.outcome.started) {
      throw new Error(`delegation refused: ${describeStartRejection(result.outcome.rejection)}`)
    }
    // This run was opened for a child that does not exist yet. An epoch that
    // never publishes one settles it here instead of leaving it to a lease,
    // since no `subagent/end` will ever name a child that was not created.
    return async () => void await ctx.runScheduler.closeSessionRun(childId)
  }), 'run-delegation.onBeforeDelegate()')
}
