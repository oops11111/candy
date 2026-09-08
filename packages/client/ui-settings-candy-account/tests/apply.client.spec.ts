/**
 * Candy account page registration: the slot contribution, the injected face,
 * the locale-following nav label, and HMR recovery.
 *
 * This lane has no jsdom `window`, so the plugin's browser reader is exercised
 * separately with globals staged for it.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import { CandyAccountSection } from '../src/client/CandyAccountSection.tsx'
import { CandyAuditSection } from '../src/client/CandyAuditSection.tsx'
import type { CandyAccountInjected } from '../src/client/CandyAccountSection.tsx'
import { apply as hostApply } from '../src/index.ts'

/** A context carrying the two services this plugin injects. */
async function bench(): Promise<{ ctx: Context; slots: SlotRegistry; locale: LocaleRuntime }> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale }
}

/** Declare the settings slot this page registers into. */
function declare(slots: SlotRegistry): () => void {
  return slots.register(
    { name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } } as never,
    () => null,
  )
}

/** The registered entry's injected face. */
function injected(slots: SlotRegistry): CandyAccountInjected {
  const entry = slots.entries('settings.section')[0]
  if (entry === undefined) throw new Error('the account page did not register')
  return (entry.inject as unknown as () => CandyAccountInjected)()
}

describe('ui-settings-candy-account apply', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares only the services it reads', () => {
    // No Remote namespace: Candy's routes carry their own authority, and
    // injecting one would make this page wait on a transport it never uses.
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('registers the page for declarations before or after apply', async () => {
    const before = await bench()
    declare(before.slots)
    await before.ctx.plugin({ inject: [...inject], apply }).await()

    const entry = before.slots.entries('settings.section')[0]
    expect(entry?.component).toBe(CandyAccountSection)
    expect(entry?.options).toMatchObject({ id: 'candy-account', order: 5 })
    // The declared namespace is what synthesizes the page's `t` seat.
    expect(entry?.locale).toBe('settings.candyAccount')
    expect(resolveSlotLabel(entry?.options.label)).toBe('账户')

    const after = await bench()
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    expect(after.slots.entries('settings.section')).toHaveLength(0)
    declare(after.slots)
    await Promise.resolve()
    expect(after.slots.entries('settings.section')).toHaveLength(2)
    expect(after.slots.entries('settings.section')[0]?.component).toBe(CandyAccountSection)
    expect(after.slots.entries('settings.section')[1]?.component).toBe(CandyAuditSection)
  })

  it('removes the contribution with the plugin fiber', async () => {
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('settings.section')).toHaveLength(2)

    await fiber.dispose()

    expect(b.slots.entries('settings.section')).toHaveLength(0)
  })

  it('follows the active locale without re-registering', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries('settings.section')[0]

    b.locale.setLocale('en')
    expect(resolveSlotLabel(entry?.options.label)).toBe('Account')
    b.locale.setLocale('zh')
    expect(resolveSlotLabel(entry?.options.label)).toBe('账户')
  })

  it('injects one controller store and callbacks over it', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const face = injected(b.slots)

    // Every surface reads one store; a second inject call must not mint another.
    expect(injected(b.slots).hooks.candyAccount).toBe(face.hooks.candyAccount)
    face.beginCreate('codex-cli')
    expect(face.hooks.candyAccount.getSnapshot().draft).toMatchObject({ provider: 'codex-cli' })
    face.editDraft({ label: 'work' })
    expect(face.hooks.candyAccount.getSnapshot().draft).toMatchObject({ label: 'work' })
    face.confirmDelete('account-1')
    expect(face.hooks.candyAccount.getSnapshot().confirming).toBe('account-1')
    face.cancelCreate()
    expect(face.hooks.candyAccount.getSnapshot().draft).toBeNull()
    expect(face.formatTime(0)).toMatch(/1970/u)
  })

  it('reads and leaves the browser through the page it is served on', async () => {
    const cookie = '__Host-candy-csrf=token'
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => new Response('{}', {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    const assign = vi.fn()
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('document', { cookie })
    vi.stubGlobal('location', { assign })
    try {
      const b = await bench()
      declare(b.slots)
      await b.ctx.plugin({ inject: [...inject], apply }).await()
      const face = injected(b.slots)

      await face.load()
      expect(fetch.mock.calls.map(call => call[0])).toEqual([
        '/auth/session', '/api/candy/provider-accounts',
      ])

      face.signIn()
      expect(assign).toHaveBeenCalledWith('/auth/oauth/start')

      // Every remaining callback reaches the same transport; a write also
      // reads the CSRF cookie back out of the document it is served on.
      face.beginCreate('claude-cli')
      face.editDraft({ label: 'work', secret: 'provider-secret' })
      await face.confirmCreate()
      await face.validate('account-1')
      await face.makeDefault('account-1')
      await face.revoke('account-1')
      face.confirmDelete('account-1')
      await face.remove()
      await face.signOut()

      expect(fetch.mock.calls.map(call => call[0])).toEqual([
        '/auth/session', '/api/candy/provider-accounts',
        '/api/candy/provider-accounts/create',
        // The create re-reads the roster before the next action runs.
        '/auth/session', '/api/candy/provider-accounts',
        '/api/candy/provider-accounts/validate',
        '/api/candy/provider-accounts/default',
        '/auth/session', '/api/candy/provider-accounts',
        '/api/candy/provider-accounts/revoke',
        '/auth/session', '/api/candy/provider-accounts',
        '/api/candy/provider-accounts/delete',
        '/auth/session', '/api/candy/provider-accounts',
        '/auth/logout',
      ])
      const write = fetch.mock.calls.find(call => call[0] === '/api/candy/provider-accounts/create')
      expect(new Headers(write?.[1]?.headers).get('x-candy-csrf')).toBe('token')
      expect(assign).toHaveBeenCalledTimes(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
