/**
 * The Candy account page's state, and the operations that move it.
 *
 * The control plane is the single fact source: every mutation writes through
 * the API and the page re-reads the roster afterwards, because making one
 * account the default clears the flag on another and no answer says which.
 *
 * A failure is state, not an exception the caller handles. Each operation
 * settles the store and resolves; a signed-out answer clears the roster,
 * because those rows belong to a session that no longer exists.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  CandyAccountApi, CandyAccountView, CandyFailureKind, CandyIdentity, CandyProvider,
} from './api.ts'
import { CandyApiError } from './api.ts'

/** Longest secret the create form accepts, matching the API's own cap. */
export const MAX_SECRET_LENGTH = 4096

/** Longest label the control plane accepts. */
export const MAX_LABEL_LENGTH = 120

/** The create form, open only while the tenant is filling it in. */
export interface CandyAccountDraft {
  /** Which provider the new account authenticates with. */
  provider: CandyProvider
  /** Display label being typed. */
  label: string
  /** The credential being typed; it leaves this state on submit and is not kept. */
  secret: string
  /** Whether the new account becomes its provider's default. */
  isDefault: boolean
  /** Whether the create call is in flight. */
  saving: boolean
  /** Why the last submit was refused, cleared by the next edit. */
  error: string | null
}

/** The last thing an account action reported, shown until the next one. */
export interface CandyAccountNotice {
  /** Which account it concerns. */
  id: string
  /**
   * What happened: the credential answered as usable, the provider rejected
   * it, or the call itself did not go through. The last is not a statement
   * about the credential, so the page does not word it as one.
   */
  outcome: 'valid' | 'invalid' | 'failed'
  /** The refusal's own reason, absent when the credential simply worked. */
  reason?: string
}

/** Everything the page renders. */
export interface CandyAccountState {
  /** Whether the roster has been read yet, and how that went. */
  status: 'idle' | 'loading' | 'ready' | 'failed'
  /** Why the roster could not be read, absent while it can. */
  failure: CandyFailureKind | null
  /** Who this browser is signed in as, absent until the first read settles. */
  identity: CandyIdentity | null
  /** The tenant's accounts, newest last exactly as the control plane ordered them. */
  rows: readonly CandyAccountView[]
  /** The create form, absent while it is closed. */
  draft: CandyAccountDraft | null
  /** The account whose action is in flight, absent while none is. */
  busy: string | null
  /** The last account action's answer. */
  notice: CandyAccountNotice | null
  /** The account awaiting delete confirmation. */
  confirming: string | null
}

/** The state a page starts from. */
function initialState(): CandyAccountState {
  return {
    status: 'idle',
    failure: null,
    identity: null,
    rows: [],
    draft: null,
    busy: null,
    notice: null,
    confirming: null,
  }
}

/**
 * Why one draft cannot be submitted yet, as a locale key.
 * @param draft - the form being filled in.
 * @returns the blocking key, or undefined when the draft is submittable.
 */
export function draftBlocker(draft: CandyAccountDraft): 'labelRequired' | 'labelTooLong' | 'secretRequired' | 'secretTooLong' | undefined {
  if (draft.label.trim() === '') return 'labelRequired'
  if (draft.label.length > MAX_LABEL_LENGTH) return 'labelTooLong'
  if (draft.secret === '') return 'secretRequired'
  if (draft.secret.length > MAX_SECRET_LENGTH) return 'secretTooLong'
  return undefined
}

/**
 * Which failure an unknown rejection is.
 * @param error - what an operation rejected with.
 * @returns the failure kind, `unavailable` for anything not from the API.
 */
function failureOf(error: unknown): CandyFailureKind {
  return error instanceof CandyApiError ? error.kind : 'unavailable'
}

/** The page controller: one store, and the operations that settle it. */
export class CandyAccountController {
  /** Page state, bound by the renderer as `useCandyAccount`. */
  readonly store: SnapshotStore<CandyAccountState> = createSnapshotStore(initialState())

  readonly #api: CandyAccountApi

  /**
   * @param api - the control-plane operations this page drives.
   */
  constructor(api: CandyAccountApi) {
    this.#api = api
  }

  /**
   * Read the identity and the roster together; the page calls this when it
   * first renders and after every mutation.
   * @returns when the store carries the answer.
   */
  async load(): Promise<void> {
    this.store.update((state) => { state.status = 'loading' })
    try {
      const [identity, rows] = await Promise.all([this.#api.identity(), this.#api.list()])
      this.store.update((state) => {
        state.status = 'ready'
        state.failure = null
        state.identity = identity
        state.rows = rows
      })
    } catch (error) {
      this.#fail(failureOf(error))
    }
  }

  /**
   * Record a failed read, clearing the roster when the session is what ended.
   * @param failure - why the read did not answer.
   */
  #fail(failure: CandyFailureKind): void {
    this.store.update((state) => {
      state.status = 'failed'
      state.failure = failure
      if (failure === 'signedOut') {
        state.identity = null
        state.rows = []
        state.draft = null
      }
    })
  }

  /**
   * Open the create form on one provider.
   * @param provider - the provider the form starts on.
   */
  beginCreate(provider: CandyProvider): void {
    this.store.update((state) => {
      state.draft = { provider, label: '', secret: '', isDefault: false, saving: false, error: null }
      state.notice = null
    })
  }

  /**
   * Edit the open form. A draft closed underneath a pending keystroke drops
   * it rather than reopening the form.
   * @param patch - the fields the tenant changed.
   */
  editDraft(patch: Partial<Pick<CandyAccountDraft, 'provider' | 'label' | 'secret' | 'isDefault'>>): void {
    this.store.update((state) => {
      if (state.draft === null) return
      state.draft = { ...state.draft, ...patch, error: null }
    })
  }

  /** Close the create form, discarding the secret with it. */
  cancelCreate(): void {
    this.store.update((state) => { state.draft = null })
  }

  /**
   * Submit the open form, then re-read the roster.
   * @returns when the store carries the answer.
   */
  async confirmCreate(): Promise<void> {
    const draft = this.store.getSnapshot().draft
    if (draft === null || draft.saving || draftBlocker(draft) !== undefined) return
    this.store.update((state) => { state.draft = { ...draft, saving: true } })
    try {
      await this.#api.create({
        provider: draft.provider,
        label: draft.label.trim(),
        secret: draft.secret,
        isDefault: draft.isDefault,
      })
    } catch (error) {
      const failure = failureOf(error)
      if (failure === 'signedOut') {
        this.#fail(failure)
        return
      }
      this.store.update((state) => {
        // The form can be cancelled while its submit is in flight; a refusal
        // that arrives afterwards has no form left to report itself in.
        if (state.draft === null) return
        state.draft.saving = false
        state.draft.error = error instanceof CandyApiError ? error.message : 'unavailable'
      })
      return
    }
    this.store.update((state) => { state.draft = null })
    await this.load()
  }

  /**
   * Ask the provider whether one account's stored credential still works.
   * @param id - the account to check.
   * @returns when the store carries the answer.
   */
  async validate(id: string): Promise<void> {
    await this.#act(id, async () => {
      const checked = await this.#api.validate(id)
      this.store.update((state) => {
        state.notice = {
          id,
          outcome: checked.valid ? 'valid' : 'invalid',
          ...(checked.reason === undefined ? {} : { reason: checked.reason }),
        }
      })
    })
  }

  /**
   * Make one account its provider's default for this tenant.
   * @param id - the account to promote.
   * @returns when the store carries the answer.
   */
  async makeDefault(id: string): Promise<void> {
    await this.#act(id, async () => { await this.#api.makeDefault(id) }, true)
  }

  /**
   * Revoke one account's credential, keeping its record readable.
   * @param id - the account to revoke.
   * @returns when the store carries the answer.
   */
  async revoke(id: string): Promise<void> {
    await this.#act(id, async () => { await this.#api.revoke(id) }, true)
  }

  /**
   * Ask for delete confirmation, or dismiss it with null.
   * @param id - the account to confirm, or null to dismiss.
   */
  confirmDelete(id: string | null): void {
    this.store.update((state) => { state.confirming = id })
  }

  /**
   * Delete the account awaiting confirmation.
   * @returns when the store carries the answer.
   */
  async remove(): Promise<void> {
    const id = this.store.getSnapshot().confirming
    if (id === null) return
    this.store.update((state) => { state.confirming = null })
    await this.#act(id, async () => { await this.#api.remove(id) }, true)
  }

  /**
   * Run one account action, then re-read when it changed more than its row.
   * @param id - the account the action targets.
   * @param run - the call itself.
   * @param reload - whether the roster must be re-read afterwards.
   */
  async #act(id: string, run: () => Promise<void>, reload = false): Promise<void> {
    if (this.store.getSnapshot().busy !== null) return
    this.store.update((state) => {
      state.busy = id
      state.notice = null
    })
    try {
      await run()
    } catch (error) {
      const failure = failureOf(error)
      if (failure === 'signedOut') {
        this.store.update((state) => { state.busy = null })
        this.#fail(failure)
        return
      }
      this.store.update((state) => {
        state.busy = null
        state.notice = { id, outcome: 'failed', reason: error instanceof CandyApiError ? error.message : 'unavailable' }
      })
      return
    }
    this.store.update((state) => { state.busy = null })
    if (reload) await this.load()
  }

  /**
   * End the session and hand the browser back to the sign-in entry point.
   * @returns when the browser has been sent, or the failure recorded.
   */
  async signOut(): Promise<void> {
    try {
      await this.#api.signOut()
    } catch (error) {
      this.#fail(failureOf(error))
    }
  }
}
