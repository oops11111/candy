import { Context } from '@deepseek-ai/cordis'
import ProviderCredentialChecks from '@deepseek-ai/dsh-provider-credential-checks'
import { describe, expect, it, vi } from 'vitest'
import { apply, checkDeepSeekCredential } from '../src/index.ts'

const secret = new TextEncoder().encode('test-key')

describe('DeepSeek credential check', () => {
  it.each([[200, true, undefined], [401, false, 'invalid-credential'], [403, false, 'invalid-credential'], [429, false, 'provider-unavailable'], [500, false, 'provider-unavailable']] as const)(
    'maps HTTP %s without exposing provider details', async (status, valid, reason) => {
      const fetcher = vi.fn(async () => new Response('{"private":"body"}', { status })) as unknown as typeof fetch
      const result = await checkDeepSeekCredential(secret, { baseURL: 'https://provider.invalid/', timeoutMs: 100, fetch: fetcher })
      expect(result).toEqual(reason === undefined ? { valid } : { valid, reason })
      expect(JSON.stringify(result)).not.toContain('provider.invalid')
      expect(JSON.stringify(result)).not.toContain('private')
      expect(fetcher).toHaveBeenCalledWith('https://provider.invalid/models', expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer test-key' }),
      }))
    },
  )

  it('contains transport failures and malformed or empty credentials', async () => {
    const unavailable = await checkDeepSeekCredential(secret, {
      baseURL: 'https://provider.invalid', timeoutMs: 1,
      fetch: vi.fn(async () => { throw new Error('endpoint and body must stay private') }) as unknown as typeof fetch,
    })
    expect(unavailable).toEqual({ valid: false, reason: 'provider-unavailable' })
    await expect(checkDeepSeekCredential(new Uint8Array([0xff]), { baseURL: '', timeoutMs: 1 }))
      .resolves.toEqual({ valid: false, reason: 'invalid-credential' })
    await expect(checkDeepSeekCredential(new Uint8Array(), { baseURL: '', timeoutMs: 1 }))
      .resolves.toEqual({ valid: false, reason: 'invalid-credential' })
  })

  it('registers only the deepseek-api provider in the existing registry', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
    const ctx = new Context()
    new ProviderCredentialChecks(ctx)
    apply(ctx, {})
    expect(await ctx.providerCredentialChecks.check('deepseek-api', secret)).toEqual({ valid: true })
    expect(await ctx.providerCredentialChecks.check('claude-cli', secret))
      .toEqual({ valid: false, reason: 'unsupported-provider' })
    await ctx.fiber.dispose()
    globalThis.fetch = originalFetch
  })
})
