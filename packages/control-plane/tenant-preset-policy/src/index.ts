/**
 * Restricts a Candy tenant to a configured subset of an otherwise-shared
 * `dsh-agent-presets` roster.
 *
 * `dsh-agent-presets` is a general-purpose Harness package and carries no
 * notion of a tenant; teaching it one would move a Candy-specific concept
 * into a package every deployment shares. Its `AgentPresets.guard()`
 * extension point exists exactly so a consumer can add that concept without
 * the roster knowing it exists — this plugin is that consumer. It resolves a
 * session's tenant through `RunScheduler.tenantOf` (synchronous, matching the
 * guard's own synchronous contract) and refuses a preset id absent from that
 * tenant's configured allowlist.
 *
 * A tenant absent from `config.allowlists` is unrestricted, and so is a
 * session `tenantOf` cannot resolve to one tenant — no open run, an
 * ambiguous claim, or a run whose account is no longer usable. Both mirror
 * `RunScheduler`'s own metering default: a composition with no Candy run
 * behind a session has nothing here for this policy to enforce.
 *
 * @module @deepseek-ai/dsh-tenant-preset-policy
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent-presets'
// Type-only: resolves the `agentCtx.agent` field this plugin's guard reads.
// Always present at runtime — `dsh-agent-presets` already requires `dsh-agent`
// for the lifecycle event its own roster watches.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-run-scheduler'

/** Per-tenant preset allowlists this deployment enforces. */
export interface Config {
  /**
   * Preset ids each named tenant may mount or switch to, keyed by tenant id.
   * A tenant absent from this map is unrestricted.
   */
  readonly allowlists: Readonly<Record<string, readonly string[]>>
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  allowlists: z.dict(z.array(z.string())).default({}),
}) as z<Config>

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tenant-preset-policy'

/** Services this plugin reads: the roster it guards, and the tenant it guards by. */
export const inject = ['agentPresets', 'runScheduler']

/**
 * Register the tenant allowlist guard against `AgentPresets.guard()`.
 * @param ctx - context carrying `agentPresets` and `runScheduler`.
 * @param config - per-tenant preset allowlists.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.agentPresets.guard((agentCtx, id) => {
    const sessionId = agentCtx.agent?.id
    if (sessionId === undefined) return undefined
    const userId = ctx.runScheduler.tenantOf(sessionId)
    if (userId === undefined) return undefined
    const allowlist = config.allowlists[userId]
    if (allowlist === undefined || allowlist.includes(id)) return undefined
    return `tenant "${userId}" is not permitted to use preset "${id}"`
  }), 'tenant-preset-policy.guard()')
}
