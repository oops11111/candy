/**
 * The binding a paired host keeps, over the real local credential provider
 * and a real file: the record has to survive a restart and be singular under
 * concurrency, and a double would prove neither.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { DeviceId, UserId } from '@deepseek-ai/dsh-control-plane'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DeviceBinding, {
  describeBinding,
  DeviceBindingError,
  normalizeServerOrigin,
  type HostDeviceBinding,
} from '../src/index.ts'

const NOW = 1_780_000_000_000
const ALICE = UserId('user-alice')
const BOBBY = UserId('user-bobby')
const DEVICE = DeviceId('device-1')
const ORIGIN = 'https://candy.example'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  while (cleanups.length > 0) await cleanups.pop()?.()
})

/** A credential file of this test's own, and the two services over it. */
async function boot(at?: string): Promise<{ ctx: Context; path: string }> {
  const dir = at ?? await mkdtemp(join(tmpdir(), 'dsh-device-binding-'))
  if (at === undefined) cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, '.credentials.yaml')
  const ctx = new Context()
  const credentials = ctx.plugin(LocalCredentialProvider, { path, watch: false })
  await credentials
  const binding = ctx.plugin(DeviceBinding)
  await binding
  cleanups.push(async () => {
    await binding.dispose()
    await credentials.dispose()
  })
  return { ctx, path: dir }
}

/** What a pairing exchange hands the host. */
function pairing(overrides: Partial<Parameters<DeviceBinding['bind']>[0]> = {}): Parameters<DeviceBinding['bind']>[0] {
  return { serverOrigin: ORIGIN, userId: ALICE, deviceId: DEVICE, token: 'device-token', ...overrides }
}

/** The code the operation refused with. */
async function refusal(operation: () => Promise<unknown>): Promise<string> {
  try {
    await operation()
  } catch (error) {
    if (error instanceof DeviceBindingError) return error.code
    throw error
  }
  throw new Error('the operation was not refused')
}

describe('the binding a host takes', () => {
  it('answers nothing while the host is unpaired', async () => {
    const { ctx } = await boot()

    expect(await ctx.deviceBinding.read()).toBeUndefined()
    expect(await ctx.deviceBinding.describe()).toBeUndefined()
    // Releasing an unpaired host is not being told it was too late.
    await expect(ctx.deviceBinding.release()).resolves.toBeUndefined()
  })

  it('keeps which server it serves and as whom, across a restart', async () => {
    const first = await boot()

    const taken = await first.ctx.deviceBinding.bind(pairing(), NOW)
    expect(taken).toEqual({
      serverOrigin: ORIGIN, userId: ALICE, deviceId: DEVICE, token: 'device-token', boundAt: NOW,
    })

    const second = await boot(first.path)
    expect(await second.ctx.deviceBinding.read()).toEqual(taken)
  })

  it('reports the binding without the token it holds', async () => {
    const { ctx } = await boot()
    await ctx.deviceBinding.bind(pairing(), NOW)

    const view = await ctx.deviceBinding.describe()

    expect(view).toEqual({ serverOrigin: ORIGIN, userId: ALICE, deviceId: DEVICE, boundAt: NOW })
    expect(JSON.stringify(view)).not.toContain('device-token')
    expect(describeBinding(await ctx.deviceBinding.read() as HostDeviceBinding)).toEqual(view)
  })

  it('asks the bound deployment whether this device still authenticates', async () => {
    const { ctx } = await boot()
    await ctx.deviceBinding.bind(pairing(), NOW)
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      deviceId: DEVICE,
      userId: ALICE,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetcher)

    await expect(ctx.deviceBinding.verify()).resolves.toBe(true)
    expect(fetcher).toHaveBeenCalledWith(`${ORIGIN}/api/candy/devices/authenticate`, {
      method: 'GET',
      headers: { authorization: 'Bearer device-token' },
    })
  })

  it('does not mistake an absent or refused binding for a live one', async () => {
    const { ctx } = await boot()
    const fetcher = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetcher)
    await expect(ctx.deviceBinding.verify()).resolves.toBe(false)
    expect(fetcher).not.toHaveBeenCalled()

    await ctx.deviceBinding.bind(pairing(), NOW)
    fetcher.mockResolvedValueOnce(new Response(undefined, { status: 401 }))
    await expect(ctx.deviceBinding.verify()).resolves.toBe(false)
  })

  it('refuses an authenticated reply for another identity', async () => {
    const { ctx } = await boot()
    await ctx.deviceBinding.bind(pairing(), NOW)
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      deviceId: 'somebody-elses-device', userId: ALICE,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetcher)

    await expect(ctx.deviceBinding.verify())
      .rejects.toMatchObject({ code: 'invalid-response' })
  })

  it('keeps server, protocol, and network failures distinct from revocation', async () => {
    const { ctx } = await boot()
    await ctx.deviceBinding.bind(pairing(), NOW)
    const fetcher = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetcher)

    fetcher.mockResolvedValueOnce(new Response(undefined, { status: 503 }))
    await expect(ctx.deviceBinding.verify())
      .rejects.toMatchObject({ code: 'unexpected-status' })

    fetcher.mockResolvedValueOnce(new Response('not json', { status: 200 }))
    await expect(ctx.deviceBinding.verify())
      .rejects.toMatchObject({ code: 'invalid-response' })

    fetcher.mockResolvedValueOnce(new Response('null', { status: 200 }))
    await expect(ctx.deviceBinding.verify())
      .rejects.toMatchObject({ code: 'invalid-response' })

    fetcher.mockRejectedValueOnce(new Error('offline'))
    await expect(ctx.deviceBinding.verify()).rejects.toThrow('offline')
  })

  it('normalizes a server people type in more than one way', async () => {
    expect(normalizeServerOrigin('https://Candy.example/')).toBe(ORIGIN)
    expect(normalizeServerOrigin('https://candy.example/some/path')).toBe(ORIGIN)
    expect(normalizeServerOrigin('http://candy.example:8080')).toBe('http://candy.example:8080')

    const { ctx } = await boot()
    const taken = await ctx.deviceBinding.bind(pairing({ serverOrigin: 'https://CANDY.example/x' }), NOW)

    expect(taken.serverOrigin).toBe(ORIGIN)
  })

  it('refuses a server that is not one, and an identity that is blank', async () => {
    const { ctx } = await boot()

    expect(await refusal(() => ctx.deviceBinding.bind(pairing({ serverOrigin: 'candy.example' }), NOW)))
      .toBe('invalid-origin')
    expect(await refusal(() => ctx.deviceBinding.bind(pairing({ serverOrigin: 'ftp://candy.example' }), NOW)))
      .toBe('invalid-origin')
    expect(await refusal(() => ctx.deviceBinding.bind(pairing({ userId: UserId('') }), NOW)))
      .toBe('invalid-identity')
    expect(await refusal(() => ctx.deviceBinding.bind(pairing({ deviceId: DeviceId('') }), NOW)))
      .toBe('invalid-identity')
    expect(await refusal(() => ctx.deviceBinding.bind(pairing({ token: '' }), NOW)))
      .toBe('invalid-identity')
    expect(await ctx.deviceBinding.read()).toBeUndefined()
  })
})

describe('a host that already serves someone', () => {
  it('refuses another tenant, another device, and another deployment', async () => {
    // A machine serving two tenants at once is a machine on which either
    // tenant's work can reach the other's files.
    const { ctx } = await boot()
    await ctx.deviceBinding.bind(pairing(), NOW)

    for (const other of [
      pairing({ userId: BOBBY }),
      pairing({ deviceId: DeviceId('device-2') }),
      pairing({ serverOrigin: 'https://other.example' }),
    ]) {
      expect(await refusal(() => ctx.deviceBinding.bind(other, NOW + 1))).toBe('already-bound')
    }

    expect(await ctx.deviceBinding.read())
      .toMatchObject({ userId: ALICE, deviceId: DEVICE, serverOrigin: ORIGIN })
  })

  it('accepts the same host again and takes its new token', async () => {
    // What a host does when its tenant re-pairs it after rotating the
    // credential: the machine has served this tenant since it was bound.
    const { ctx } = await boot()
    await ctx.deviceBinding.bind(pairing(), NOW)

    const rotated = await ctx.deviceBinding.bind(pairing({ token: 'second-token' }), NOW + 60_000)

    expect(rotated).toEqual({
      serverOrigin: ORIGIN, userId: ALICE, deviceId: DEVICE, token: 'second-token', boundAt: NOW,
    })
  })

  it('installs exactly one binding when two pairings land at once', async () => {
    const { ctx } = await boot()

    const outcomes = await Promise.allSettled([
      ctx.deviceBinding.bind(pairing(), NOW),
      ctx.deviceBinding.bind(pairing({ userId: BOBBY, deviceId: DeviceId('device-2') }), NOW),
    ])

    expect(outcomes.filter(one => one.status === 'fulfilled')).toHaveLength(1)
    const loser = outcomes.find(one => one.status === 'rejected')
    expect((loser as PromiseRejectedResult).reason).toMatchObject({ code: 'already-bound' })
    const held = await ctx.deviceBinding.read()
    expect(held?.userId === ALICE || held?.userId === BOBBY).toBe(true)
  })

  it('lets an operator release it and pair the machine to someone else', async () => {
    const { ctx } = await boot()
    await ctx.deviceBinding.bind(pairing(), NOW)

    await ctx.deviceBinding.release()

    expect(await ctx.deviceBinding.read()).toBeUndefined()
    const rebound = await ctx.deviceBinding.bind(
      pairing({ userId: BOBBY, deviceId: DeviceId('device-2'), token: 'bobby-token' }), NOW + 1,
    )
    expect(rebound).toMatchObject({ userId: BOBBY, deviceId: DeviceId('device-2'), boundAt: NOW + 1 })
  })
})

describe('a record this service did not write', () => {
  it.each([
    ['not an object', 'a string'],
    ['null', null],
    ['missing the server', { userId: 'u', deviceId: 'd', token: 't', boundAt: NOW }],
    ['missing the tenant', { serverOrigin: ORIGIN, deviceId: 'd', token: 't', boundAt: NOW }],
    ['missing the device', { serverOrigin: ORIGIN, userId: 'u', token: 't', boundAt: NOW }],
    ['missing the token', { serverOrigin: ORIGIN, userId: 'u', deviceId: 'd', boundAt: NOW }],
    ['missing the instant', { serverOrigin: ORIGIN, userId: 'u', deviceId: 'd', token: 't' }],
    ['an unusable instant', { serverOrigin: ORIGIN, userId: 'u', deviceId: 'd', token: 't', boundAt: 'soon' }],
  ])('reads as unpaired when the stored payload is %s', async (_name, payload) => {
    // The seam stores a grant payload as opaque JSON and hands it back
    // uninterpreted, so a hand-edited file reaches this exact boundary.
    const { ctx } = await boot()
    await ctx.credentials.modifyRecord(
      credentialKey('device-binding', 'host'),
      () => Promise.resolve({ kind: 'grant', payload }),
    )

    expect(await ctx.deviceBinding.read()).toBeUndefined()
    // And an unusable record does not stand in the way of pairing the host.
    await expect(ctx.deviceBinding.bind(pairing(), NOW)).resolves.toMatchObject({ userId: ALICE })
  })

  it('reads as unpaired when the record is not a grant', async () => {
    const { ctx } = await boot()
    await ctx.credentials.modifyRecord(
      credentialKey('device-binding', 'host'),
      () => Promise.resolve({ kind: 'api-key', key: 'sk-not-a-binding' }),
    )

    expect(await ctx.deviceBinding.read()).toBeUndefined()
  })

  it('keeps the token out of every file but the credential store', async () => {
    const { ctx, path } = await boot()
    await ctx.deviceBinding.bind(pairing(), NOW)

    // The store is where a secret belongs, and it is the only place this is.
    const stored = await readFile(join(path, '.credentials.yaml'), 'utf8')
    expect(stored).toContain('device-token')
    expect(stored).toContain('device-binding')
  })
})
