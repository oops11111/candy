/**
 * The account page's state machine over a scripted control plane.
 *
 * Two rules carry the page: the control plane is the only fact source, so a
 * mutation that can move another row re-reads the roster; and a session that
 * ended is not a failed call, so it clears what is on screen instead of
 * leaving another tenant's neighbour's rows visible.
 */
import { describe, expect, it, vi } from 'vitest'
import { CandyApiError, type CandyAccountApi, type CandyAccountView } from '../src/client/api.ts'
import { CandyAccountController, draftBlocker, MAX_LABEL_LENGTH, MAX_SECRET_LENGTH } from '../src/client/store.ts'

const IDENTITY = { userId: 'alice', role: 'member' as const, expiresAt: 9 }

/** One account view. */
function account(overrides: Partial<CandyAccountView> = {}): CandyAccountView {
  return {
    id: 'account-1',
    provider: 'claude-cli',
    label: 'work',
    createdAt: 1,
    updatedAt: 1,
    validatedAt: undefined,
    revokedAt: undefined,
    isDefault: false,
    ...overrides,
  }
}

/** An API whose every operation answers, with the calls it received recorded. */
function api(overrides: Partial<CandyAccountApi> = {}): CandyAccountApi {
  return {
    identity: vi.fn(async () => IDENTITY),
    list: vi.fn(async () => [account()]),
    create: vi.fn(async () => account()),
    validate: vi.fn(async () => ({ valid: true })),
    makeDefault: vi.fn(async () => account({ isDefault: true })),
    revoke: vi.fn(async () => account({ revokedAt: 2 })),
    remove: vi.fn(async () => account({ revokedAt: 2 })),
    signOut: vi.fn(async () => {}),
    ...overrides,
  }
}

/** A controller with an open, submittable draft. */
async function withDraft(controller: CandyAccountController): Promise<void> {
  await controller.load()
  controller.beginCreate('claude-cli')
  controller.editDraft({ label: 'work', secret: 'provider-secret' })
}

describe('draftBlocker', () => {
  const draft = { provider: 'claude-cli' as const, label: 'work', secret: 's', isDefault: false, saving: false, error: null }

  it('names the first thing a draft is missing', () => {
    expect(draftBlocker(draft)).toBeUndefined()
    expect(draftBlocker({ ...draft, label: '   ' })).toBe('labelRequired')
    expect(draftBlocker({ ...draft, label: 'x'.repeat(MAX_LABEL_LENGTH + 1) })).toBe('labelTooLong')
    expect(draftBlocker({ ...draft, secret: '' })).toBe('secretRequired')
    expect(draftBlocker({ ...draft, secret: 'x'.repeat(MAX_SECRET_LENGTH + 1) })).toBe('secretTooLong')
  })
})

describe('the account page controller', () => {
  it('reads the identity and the roster together', async () => {
    const controller = new CandyAccountController(api())

    await controller.load()

    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'ready',
      failure: null,
      identity: IDENTITY,
      rows: [account()],
    })
  })

  it('keeps the roster on a failed read and clears it when the session ended', async () => {
    const unreachable = new CandyAccountController(api({
      list: vi.fn(async () => { throw new CandyApiError('unavailable', 'network') }),
    }))
    await unreachable.load()
    expect(unreachable.store.getSnapshot()).toMatchObject({ status: 'failed', failure: 'unavailable' })

    let live = true
    const signedOut = new CandyAccountController(api({
      list: vi.fn(async () => {
        if (!live) throw new CandyApiError('signedOut', 'status 401')
        return [account()]
      }),
    }))
    await signedOut.load()
    expect(signedOut.store.getSnapshot().rows).toHaveLength(1)

    live = false
    await signedOut.load()
    expect(signedOut.store.getSnapshot()).toMatchObject({
      failure: 'signedOut', identity: null, rows: [], draft: null,
    })
  })

  it('treats a rejection that is not the transport\'s as unavailable', async () => {
    const controller = new CandyAccountController(api({
      identity: vi.fn(async () => { throw new TypeError('undefined is not a function') }),
    }))

    await controller.load()

    expect(controller.store.getSnapshot().failure).toBe('unavailable')
  })

  it('opens, edits, and closes the create form', async () => {
    const controller = new CandyAccountController(api())

    controller.beginCreate('deepseek-api')
    expect(controller.store.getSnapshot().draft).toMatchObject({ provider: 'deepseek-api', label: '', secret: '' })

    controller.editDraft({ label: 'work', isDefault: true })
    expect(controller.store.getSnapshot().draft).toMatchObject({ label: 'work', isDefault: true })

    controller.cancelCreate()
    expect(controller.store.getSnapshot().draft).toBeNull()

    // A keystroke that arrives after the form closed does not reopen it.
    controller.editDraft({ secret: 'late' })
    expect(controller.store.getSnapshot().draft).toBeNull()
  })

  it('sends the trimmed label and the secret verbatim, then re-reads the roster', async () => {
    const scripted = api()
    const controller = new CandyAccountController(scripted)
    await withDraft(controller)
    controller.editDraft({ label: '  work  ', isDefault: true })

    await controller.confirmCreate()

    expect(scripted.create).toHaveBeenCalledWith({
      provider: 'claude-cli', label: 'work', secret: 'provider-secret', isDefault: true,
    })
    expect(scripted.list).toHaveBeenCalledTimes(2)
    expect(controller.store.getSnapshot().draft).toBeNull()
  })

  it('submits nothing while the draft is closed, blocked, or already in flight', async () => {
    const scripted = api()
    const controller = new CandyAccountController(scripted)

    await controller.confirmCreate()
    controller.beginCreate('claude-cli')
    await controller.confirmCreate()
    expect(scripted.create).not.toHaveBeenCalled()

    controller.editDraft({ label: 'work', secret: 'provider-secret' })
    controller.store.update((state) => {
      if (state.draft !== null) state.draft.saving = true
    })
    await controller.confirmCreate()
    expect(scripted.create).not.toHaveBeenCalled()
  })

  it('keeps a refused draft open with its reason, and drops it when the session ended', async () => {
    const refused = new CandyAccountController(api({
      create: vi.fn(async () => { throw new CandyApiError('refused', 'label is required') }),
    }))
    await withDraft(refused)
    await refused.confirmCreate()
    expect(refused.store.getSnapshot().draft).toMatchObject({ saving: false, error: 'label is required' })

    const broken = new CandyAccountController(api({
      create: vi.fn(async () => { throw new TypeError('boom') }),
    }))
    await withDraft(broken)
    await broken.confirmCreate()
    expect(broken.store.getSnapshot().draft?.error).toBe('unavailable')

    const expired = new CandyAccountController(api({
      create: vi.fn(async () => { throw new CandyApiError('signedOut', 'status 401') }),
    }))
    await withDraft(expired)
    await expired.confirmCreate()
    expect(expired.store.getSnapshot()).toMatchObject({ failure: 'signedOut', draft: null })
  })

  it('drops a refusal that arrives after the form was cancelled', async () => {
    let release = (): void => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    const controller = new CandyAccountController(api({
      create: vi.fn(async () => {
        await held
        throw new CandyApiError('refused', 'label is required')
      }),
    }))
    await withDraft(controller)

    const submitting = controller.confirmCreate()
    controller.cancelCreate()
    release()
    await submitting

    expect(controller.store.getSnapshot().draft).toBeNull()
  })

  it('reports what the provider answered about a credential', async () => {
    const usable = new CandyAccountController(api())
    await usable.validate('account-1')
    expect(usable.store.getSnapshot().notice).toEqual({ id: 'account-1', outcome: 'valid' })

    const rejected = new CandyAccountController(api({
      validate: vi.fn(async () => ({ valid: false, reason: 'invalid-credential' })),
    }))
    await rejected.validate('account-1')
    expect(rejected.store.getSnapshot().notice)
      .toEqual({ id: 'account-1', outcome: 'invalid', reason: 'invalid-credential' })
  })

  it('separates a call that did not go through from a credential that does not work', async () => {
    const controller = new CandyAccountController(api({
      validate: vi.fn(async () => { throw new CandyApiError('gone', 'status 404') }),
    }))

    await controller.validate('account-1')

    expect(controller.store.getSnapshot()).toMatchObject({
      busy: null,
      notice: { id: 'account-1', outcome: 'failed', reason: 'status 404' },
    })
  })

  it('records an unrecognized rejection from an account action as unavailable', async () => {
    const controller = new CandyAccountController(api({
      revoke: vi.fn(async () => { throw new TypeError('boom') }),
    }))

    await controller.revoke('account-1')

    expect(controller.store.getSnapshot().notice).toMatchObject({ outcome: 'failed', reason: 'unavailable' })
  })

  it('re-reads the roster after an action that can move another row', async () => {
    const scripted = api()
    const controller = new CandyAccountController(scripted)
    await controller.load()

    await controller.makeDefault('account-1')
    await controller.revoke('account-1')

    expect(scripted.list).toHaveBeenCalledTimes(3)
    // A check reports on one row alone, so it re-reads nothing.
    await controller.validate('account-1')
    expect(scripted.list).toHaveBeenCalledTimes(3)
  })

  it('runs one account action at a time', async () => {
    let release = (): void => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    const scripted = api({ revoke: vi.fn(async () => { await held; return account({ revokedAt: 2 }) }) })
    const controller = new CandyAccountController(scripted)

    const first = controller.revoke('account-1')
    await controller.makeDefault('account-2')
    expect(scripted.makeDefault).not.toHaveBeenCalled()

    release()
    await first
    expect(controller.store.getSnapshot().busy).toBeNull()
  })

  it('deletes only the account the tenant confirmed', async () => {
    const scripted = api()
    const controller = new CandyAccountController(scripted)

    await controller.remove()
    expect(scripted.remove).not.toHaveBeenCalled()

    controller.confirmDelete('account-1')
    controller.confirmDelete(null)
    await controller.remove()
    expect(scripted.remove).not.toHaveBeenCalled()

    controller.confirmDelete('account-1')
    await controller.remove()
    expect(scripted.remove).toHaveBeenCalledWith('account-1')
    expect(controller.store.getSnapshot().confirming).toBeNull()
  })

  it('ends a session that a signed-out answer already ended', async () => {
    const controller = new CandyAccountController(api({
      revoke: vi.fn(async () => { throw new CandyApiError('signedOut', 'status 401') }),
    }))
    await controller.load()

    await controller.revoke('account-1')

    expect(controller.store.getSnapshot()).toMatchObject({ busy: null, failure: 'signedOut', rows: [] })
  })

  it('records a sign-out that the control plane refused', async () => {
    const clean = new CandyAccountController(api())
    await clean.signOut()
    expect(clean.store.getSnapshot().failure).toBeNull()

    const refused = new CandyAccountController(api({
      signOut: vi.fn(async () => { throw new CandyApiError('unavailable', 'status 503') }),
    }))
    await refused.signOut()
    expect(refused.store.getSnapshot().failure).toBe('unavailable')
  })
})
