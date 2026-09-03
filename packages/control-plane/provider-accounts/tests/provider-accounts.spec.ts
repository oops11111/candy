import { ProviderAccountId, UserId, type ProviderKind } from '@deepseek-ai/dsh-control-plane'
import { CredentialKeyVersion, openCredential, type CredentialKeyring } from '@deepseek-ai/dsh-credential-vault'
import { describe, expect, it } from 'vitest'
import {
  createProviderAccount,
  deleteProviderAccount,
  listProviderAccounts,
  ProviderAccountError,
  revokeProviderAccount,
  selectDefaultProviderAccount,
  validateProviderAccount,
  type ProviderAccountEntry,
  type ProviderAccountStore,
} from '../src/index.ts'

const NOW = 1_800_000_000_000
const ALICE = UserId('user-alice')
const BOB = UserId('user-bob')
const DEEPSEEK: ProviderKind = 'deepseek-api'
const CLAUDE: ProviderKind = 'claude-cli'
const KEYRING: CredentialKeyring = {
  currentVersion: CredentialKeyVersion('2026-09-a'),
  keys: new Map([[CredentialKeyVersion('2026-09-a'), Buffer.alloc(32, 7)]]),
}

function memoryStore(): ProviderAccountStore & { readonly entries: Map<string, ProviderAccountEntry> } {
  const entries = new Map<string, ProviderAccountEntry>()
  return {
    entries,
    listByUser: userId => Promise.resolve([...entries.values()].filter(entry => entry.record.userId === userId)),
    find: id => Promise.resolve(entries.get(id)),
    save: (entry) => { entries.set(entry.record.id, entry); return Promise.resolve() },
  }
}

async function create(
  store: ProviderAccountStore,
  id: string,
  userId = ALICE,
  provider = DEEPSEEK,
  makeDefault?: boolean,
) {
  return createProviderAccount(store, KEYRING, {
    id: ProviderAccountId(id),
    userId,
    provider,
    label: ` ${id} `,
    secret: Buffer.from(`secret-${id}`, 'utf8'),
    // Omitted rather than passed undefined: the request declares makeDefault
    // optional, and exactOptionalPropertyTypes distinguishes the two.
    ...makeDefault === undefined ? {} : { makeDefault },
  }, NOW)
}

describe('provider accounts', () => {
  it('creates an encrypted account and returns a secret-free view', async () => {
    const store = memoryStore()

    const created = await create(store, 'account-1')

    expect(created.value).toMatchObject({ id: ProviderAccountId('account-1'), label: 'account-1', isDefault: true })
    expect(JSON.stringify(created.value)).not.toContain('secret-account-1')
    const entry = store.entries.get('account-1')
    expect(entry?.credential.ciphertext).not.toContain('secret-account-1')
    const opened = openCredential(entry!.credential, { userId: ALICE, accountId: ProviderAccountId('account-1') }, KEYRING, NOW)
    expect(opened.opened && Buffer.from(opened.secret).toString('utf8')).toBe('secret-account-1')
  })

  it('lists only the caller accounts and can filter by provider', async () => {
    const store = memoryStore()
    await create(store, 'account-1')
    await create(store, 'account-2', BOB)
    await create(store, 'account-3', ALICE, CLAUDE)

    expect(await listProviderAccounts(store, ALICE)).toHaveLength(2)
    expect(await listProviderAccounts(store, ALICE, DEEPSEEK)).toMatchObject([{ id: ProviderAccountId('account-1') }])
  })

  it('keeps one default per user and provider', async () => {
    const store = memoryStore()
    await create(store, 'account-1')
    await create(store, 'account-2')

    expect(await listProviderAccounts(store, ALICE, DEEPSEEK))
      .toMatchObject([{ isDefault: true }, { isDefault: false }])

    await selectDefaultProviderAccount(store, ALICE, ProviderAccountId('account-2'), NOW + 1)

    expect(await listProviderAccounts(store, ALICE, DEEPSEEK))
      .toMatchObject([{ id: ProviderAccountId('account-1'), isDefault: false }, { id: ProviderAccountId('account-2'), isDefault: true }])
  })

  it('treats another tenant account id as not found', async () => {
    const store = memoryStore()
    await create(store, 'account-1', BOB)

    await expect(selectDefaultProviderAccount(store, ALICE, ProviderAccountId('account-1'), NOW))
      .rejects.toMatchObject({ code: 'not-found' })
  })

  it('revokes an account, revokes the envelope, and promotes a replacement default', async () => {
    const store = memoryStore()
    await create(store, 'account-1')
    await create(store, 'account-2')

    await revokeProviderAccount(store, ALICE, ProviderAccountId('account-1'), NOW + 1)

    const listed = await listProviderAccounts(store, ALICE, DEEPSEEK)
    expect(listed).toMatchObject([
      { id: ProviderAccountId('account-1'), revokedAt: NOW + 1, isDefault: false },
      { id: ProviderAccountId('account-2'), isDefault: true },
    ])
    const opened = openCredential(store.entries.get('account-1')!.credential, { userId: ALICE, accountId: ProviderAccountId('account-1') }, KEYRING, NOW + 1)
    expect(opened).toMatchObject({ opened: false, rejection: 'revoked' })
  })

  it('soft-deletes an account from list results', async () => {
    const store = memoryStore()
    await create(store, 'account-1')

    await deleteProviderAccount(store, ALICE, ProviderAccountId('account-1'), NOW + 1)

    expect(await listProviderAccounts(store, ALICE)).toEqual([])
    await expect(selectDefaultProviderAccount(store, ALICE, ProviderAccountId('account-1'), NOW + 2))
      .rejects.toMatchObject({ code: 'deleted' })
  })

  it('validates with the plaintext secret but returns only a scrubbed diagnostic', async () => {
    const store = memoryStore()
    await create(store, 'account-1')

    const result = await validateProviderAccount(
      store,
      KEYRING,
      ALICE,
      ProviderAccountId('account-1'),
      (provider, secret) => Promise.resolve(
        provider === DEEPSEEK && Buffer.from(secret).toString('utf8') === 'secret-account-1'
          ? { valid: true, diagnostic: 'x'.repeat(500) }
          // The union requires a reason on the failing side, so the branch is
          // explicit rather than a computed `valid` the compiler cannot narrow.
          : { valid: false, reason: 'invalid-credential', diagnostic: 'x'.repeat(500) },
      ),
      NOW + 1,
    )

    expect(result.value.validation).toMatchObject({ valid: true, diagnostic: 'x'.repeat(240) })
    expect(result.value.account.validatedAt).toBe(NOW + 1)
    expect(JSON.stringify(result.value)).not.toContain('secret-account-1')
  })

  it('rejects empty labels and duplicate live ids', async () => {
    const store = memoryStore()
    await expect(createProviderAccount(store, KEYRING, {
      id: ProviderAccountId('account-1'),
      userId: ALICE,
      provider: DEEPSEEK,
      label: ' ',
      secret: Buffer.from('secret', 'utf8'),
    }, NOW)).rejects.toBeInstanceOf(ProviderAccountError)

    await create(store, 'account-1')
    await expect(create(store, 'account-1')).rejects.toMatchObject({ code: 'account-already-exists' })
  })

  it('never lets a deleted id be reused, even by the tenant that owned it', async () => {
    const store = memoryStore()
    await create(store, 'account-1')
    await deleteProviderAccount(store, ALICE, ProviderAccountId('account-1'), NOW + 1)
    const retained = await store.find(ProviderAccountId('account-1'))

    await expect(createProviderAccount(store, KEYRING, {
      id: ProviderAccountId('account-1'),
      userId: ALICE,
      provider: DEEPSEEK,
      label: 'replacement',
      secret: Buffer.from('secret-replacement', 'utf8'),
    }, NOW + 2)).rejects.toMatchObject({ code: 'account-already-exists' })

    // The refusal is what protects it: a caller that reused the id would
    // silently overwrite the very record deletion promises to retain.
    expect(await store.find(ProviderAccountId('account-1'))).toEqual(retained)
  })
})

describe('the paths that refuse an account', () => {
  it('reports an unopenable credential as a failed validation, not a thrown error', async () => {
    const store = memoryStore()
    await create(store, 'account-1')

    // A keyring without the version the envelope names: the vault cannot open
    // it. That is a validation outcome the caller routes on, not a defect.
    const otherKeyring: CredentialKeyring = {
      currentVersion: CredentialKeyVersion('2026-09-b'),
      keys: new Map([[CredentialKeyVersion('2026-09-b'), Buffer.alloc(32, 9)]]),
    }
    let probed = false
    const result = await validateProviderAccount(
      store, otherKeyring, ALICE, ProviderAccountId('account-1'),
      () => { probed = true; return Promise.resolve({ valid: true }) },
      NOW + 1,
    )

    expect(result.value.validation).toEqual({ valid: false, reason: 'invalid-credential' })
    // The probe never runs, so a broken keyring cannot send a secret anywhere.
    expect(probed).toBe(false)
    expect(result.audits).toHaveLength(1)
  })

  it('leaves validatedAt untouched when the probe reports failure', async () => {
    const store = memoryStore()
    await create(store, 'account-1')

    const result = await validateProviderAccount(
      store, KEYRING, ALICE, ProviderAccountId('account-1'),
      () => Promise.resolve({ valid: false, reason: 'provider-unavailable' }),
      NOW + 1,
    )

    // Only a successful probe stamps the record, so a provider outage cannot
    // make a stale credential look freshly checked.
    expect(result.value.account.validatedAt).toBeUndefined()
    expect(store.entries.get('account-1')?.record.updatedAt).toBe(NOW)
  })

  it('returns a validation that carried no diagnostic unchanged', async () => {
    const store = memoryStore()
    await create(store, 'account-1')

    const result = await validateProviderAccount(
      store, KEYRING, ALICE, ProviderAccountId('account-1'),
      () => Promise.resolve({ valid: true }),
      NOW + 1,
    )

    expect(result.value.validation).toEqual({ valid: true })
    expect(result.value.account.validatedAt).toBe(NOW + 1)
  })

  it('refuses an account another tenant owns as not-found', async () => {
    const store = memoryStore()
    await create(store, 'account-1')

    // Reported as absent rather than forbidden: a distinct error would let one
    // tenant probe another's account ids.
    await expect(selectDefaultProviderAccount(store, BOB, ProviderAccountId('account-1'), NOW + 1))
      .rejects.toThrow(new ProviderAccountError('not-found'))
  })

  it('refuses a revoked account', async () => {
    const store = memoryStore()
    await create(store, 'account-1')
    await revokeProviderAccount(store, ALICE, ProviderAccountId('account-1'), NOW + 1)

    await expect(selectDefaultProviderAccount(store, ALICE, ProviderAccountId('account-1'), NOW + 2))
      .rejects.toThrow(new ProviderAccountError('revoked'))
  })

  it('refuses a deleted account', async () => {
    const store = memoryStore()
    await create(store, 'account-1')
    await deleteProviderAccount(store, ALICE, ProviderAccountId('account-1'), NOW + 1)

    await expect(selectDefaultProviderAccount(store, ALICE, ProviderAccountId('account-1'), NOW + 2))
      .rejects.toThrow(new ProviderAccountError('deleted'))
  })

  it.each([
    ['blank once trimmed', '   '],
    ['longer than 120 characters', 'x'.repeat(121)],
  ])('refuses a label that is %s', async (_case, label) => {
    const store = memoryStore()

    await expect(createProviderAccount(store, KEYRING, {
      id: ProviderAccountId('account-1'),
      userId: ALICE,
      provider: DEEPSEEK,
      label,
      secret: Buffer.from('secret', 'utf8'),
    }, NOW)).rejects.toThrow(new ProviderAccountError('invalid-label'))
  })
})
