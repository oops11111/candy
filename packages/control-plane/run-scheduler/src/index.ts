/**
 * The Candy runtime's scheduler: one place that holds a runtime's live run
 * state and performs the control-plane order for a request.
 *
 * Everything it composes already existed as a library. What did not exist was
 * an owner: the ledger was a per-runtime object nothing held, admission's
 * ports had to be assembled by hand at every call site, and
 * `RunLedger.expire` was a call no clock made — a run abandoned without
 * settling held its parent's allowance until someone thought to reclaim it.
 *
 * It is where a tenant's durable allowance and its live runs meet, and that
 * meeting is the whole of Candy's tenant-level bound. `ControlPlaneStore`
 * holds a grant and what settled runs consumed of it but knows nothing of what
 * is running; the ledger holds what is running but knows nothing of the
 * tenant. Read on its own, either half admits a run it should refuse: a grant
 * with no consumption subtracted funds every run a tenant ever starts, and a
 * ledger with no tenant above it lets unrelated trees each hold the whole
 * allowance at once.
 *
 * It also meters the provider streams a run makes, which is where an allowance
 * stops being an accounting figure: a call is refused before the provider is
 * reached when the run has nothing left, and cut when it outruns the wall time
 * the run still had.
 *
 * Its records are durable, and every settlement is exactly-once across a crash.
 * A settlement is two writes the medium cannot make one — charge whoever funded
 * the run, then forget the run — so each charge is written into the funder's own
 * record together with the id of the run it absorbed, and a repeat of that id is
 * a no-op. A restarting runtime therefore re-drives an interrupted settlement
 * without knowing how far it got. That guarantee needs one settlement at a time,
 * which is why every write to a run record queues on one chain here.
 *
 * The order queued requests run in is still a decision nothing here makes:
 * this starts the run a caller asks for, or says which step refused it.
 *
 * @module @deepseek-ai/dsh-run-scheduler
 */

import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import { RunId, type ProviderAccountId, type ProviderKind, type UserId, type WorkspaceGrantId } from '@deepseek-ai/dsh-control-plane'
import {
  assembleKeyring,
  openCredential,
  type CredentialAuditEvent,
  type CredentialKeyring,
  type CredentialRejection,
} from '@deepseek-ai/dsh-credential-vault'
import { mintExecutionAssertion, type ExecutionAssertionClaims } from '@deepseek-ai/dsh-execution-assertion'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { isProviderAccountUsable, type ProviderAccountRecord } from '@deepseek-ai/dsh-provider-accounts'
import { runtimePoolKey, runtimePoolRoot } from '@deepseek-ai/dsh-runtime-pool'
import type { SubprocessLaunched } from '@deepseek-ai/dsh-subprocess'
import type { ToolAuthorizationDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { CREDENTIAL_REVOKED, meterRun, refusedCall, RUN_NOT_OPEN } from '@deepseek-ai/dsh-run-metering'
import type { RunAdmissionPolicy } from '@deepseek-ai/dsh-run-admission'
import type { RunBudget, RunSpend } from '@deepseek-ai/dsh-run-budget'
import { RunLedger, type RunChargeResult, type RunLedgerResult, type RunRecord, type RunSettlement } from '@deepseek-ai/dsh-run-ledger'
import { startRun, type RunStartOutcome, type RunStartRejection } from '@deepseek-ai/dsh-run-start'
import { remainingAllowance } from '@deepseek-ai/dsh-tenant-allowance'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import {
  runtimeSubject,
  tenantSubject,
  type AuditSubject,
  type DurableRunRecord,
  type RunAuditRecord,
} from '@deepseek-ai/dsh-control-plane-store'

declare module '@deepseek-ai/cordis' {
  interface Context {
    runScheduler: RunScheduler
  }
}

/** Deployment-varying facts for one Candy runtime's scheduler. */
export interface Config {
  /** Control plane whose assertions this runtime admits. */
  issuer: string
  /** This runtime's own audience identifier; an assertion for another is refused. */
  audience: string
  /** Longest issued-to-expiry span this runtime admits, in milliseconds. */
  maxLifetimeMs?: number
  /** Environment variable holding the assertion HMAC secret, at least 32 bytes. */
  assertionSecretEnv?: string
  /** Environment variable holding the credential key, exactly 32 bytes. */
  credentialKeyEnv?: string
  /** Keyring version the credential key is registered under. */
  credentialKeyVersion: string
  /**
   * Key versions this runtime still opens, beside the current one.
   *
   * A rotation changes `credentialKeyVersion` and the key behind it, and every
   * envelope already sealed names the version it was sealed under. Without the
   * retired key the runtime cannot open any of them: each tenant is locked out
   * of the account it configured until the old value is put back. Retaining
   * the old version is what makes a rotation a migration rather than an
   * outage — a retired key is dropped once every envelope has been rewrapped.
   */
  retiredCredentialKeys?: RetiredCredentialKey[]
  /** Absolute directory holding every runtime pool's root; the deployment provisions it. */
  poolBase: string
  /** How long an unsettled run holds its allowance before `expire` releases it. */
  leaseMs?: number
  /** How often the clock releases expired holds and drops spent-nonce records. */
  sweepMs?: number
  /** How many ended sessions this runtime remembers, so their calls stay refused. */
  endedSessionMemory?: number
  /** Most audit records kept per tenant, and per runtime for attempts that named none. */
  auditRetention?: number
}

/** One key version a rotation left behind, and where its key is read from. */
export interface RetiredCredentialKey {
  /** Version the envelopes sealed under this key name. */
  version: string
  /** Environment variable holding that key, exactly 32 bytes. */
  env: string
}

/**
 * The config after the Loader applied {@link RunScheduler.Config}: every
 * optional field is filled, so nothing inside re-decides a default.
 */
type ResolvedConfig = Required<Config>

/** Why a session did not resolve to one open, usable run. */
export type SessionRunRejection =
  /** No run of this runtime's is open for the session. */
  | { readonly reason: 'no-open-run' }
  /** More than one open run names this session, so neither can be charged unambiguously. */
  | { readonly reason: 'claimed-by-several'; readonly runIds: readonly RunId[] }
  /** The run's account can no longer authorize work — most often, it was revoked. */
  | { readonly reason: 'account-unusable'; readonly runId: RunId; readonly accountId: ProviderAccountId }

/** One session's open run and its usable account, or why neither is available. */
export type SessionRunResult =
  | { readonly ok: true; readonly run: DurableRunRecord; readonly account: ProviderAccountRecord }
  | { readonly ok: false; readonly rejection: SessionRunRejection }

/**
 * What a provider binding needs to launch one call for an open run: an opened
 * credential, the pool directory it may use, and what this call may still
 * spend.
 */
export interface RunIdentity {
  /** The run this identity was resolved for. */
  readonly runId: RunId
  /** The account's own provider name, for a binding to check against its own. */
  readonly provider: ProviderKind
  /** The tenant's runtime pool root; used as both `HOME` and the working directory. */
  readonly poolRoot: string
  /** The opened provider credential. The caller owns its lifetime and must not retain it past this call. */
  readonly secret: Uint8Array
  /** What this run may still spend, for a binding to use as this invocation's own ceiling. */
  readonly remaining: RunBudget
}

/** Why a run's launch identity could not be resolved. */
export type RunIdentityRejection =
  | SessionRunRejection
  /** The account exists but this store holds no sealed credential for it — a storage inconsistency. */
  | { readonly reason: 'no-credential'; readonly runId: RunId; readonly accountId: ProviderAccountId }
  /** The account's sealed credential could not be opened. */
  | { readonly reason: CredentialRejection; readonly runId: RunId; readonly accountId: ProviderAccountId }

/** The outcome of resolving a session's run into a launch identity. */
export type RunIdentityResult =
  | { readonly ok: true; readonly value: RunIdentity }
  | { readonly ok: false; readonly rejection: RunIdentityRejection }

/**
 * The outcome of {@link RunScheduler.startChildRun}: `ok: false` only when the
 * PARENT session itself could not be resolved to one open run — once minting
 * proceeds, admission's own decision (started, or a named refusal) travels
 * inside `outcome`, exactly as {@link RunScheduler.start} already reports it.
 */
export type StartChildRunResult =
  | { readonly ok: true; readonly outcome: RunStartOutcome }
  | { readonly ok: false; readonly rejection: SessionRunRejection }

/** An assertion this runtime mints for itself is valid only long enough to admit immediately: it is never transmitted or persisted. */
const MINTED_CHILD_ASSERTION_LIFETIME_MS = 60_000

/**
 * Read one required secret from the environment.
 * @throws Error when the variable is unset or empty, which is a deployment
 *   error rather than a denied run.
 */
function requireSecret(environment: Readonly<Record<string, string | undefined>>, name: string): Buffer {
  const value = environment[name]
  if (value === undefined || value.length === 0) {
    throw new Error(`dsh-run-scheduler: ${name} is not set, so this runtime has no key to verify with`)
  }
  return Buffer.from(value, 'utf8')
}

/**
 * Live run state for one Candy runtime, and the composition that starts a run.
 *
 * One instance owns one ledger, so every run this runtime admits is accounted
 * against the same delegation trees. Spent nonces instead belong to the
 * durable control-plane store and are shared across runtime processes.
 */
export class RunScheduler extends Service {
  static inject = ['controlPlaneStore', 'timer']

  /**
   * Deployment-varying facts, validated at load.
   *
   * Binding the schema here is what makes the required fields required: a
   * runtime whose `audience` is absent would otherwise start and admit
   * assertions addressed to nobody.
   */
  static Config: z<Config> = z.object({
    issuer: z.string().required(),
    audience: z.string().required(),
    maxLifetimeMs: z.number().step(1).min(1).default(60_000),
    assertionSecretEnv: z.string().role('credential-ref').default('CANDY_ASSERTION_SECRET'),
    credentialKeyEnv: z.string().role('credential-ref').default('CANDY_CREDENTIAL_KEY'),
    credentialKeyVersion: z.string().required(),
    retiredCredentialKeys: z.array(z.object({
      version: z.string().required(),
      env: z.string().role('credential-ref').required(),
    })).default([]),
    poolBase: z.string().required(),
    leaseMs: z.number().step(1).min(1).default(300_000),
    sweepMs: z.number().step(1).min(1).default(30_000),
    endedSessionMemory: z.number().step(1).min(1).default(1_000),
    auditRetention: z.number().step(1).min(1).default(200),
  })

  /** Open runs and their holds, for every tree this runtime is running. */
  readonly ledger: RunLedger = new RunLedger()

  /**
   * The one chain every decision this runtime acts on queues behind.
   *
   * Two things need it. A settlement charges its funder and then forgets the
   * run, and the marker that makes the charge repeatable holds only while no
   * other write to those two records interleaves. And a start reads what a
   * tenant has left, then opens a run that consumes it — two concurrent starts
   * that both read before either opened would each be admitted against the
   * whole remainder, and the tenant would hold twice its grant.
   *
   * So the chain orders whole operations, not writes: the state a decision was
   * made from cannot change before that decision is applied.
   */
  private serial: Promise<unknown> = Promise.resolve()

  /**
   * Sessions whose run this instance settled, most recently ended last.
   *
   * A run ends while the agent driving its session may still be alive — a
   * lease that expired under a working agent is exactly that case — and the
   * run record is gone by then, so a request naming that session would look
   * like one this runtime never had and pass through unmetered. The run that
   * was cut off for outliving its lease would run for free.
   *
   * This is a bounded cache. The control-plane store retains session ownership
   * after settlement, so eviction and restart do not remove the restriction.
   */
  private readonly ended = new Set<SessionId>()

  /** Per run, the call that must end before the next one may read its remainder. */
  private readonly callLines = new Map<RunId, Promise<void>>()

  /**
   * Per run, the disposer that releases whatever live resource its ledger
   * record has no reach into — a spawned process, most concretely.
   *
   * A run ends here as accounting: `settle` writes a charge and forgets the
   * record. Nothing in that write reaches what the run actually started, so a
   * run ended for cause — a revoked account, an expired lease, a tree closed
   * around it — left its process running with no accounting left to stop it.
   * This is that reach, registered by whatever holds the resource and invoked
   * once, by `settle`, whichever way the run ends.
   */
  private readonly disposers = new Map<RunId, () => void | Promise<void>>()

  /**
   * The run whose metered call the current asynchronous work belongs to.
   *
   * A provider process is started deep inside an adapter, with no session and
   * no run of its own to name. What it does have is a place in the call that
   * started it, and this carries the run across that distance.
   *
   * The scope is entered around each pull rather than around the stream: an
   * async generator's body runs when its consumer asks for a chunk, in the
   * consumer's context and not the one the generator was created in, so a
   * scope wrapped around creation reaches none of the body.
   */
  private readonly metered = new AsyncLocalStorage<RunId>()

  private readonly keyring: CredentialKeyring
  private readonly assertionSecret: Buffer

  private readonly config: ResolvedConfig

  constructor(ctx: Context, config: Config) {
    super(ctx, 'runScheduler')
    this.config = RunScheduler.Config(config) as ResolvedConfig
    const environment = process.env
    this.assertionSecret = requireSecret(environment, this.config.assertionSecretEnv)
    this.keyring = assembleKeyring({
      component: 'dsh-run-scheduler',
      environment,
      currentVersion: this.config.credentialKeyVersion,
      currentEnv: this.config.credentialKeyEnv,
      retired: this.config.retiredCredentialKeys,
    })
  }

  /**
   * Finish what a previous process left, then start the clock.
   *
   * Cordis awaits this before the service is reachable, so no run is admitted
   * against an allowance that still counts an interrupted settlement.
   */
  protected async [Service.init](): Promise<void> {
    await this.recover()
    // Every model request the harness assembles carries the session it was
    // assembled for, which is the only thing a provider stream and an admitted
    // run have in common. A request naming no session of this runtime's is not
    // this runtime's to charge and passes through untouched.
    this.ctx.on('llm/stream', (options: GenerateOptions, next) => this.meterRequest(options, next), {
      global: true,
      prepend: true,
    })
    // A provider process is started deep inside an adapter, so what it belongs
    // to is the metered call it was started during. A launch with no such call
    // — the harness's own bash or language-server children — is left alone:
    // it belongs to no tenant, and filing it would push a tenant's records out
    // of a trail bounded per subject.
    this.ctx.on('subprocess/launched', (launch) => { this.fileLaunch(launch) }, { global: true })
    this.ctx.on('tools/authorization', (execution, decision) => this.fileToolAuthorization(execution, decision), {
      global: true,
    })
    this.ctx.interval(() => {
      // A sweep now writes to the medium, and a rejected write must not become
      // an unhandled rejection that takes the runtime down: the holds it failed
      // to charge are already released, and the next sweep runs regardless.
      this.sweep(Date.now()).catch((error: unknown) => {
        this.ctx.logger.warn(`run-scheduler: sweep failed to settle: ${String(error)}`)
      })
    }, this.config.sweepMs)
  }

  /**
   * Admit one request, fund the run it names, and place it in its pool.
   *
   * @param token - the execution assertion exactly as received.
   * @param share - the allowance to open the run with; a root run is normally
   *   opened with what admission answered, and a child with the share its
   *   parent delegates.
   * @param now - epoch milliseconds; defaults to this runtime's clock.
   * @returns the started run, or the step that refused it, with every audit
   *   record the attempt produced.
   */
  start(
    token: string,
    share: (run: { budget: RunBudget }) => RunBudget = run => run.budget,
    now: number = Date.now(),
  ): Promise<RunStartOutcome> {
    return this.queue(() => this.admitAndOpen(token, share, now))
  }

  /**
   * Admit, fund, place and record one run, with nothing else interleaving.
   *
   * Every check this performs reads state a later step changes: the tenant's
   * remainder, the parent's allowance, the session's holder. Running under the
   * chain is what makes each of them decide about the state its own hold is
   * then taken from.
   */
  private async admitAndOpen(
    token: string,
    share: (run: { budget: RunBudget }) => RunBudget,
    now: number,
  ): Promise<RunStartOutcome> {
    const outcome = await startRun({ token }, this.policy(), {
      ledger: this.ledger,
      share,
      leaseExpiresAt: now + this.config.leaseMs,
    }, now)
    if (!outcome.started) {
      await this.record(outcome, now)
      return outcome
    }
    const { claims } = outcome.value.run
    // `startRun` opened the ledger record, so the ledger has it.
    // oxlint-disable-next-line typescript/no-non-null-assertion -- the comment above states the invariant
    const record = this.ledger.get(claims.runId)!
    try {
      // Called directly: this already runs under the chain, and queueing
      // behind itself would never resolve.
      await this.ctx.controlPlaneStore.openRun({
        record,
        userId: claims.userId,
        sessionId: claims.sessionId,
        accountId: claims.accountId,
        deviceId: claims.deviceId,
        workspaceGrantId: claims.workspaceGrantId,
        conversationId: claims.conversationId,
        runtime: this.config.audience,
        settledSpent: undefined,
        absorbed: undefined,
      })
      this.ended.delete(claims.sessionId)
    } catch (unwritable) {
      // The record was opened a moment ago and has spent nothing, so closing it
      // returns a child's whole hold to its parent at once. A run this runtime
      // cannot write down is a run a restart would forget while its provider
      // kept spending, so the medium failure keeps travelling.
      this.ledger.close(claims.runId)
      throw unwritable
    }
    await this.record(outcome, now)
    return outcome
  }

  /**
   * Record what one run consumed since its last charge.
   * @param runId - the open run.
   * @param spend - what the invocation consumed.
   * @returns the updated record and the dimensions now used up, or why the
   *   charge was refused.
   */
  charge(runId: RunId, spend: RunSpend): Promise<RunLedgerResult<RunChargeResult>> {
    return this.queue(async () => {
      const charged = this.ledger.charge(runId, spend)
      if (!charged.ok) return charged
      await this.ctx.controlPlaneStore.recordRunSpend(runId, charged.value.record.spent)
      return charged
    })
  }

  /**
   * Resolve the one open, usable run driving a session.
   *
   * A model request carries the session it was assembled for, and an
   * execution assertion names the session its run drives, so this is the one
   * lookup both metering and a provider binding's per-call identity are built
   * on. The account is read fresh rather than trusted from admission — a run
   * opens its credential once and holds it, so revoking the account destroys
   * the stored envelope without reaching a process already authenticated with
   * it, and reading the record per call is what makes a revocation stop work
   * already under way.
   * @param sessionId - the session a request or a launch names.
   * @returns the run and its usable account, or the reason neither is available.
   */
  private findSessionRun(sessionId: SessionId): SessionRunResult {
    const open = this.ctx.controlPlaneStore.runsOfSession(this.config.audience, sessionId)
    if (open.length === 0) return { ok: false, rejection: { reason: 'no-open-run' } }
    if (open.length > 1) {
      return { ok: false, rejection: { reason: 'claimed-by-several', runIds: open.map(run => run.record.runId) } }
    }
    // The length check above establishes the entry.
    // oxlint-disable-next-line typescript/no-non-null-assertion -- the comment above states the invariant
    const run = open[0]!
    const account = this.ctx.controlPlaneStore.accountOf(run.accountId)
    if (account === undefined || !isProviderAccountUsable(account)) {
      return { ok: false, rejection: { reason: 'account-unusable', runId: run.record.runId, accountId: run.accountId } }
    }
    return { ok: true, run, account }
  }

  /**
   * The tenant of a session's one open, usable run.
   *
   * Synchronous, unlike {@link runIdentityFor}: resolving a tenant reads the
   * same in-memory run index {@link findSessionRun} already reads for
   * metering and requires no credential open, so a caller wiring a
   * synchronous policy hook elsewhere in the harness — an `AgentPresets`
   * guard, for instance — can consult it directly instead of threading a
   * `Promise` through a call path that has no other reason to be async.
   * @param sessionId - the session naming the run to resolve.
   * @returns the run's tenant, or `undefined` when this runtime has no
   *   single open, usable run for that session.
   */
  tenantOf(sessionId: SessionId): UserId | undefined {
    const resolved = this.findSessionRun(sessionId)
    return resolved.ok ? resolved.run.userId : undefined
  }

  /**
   * Persist one final route-policy refusal for a managed session.
   *
   * The write settles before this promise does and never rejects, matching
   * metering refusal ordering: callers may report the denial only after the
   * trail has it, while an unavailable trail cannot turn a refusal into an
   * authorization success or a different failure.
   * @param sessionId - session whose route was refused.
   * @param code - stable policy failure code.
   * @param message - refusal text used if the audit write must be logged.
   */
  recordRouteRefusal(sessionId: SessionId, code: string, message: string): Promise<void> {
    const resolved = this.findSessionRun(sessionId)
    return this.fileRefusal(resolved.ok ? resolved.run.record.runId : undefined, code, message, 'route')
  }

  /**
   * Meter one assembled request against the run whose session it names.
   *
   * A request with no session, or one naming no run this runtime has open,
   * is not this runtime's to charge and is passed through. A session that two
   * open runs both claim is refused: the control plane minted two runs for one
   * session, and charging either tree is a misbilling a caller cannot detect.
   */
  private meterRequest(
    options: GenerateOptions,
    next: () => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> {
    if (options.sessionId === undefined) return next()
    const resolved = this.findSessionRun(options.sessionId)
    if (resolved.ok) {
      const source = next()
      return this.routeAndMeter(resolved.run, options, source)
    }
    const { rejection } = resolved
    switch (rejection.reason) {
      case 'no-open-run': {
        if (!this.ended.has(options.sessionId)
          && !this.ctx.controlPlaneStore.isManagedSession(options.sessionId, this.config.audience)) return next()
        return this.refuse(
          undefined,
          `session '${options.sessionId}' has no open run: the run driving it has ended`,
          RUN_NOT_OPEN,
        )
      }
      case 'claimed-by-several': {
        return this.refuse(
          undefined,
          `session '${options.sessionId}' is claimed by ${String(rejection.runIds.length)} open runs `
            + `(${rejection.runIds.join(', ')}), so this call cannot be charged to one`,
          RUN_NOT_OPEN,
        )
      }
      case 'account-unusable': {
        return this.refuse(
          rejection.runId,
          `account '${rejection.accountId}' can no longer authorize work, so run '${rejection.runId}' may not spend it`,
          CREDENTIAL_REVOKED,
        )
      }
      /* v8 ignore next 2 -- SessionRunRejection is closed and every variant is handled above. */
      default:
        assertNever(rejection, 'RunScheduler.meterRequest')
    }
  }

  /**
   * Meter one provider stream against an open run.
   *
   * This is where an allowance stops being an accounting figure. The call is
   * refused before the provider is reached when the run has nothing left, cut
   * when it outruns the wall time the run still had, and charged — durably —
   * before its terminal chunk reaches the consumer, so the next call is
   * admitted against a ledger that already knows about this one.
   *
   * A cut ends the call, not the run: the record stays open with what the call
   * consumed, and whoever started the run decides what happens next.
   * @param runId - the open run this call belongs to.
   * @param source - the provider's stream for one call.
   * @returns the same chunks, ending early when the run cannot afford the rest.
   */
  meter(runId: RunId, source: AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    return this.oneCallAtATime(runId, () => meterRun(source, runId, {
      remaining: id => this.ledger.remaining(id),
      charge: (id, spend) => this.charge(id, spend),
      refused: (id, code, message) => this.fileRefusal(id, code, message),
    }))
  }

  /** Record the final waterfall-selected route before its managed stream reaches the provider. */
  private async * routeAndMeter(
    run: DurableRunRecord,
    options: GenerateOptions,
    source: AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> {
    await this.fileRoute(run, options.provider, options.model)
    yield* this.meter(run.record.runId, source)
  }

  /**
   * Resolve what a provider binding needs to launch one call for the run
   * driving a session: an opened credential, the pool it may use, and this
   * call's own spend ceiling.
   *
   * This is the reach `dsh-run-admission` gives a run once, at start, made
   * available again for every later call the same run makes. Nothing here is
   * cached from that first admission: the account is read fresh, and the
   * credential is opened fresh, so a binding built on this method inherits the
   * same property `meterRequest` already does — a revocation that happens
   * between two calls of one run stops the second rather than only the next
   * metered chunk.
   *
   * The opened secret is not retained here, and this method does not itself
   * launch anything: a caller that never calls it, and the ledger's own
   * per-call metering, are both unaffected by whether anything ever does.
   * @param sessionId - the session a provider binding's call was assembled for.
   * @returns the launch identity, or the reason none could be resolved.
   */
  async runIdentityFor(sessionId: SessionId): Promise<RunIdentityResult> {
    const resolved = this.findSessionRun(sessionId)
    if (!resolved.ok) return { ok: false, rejection: resolved.rejection }
    const { run, account } = resolved
    const runId = run.record.runId
    const remaining = this.ledger.remaining(runId)
    if (remaining === undefined) return { ok: false, rejection: { reason: 'no-open-run' } }
    const envelope = await this.ctx.controlPlaneStore.findCredential({ userId: run.userId, accountId: run.accountId })
    if (envelope === undefined) {
      return { ok: false, rejection: { reason: 'no-credential', runId, accountId: run.accountId } }
    }
    const opened = openCredential(envelope, { userId: run.userId, accountId: run.accountId }, this.keyring, Date.now())
    await this.fileCredentialAudit(run.userId, opened.audit)
    if (!opened.opened) return { ok: false, rejection: { reason: opened.rejection, runId, accountId: run.accountId } }
    const poolKey = runtimePoolKey({ userId: run.userId, provider: account.provider, accountId: run.accountId })
    return {
      ok: true,
      value: {
        runId,
        provider: account.provider,
        poolRoot: runtimePoolRoot(this.config.poolBase, poolKey),
        secret: opened.secret,
        remaining,
      },
    }
  }

  /**
   * Resolve the one open durable run that owns a session in this runtime.
   * @param sessionId - session whose workspace authority is about to be used.
   * @returns the run record, or undefined when this runtime owns no unique open run.
   */
  runOfSession(sessionId: SessionId): DurableRunRecord | undefined {
    const records = this.ctx.controlPlaneStore.runsOfSession(this.config.audience, sessionId)
    if (records.length !== 1) return undefined
    const record = records[0]
    return record !== undefined && this.ledger.remaining(record.record.runId) !== undefined ? record : undefined
  }

  /**
   * Mint and admit a child run for a session delegated from an already-open
   * run, inheriting the delegating run's tenant, account, provider, device,
   * workspace grant and conversation.
   *
   * This is the one place this runtime mints an execution assertion rather
   * than only verifying one it was handed. It needs no external issuing
   * authority because it authenticates nothing new: a delegated child's
   * identity is exactly its parent's, already verified when the parent's own
   * run was admitted, so re-deriving it here — sessionId, runId and nonce
   * freshly generated, everything else copied — is not a new grant of
   * authority, only a restatement of one already held. The minted token is
   * never transmitted or persisted; it exists only to drive the same
   * `start()` admission path a caller-supplied token would, so a child run is
   * funded, ledgered and audited exactly as a root run is, including the
   * parent-subset budget and concurrency accounting `dsh-run-budget` already
   * enforces for any assertion naming a `parentRunId`.
   * @param parentSessionId - the session whose open run the child delegates from.
   * @param childSessionId - the session the new child run drives.
   * @param share - the allowance to open the child with, computed from the
   *   parent's own remaining budget. Required rather than defaulted: how much
   *   of a parent's budget a delegated child should receive is a policy
   *   choice this runtime has no basis to guess.
   * @param now - epoch milliseconds; defaults to this runtime's clock.
   * @returns the child's start outcome, or the reason the parent session
   *   itself could not be resolved to one open, usable run.
   */
  async startChildRun(
    parentSessionId: SessionId,
    childSessionId: SessionId,
    share: (run: { budget: RunBudget }) => RunBudget,
    now: number = Date.now(),
  ): Promise<StartChildRunResult> {
    const resolved = this.findSessionRun(parentSessionId)
    if (!resolved.ok) return { ok: false, rejection: resolved.rejection }
    const { run, account } = resolved
    const claims: ExecutionAssertionClaims = {
      issuer: this.config.issuer,
      audience: this.config.audience,
      userId: run.userId,
      deviceId: run.deviceId,
      accountId: run.accountId,
      provider: account.provider,
      workspaceGrantId: run.workspaceGrantId,
      conversationId: run.conversationId,
      sessionId: childSessionId,
      runId: RunId(randomUUID()),
      parentRunId: run.record.runId,
      nonce: randomUUID(),
      issuedAt: now,
      expiresAt: now + MINTED_CHILD_ASSERTION_LIFETIME_MS,
    }
    const token = mintExecutionAssertion(claims, this.assertionSecret)
    const outcome = await this.start(token, share, now)
    return { ok: true, outcome }
  }

  /** File one vault operation this scheduler performed outside a scheduling attempt. */
  private async fileCredentialAudit(userId: UserId, audit: CredentialAuditEvent): Promise<void> {
    const record: RunAuditRecord = {
      at: audit.at,
      userId: audit.userId,
      accountId: audit.accountId,
      event: 'credential',
      action: audit.action,
      outcome: audit.outcome,
    }
    const retain = this.config.auditRetention
    await this.ctx.controlPlaneStore.recordAudit(tenantSubject(userId), [record], retain).catch((error: unknown) => {
      this.ctx.logger.warn(`run-scheduler: could not record a credential open for tenant '${userId}': ${String(error)}`)
    })
  }

  /** Persist the provider/model pair selected after LLM routing middleware. */
  private async fileRoute(run: DurableRunRecord, provider: string, model: string): Promise<void> {
    const record: RunAuditRecord = {
      at: Date.now(),
      runId: run.record.runId,
      ...lineage(run.record.parentRunId),
      userId: run.userId,
      accountId: run.accountId,
      provider,
      model,
      event: 'routed',
      action: 'select',
      outcome: 'ok',
    }
    await this.ctx.controlPlaneStore.recordAudit(
      tenantSubject(run.userId),
      [record],
      this.config.auditRetention,
    ).catch((error: unknown) => {
      this.ctx.logger.warn(`run-scheduler: could not record route for run '${run.record.runId}': ${String(error)}`)
    })
  }

  /** Persist only the final decision and tool name; arguments and reasons stay out of the trail. */
  private async fileToolAuthorization(
    execution: Readonly<ToolExecution>,
    decision: Readonly<ToolAuthorizationDecision>,
  ): Promise<void> {
    const sessionId = execution.agent?.session.id
    if (sessionId === undefined) return
    const run = this.runOfSession(sessionId)
    if (run === undefined) return
    const record: RunAuditRecord = {
      at: Date.now(),
      runId: run.record.runId,
      ...lineage(run.record.parentRunId),
      userId: run.userId,
      accountId: run.accountId,
      event: 'tool',
      action: execution.name,
      outcome: decision.kind === 'allow' ? 'allowed' : 'denied',
    }
    await this.ctx.controlPlaneStore.recordAudit(
      tenantSubject(run.userId),
      [record],
      this.config.auditRetention,
    ).catch((error: unknown) => {
      this.ctx.logger.warn(`run-scheduler: could not record tool authorization for run '${run.record.runId}': ${String(error)}`)
    })
  }

  /**
   * Hold one run's calls in a line, so each reads a remainder the one before
   * it has already been charged against.
   *
   * A meter reads what the run may spend once, before the provider is called,
   * and charges once the call ends. Two calls that overlap therefore both start
   * against a remainder neither has been charged against yet, and a run allowed
   * one call's worth of tokens spends two calls' worth. The dimensions are
   * bounds on the run, not on a call, so they can only hold if the calls do not
   * observe the same remainder.
   *
   * The line is per run, not per runtime: two tenants' calls never wait for
   * each other. A run whose calls are sequential — an agent loop's are — never
   * waits either, because the line is already empty when the next call starts.
   *
   * @param runId - the run whose calls share one allowance.
   * @param start - builds the metered stream, called once this call's turn comes.
   * @returns the metered stream, which begins reading when the call before it ends.
   */
  private oneCallAtATime(
    runId: RunId,
    start: () => AsyncGenerator<StreamChunk, void, undefined>,
  ): AsyncIterable<StreamChunk> {
    return {
      [Symbol.asyncIterator]: () => {
        const ahead = this.callLines.get(runId) ?? Promise.resolve()
        // Both are built now, not once this call's turn comes: a consumer may
        // close the stream before it ever reads, and the line has to be
        // givable up from the moment it is taken.
        let leave!: () => void
        const held = new Promise<void>((resolve) => { leave = resolve })
        const line = ahead.then(() => held)
        this.callLines.set(runId, line)
        // Dropping the entry once nothing waits behind it keeps a long-lived
        // runtime from holding one promise per run it ever metered.
        void line.then(() => { if (this.callLines.get(runId) === line) this.callLines.delete(runId) })
        let reader: AsyncGenerator<StreamChunk, void, undefined> | undefined
        let left = false
        const leaveLine = (): void => {
          if (left) return
          left = true
          leave()
        }
        return {
          next: async () => {
            if (left) return { done: true, value: undefined }
            if (reader === undefined) {
              await ahead
              // oxlint-disable-next-line typescript/no-unnecessary-condition -- return() may set left while the await is pending
              if (left) return { done: true, value: undefined }
              reader = start()
            }
            // Captured after the assignment above: the closure would widen the
            // narrowed local back to `undefined` on its own.
            const active = reader
            try {
              const step = await this.metered.run(runId, () => active.next())
              if (step.done === true) leaveLine()
              return step
            } catch (failure) {
              leaveLine()
              throw failure
            }
          },
          return: async () => {
            // A consumer that stops reading part-way leaves the line too, or
            // every later call on this run would wait on a stream nobody is
            // draining. `meterRun` charges what the abandoned call used.
            //
            // The line is given up in a `finally` because closing can fail:
            // a cancelled call closes a source that is itself failing, and
            // that rejection reaches here. Leaving after it would hold the
            // line for the life of the run over a close that went wrong.
            try {
              if (reader !== undefined) await reader.return()
              return { done: true, value: undefined }
            } finally {
              leaveLine()
            }
          },
        }
      },
    }
  }

  /**
   * Close one run and its descendants, and charge its tenant for what the tree
   * consumed.
   *
   * Closing a root is the one point a tenant's durable allowance moves. A child
   * settles into its parent's record instead, and reaches the tenant when that
   * parent's root closes, so a tree is charged once rather than once per run.
   * @param runId - the run to settle.
   * @returns the settlement, or why it could not be closed.
   */
  close(runId: RunId): Promise<RunLedgerResult<RunSettlement>> {
    return this.queue(() => this.settle(runId, 'closed'))
  }

  /**
   * Close the one open run driving a session, for a caller that knows the
   * session rather than the run.
   *
   * A delegated child is the case this exists for: whatever opened its run
   * named it by session, and the settlement it is reacting to names the same
   * session. Waiting for the lease instead would hold the parent's allowance
   * and one of its concurrency slots for minutes after the child finished, so
   * a parent that delegates in sequence would run out of slots it is no longer
   * using.
   *
   * A session this runtime has no single open run for is not an error: there
   * is nothing here to close, exactly as {@link tenantOf} answers nothing for
   * the same session.
   * @param sessionId - the session whose run should be settled.
   * @returns the settlement, or `undefined` when nothing was closed — this
   *   runtime has no single open run for that session, or a concurrent close
   *   settled it between resolving the run and reaching the queue.
   */
  async closeSessionRun(sessionId: SessionId): Promise<RunSettlement | undefined> {
    const resolved = this.findSessionRun(sessionId)
    if (!resolved.ok) return undefined
    const outcome = await this.close(resolved.run.record.runId)
    /* v8 ignore next -- the run was open a moment ago; only a close that won the
     * race to the queue leaves nothing here to settle, which is the same answer. */
    return outcome.ok ? outcome.value : undefined
  }

  /**
   * Register a disposer to run once, when `runId` is settled.
   *
   * The producer is whatever holds a live resource this run started and the
   * ledger cannot reach: a spawned process, bound to the run at the moment it
   * is created. Settlement ends the run's accounting whichever way it comes
   * about — a normal finish, an expired lease, an account no longer able to
   * authorize it, or an ancestor's tree closing around it — and this is what
   * lets that same event reach the resource.
   *
   * At most one disposer is held per run: a later registration replaces an
   * earlier one rather than accumulating, which is correct for a run that
   * makes several sequential calls, since only the live one still needs
   * releasing. A caller whose resource already ended on its own unregisters
   * with the returned function, so a stale disposer is never invoked for a
   * process that already exited.
   * @param runId - the run whose settlement should trigger disposal.
   * @param dispose - releases the resource; a rejection is logged and never
   *   allowed to fail the settlement that triggered it.
   * @returns unregisters this disposer without invoking it.
   */
  registerDisposer(runId: RunId, dispose: () => void | Promise<void>): () => void {
    this.disposers.set(runId, dispose)
    return () => { if (this.disposers.get(runId) === dispose) this.disposers.delete(runId) }
  }

  /**
   * Wrap a process-spawning function so every handle it returns is registered
   * against `runId`'s lifetime and unregistered once that process exits on
   * its own.
   *
   * This is the whole of the disposal wiring a provider binding needs: compose
   * it around the `spawn` function an adapter is given, and settlement reaches
   * every process that function ever starts for this run, without the binding
   * knowing anything about settlement itself.
   * @param runId - the run each spawned handle's disposer is registered against.
   * @param spawn - the underlying spawn function, called unchanged.
   * @returns a spawn function with the same signature.
   */
  disposableSpawn<Spec, Handle extends { readonly done: Promise<unknown>; terminate(): void }>(
    runId: RunId,
    spawn: (spec: Spec) => Handle,
  ): (spec: Spec) => Handle {
    return (spec: Spec): Handle => {
      const handle = spawn(spec)
      const unregister = this.registerDisposer(runId, () => { handle.terminate() })
      handle.done.then(unregister, unregister)
      return handle
    }
  }

  /** Invoke and clear a run's registered disposer, if it has one; never throws. */
  private async disposeOf(runId: RunId): Promise<void> {
    const dispose = this.disposers.get(runId)
    if (dispose === undefined) return
    this.disposers.delete(runId)
    try {
      await dispose()
    } catch (error) {
      // The disposer's own failure must not leave a run unsettled: settlement
      // is accounting and has already happened by the time this runs, so
      // there is nowhere left for this error to go but the log.
      this.ctx.logger.warn(`run-scheduler: disposer for run '${runId}' failed: ${String(error)}`)
    }
  }

  /**
   * Release every hold whose lease has passed and drop nonce records that can
   * no longer deny anything.
   *
   * The clock calls this; a caller with its own decision timestamp may call it
   * directly. Eviction changes no decision — `spend` already treats an expired
   * record as absent — so this only bounds what the runtime holds.
   * @param now - epoch milliseconds.
   * @returns the runs whose holds were released.
   */
  async sweep(now: number): Promise<readonly RunSettlement[]> {
    const settled: RunSettlement[] = []
    for (const record of this.ledger.open()) {
      // A revoked account ends its run however live the session driving it is:
      // this decides authority, and only the branch below decides abandonment.
      const revoked = this.spent(record.runId)
      if (!revoked) {
        if (record.leaseExpiresAt > now) continue
        if (this.driven(record.runId)) {
          await this.queue(() => this.renew(record.runId, now))
          continue
        }
      }
      // Re-read through `settle`: closing one run closes its descendants, and a
      // descendant already gone is no longer expired.
      const outcome = await this.queue(() => this.settle(record.runId, revoked ? 'revoked' : 'expired'))
      if (outcome.ok) settled.push(outcome.value)
    }
    await this.ctx.controlPlaneStore.evictNonces(now)
    return settled
  }

  /**
   * Whether this runtime still drives the session one open run was started
   * for.
   *
   * A lease answers "did the runtime holding this run go away", which a
   * runtime that still has the session is answering directly rather than
   * waiting to be asked. The session store is read opportunistically: a
   * composition without one leaves every run to its lease, exactly as before
   * this check existed.
   *
   * Liveness is not activity. A session parked between turns — waiting on a
   * tool, an approval, or a person — is still this runtime's to fund, and
   * loses its run only when the session itself goes.
   * @param runId - one open run.
   * @returns true when this runtime holds a live session for that run.
   */
  private driven(runId: RunId): boolean {
    const run = this.ctx.controlPlaneStore.findRun(runId)
    if (run === undefined) return false
    return this.ctx.get('sessions')?.get(run.sessionId) !== undefined
  }

  /**
   * Hold one still-driven run's allowance for another lease.
   *
   * The durable record moves with the ledger so a later reader sees the same
   * lease this runtime is honouring. A write that fails leaves the ledger's
   * own lease advanced and the next sweep renewing again, which costs one
   * sweep of staleness rather than a run settled underneath a live session.
   */
  private async renew(runId: RunId, now: number): Promise<void> {
    const leaseExpiresAt = now + this.config.leaseMs
    // Neither result is read: both operations are no-ops for a run this
    // queued step found already settled, which is the outcome either way.
    this.ledger.renew(runId, leaseExpiresAt)
    await this.ctx.controlPlaneStore.renewRun(runId, leaseExpiresAt)
  }

  /** The admission policy for this runtime, assembled from the store and this instance's state. */
  private policy(): RunAdmissionPolicy {
    const store = this.ctx.controlPlaneStore
    return {
      expectation: {
        issuer: this.config.issuer,
        audience: this.config.audience,
        maxLifetimeMs: this.config.maxLifetimeMs,
      },
      assertionSecret: this.assertionSecret,
      keyring: this.keyring,
      poolBase: this.config.poolBase,
      spendNonce: (claims: ExecutionAssertionClaims) => this.ctx.controlPlaneStore.spendNonce(claims, Date.now()),
      // A session driven by two runs at once is spend nobody can attribute, so
      // the second run is refused where the conflict is created.
      findSessionRun: (claims: ExecutionAssertionClaims) => Promise.resolve(
        store.runsOfSession(this.config.audience, claims.sessionId)[0]?.record.runId,
      ),
      // A child that named another tenant or another account would run on that
      // identity's credential while its spend settled into this parent's tree.
      findParentIdentity: (parentRunId: RunId) => Promise.resolve(store.findRun(parentRunId)),
      // The record an assertion's grant id resolves to. A run whose grant is
      // gone, revoked, or another tenant's or device's is refused before its
      // nonce is spent, so reissuing one lets the same assertion be retried.
      findWorkspaceGrant: (id: WorkspaceGrantId) => store.findGrant(id),
      findCredential: (claims: ExecutionAssertionClaims) => store.findCredential(claims),
      // A child is admitted against its parent's remainder, not the tenant's
      // own allowance: a tenant with plenty left can have an exhausted parent.
      findBudget: (claims: ExecutionAssertionClaims) => claims.parentRunId === undefined
        ? this.tenantRemaining(claims.userId)
        : Promise.resolve(this.ledger.remaining(claims.parentRunId)),
    }
  }

  /**
   * What one tenant may start a new root run against: its durable allowance,
   * less the reservation every root run of that tenant still open is holding.
   */
  private async tenantRemaining(userId: UserId): Promise<RunBudget | undefined> {
    const store = this.ctx.controlPlaneStore
    const allowance = await store.tenantAllowance(userId)
    if (allowance === undefined) return undefined
    // Ownership comes from the durable record, which is the only place a run's
    // tenant is written down; what it holds comes from the ledger, which is the
    // accounting authority while the run is open.
    const owners = new Map((await store.runsOf(this.config.audience)).map(run => [run.record.runId, run.userId]))
    const held = this.ledger.open()
      .filter(record => record.parentRunId === undefined && owners.get(record.runId) === userId)
      .map(record => record.reserved)
    return remainingAllowance(allowance, held)
  }

  /**
   * Settle one run durably, then in memory.
   *
   * The order is the guarantee. The charge is computed before anything moves,
   * written down as the run's own settled figure, applied to whoever funded the
   * run, and only then are the records forgotten and the hold released. A write
   * that rejects therefore leaves the run open in both places, and its lease
   * brings the sweep back to try again — where settling first and writing after
   * would lose the charge the write was carrying.
   *
   * Callers reach this through {@link close} and {@link sweep}, which queue it
   * on the one write chain; nothing else may run between the charge and the
   * deletion it is paired with.
   *
   * Disposal runs first and independently of the writes below: a run and
   * every descendant this settlement closes has whatever resource it
   * registered released before anything is charged, since a process this
   * settlement is about to stop billing for should stop running as soon as
   * that is decided, not once the durable writes that follow succeed.
   */
  private async settle(runId: RunId, cause: SettlementCause): Promise<RunLedgerResult<RunSettlement>> {
    const preview = this.ledger.settlementOf(runId)
    if (preview === undefined) return { ok: false, rejection: { reason: 'unknown-run', runId } }
    await this.disposeOf(runId)
    for (const descendant of preview.closed) await this.disposeOf(descendant)
    const store = this.ctx.controlPlaneStore
    const marked = await store.markRunSettled(runId, preview.spent)
    await this.applyCharge(marked, preview.spent)
    for (const descendant of preview.closed) await store.deleteRun(descendant)
    await store.deleteRun(runId)
    this.remember(marked.sessionId)
    await this.fileSettlement(marked, cause, preview.spent)
    // Nothing between the preview and here removed the run, because every write
    // to a run record queues on the chain this call already holds.
    return this.ledger.close(runId)
  }

  /**
   * Recover one run, adopting it as a root when the store does not hold its
   * parent.
   *
   * A record whose parent is missing is damage: a partial write, or a delete
   * that took the parent and left the child. The ledger refuses to restore
   * one, which failed the boot — so a single damaged record took every tenant
   * on this runtime down, a blast radius far larger than the damage.
   *
   * Adopting loses no accounting, because recovery settles every root it
   * restores. The run was going to be settled a moment later either way; the
   * only question is who is charged for what it spent, and the record names
   * its tenant. A charge that would have reached its parent reaches that
   * tenant instead, which is where the parent's own settlement would have
   * carried it.
   *
   * @param run - one durable run record.
   * @param present - the ids this recovery holds records for.
   * @returns the run, with its parent cleared when that parent is gone.
   */
  private async adopt(run: DurableRunRecord, present: ReadonlySet<RunId>): Promise<DurableRunRecord> {
    const parent = run.record.parentRunId
    if (parent === undefined || present.has(parent)) return run
    this.ctx.logger.warn(
      `run-scheduler: run '${run.record.runId}' names parent '${parent}', which the store does not hold; `
      + `settling it against tenant '${run.userId}' instead`,
    )
    const adopted: DurableRunRecord = { ...run, record: { ...run.record, parentRunId: undefined } }
    // Written back, not only restored: the settlement that follows reads the
    // record from the store, and one still naming the missing parent would
    // charge that parent — which is to say nobody — instead of the tenant.
    await this.ctx.controlPlaneStore.openRun(adopted)
    return adopted
  }

  /**
   * Charge one settled run to whoever funded it: its parent run, or its tenant
   * when it has none.
   *
   * Both carry the id of the run they last absorbed, so this is repeatable, and
   * a recovering runtime re-drives it without knowing whether it already ran.
   */
  private async applyCharge(run: DurableRunRecord, spent: RunSpend): Promise<void> {
    const store = this.ctx.controlPlaneStore
    const { record } = run
    if (record.parentRunId !== undefined) {
      await store.absorbChild(record.parentRunId, record.runId, cappedAt(spent, record.reserved))
      return
    }
    await store.consumeTenantAllowance(run.userId, record.runId, spent)
  }

  /**
   * Finish every settlement a previous process started, then settle what it
   * left open.
   *
   * A record this runtime wrote is a run it was driving, and the process that
   * drove it is gone — so nothing is resumed. Settling on the way up is what
   * keeps a restart from handing a tenant back an allowance its runs consumed;
   * leaving the records open instead would do that until each lease expired.
   * @throws Error when the records do not form complete trees, which is a
   *   corrupt store rather than a run to admit.
   */
  private async recover(): Promise<void> {
    const store = this.ctx.controlPlaneStore
    const records = await store.runsOf(this.config.audience)
    const gone = new Set<RunId>()
    for (const run of records) {
      if (run.settledSpent === undefined) continue
      await this.applyCharge(run, run.settledSpent)
      for (const id of [...descendantsOf(records, run.record.runId), run.record.runId]) {
        await store.deleteRun(id)
        gone.add(id)
      }
    }
    const held = records.filter(run => !gone.has(run.record.runId))
    const present = new Set(held.map(run => run.record.runId))
    const remaining: DurableRunRecord[] = []
    for (const run of held) remaining.push(await this.adopt(run, present))
    this.ledger.restore(remaining.map(run => run.record))
    for (const run of remaining) {
      if (run.record.parentRunId === undefined) await this.settle(run.record.runId, 'recovered')
    }
  }

  /**
   * Read back what one tenant's scheduling attempts did here, oldest first.
   * @param userId - the tenant to read.
   * @returns its retained records.
   */
  auditsOfTenant(userId: UserId): readonly RunAuditRecord[] {
    return this.ctx.controlPlaneStore.auditsOf(tenantSubject(userId))
  }

  /**
   * Read back the attempts this runtime refused before it knew whose they were.
   *
   * An assertion that fails to verify names no tenant this runtime may believe,
   * so its record is filed here rather than dropped — it is the clearest attack
   * signal admission can observe.
   * @returns this runtime's retained unattributed records, oldest first.
   */
  auditsOfRuntime(): readonly RunAuditRecord[] {
    return this.ctx.controlPlaneStore.auditsOf(runtimeSubject(this.config.audience))
  }

  /**
   * Refuse one call and record that it happened.
   *
   * @param runId - the run the call belonged to, or undefined when the session
   *   named none this runtime still holds; a refusal with no run is filed
   *   against the runtime, because there is no tenant this runtime may believe.
   * @param message - what the caller is told.
   * @param code - the failure code the caller matches on.
   * @returns the one-chunk stream carrying the refusal.
   */
  private refuse(runId: RunId | undefined, message: string, code: string): AsyncIterable<StreamChunk> {
    const recorded = this.fileRefusal(runId, code, message)
    return {
      [Symbol.asyncIterator]: () => {
        const chunks = refusedCall(message, code)[Symbol.asyncIterator]()
        // The record lands before the caller is told, the same ordering the
        // meter's own refusals keep.
        return { next: async () => { await recorded; return chunks.next() } }
      },
    }
  }

  /**
   * Whether one open run can no longer authorize anything it does.
   *
   * Revoking an account destroys its stored envelope, which stops the next
   * admission and refuses the run's next call, but leaves the run itself open
   * — holding its funder's allowance, and with what it already spent unbilled,
   * until its lease runs out minutes later. The sweep is where this runtime
   * ends runs it has decided should end, so it ends these too.
   *
   * The judgement is the one {@link meterRequest} makes, so a run whose every
   * call is refused is not also a run that lingers. It is made only on
   * positive evidence: a run whose record this runtime cannot read is left to
   * its lease rather than settled on a store that answered nothing.
   *
   * @param runId - one open run.
   * @returns true when the account behind it can no longer authorize work.
   */
  private spent(runId: RunId): boolean {
    const run = this.ctx.controlPlaneStore.findRun(runId)
    if (run === undefined) return false
    const account = this.ctx.controlPlaneStore.accountOf(run.accountId)
    return account === undefined || !isProviderAccountUsable(account)
  }

  /**
   * Record that one run ended, and how.
   *
   * The durable run record is deleted at settlement, so this is the only place
   * the run's end survives: without it a trail shows a run starting and then
   * nothing, and an operator cannot tell a run still working from one an
   * expired lease or a revoked account ended minutes ago.
   *
   * Only the run this settlement was asked for is recorded. A descendant
   * closed with it left its own `started` record naming this run as its
   * parent, so the tree is readable from that end; a descendant settled in its
   * own right — which is how a delegated child normally ends — reaches here as
   * the run it was asked about.
   *
   * The write is awaited so the record is durable before the settlement is
   * reported, and never rejects: a store that cannot take the record must not
   * turn a completed settlement into a failure.
   *
   * @param run - the settled run, read before its record was deleted.
   * @param cause - how the settlement came about, filed as the outcome.
   * @param spent - final billable usage, including descendants closed with it.
   */
  private async fileSettlement(run: DurableRunRecord, cause: SettlementCause, spent: RunSpend): Promise<void> {
    const record: RunAuditRecord = {
      at: Date.now(),
      runId: run.record.runId,
      ...lineage(run.record.parentRunId),
      userId: run.userId,
      accountId: run.accountId,
      event: 'settled',
      action: 'settle',
      outcome: cause,
      spent,
    }
    const retain = this.config.auditRetention
    await this.ctx.controlPlaneStore.recordAudit(tenantSubject(run.userId), [record], retain).catch((error: unknown) => {
      this.ctx.logger.warn(`run-scheduler: could not record the settlement of run '${run.record.runId}': ${String(error)}`)
    })
  }

  /**
   * Record one launched process against the run whose call started it.
   *
   * The seam that announces a launch knows the executable and nothing about
   * tenants; the run scope entered around each metered pull is what supplies
   * the rest. A launch outside any metered call is not this runtime's to
   * attribute and is dropped.
   *
   * @param launch - the seam's record of one started child.
   */
  private fileLaunch(launch: SubprocessLaunched): void {
    const runId = this.metered.getStore()
    if (runId === undefined) return
    const run = this.ctx.controlPlaneStore.findRun(runId)
    if (run === undefined) return
    const record: RunAuditRecord = {
      at: Date.now(),
      runId,
      ...lineage(run.record.parentRunId),
      userId: run.userId,
      accountId: run.accountId,
      event: 'launched',
      action: launch.executable,
      outcome: launch.pid === -1 ? 'spawn-failed' : 'ok',
    }
    const retain = this.config.auditRetention
    this.ctx.controlPlaneStore.recordAudit(tenantSubject(run.userId), [record], retain)
      .catch((error: unknown) => {
        this.ctx.logger.warn(`run-scheduler: could not record a launched process: ${String(error)}`)
      })
  }

  /**
   * Record one refused call against the tenant whose run it was.
   *
   * The returned promise settles when the record is durable, and never
   * rejects: a caller awaits it before handing the refusal on, and a store
   * that cannot take the record must not turn one refused call into a failure
   * of its own.
   *
   * @param runId - the refused call's run, or undefined when it had none.
   * @param code - the failure code, filed as the record's outcome.
   * @param message - the refusal text, for the log if the write fails.
   * @returns resolution once the record is written, or logged as unwritable.
   */
  private fileRefusal(
    runId: RunId | undefined,
    code: string,
    message: string,
    action: 'meter' | 'route' = 'meter',
  ): Promise<void> {
    const run = runId === undefined ? undefined : this.ctx.controlPlaneStore.findRun(runId)
    const subject = run === undefined ? runtimeSubject(this.config.audience) : tenantSubject(run.userId)
    const record: RunAuditRecord = {
      at: Date.now(),
      ...run === undefined ? {} : { runId, ...lineage(run.record.parentRunId), userId: run.userId, accountId: run.accountId },
      event: 'refused',
      action,
      outcome: code,
    }
    const retain = this.config.auditRetention
    return this.ctx.controlPlaneStore.recordAudit(subject, [record], retain).then(() => undefined, (error: unknown) => {
      this.ctx.logger.warn(`run-scheduler: could not record a refused call (${message}): ${String(error)}`)
    })
  }

  /**
   * File everything one scheduling attempt produced.
   *
   * Records are grouped by subject before they are written, so a run whose
   * vault records name one tenant is one write rather than one per record.
   */
  private async record(outcome: RunStartOutcome, at: number): Promise<void> {
    const grouped = new Map<AuditSubject, RunAuditRecord[]>()
    for (const [subject, record] of this.recordsOf(outcome, at)) {
      const trail = grouped.get(subject) ?? []
      trail.push(record)
      grouped.set(subject, trail)
    }
    const retain = this.config.auditRetention
    for (const [subject, records] of grouped) {
      await this.ctx.controlPlaneStore.recordAudit(subject, records, retain)
    }
  }

  /** Every record one attempt produced, each with the subject it belongs to. */
  private *recordsOf(outcome: RunStartOutcome, at: number): Generator<[AuditSubject, RunAuditRecord]> {
    for (const audit of outcome.audits) {
      yield [tenantSubject(audit.userId), {
        at: audit.at,
        userId: audit.userId,
        accountId: audit.accountId,
        event: 'credential',
        action: audit.action,
        outcome: audit.outcome,
      }]
    }
    if (outcome.started) {
      const { claims } = outcome.value.run
      yield [tenantSubject(claims.userId), {
        at,
        runId: claims.runId,
        ...lineage(claims.parentRunId),
        userId: claims.userId,
        accountId: claims.accountId,
        event: 'started',
        action: 'start',
        outcome: 'ok',
      }]
      return
    }
    yield refusalOf(outcome.rejection, at, this.config.audience)
  }

  /**
   * Cache one ended session, dropping the oldest once the cap is reached.
   * Durable ownership still refuses an evicted session without an open run.
   */
  private remember(sessionId: SessionId): void {
    this.ended.delete(sessionId)
    this.ended.add(sessionId)
    const cap = this.config.endedSessionMemory
    // Insertion order makes the first entry the oldest.
    for (const oldest of this.ended) {
      if (this.ended.size <= cap) break
      this.ended.delete(oldest)
    }
  }

  /** Queue one whole operation on this runtime's single chain. */
  private queue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.serial.then(work, work)
    this.serial = next.then(() => undefined, () => undefined)
    return next
  }
}

/**
 * How one settlement came about, filed as the terminal record's outcome.
 *
 * `closed` is a caller ending a run it was driving, `expired` a lease that
 * lapsed with no live session behind it, `revoked` an account that may no
 * longer authorize the work, and `recovered` a run this runtime found open at
 * boot from a process that is gone.
 */
type SettlementCause = 'closed' | 'expired' | 'revoked' | 'recovered'

/**
 * The lineage an audit record about one run carries.
 *
 * A root run contributes nothing rather than an explicit absence, so the
 * record round-trips through the medium as the same value it was written as.
 * @param parentRunId - the run this one was delegated from, if any.
 * @returns the field to spread into the record.
 */
function lineage(parentRunId: RunId | undefined): { parentRunId?: RunId } {
  return parentRunId === undefined ? {} : { parentRunId }
}

/**
 * The record one refused attempt leaves, and whom it belongs to.
 *
 * Every stage past the assertion carries verified claims, so its record names
 * the tenant, account and run it refused. The assertion stage carries none —
 * nothing about an unverified token may be believed — so its record is filed
 * against the runtime that refused it.
 */
function refusalOf(rejection: RunStartRejection, at: number, runtime: string): [AuditSubject, RunAuditRecord] {
  if (rejection.stage === 'ledger') {
    return refusedByTenant(rejection.claims, at, 'ledger', rejection.rejection.reason)
  }
  const refused = rejection.rejection
  if (refused.stage === 'assertion') {
    // Nothing about an unverified token may be believed, its tenant included.
    return [runtimeSubject(runtime), { at, event: 'refused', action: 'assertion', outcome: refused.reason }]
  }
  return refusedByTenant(refused.claims, at, refused.stage, refused.reason)
}

/** One refusal of a run whose identity was already verified. */
function refusedByTenant(
  claims: ExecutionAssertionClaims,
  at: number,
  action: string,
  outcome: string,
): [AuditSubject, RunAuditRecord] {
  return [tenantSubject(claims.userId), {
    at,
    runId: claims.runId,
    ...lineage(claims.parentRunId),
    userId: claims.userId,
    accountId: claims.accountId,
    event: 'refused',
    action,
    outcome,
  }]
}

/** Every record descended from one run, deepest first. */
function descendantsOf(
  records: readonly { readonly record: RunRecord }[],
  runId: RunId,
): readonly RunId[] {
  const found: RunId[] = []
  for (const candidate of records) {
    if (candidate.record.parentRunId !== runId) continue
    found.push(...descendantsOf(records, candidate.record.runId), candidate.record.runId)
  }
  return found
}

/** The part of one run's charge its funder's allowance absorbs. */
function cappedAt(spent: RunSpend, reserved: RunBudget): RunSpend {
  return {
    tokens: Math.min(spent.tokens, reserved.tokens),
    wallMs: Math.min(spent.wallMs, reserved.wallMs),
    costMicroUsd: Math.min(spent.costMicroUsd, reserved.costMicroUsd),
  }
}

export default RunScheduler
