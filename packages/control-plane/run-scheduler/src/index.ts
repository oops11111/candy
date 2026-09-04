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
import type { RunAdmissionPolicy } from '@deepseek-ai/dsh-run-admission'
import type { RunBudget, RunSpend } from '@deepseek-ai/dsh-run-budget'
import { RunLedger, type RunChargeResult, type RunLedgerResult, type RunSettlement } from '@deepseek-ai/dsh-run-ledger'
import { RunReplayStore } from '@deepseek-ai/dsh-run-replay'
import { startRun, type RunStartOutcome } from '@deepseek-ai/dsh-run-start'
import { remainingAllowance } from '@deepseek-ai/dsh-tenant-allowance'
import type {} from '@deepseek-ai/dsh-control-plane-store'

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
   * Which tenant each open ROOT run belongs to.
   *
   * A `RunRecord` carries a run and its parent, not an identity, so the tenant
   * a tree is charged to would otherwise be lost the moment the assertion that
   * started it was verified. Only roots are held: a descendant's spend reaches
   * its tenant through its root's settlement, and a tree has exactly one root.
   */
  private readonly tenants = new Map<RunId, UserId>()

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

  /** Start the clock that releases abandoned holds and drops dead nonce records. */
  protected [Service.init](): void {
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
    if (outcome.started && outcome.value.run.claims.parentRunId === undefined) {
      this.tenants.set(outcome.value.run.claims.runId, outcome.value.run.claims.userId)
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
  charge(runId: RunId, spend: RunSpend): RunLedgerResult<RunChargeResult> {
    return this.ledger.charge(runId, spend)
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
  async close(runId: RunId): Promise<RunLedgerResult<RunSettlement>> {
    const outcome = this.ledger.close(runId)
    if (outcome.ok) await this.chargeTenant(outcome.value)
    return outcome
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
    const expired = this.ledger.expire(now)
    for (const settlement of expired) await this.chargeTenant(settlement)
    this.replay.evict(now)
    return expired
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
    const allowance = await this.ctx.controlPlaneStore.tenantAllowance(userId)
    if (allowance === undefined) return undefined
    const held = this.ledger.open()
      .filter(record => this.tenants.get(record.runId) === userId)
      .map(record => record.reserved)
    return remainingAllowance(allowance, held)
  }

  /**
   * Charge one settled root run's tree to its tenant and stop tracking it.
   *
   * A settlement for a run this scheduler never opened as a root — a child, or
   * a root started before a restart — charges nothing: there is no tenant to
   * charge it to, and guessing one would bill the wrong account.
   */
  private async chargeTenant(settlement: RunSettlement): Promise<void> {
    const userId = this.tenants.get(settlement.runId)
    if (userId === undefined) return
    this.tenants.delete(settlement.runId)
    await this.ctx.controlPlaneStore.consumeTenantAllowance(userId, settlement.spent)
  }
}

export default RunScheduler
