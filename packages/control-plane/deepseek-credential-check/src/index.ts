/** DeepSeek HTTP credential validation for Candy provider accounts. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ProviderAccountValidation } from '@deepseek-ai/dsh-provider-accounts'
import type {} from '@deepseek-ai/dsh-provider-credential-checks'

export const name = 'deepseek-credential-check'
export const inject = ['providerCredentialChecks']
const DEFAULT_BASE_URL = 'https://api.deepseek.com'

export interface Config { baseURL?: string; timeoutMs?: number }
export const Config: z<Config> = z.object({
  baseURL: z.string().default(DEFAULT_BASE_URL),
  timeoutMs: z.number().min(1).max(60_000).default(10_000),
})

/** Ask DeepSeek's authenticated model catalog whether a key is usable. */
export async function checkDeepSeekCredential(
  secret: Uint8Array,
  options: { baseURL: string; timeoutMs: number; fetch?: typeof fetch },
): Promise<ProviderAccountValidation> {
  let apiKey: string
  try {
    apiKey = new TextDecoder('utf-8', { fatal: true }).decode(secret).trim()
  } catch {
    return { valid: false, reason: 'invalid-credential' }
  }
  if (apiKey.length === 0) return { valid: false, reason: 'invalid-credential' }
  try {
    const response = await (options.fetch ?? fetch)(`${options.baseURL.replace(/\/$/, '')}/models`, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs),
    })
    if (response.ok) return { valid: true }
    if (response.status === 401 || response.status === 403) {
      return { valid: false, reason: 'invalid-credential' }
    }
    return { valid: false, reason: 'provider-unavailable' }
  } catch {
    return { valid: false, reason: 'provider-unavailable' }
  }
}

export function apply(ctx: Context, config: Config): void {
  const resolved = { baseURL: config.baseURL ?? DEFAULT_BASE_URL, timeoutMs: config.timeoutMs ?? 10_000 }
  ctx.providerCredentialChecks.register('deepseek-api', secret => checkDeepSeekCredential(secret, resolved))
}
