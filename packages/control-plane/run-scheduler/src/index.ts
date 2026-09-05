/**
 * The Candy runtime's scheduler: one place that holds a runtime's live run
 * state and performs the control-plane order for a request.
 *
 * Everything it composes already existed as a library. What did not exist was
 * an owner: the ledger and the replay store are per-runtime objects nothing
 * held, admission's ports had to be assembled by hand at every call site, and
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

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type { RunId, UserId } from '@deepseek-ai/dsh-control-plane'
import {
  CredentialKeyVersion,
  type CredentialKeyring,
} from '@deepseek-ai/dsh-credential-vault'
import type { ExecutionAssertionClaims } from '@deepseek-ai/dsh-execution-assertion'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { meterRun } from '@deepseek-ai/dsh-run-metering'
import type { RunAdmissionPolicy } from '@deepseek-ai/dsh-run-admission'
import type { RunBudget, RunSpend } from '@deepseek-ai/dsh-run-budget'
import { RunLedger, type RunChargeResult, type RunLedgerResult, type RunRecord, type RunSettlement } from '@deepseek-ai/dsh-run-ledger'
import { RunReplayStore } from '@deepseek-ai/dsh-run-replay'
import { startRun, type RunStartOutcome } from '@deepseek-ai/dsh-run-start'
import { remainingAllowance } from '@deepseek-ai/dsh-tenant-allowance'
import type { DurableRunRecord } from '@deepseek-ai/dsh-control-plane-store'

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
  /** Absolute directory holding every runtime pool's root; the deployment provisions it. */
  poolBase: string
  /** How long an unsettled run holds its allowance before `expire` releases it. */
  leaseMs?: number
  /** How often the clock releases expired holds and drops spent-nonce records. */
  sweepMs?: number
}

export const Config: z<Config> = z.object({
  issuer: z.string().required(),
  audience: z.string().required(),
  maxLifetimeMs: z.number().step(1).min(1).default(60_000),
  assertionSecretEnv: z.string().role('credential-ref').default('CANDY_ASSERTION_SECRET'),
  credentialKeyEnv: z.string().role('credential-ref').default('CANDY_CREDENTIAL_KEY'),
  credentialKeyVersion: z.string().required(),
  poolBase: z.string().required(),
  leaseMs: z.number().step(1).min(1).default(300_000),
  sweepMs: z.number().step(1).min(1).default(30_000),
})

/** Bytes a credential key must carry, matching what the vault seals with. */
const CREDENTIAL_KEY_BYTES = 32

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
 * One instance owns one ledger and one replay store, so every run this runtime
 * admits is accounted against the same delegation trees and the same spent
 * nonces. Two instances would each believe they held the whole allowance.
 */
export class RunScheduler extends Service {
  static inject = ['controlPlaneStore', 'timer']

  /** Open runs and their holds, for every tree this runtime is running. */
  readonly ledger: RunLedger = new RunLedger()

  /** Nonces spent by assertions still admissible here. */
  readonly replay: RunReplayStore = new RunReplayStore()

  /**
   * The one chain every write to a run record queues on.
   *
   * A settlement charges its funder and then forgets the run, and the marker
   * that makes the charge repeatable holds only while no other write to those
   * two records interleaves. Serializing them is what makes the marker a
   * guarantee rather than a likelihood.
   */
  private writes: Promise<unknown> = Promise.resolve()

  private readonly keyring: CredentialKeyring
  private readonly assertionSecret: Buffer

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'runScheduler')
    const environment = process.env
    this.assertionSecret = requireSecret(environment, config.assertionSecretEnv ?? 'CANDY_ASSERTION_SECRET')
    const key = requireSecret(environment, config.credentialKeyEnv ?? 'CANDY_CREDENTIAL_KEY')
    if (key.byteLength !== CREDENTIAL_KEY_BYTES) {
      throw new RangeError(
        `dsh-run-scheduler: the credential key must be ${String(CREDENTIAL_KEY_BYTES)} bytes, got ${String(key.byteLength)}`,
      )
    }
    this.keyring = {
      currentVersion: CredentialKeyVersion(config.credentialKeyVersion),
      keys: new Map([[CredentialKeyVersion(config.credentialKeyVersion), key]]),
    }
  }

  /**
   * Finish what a previous process left, then start the clock.
   *
   * Cordis awaits this before the service is reachable, so no run is admitted
   * against an allowance that still counts an interrupted settlement.
   */
  protected async [Service.init](): Promise<void> {
    await this.recover()
    this.ctx.interval(() => {
      // A sweep now writes to the medium, and a rejected write must not become
      // an unhandled rejection that takes the runtime down: the holds it failed
      // to charge are already released, and the next sweep runs regardless.
      this.sweep(Date.now()).catch((error: unknown) => {
        this.ctx.logger.warn(`run-scheduler: sweep failed to settle: ${String(error)}`)
      })
    }, this.config.sweepMs ?? 30_000)
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
  async start(
    token: string,
    share: (run: { budget: RunBudget }) => RunBudget = run => run.budget,
    now: number = Date.now(),
  ): Promise<RunStartOutcome> {
    const outcome = await startRun({ token }, this.policy(), {
      ledger: this.ledger,
      share,
      leaseExpiresAt: now + (this.config.leaseMs ?? 300_000),
    }, now)
    if (!outcome.started) return outcome
    const { claims } = outcome.value.run
    // `startRun` opened the ledger record, so the ledger has it.
    // oxlint-disable-next-line typescript/no-non-null-assertion -- the comment above states the invariant
    const record = this.ledger.get(claims.runId)!
    try {
      await this.queue(() => this.ctx.controlPlaneStore.openRun({
        record,
        userId: claims.userId,
        runtime: this.config.audience,
        settledSpent: undefined,
        absorbed: undefined,
      }))
    } catch (unwritable) {
      // The record was opened a moment ago and has spent nothing, so closing it
      // returns a child's whole hold to its parent at once. A run this runtime
      // cannot write down is a run a restart would forget while its provider
      // kept spending, so the medium failure keeps travelling.
      this.ledger.close(claims.runId)
      throw unwritable
    }
    return outcome
  }

  /**
   * Record what one run consumed since its last charge.
   * @param runId - the open run.
   * @param spend - what the invocation consumed.
   * @returns the updated record and the dimensions now used up, or why the
   *   charge was refused.
   */
  async charge(runId: RunId, spend: RunSpend): Promise<RunLedgerResult<RunChargeResult>> {
    const charged = this.ledger.charge(runId, spend)
    if (!charged.ok) return charged
    await this.queue(() => this.ctx.controlPlaneStore.recordRunSpend(runId, charged.value.record.spent))
    return charged
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
    return meterRun(source, runId, {
      remaining: id => this.ledger.remaining(id),
      charge: (id, spend) => this.charge(id, spend),
    })
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
    return this.queue(() => this.settle(runId))
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
      if (record.leaseExpiresAt > now) continue
      // Re-read through `settle`: closing one run closes its descendants, and a
      // descendant already gone is no longer expired.
      const outcome = await this.queue(() => this.settle(record.runId))
      if (outcome.ok) settled.push(outcome.value)
    }
    this.replay.evict(now)
    return settled
  }

  /** The admission policy for this runtime, assembled from the store and this instance's state. */
  private policy(): RunAdmissionPolicy {
    const store = this.ctx.controlPlaneStore
    return {
      expectation: {
        issuer: this.config.issuer,
        audience: this.config.audience,
        maxLifetimeMs: this.config.maxLifetimeMs ?? 60_000,
      },
      assertionSecret: this.assertionSecret,
      keyring: this.keyring,
      poolBase: this.config.poolBase,
      spendNonce: (claims: ExecutionAssertionClaims) => Promise.resolve(this.replay.spend(claims, Date.now())),
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
   */
  private async settle(runId: RunId): Promise<RunLedgerResult<RunSettlement>> {
    const preview = this.ledger.settlementOf(runId)
    if (preview === undefined) return { ok: false, rejection: { reason: 'unknown-run', runId } }
    const store = this.ctx.controlPlaneStore
    const marked = await store.markRunSettled(runId, preview.spent)
    await this.applyCharge(marked, preview.spent)
    for (const descendant of preview.closed) await store.deleteRun(descendant)
    await store.deleteRun(runId)
    // Nothing between the preview and here removed the run, because every write
    // to a run record queues on the chain this call already holds.
    return this.ledger.close(runId)
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
    const remaining = records.filter(run => !gone.has(run.record.runId))
    this.ledger.restore(remaining.map(run => run.record))
    for (const run of remaining) {
      if (run.record.parentRunId === undefined) await this.settle(run.record.runId)
    }
  }

  /** Queue one write, or one settlement, on this runtime's single write chain. */
  private queue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writes.then(work, work)
    this.writes = next.then(() => undefined, () => undefined)
    return next
  }
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
