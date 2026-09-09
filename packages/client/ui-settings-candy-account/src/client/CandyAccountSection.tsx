/**
 * The Candy account settings page: who this browser is signed in as, and the
 * provider accounts that tenant owns.
 *
 * A credential is write-only. The create form is the only field that ever
 * holds one, it is cleared when the form closes, and every row is drawn from
 * the control plane's own view, which has no secret to render. A revoked
 * account stays listed because an operator needs to see why a provider
 * stopped working; a deleted one is gone from the roster entirely.
 */

import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { PROVIDERS, type CandyAccountView, type CandyFailureKind, type CandyProvider } from './api.ts'
import { draftBlocker, MAX_LABEL_LENGTH, MAX_SECRET_LENGTH, type CandyAccountState } from './store.ts'
import type { CandyAccountKey } from './locales.ts'
import css from './CandyAccountSection.module.css'

/** Registration-side business face for the account page. */
export interface CandyAccountInjected {
  hooks: {
    /** Page snapshot bound by the renderer as useCandyAccount. */
    candyAccount: SnapshotStore<CandyAccountState>
  }
  /** Read the identity and the roster; called once when the page first renders. */
  load: () => Promise<void>
  /** Open the create form on one provider. */
  beginCreate: (provider: CandyProvider) => void
  /** Edit the open form. */
  editDraft: (patch: { provider?: CandyProvider; label?: string; secret?: string; isDefault?: boolean }) => void
  /** Close the create form, discarding the secret with it. */
  cancelCreate: () => void
  /** Submit the open form. */
  confirmCreate: () => Promise<void>
  /** Ask the provider whether one account's credential still works. */
  validate: (id: string) => Promise<void>
  /** Make one account its provider's default. */
  makeDefault: (id: string) => Promise<void>
  /** Revoke one account's credential. */
  revoke: (id: string) => Promise<void>
  /** Ask for delete confirmation, or dismiss it with null. */
  confirmDelete: (id: string | null) => void
  /** Delete the account awaiting confirmation. */
  remove: () => Promise<void>
  /** End the browser session. */
  signOut: () => Promise<void>
  /** Send the browser to the sign-in entry point. */
  signIn: () => void
  /** Render one epoch-millisecond timestamp in the viewer's locale. */
  formatTime: (at: number) => string
}

/** Full component props. */
export type CandyAccountSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.candyAccount'>
  & InjectFace<CandyAccountInjected>

/** Translate bound to this page's namespace. */
type T = (key: CandyAccountKey, params?: Record<string, unknown>) => string

/** Locale key naming one provider. */
const PROVIDER_KEY = {
  'deepseek-api': 'providerDeepseekApi',
  'claude-cli': 'providerClaudeCli',
  'codex-cli': 'providerCodexCli',
} as const satisfies Record<CandyProvider, CandyAccountKey>

/** Locale key naming why the page could not read the control plane. */
const FAILURE_KEY = {
  signedOut: 'failureSignedOut',
  forbidden: 'failureForbidden',
  gone: 'failureGone',
  refused: 'failureRefused',
  unavailable: 'failureUnavailable',
} as const satisfies Record<CandyFailureKind, CandyAccountKey>

/** Providers whose tenant-owned credentials are consumed by server CLI processes. */
const CLI_PROVIDERS = ['claude-cli', 'codex-cli'] as const satisfies readonly CandyProvider[]

/** One CLI provider's state derived from the authenticated tenant roster. */
type CliState =
  | { readonly kind: 'configured'; readonly label: string }
  | { readonly kind: 'revoked' }
  | { readonly kind: 'not-configured' }

/**
 * Derive the state a tenant may safely see without inspecting a shared CLI home.
 * @param accounts - the authenticated tenant's secret-free account roster.
 * @param provider - the CLI provider to summarize.
 * @returns the active account label, a revoked-only state, or an absent state.
 */
function cliStateOf(accounts: readonly CandyAccountView[], provider: CandyProvider): CliState {
  const matching = accounts.filter(account => account.provider === provider)
  const active = matching.find(account => account.revokedAt === undefined && account.isDefault)
    ?? matching.find(account => account.revokedAt === undefined)
  if (active !== undefined) return { kind: 'configured', label: active.label }
  return matching.length === 0 ? { kind: 'not-configured' } : { kind: 'revoked' }
}

/** Render the two tenant-scoped CLI states beside the account roster that supplies them. */
function CliStates({ accounts, t }: { accounts: readonly CandyAccountView[]; t: T }): ReactNode {
  return (
    <div className={css.cli} aria-labelledby="candy-cli-state-title">
      <h4 id="candy-cli-state-title" className={css.cliTitle}>{t('cliTitle')}</h4>
      <p className={css.cliIntro}>{t('cliIntro')}</p>
      <div className={css.cliRows}>
        {CLI_PROVIDERS.map((provider) => {
          const state = cliStateOf(accounts, provider)
          const text = state.kind === 'configured'
            ? t('cliConfigured', { label: state.label })
            : t(state.kind === 'revoked' ? 'cliRevoked' : 'cliNotConfigured')
          return (
            <div key={provider} className={css.cliRow}>
              <span className={css.cliProvider}>{t(PROVIDER_KEY[provider])}</span>
              <span className={state.kind === 'configured' ? css.ok : css.cliState}>{text}</span>
            </div>
          )
        })}
      </div>
      <p className={css.cliIntro}>{t('cliUnchecked')}</p>
    </div>
  )
}

/** The create form's own props: the draft plus what mutates it. */
interface CreateFormProps {
  draft: NonNullable<CandyAccountState['draft']>
  t: T
  actions: Pick<CandyAccountInjected, 'cancelCreate' | 'confirmCreate' | 'editDraft'>
}

function CreateForm({ draft, t, actions }: CreateFormProps): ReactNode {
  const blocker = draftBlocker(draft)
  const message = draft.error ?? (blocker === undefined ? null : t(blocker))
  return (
    <form
      className={css.form}
      onSubmit={(event) => {
        event.preventDefault()
        void actions.confirmCreate()
      }}
    >
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('provider')}</span>
        <select
          className={css.select}
          value={draft.provider}
          disabled={draft.saving}
          onChange={(event) => { actions.editDraft({ provider: event.target.value as CandyProvider }) }}
        >
          {PROVIDERS.map(provider => (
            <option key={provider} value={provider}>{t(PROVIDER_KEY[provider])}</option>
          ))}
        </select>
      </label>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('label')}</span>
        <Input
          value={draft.label}
          maxLength={MAX_LABEL_LENGTH}
          placeholder={t('labelPlaceholder')}
          disabled={draft.saving}
          onChange={(event) => { actions.editDraft({ label: event.target.value }) }}
        />
      </label>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('secret')}</span>
        <Input
          type="password"
          value={draft.secret}
          maxLength={MAX_SECRET_LENGTH}
          placeholder={t('secretPlaceholder')}
          autoComplete="off"
          disabled={draft.saving}
          onChange={(event) => { actions.editDraft({ secret: event.target.value }) }}
        />
        <span className={css.hint}>{t('secretHint')}</span>
      </label>
      <label className={css.checkbox}>
        <input
          type="checkbox"
          checked={draft.isDefault}
          disabled={draft.saving}
          onChange={(event) => { actions.editDraft({ isDefault: event.target.checked }) }}
        />
        <span>{t('makeDefaultField')}</span>
      </label>
      {message === null ? null : <p className={css.error}>{message}</p>}
      <div className={css.formActions}>
        <Button type="submit" variant="primary" disabled={draft.saving || blocker !== undefined}>
          {draft.saving ? t('creating') : t('create')}
        </Button>
        <Button onClick={() => { actions.cancelCreate() }} disabled={draft.saving}>{t('cancel')}</Button>
      </div>
    </form>
  )
}

/**
 * What one account action reported, as a sentence.
 *
 * A call that did not go through says so; only the provider's own answer is
 * worded as a statement about the credential.
 * @param notice - the action's outcome and reason.
 * @param t - this page's translate.
 * @returns the sentence to render.
 */
function noticeText(notice: NonNullable<CandyAccountState['notice']>, t: T): string {
  if (notice.outcome === 'valid') return t('validationOk')
  const reason = notice.reason ?? ''
  return notice.outcome === 'invalid'
    ? t('validationBad', { reason })
    : t('actionFailed', { reason })
}

/** One account row's props. */
interface AccountRowProps {
  account: CandyAccountView
  state: CandyAccountState
  t: T
  formatTime: (at: number) => string
  actions: Pick<CandyAccountInjected, 'confirmDelete' | 'makeDefault' | 'revoke' | 'validate'>
}

function AccountRow({ account, state, t, formatTime, actions }: AccountRowProps): ReactNode {
  const busy = state.busy === account.id
  const blocked = state.busy !== null
  const notice = state.notice?.id === account.id ? state.notice : null
  return (
    <li className={css.row}>
      <div className={css.rowHead}>
        <span className={css.rowLabel}>{account.label}</span>
        <span className={css.rowProvider}>{t(PROVIDER_KEY[account.provider])}</span>
        {account.isDefault ? <span className={css.badge}>{t('defaultBadge')}</span> : null}
        {account.revokedAt === undefined
          ? null
          : <span className={css.badgeMuted}>{t('revokedBadge')}</span>}
      </div>
      <p className={css.rowMeta}>
        {account.validatedAt === undefined
          ? t('neverValidated')
          : t('validatedAt', { time: formatTime(account.validatedAt) })}
      </p>
      {notice === null
        ? null
        : (
          <p className={notice.outcome === 'valid' ? css.ok : css.error}>
            {noticeText(notice, t)}
          </p>
        )}
      <div className={css.rowActions}>
        <Button size="sm" disabled={blocked} onClick={() => { void actions.validate(account.id) }}>
          {busy ? t('working') : t('validate')}
        </Button>
        {account.isDefault || account.revokedAt !== undefined
          ? null
          : (
            <Button size="sm" disabled={blocked} onClick={() => { void actions.makeDefault(account.id) }}>
              {t('makeDefault')}
            </Button>
          )}
        {account.revokedAt === undefined
          ? (
            <Button size="sm" disabled={blocked} onClick={() => { void actions.revoke(account.id) }}>
              {t('revoke')}
            </Button>
          )
          : null}
        <Button size="sm" className={css.danger} disabled={blocked} onClick={() => { actions.confirmDelete(account.id) }}>
          {t('delete')}
        </Button>
      </div>
    </li>
  )
}

/**
 * The Candy account page.
 * @param props - the four prop shares.
 * @returns the page.
 */
export function CandyAccountSection(props: CandyAccountSectionProps): ReactNode {
  const { t, useCandyAccount, load } = props
  const state = useCandyAccount(snapshot => snapshot)

  useEffect(() => { void load() }, [load])

  const signedOut = state.failure === 'signedOut'
  return (
    <section className={css.section}>
      <h3 className={css.title}>{t('title')}</h3>
      <p className={css.intro}>{t('intro')}</p>
      <div className={css.identity}>
        <span className={css.identityText}>
          {state.identity === null
            ? t('loading')
            : `${t('signedInAs', { userId: state.identity.userId })} · ${
              t(state.identity.role === 'administrator' ? 'roleAdministrator' : 'roleMember')}`}
        </span>
        {signedOut
          ? <Button size="sm" variant="primary" onClick={() => { props.signIn() }}>{t('signIn')}</Button>
          : <Button size="sm" onClick={() => { void props.signOut() }}>{t('signOut')}</Button>}
      </div>

      {state.failure === null
        ? null
        : (
          <div className={css.failure}>
            <p className={css.error}>{t(FAILURE_KEY[state.failure])}</p>
            {signedOut
              ? null
              : <Button size="sm" onClick={() => { void load() }}>{t('retry')}</Button>}
          </div>
        )}

      {state.status === 'ready' ? <CliStates accounts={state.rows} t={t} /> : null}

      {state.draft === null
        ? (
          <div className={css.addRow}>
            <Button
              variant="primary"
              disabled={signedOut}
              onClick={() => { props.beginCreate(PROVIDERS[0]) }}
            >
              {t('add')}
            </Button>
          </div>
        )
        : <CreateForm draft={state.draft} t={t} actions={props} />}

      {state.status === 'ready' && state.rows.length === 0
        ? <p className={css.empty}>{t('empty')}</p>
        : null}

      <ul className={css.rows}>
        {state.rows.map(account => (
          <AccountRow
            key={account.id}
            account={account}
            state={state}
            t={t}
            formatTime={props.formatTime}
            actions={props}
          />
        ))}
      </ul>

      <Modal
        open={state.confirming !== null}
        onClose={() => { props.confirmDelete(null) }}
        title={t('deleteTitle')}
        closeLabel={t('close')}
        description={t('deleteDescription')}
        footer={(
          <div className={css.formActions}>
            <Button className={css.danger} onClick={() => { void props.remove() }}>{t('deleteConfirm')}</Button>
            <Button onClick={() => { props.confirmDelete(null) }}>{t('cancel')}</Button>
          </div>
        )}
      />
    </section>
  )
}
