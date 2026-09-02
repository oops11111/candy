import { ProviderAccountId, UserId } from '@deepseek-ai/dsh-control-plane'
import { describe, expect, it } from 'vitest'
import {
  RUNTIME_POOL_KEY_LENGTH,
  parseRuntimePoolKey,
  runtimePoolKey,
  runtimePoolRoot,
  type RuntimePoolIdentity,
} from '../src/index.ts'

function identity(overrides: Partial<RuntimePoolIdentity> = {}): RuntimePoolIdentity {
  return {
    userId: UserId('user-1'),
    provider: 'deepseek-api',
    accountId: ProviderAccountId('account-1'),
    ...overrides,
  }
}

describe('runtimePoolKey', () => {
  it('is stable for one identity', () => {
    expect(runtimePoolKey(identity())).toBe(runtimePoolKey(identity()))
  })

  it('spells the key as lowercase hex of the documented length', () => {
    const key = runtimePoolKey(identity())

    expect(key).toMatch(/^[0-9a-f]+$/)
    expect(key).toHaveLength(RUNTIME_POOL_KEY_LENGTH)
  })

  it.each([
    ['tenant', identity({ userId: UserId('user-2') })],
    ['provider', identity({ provider: 'claude-cli' })],
    ['account', identity({ accountId: ProviderAccountId('account-2') })],
  ])('separates pools that differ by %s', (_field, other) => {
    expect(runtimePoolKey(other)).not.toBe(runtimePoolKey(identity()))
  })

  it('separates ids that differ only in case, which a path would fold together', () => {
    const lower = runtimePoolKey(identity({ userId: UserId('tenant') }))
    const upper = runtimePoolKey(identity({ userId: UserId('TENANT') }))

    expect(lower).not.toBe(upper)
  })

  it('separates triples that only shift a boundary between fields', () => {
    const left = runtimePoolKey(identity({
      userId: UserId('ab'), accountId: ProviderAccountId('c'),
    }))
    const right = runtimePoolKey(identity({
      userId: UserId('a'), accountId: ProviderAccountId('bc'),
    }))

    expect(left).not.toBe(right)
  })

  it('reduces an id carrying path syntax to plain hex', () => {
    const key = runtimePoolKey(identity({ userId: UserId('../../etc/shadow') }))

    expect(key).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('parseRuntimePoolKey', () => {
  it('admits a minted key', () => {
    const key = runtimePoolKey(identity())

    expect(parseRuntimePoolKey(key)).toBe(key)
  })

  it.each([
    ['empty', ''],
    ['too short', 'a'.repeat(63)],
    ['too long', 'a'.repeat(65)],
    ['uppercase hex', 'A'.repeat(64)],
    ['non-hex', 'z'.repeat(64)],
    ['path syntax', '../'.padEnd(64, 'a')],
  ])('refuses a %s value', (_case, value) => {
    expect(parseRuntimePoolKey(value)).toBeUndefined()
  })
})

describe('runtimePoolRoot', () => {
  it('places a pool directly under the base', () => {
    const key = runtimePoolKey(identity())

    expect(runtimePoolRoot('/srv/candy/pools', key)).toBe(`/srv/candy/pools/${key}`)
  })

  it('gives two pools two directories', () => {
    const first = runtimePoolRoot('/srv/candy/pools', runtimePoolKey(identity()))
    const second = runtimePoolRoot('/srv/candy/pools', runtimePoolKey(identity({ provider: 'codex-cli' })))

    expect(first).not.toBe(second)
  })

  it('keeps a root under its base even when the tenant id is path syntax', () => {
    const base = '/srv/candy/pools'
    const key = runtimePoolKey(identity({ userId: UserId('../../../root') }))

    const root = runtimePoolRoot(base, key)

    expect(root.startsWith(`${base}/`)).toBe(true)
    expect(root).not.toContain('..')
  })

  it('refuses a base that is not absolute', () => {
    expect(() => runtimePoolRoot('pools', runtimePoolKey(identity())))
      .toThrow(/must be an absolute path, got 'pools'/)
  })
})
