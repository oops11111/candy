/**
 * The runtime-pool key and the directory it owns.
 *
 * [Candy Runtime Boundaries](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/candy-runtime-boundaries.md)
 * lets workers share immutable CLI binaries and package caches, and forbids
 * sharing authenticated home directories, writable provider config,
 * environment overlays, process trees, session stores, private caches, or
 * workspace mounts across `userId + provider + accountId`. This module turns
 * that triple into one key and one containing directory, so "what may a pool
 * share" has a single answer every later package reads the same way.
 *
 * The key is a digest rather than the triple's text. Tenant and account ids
 * are opaque strings this repository does not constrain: spelled into a path
 * directly they could traverse out of the base, exceed a path limit, or — on
 * a case-insensitive filesystem — collide two tenants whose ids differ only in
 * case onto one directory. A lowercase hex digest of fixed length has none of
 * those properties, and the inputs are length-prefixed so no two distinct
 * triples can produce one key by shifting a boundary between fields.
 *
 * @module @deepseek-ai/dsh-runtime-pool
 */

import { createHash } from 'node:crypto'
import { posix, win32 } from 'node:path'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { ProviderAccountId, ProviderKind, UserId } from '@deepseek-ai/dsh-control-plane'

/** Length of the hex digest a key is spelled as. */
const KEY_LENGTH = 64

/** The grammar {@link parseRuntimePoolKey} admits: lowercase hex only, so a key can never traverse. */
const KEY_PATTERN = /^[0-9a-f]{64}$/

/** The tenant, provider, and account whose runtime state may be shared. */
export interface RuntimePoolIdentity {
  /** Tenant the pool runs for. */
  readonly userId: UserId
  /** Provider the pool executes. */
  readonly provider: ProviderKind
  /** Provider account the pool authenticates as. */
  readonly accountId: ProviderAccountId
}

/**
 * One runtime pool's isolation key: a 64-character lowercase hex digest.
 *
 * A value of this type is always well-formed, because the only ways to obtain
 * one are {@link runtimePoolKey}, which mints it, and
 * {@link parseRuntimePoolKey}, which admits a stored one after checking the
 * grammar. There is no free-form constructor, so {@link runtimePoolRoot}
 * cannot be handed a key that escapes its base.
 */
export type RuntimePoolKey = Branded<'RuntimePoolKey'>

/**
 * Derive the isolation key for one tenant, provider, and account.
 *
 * @param identity - the triple whose runtime state may be shared.
 * @returns the pool's key; equal identities give equal keys, and distinct ones do not collide.
 */
export function runtimePoolKey(identity: RuntimePoolIdentity): RuntimePoolKey {
  // Length-prefixed so no field boundary can be forged: ('ab', 'c') and
  // ('a', 'bc') must not digest alike.
  const canonical = [identity.userId, identity.provider, identity.accountId]
    .map(field => `${String(field.length)}:${field}`)
    .join('')
  return brandString<RuntimePoolKey>(createHash('sha256').update(canonical, 'utf8').digest('hex'))
}

/**
 * Admit a stored key, which arrives as ordinary text from a database or file.
 *
 * @param value - the stored key.
 * @returns the key, or undefined when it is not the 64-character lowercase hex a mint produces.
 */
export function parseRuntimePoolKey(value: string): RuntimePoolKey | undefined {
  return KEY_PATTERN.test(value) ? brandString<RuntimePoolKey>(value) : undefined
}

/**
 * The one directory a runtime pool owns.
 *
 * Everything private to the pool — its authenticated provider home, writable
 * config, private caches, and session state — belongs under this path, and
 * nothing under it may be shared with another pool. Immutable CLI binaries and
 * shared package caches live outside it, which is what the boundaries page
 * permits pools to share.
 *
 * The base's own syntax decides how the path is joined, not the platform this
 * runs on: a control plane on Linux resolves a Windows host's pool root, and
 * `path.join` on that host would produce the other separator. POSIX is tried
 * first because the Win32 rules also accept a leading slash.
 *
 * @param base - absolute directory holding every pool's root, in POSIX or Win32 syntax.
 * @param key - the pool's key.
 * @returns the pool's own directory, always directly under `base`, in the base's own syntax.
 * @throws RangeError when `base` is absolute in neither syntax, since a pool root
 *   resolved against a working directory is a deployment error.
 */
export function runtimePoolRoot(base: string, key: RuntimePoolKey): string {
  if (posix.isAbsolute(base)) return posix.join(base, key)
  if (win32.isAbsolute(base)) return win32.join(base, key)
  throw new RangeError(`dsh-runtime-pool: the pool base must be an absolute path, got '${base}'`)
}

/** How many characters a key is spelled with, for callers sizing a column or a path budget. */
export const RUNTIME_POOL_KEY_LENGTH = KEY_LENGTH
