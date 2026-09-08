// @vitest-environment jsdom
/**
 * What the page shows and what a click on it asks for.
 *
 * The secret field is the one thing on this page that must never render back
 * a stored value, so its presence and its absence are both asserted; the rest
 * is the shell's own settings chrome and is not this package's to test.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { CandyAccountView } from '../src/client/api.ts'
import type { CandyAccountState } from '../src/client/store.ts'
import { CandyAccountSection } from '../src/client/CandyAccountSection.tsx'
import type { CandyAccountSectionProps } from '../src/client/CandyAccountSection.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: keyof typeof en, params?: Record<string, string | number>) => {
  const template = en[key]
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (_whole, name: string) => String(params[name] ?? ''))
}) as CandyAccountSectionProps['t']

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

/** The page state a case starts from. */
function state(overrides: Partial<CandyAccountState> = {}): CandyAccountState {
  return {
    status: 'ready',
    failure: null,
    identity: { userId: 'alice', role: 'member', expiresAt: 9 },
    rows: [],
    draft: null,
    busy: null,
    notice: null,
    confirming: null,
    ...overrides,
  }
}

/** Every injected callback, as spies. */
function actions() {
  return {
    load: vi.fn(async () => {}),
    beginCreate: vi.fn((_provider: CandyAccountView['provider']) => {}),
    editDraft: vi.fn((_patch: Record<string, unknown>) => {}),
    cancelCreate: vi.fn(() => {}),
    confirmCreate: vi.fn(async () => {}),
    validate: vi.fn(async (_id: string) => {}),
    makeDefault: vi.fn(async (_id: string) => {}),
    revoke: vi.fn(async (_id: string) => {}),
    confirmDelete: vi.fn((_id: string | null) => {}),
    remove: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
    signIn: vi.fn(() => {}),
  }
}

/** Render the page over one fixed state. */
function mount(next: CandyAccountState): ReturnType<typeof actions> {
  const spies = actions()
  const props = {
    close: () => {},
    t,
    useCandyAccount: bindSnapshotSelector(createSnapshotStore(next)),
    formatTime: (at: number) => `t+${String(at)}`,
    ...spies,
  } as unknown as CandyAccountSectionProps
  render(<CandyAccountSection {...props} />)
  return spies
}

describe('the Candy account page', () => {
  it('reads the roster once when it first renders', () => {
    const spies = mount(state())

    expect(spies.load).toHaveBeenCalledOnce()
    expect(screen.getByText(en.empty)).toBeTruthy()
  })

  it('names who the browser is signed in as, and their role', () => {
    mount(state({ identity: { userId: 'alice', role: 'administrator', expiresAt: 9 } }))

    expect(screen.getByText(`Signed in as alice · ${en.roleAdministrator}`)).toBeTruthy()
  })

  it('says it is still reading before the first answer lands', () => {
    mount(state({ status: 'loading', identity: null }))

    expect(screen.getByText(en.loading)).toBeTruthy()
  })

  it('offers to sign out while the session holds, and to sign in once it does not', () => {
    const live = mount(state())
    fireEvent.click(screen.getByRole('button', { name: en.signOut }))
    expect(live.signOut).toHaveBeenCalledOnce()
    cleanup()

    const expired = mount(state({ status: 'failed', failure: 'signedOut', identity: null }))
    expect(screen.queryByRole('button', { name: en.signOut })).toBeNull()
    expect(screen.queryByRole('button', { name: en.retry })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.signIn }))
    expect(expired.signIn).toHaveBeenCalledOnce()
    expect(screen.getByText(en.failureSignedOut)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.add }).hasAttribute('disabled')).toBe(true)
  })

  it.each([
    ['forbidden', en.failureForbidden],
    ['gone', en.failureGone],
    ['refused', en.failureRefused],
    ['unavailable', en.failureUnavailable],
  ] as const)('offers a retry after a %s read', (failure, message) => {
    const spies = mount(state({ status: 'failed', failure }))

    expect(screen.getByText(message)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    // Once on mount, once from the button.
    expect(spies.load).toHaveBeenCalledTimes(2)
  })

  it('opens the create form on the first provider and keeps the secret write-only', () => {
    const closed = mount(state())
    expect(screen.queryByText(en.secretHint)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    expect(closed.beginCreate).toHaveBeenCalledWith('deepseek-api')
    cleanup()

    mount(state({
      draft: { provider: 'claude-cli', label: 'work', secret: 'typed', isDefault: false, saving: false, error: null },
    }))
    const secret = screen.getByPlaceholderText(en.secretPlaceholder)
    expect(secret.getAttribute('type')).toBe('password')
    expect(secret.getAttribute('autocomplete')).toBe('off')
    expect(screen.getByText(en.secretHint)).toBeTruthy()
  })

  it('reports each edit and lets the form be closed', () => {
    const spies = mount(state({
      draft: { provider: 'claude-cli', label: 'work', secret: 'typed', isDefault: false, saving: false, error: null },
    }))

    fireEvent.change(screen.getByPlaceholderText(en.labelPlaceholder), { target: { value: 'home' } })
    fireEvent.change(screen.getByPlaceholderText(en.secretPlaceholder), { target: { value: 'other' } })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'codex-cli' } })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))

    expect(spies.editDraft.mock.calls.map(call => call[0])).toEqual([
      { label: 'home' }, { secret: 'other' }, { provider: 'codex-cli' }, { isDefault: true },
    ])
    expect(spies.cancelCreate).toHaveBeenCalledOnce()
  })

  it('submits the form and refuses to while a field blocks it', () => {
    const blocked = mount(state({
      draft: { provider: 'claude-cli', label: '', secret: '', isDefault: false, saving: false, error: null },
    }))
    expect(screen.getByText(en.labelRequired)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.create }).hasAttribute('disabled')).toBe(true)
    expect(blocked.confirmCreate).not.toHaveBeenCalled()
    cleanup()

    const ready = mount(state({
      draft: { provider: 'claude-cli', label: 'work', secret: 'typed', isDefault: false, saving: false, error: null },
    }))
    fireEvent.click(screen.getByRole('button', { name: en.create }))
    expect(ready.confirmCreate).toHaveBeenCalledOnce()
  })

  it('shows the refusal the control plane gave, in place of the blocking hint', () => {
    mount(state({
      draft: {
        provider: 'claude-cli', label: '', secret: '', isDefault: false, saving: true, error: 'label is required',
      },
    }))

    expect(screen.getByText('label is required')).toBeTruthy()
    expect(screen.queryByText(en.labelRequired)).toBeNull()
    expect(screen.getByRole('button', { name: en.creating }).hasAttribute('disabled')).toBe(true)
  })

  it('marks the default account and reports when it was last checked', () => {
    mount(state({
      rows: [
        account({ id: 'a', label: 'default one', isDefault: true, validatedAt: 42 }),
        account({ id: 'b', label: 'revoked one', revokedAt: 7 }),
      ],
    }))

    const rows = screen.getAllByRole('listitem')
    expect(within(rows[0] as HTMLElement).getByText(en.defaultBadge)).toBeTruthy()
    expect(within(rows[0] as HTMLElement).getByText('Last checked t+42')).toBeTruthy()
    expect(within(rows[1] as HTMLElement).getByText(en.revokedBadge)).toBeTruthy()
    expect(within(rows[1] as HTMLElement).getByText(en.neverValidated)).toBeTruthy()
    expect(screen.queryByText(en.empty)).toBeNull()
  })

  it('offers only the actions an account can still take', () => {
    mount(state({
      rows: [
        account({ id: 'a', label: 'plain' }),
        account({ id: 'b', label: 'default one', isDefault: true }),
        account({ id: 'c', label: 'revoked one', revokedAt: 7 }),
      ],
    }))

    const rows = screen.getAllByRole('listitem')
    const names = (row: HTMLElement): string[] =>
      within(row).getAllByRole('button').map(button => button.textContent ?? '')
    expect(names(rows[0] as HTMLElement)).toEqual([en.validate, en.makeDefault, en.revoke, en.delete])
    // Already default: nothing to promote. Revoked: nothing left to revoke or promote.
    expect(names(rows[1] as HTMLElement)).toEqual([en.validate, en.revoke, en.delete])
    expect(names(rows[2] as HTMLElement)).toEqual([en.validate, en.delete])
  })

  it('asks for each account action against its own id', () => {
    const spies = mount(state({ rows: [account({ id: 'account-9' })] }))

    fireEvent.click(screen.getByRole('button', { name: en.validate }))
    fireEvent.click(screen.getByRole('button', { name: en.makeDefault }))
    fireEvent.click(screen.getByRole('button', { name: en.revoke }))
    fireEvent.click(screen.getByRole('button', { name: en.delete }))

    expect(spies.validate).toHaveBeenCalledWith('account-9')
    expect(spies.makeDefault).toHaveBeenCalledWith('account-9')
    expect(spies.revoke).toHaveBeenCalledWith('account-9')
    expect(spies.confirmDelete).toHaveBeenCalledWith('account-9')
  })

  it('blocks every row while one action is in flight', () => {
    mount(state({ rows: [account({ id: 'a' }), account({ id: 'b' })], busy: 'a' }))

    const rows = screen.getAllByRole('listitem')
    expect(within(rows[0] as HTMLElement).getByRole('button', { name: en.working }).hasAttribute('disabled')).toBe(true)
    for (const row of rows) {
      for (const button of within(row).getAllByRole('button')) {
        expect(button.hasAttribute('disabled')).toBe(true)
      }
    }
  })

  it('words a working credential, a rejected one, and a call that did not go through', () => {
    const rows = [account({ id: 'a' })]
    mount(state({ rows, notice: { id: 'a', outcome: 'valid' } }))
    expect(screen.getByText(en.validationOk)).toBeTruthy()
    cleanup()

    mount(state({ rows, notice: { id: 'a', outcome: 'invalid', reason: 'invalid-credential' } }))
    expect(screen.getByText('The credential does not work: invalid-credential')).toBeTruthy()
    cleanup()

    mount(state({ rows, notice: { id: 'a', outcome: 'failed', reason: 'status 404' } }))
    expect(screen.getByText('That did not go through: status 404')).toBeTruthy()
    cleanup()

    // A notice belongs to the row it names, and to no other.
    mount(state({ rows, notice: { id: 'other', outcome: 'valid' } }))
    expect(screen.queryByText(en.validationOk)).toBeNull()
  })

  it('renders an invalid answer the provider gave no reason for', () => {
    mount(state({ rows: [account({ id: 'a' })], notice: { id: 'a', outcome: 'invalid' } }))

    expect(screen.getByText('The credential does not work:')).toBeTruthy()
  })

  it('confirms a delete before it happens, and lets it be dismissed', () => {
    const spies = mount(state({ rows: [account({ id: 'a' })], confirming: 'a' }))
    const dialog = screen.getByRole('dialog')

    expect(within(dialog).getByText(en.deleteDescription)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: en.deleteConfirm }))
    expect(spies.remove).toHaveBeenCalledOnce()

    fireEvent.click(within(dialog).getByRole('button', { name: en.cancel }))
    expect(spies.confirmDelete).toHaveBeenCalledWith(null)
  })

  it('dismisses the confirmation from its own chrome', () => {
    const spies = mount(state({ rows: [account({ id: 'a' })], confirming: 'a' }))

    fireEvent.click(screen.getByRole('button', { name: en.close }))

    expect(spies.confirmDelete).toHaveBeenCalledWith(null)
    expect(spies.remove).not.toHaveBeenCalled()
  })

  it('shows no confirmation while none is pending', () => {
    mount(state({ rows: [account({ id: 'a' })] }))

    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
