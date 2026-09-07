/**
 * Registers a Claude CLI `dsh-llm` route whose credential and pool are
 * resolved per call from the Candy run driving the request's session.
 *
 * `dsh-llm-claude-cli`'s own composition constructs one `ClaudeCliAdapter` per
 * process, holding one tenant's isolation on the instance — correct for a
 * single-tenant deployment, and the reason its own README states the loop
 * cannot use it as a shared route. `dsh-run-scheduler` answers "which run
 * drives this session" fresh on every call, through `runIdentityFor`, which is
 * exactly what a per-call `ClaudeCliAdapter` needs and a per-process one
 * cannot express. This module is the join: one route, resolved a tenant at a
 * time, so a multi-tenant runtime mounts it once rather than constructing and
 * disposing an adapter per pool by hand.
 *
 * Termination is joined the same way. `runIdentityFor` never caches the
 * credential it opens, and `RunScheduler.disposableSpawn` ties the process
 * this route starts to the run's own settlement, so ending the run for cause —
 * a revoked account, an expired lease, a tree closed around it — reaches the
 * process this route is the first thing to ever construct for it.
 *
 * @module @deepseek-ai/dsh-claude-cli-route
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { bindClaudeCliCredential, type ClaudeCliDeployment } from '@deepseek-ai/dsh-claude-cli-binding'
import { LlmAdapter, LlmError, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { ClaudeCliAdapter } from '@deepseek-ai/dsh-llm-claude-cli'
import { CREDENTIAL_REVOKED, RUN_NOT_OPEN } from '@deepseek-ai/dsh-run-metering'
import type { RunIdentityRejection, RunScheduler } from '@deepseek-ai/dsh-run-scheduler'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

export const name = 'claude-cli-route'
export const inject = ['llm', 'subprocess', 'runScheduler']

/** Provider route this plugin serves. Distinct provider CLIs are distinct packages, not a configurable name. */
export const PROVIDER = 'claude-cli'

/** Machine code: the request carries no session, so no Candy run can be resolved for it. */
export const NO_SESSION_CODE = 'NO_SESSION'
/** Machine code: the run's account authenticates a different provider than this route serves. */
export const PROVIDER_MISMATCH_CODE = 'PROVIDER_MISMATCH'
/** Machine code: the run's credential exists but could not be opened. */
export const CREDENTIAL_UNAVAILABLE_CODE = 'CREDENTIAL_UNAVAILABLE'
/** Machine code: the opened credential or the run's remaining budget could not be turned into a launch. */
export const BINDING_REFUSED_CODE = 'BINDING_REFUSED'

/** Deployment-varying facts for this host's Claude CLI, the same for every tenant it runs. */
export interface Config {
  /** Absolute path to the `claude` executable; defaults to `claude` on PATH. */
  executable?: string
  /** Process-tree termination grace in milliseconds. */
  graceMs?: number
  /** Most stdout bytes one run may write before it is failed and reaped. */
  maxOutputBytes?: number
  /** Most stderr bytes to keep from one run, as that stream's tail. */
  maxStderrBytes?: number
}

export const Config: z<Config> = z.object({
  executable: z.string().default('claude'),
  graceMs: z.number().step(1).min(1).default(5_000),
  maxOutputBytes: z.number().step(1).min(1).default(16 * 1024 * 1024),
  maxStderrBytes: z.number().step(1).min(1).default(8 * 1024),
})

/** The narrow slice of `RunScheduler` this route calls; see that package for the full contract. */
export type SessionRunIdentitySource = Pick<RunScheduler, 'runIdentityFor' | 'disposableSpawn'>

/** What this adapter needs beyond the request itself. */
export interface SessionRoutedClaudeCliOptions {
  /** Host facts every tenant's launch shares. */
  readonly deployment: ClaudeCliDeployment
  /** Resolves a session to its run's launch identity, and ties a spawn to that run's lifetime. */
  readonly scheduler: SessionRunIdentitySource
  /** Starts the process; the caller's own subprocess service, unwrapped. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
}

/** Map a resolution failure to the refusal a caller reads from `dsh-llm`. */
function refusalFor(rejection: RunIdentityRejection): LlmError {
  switch (rejection.reason) {
    case 'no-open-run':
      return new LlmError('claude-cli route: this session has no open Candy run to authenticate as', RUN_NOT_OPEN)
    case 'claimed-by-several':
      return new LlmError(
        `claude-cli route: this session is claimed by ${String(rejection.runIds.length)} open runs, `
          + 'so it cannot be authenticated as one',
        RUN_NOT_OPEN,
      )
    case 'account-unusable':
      return new LlmError(
        `claude-cli route: run '${rejection.runId}' account can no longer authorize work`,
        CREDENTIAL_REVOKED,
      )
    case 'no-credential':
      return new LlmError(
        `claude-cli route: run '${rejection.runId}' account has no stored credential to open`,
        CREDENTIAL_UNAVAILABLE_CODE,
      )
    default:
      // The remaining variants are dsh-credential-vault's CredentialRejection
      // values (revoked, unknown-key, binding-mismatch, unsupported-version,
      // corrupt); none is this route's to distinguish further.
      return new LlmError(
        `claude-cli route: run '${rejection.runId}' credential could not be opened: ${rejection.reason}`,
        CREDENTIAL_UNAVAILABLE_CODE,
      )
  }
}

/**
 * Serves one Claude CLI call, resolved to the tenant driving the request's
 * session at the moment the call is made.
 *
 * Every call is independent: nothing here is retained between two calls of
 * even the same run, so a credential opened for one call is never reused for
 * the next, and a run whose account is revoked between two calls has its
 * second call refused rather than served on a stale secret. Only one route
 * name is ever registered per instance, so two tenants calling the same route
 * never share a `ClaudeCliAdapter` — each call constructs and discards its own.
 */
export class SessionRoutedClaudeCliAdapter extends LlmAdapter {
  constructor(private readonly options: SessionRoutedClaudeCliOptions) {
    super()
  }

  /**
   * @param options - the fully-assembled request; `options.sessionId` names
   *   the Candy run this call authenticates as.
   * @throws LlmError when the session names no run, the run's account cannot
   *   authorize work, its credential cannot be opened, or its account is for a
   *   provider other than {@link PROVIDER}.
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.sessionId === undefined) {
      throw new LlmError('claude-cli route: a request with no session cannot be resolved to a Candy run', NO_SESSION_CODE)
    }
    const identity = await this.options.scheduler.runIdentityFor(options.sessionId)
    if (!identity.ok) throw refusalFor(identity.rejection)
    const { value } = identity
    if (value.provider !== PROVIDER) {
      throw new LlmError(
        `claude-cli route: run '${value.runId}' authenticates a '${value.provider}' account, not '${PROVIDER}'`,
        PROVIDER_MISMATCH_CODE,
      )
    }
    const bound = bindClaudeCliCredential(value.secret, value.poolRoot, this.options.deployment, value.remaining)
    if (!bound.bound) {
      throw new LlmError(
        `claude-cli route: run '${value.runId}' could not be bound to a launch: ${bound.rejection}`,
        BINDING_REFUSED_CODE,
      )
    }
    const adapter = new ClaudeCliAdapter({
      ...bound.binding,
      spawn: this.options.scheduler.disposableSpawn(value.runId, this.options.spawn),
    })
    yield* adapter.stream(options)
  }
}

/**
 * Resolve one configuration into the deployment facts every launch shares.
 *
 * Schemastery fills every defaulted field for a `cordis.yml` composition, but
 * a programmatic one may bypass it, so defaulting happens here — one explicit
 * step with a result — rather than as fallbacks scattered through `apply`.
 * @param config - the route's configuration, as written or as normalized.
 * @returns the deployment facts {@link bindClaudeCliCredential} binds against.
 */
export function resolveDeployment(config: Config): ClaudeCliDeployment {
  return {
    executable: config.executable ?? 'claude',
    graceMs: config.graceMs ?? 5_000,
    maxOutputBytes: config.maxOutputBytes ?? 16 * 1024 * 1024,
    maxStderrBytes: config.maxStderrBytes ?? 8 * 1024,
  }
}

/**
 * Register the Claude CLI route for this composition's configuration.
 * @param ctx - the plugin fiber's context, carrying `llm`, `subprocess`, and `runScheduler`.
 * @param config - this host's Claude CLI executable and process-lifetime facts.
 */
export function apply(ctx: Context, config: Config): void {
  const adapter = new SessionRoutedClaudeCliAdapter({
    deployment: resolveDeployment(config),
    scheduler: ctx.runScheduler,
    spawn: spec => ctx.subprocess.spawn(spec),
  })
  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], adapter))
}
