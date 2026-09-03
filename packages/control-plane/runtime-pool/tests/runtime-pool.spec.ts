import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProviderAccountId, UserId } from '@deepseek-ai/dsh-control-plane'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  RUNTIME_POOL_KEY_LENGTH,
  RUNTIME_POOL_ROOT_MODE,
  openRuntimePool,
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

  it('joins a Windows base in Windows syntax, wherever it runs', () => {
    const key = runtimePoolKey(identity())

    // A control plane on Linux resolves a Windows host's pool root, so the
    // base's own syntax decides the separator rather than this platform's.
    expect(runtimePoolRoot('C:\\candy\\pools', key)).toBe(`C:\\candy\\pools\\${key}`)
  })

  it.each([['pools'], ['./pools'], ['pools/candy'], ['C:pools']])('refuses the base %s, absolute in neither syntax', (base) => {
    expect(() => runtimePoolRoot(base, runtimePoolKey(identity())))
      .toThrow(/must be an absolute path/)
  })
})

describe('openRuntimePool', () => {
  let base: string

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'dsh-runtime-pool-'))
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  /** The pool root's POSIX permission bits, as the filesystem holds them. */
  async function modeOf(path: string): Promise<number> {
    return (await stat(path)).mode & 0o777
  }

  it('creates the pool root private to this account', async () => {
    const key = runtimePoolKey(identity())

    const root = await openRuntimePool(base, key)

    expect(root).toBe(runtimePoolRoot(base, key))
    expect(await modeOf(root)).toBe(RUNTIME_POOL_ROOT_MODE)
  })

  it('makes an existing pool root private instead of trusting its permissions', async () => {
    // The root an earlier run, an operator, or a different umask left behind
    // is the one `mkdir` never applies a mode to, and the provider's
    // credential file is written inside it.
    const key = runtimePoolKey(identity())
    const root = runtimePoolRoot(base, key)
    await mkdir(root, { mode: 0o755 })
    await chmod(root, 0o755)

    await openRuntimePool(base, key)

    expect(await modeOf(root)).toBe(RUNTIME_POOL_ROOT_MODE)
  })

  it('keeps what an existing pool holds, so a second run joins it', async () => {
    const key = runtimePoolKey(identity())
    const root = await openRuntimePool(base, key)
    await writeFile(join(root, '.credentials.json'), 'kept', 'utf8')

    await openRuntimePool(base, key)

    expect(await modeOf(root)).toBe(RUNTIME_POOL_ROOT_MODE)
    expect((await stat(join(root, '.credentials.json'))).size).toBe(4)
  })

  it('separates two tenants into two directories', async () => {
    const alice = await openRuntimePool(base, runtimePoolKey(identity()))
    const bobby = await openRuntimePool(base, runtimePoolKey(identity({ userId: UserId('user-2') })))

    expect(alice).not.toBe(bobby)
    expect(await modeOf(bobby)).toBe(RUNTIME_POOL_ROOT_MODE)
  })

  it('refuses a pool base the deployment never provisioned', async () => {
    // Creating the whole tree would place a tenant's home under a mistyped
    // path with whatever permissions its ancestors imply.
    await expect(openRuntimePool(join(base, 'unprovisioned'), runtimePoolKey(identity())))
      .rejects.toThrow(/pool base '.*unprovisioned' does not exist/)
  })

  it('refuses a relative pool base before touching the filesystem', async () => {
    await expect(openRuntimePool('pools', runtimePoolKey(identity())))
      .rejects.toThrow(RangeError)
  })

  it('reports a failure that is not a missing base or an existing pool', async () => {
    const blocked = join(base, 'file')
    await writeFile(blocked, 'not a directory', 'utf8')

    await expect(openRuntimePool(blocked, runtimePoolKey(identity())))
      .rejects.toThrow(/ENOTDIR/)
  })
})
