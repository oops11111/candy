/**
 * The Candy transport: what each call sends, and what a refusal becomes.
 *
 * These routes are the only place the page carries authority, so the checks
 * here are about exactly that — the session cookie travels, the CSRF cookie
 * is echoed in the header a write is refused without, and a secret goes out
 * without ever coming back.
 */
import { describe, expect, it, vi } from 'vitest'
import { CandyApiError, createCandyAccountApi, type CandyBrowser } from '../src/client/api.ts'

const ACCOUNT = {
  id: 'account-1',
  provider: 'claude-cli' as const,
  label: 'work',
  createdAt: 1,
  updatedAt: 1,
  validatedAt: undefined,
  revokedAt: undefined,
  isDefault: true,
}

/** A browser whose transport answers from a scripted queue. */
function browser(responses: Response[], cookie = '__Host-candy-csrf=csrf-token'): {
  readonly browser: CandyBrowser
  readonly fetch: ReturnType<typeof vi.fn>
  readonly restart: ReturnType<typeof vi.fn>
} {
  const fetch = vi.fn(async () => {
    const next = responses.shift()
    if (next === undefined) throw new Error('unscripted request')
    return next
  })
  const restart = vi.fn()
  return {
    fetch,
    restart,
    browser: { fetch, cookie: () => cookie, restart },
  }
}

/** One JSON answer. */
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

describe('the Candy account transport', () => {
  it('reads the roster with the session cookie and no CSRF header', async () => {
    const harness = browser([json([ACCOUNT])])

    await expect(createCandyAccountApi(harness.browser).list()).resolves.toEqual([ACCOUNT])

    const [path, init] = harness.fetch.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/api/candy/provider-accounts')
    expect(init.method).toBe('GET')
    expect(init.credentials).toBe('same-origin')
    expect(new Headers(init.headers).get('x-candy-csrf')).toBeNull()
  })

  it('echoes the CSRF cookie on a write and never reads a secret back', async () => {
    const harness = browser([json(ACCOUNT, 201)])

    const created = await createCandyAccountApi(harness.browser).create({
      provider: 'claude-cli', label: 'work', secret: 'provider-secret', isDefault: true,
    })

    const [path, init] = harness.fetch.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/api/candy/provider-accounts/create')
    expect(new Headers(init.headers).get('x-candy-csrf')).toBe('csrf-token')
    expect(JSON.parse(init.body as string)).toEqual({
      provider: 'claude-cli', label: 'work', secret: 'provider-secret', isDefault: true,
    })
    expect(JSON.stringify(created)).not.toContain('provider-secret')
  })

  it('sends an empty CSRF header when no cookie carries the token', async () => {
    // The write still goes out: an absent token and a stale one are the same
    // answer from the envelope, and inventing one here would hide that.
    const harness = browser([json(ACCOUNT)], 'other=value')

    await createCandyAccountApi(harness.browser).revoke('account-1')

    const init = harness.fetch.mock.calls[0]?.[1] as RequestInit
    expect(new Headers(init.headers).get('x-candy-csrf')).toBe('')
  })

  it('addresses each operation at its own path', async () => {
    const harness = browser([
      json({ userId: 'alice', role: 'member', expiresAt: 9 }),
      json({ valid: true }),
      json(ACCOUNT),
      json(ACCOUNT),
      json(ACCOUNT),
    ])
    const api = createCandyAccountApi(harness.browser)

    await expect(api.identity()).resolves.toEqual({ userId: 'alice', role: 'member', expiresAt: 9 })
    await expect(api.validate('account-1')).resolves.toEqual({ valid: true })
    await api.makeDefault('account-1')
    await api.revoke('account-1')
    await api.remove('account-1')

    expect(harness.fetch.mock.calls.map(call => call[0] as string)).toEqual([
      '/auth/session',
      '/api/candy/provider-accounts/validate',
      '/api/candy/provider-accounts/default',
      '/api/candy/provider-accounts/revoke',
      '/api/candy/provider-accounts/delete',
    ])
  })

  it('sends the browser to sign-in after the session ends', async () => {
    const harness = browser([new Response(null, { status: 204 })])

    await createCandyAccountApi(harness.browser).signOut()

    expect(harness.fetch.mock.calls[0]?.[0]).toBe('/auth/logout')
    expect(harness.restart).toHaveBeenCalledOnce()
  })

  it.each([
    [401, 'signedOut'],
    [403, 'forbidden'],
    [404, 'gone'],
    [409, 'refused'],
    [413, 'refused'],
    [500, 'unavailable'],
  ])('turns %i into a %s failure', async (status, kind) => {
    const harness = browser([new Response('refusal reason', { status })])

    const failure = await createCandyAccountApi(harness.browser).list().catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(CandyApiError)
    expect((failure as CandyApiError).kind).toBe(kind)
  })

  it('carries a refusal reason and hides every other status body', async () => {
    const refused = browser([new Response('label is required', { status: 400 })])
    await expect(createCandyAccountApi(refused.browser).list())
      .rejects.toThrow('label is required')

    const empty = browser([new Response('   ', { status: 400 })])
    await expect(createCandyAccountApi(empty.browser).list()).rejects.toThrow('status 400')

    const server = browser([new Response('stack trace the page must not show', { status: 500 })])
    await expect(createCandyAccountApi(server.browser).list()).rejects.toThrow('status 500')
  })

  it('reports a request that never completed as unavailable', async () => {
    const fetch = vi.fn(async () => { throw new Error('connection refused') })
    const api = createCandyAccountApi({ fetch, cookie: () => '', restart: vi.fn() })

    const failure = await api.list().catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(CandyApiError)
    expect((failure as CandyApiError).kind).toBe('unavailable')
    expect((failure as CandyApiError).message).toBe('network')
  })
})
