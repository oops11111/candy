/**
 * Enforces Candy's tenant model-route grants at the last in-process boundary
 * before an LLM adapter is selected.
 *
 * DeepSeek Harness already owns model discovery, selection and provider
 * adapters. This plugin does not duplicate those features. It adds the one
 * Candy-specific question they cannot answer: whether the tenant behind a
 * managed session may use this exact provider/model pair. Calls outside a
 * Candy run pass through; managed tenants are closed by default and must have
 * an exact route in the durable control-plane allowlist.
 *
 * @module @deepseek-ai/dsh-tenant-route-policy
 */

import type { Context } from '@deepseek-ai/cordis'
import type { TenantModelRoute } from '@deepseek-ai/dsh-control-plane-store'
import type { LlmRouteSelection } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-run-scheduler'

/** Failure code returned when a managed tenant requests an ungranted route. */
export const TENANT_ROUTE_NOT_ALLOWED = 'TENANT_ROUTE_NOT_ALLOWED'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tenant-route-policy'

/** Services needed to intercept calls and resolve their managed tenant. */
export const inject = ['llm', 'runScheduler', 'controlPlaneStore']

/** Whether one exact route occurs in a tenant's durable grant. */
function permits(routes: readonly TenantModelRoute[] | undefined, selection: LlmRouteSelection): boolean {
  return routes?.some(route => route.provider === selection.provider && route.model === selection.model) ?? false
}

/**
 * Install the final model-route authorization check.
 * @param ctx - context carrying the LLM waterfall and Candy run scheduler.
 */
export function apply(ctx: Context): void {
  ctx.llm.guard(async (selection) => {
    if (selection.sessionId === undefined) return undefined
    const tenant = ctx.runScheduler.tenantOf(selection.sessionId)
    if (tenant === undefined || permits(ctx.controlPlaneStore.tenantModelRoutes(tenant), selection)) return undefined
    const message = `tenant "${tenant}" is not permitted to use route "${selection.provider}/${selection.model}"`
    await ctx.runScheduler.recordRouteRefusal(selection.sessionId, TENANT_ROUTE_NOT_ALLOWED, message)
    return {
      code: TENANT_ROUTE_NOT_ALLOWED,
      message,
    }
  })
}
