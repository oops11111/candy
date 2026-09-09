/** Administrator-only retained audit-window API. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { tenantSubject, type RunAuditRecord } from '@deepseek-ai/dsh-control-plane-store'
import { registerApiRoute, type ApiHost } from '@deepseek-ai/dsh-control-plane-api'
import type {} from '@deepseek-ai/dsh-run-scheduler'

export const name = 'audit-api'
export const inject = ['webServer', 'controlPlaneStore', 'runScheduler']
/** HTTP path serving the administrator-only retained audit window. */
export const AUDIT_PATH = '/api/candy/audits'
/** Configuration for the administrator audit-window route. */
export interface Config {
  /** Canonical public origin used by the inherited authenticated API envelope. */
  publicOrigin: string
  /** Maximum records returned from each bounded audit window. */
  auditRetention?: number
}
export const Config: z<Config> = z.object({ publicOrigin: z.string().required(), auditRetention: z.number().step(1).min(1).default(200) })

/**
 * Register the administrator-only retained audit-window route.
 * @param ctx - Candy application context containing the Web and control-plane services.
 * @param config - Public-origin and bounded-retention settings for the route.
 */
export function apply(ctx: Context, config: Config): void {
  const retain = config.auditRetention ?? 200
  const host: ApiHost = {
    publicOrigin: config.publicOrigin,
    sessions: ctx.controlPlaneStore,
    audit: async (event) => {
      await ctx.controlPlaneStore.recordAudit(tenantSubject(event.userId), [{
        at: Date.now(), userId: event.userId, event: 'refused', action: event.action, outcome: event.outcome,
      } satisfies RunAuditRecord], retain)
    },
  }
  ctx.effect(() => registerApiRoute(ctx.webServer, host, {
    path: AUDIT_PATH,
    methods: ['GET'],
    role: 'administrator',
    action: 'audits.read',
    handle: actor => ({
      kind: 'json', status: 200,
      body: {
        tenant: ctx.runScheduler.auditsOfTenant(actor.userId),
        runtime: ctx.runScheduler.auditsOfRuntime(),
        retention: retain,
        completeHistory: false,
      },
    }),
  }))
}
