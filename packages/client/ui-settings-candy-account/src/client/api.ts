/**
 * The Candy control-plane calls this page makes, as plain callbacks.
 *
 * These routes are not the dsh `/api` carrier and do not ride `ctx.remote`:
 * that carrier authenticates a process launch token, while Candy authenticates
 * a browser user through the session cookie the OAuth callback set. So the
 * page speaks same-origin HTTP, sends the cookie, and echoes the CSRF cookie
 * back in `x-candy-csrf` on every write — the pair the Host envelope checks.
 *
 * A credential travels in one direction. `create` sends a secret and every
 * answer here is a `ProviderAccountView`, which carries no field for one.
 */

/** Where the Candy account operations are mounted. */
const ACCOUNT_PATHS = {
  list: '/api/candy/provider-accounts',
  create: '/api/candy/provider-accounts/create',
  validate: '/api/candy/provider-accounts/validate',
  default: '/api/candy/provider-accounts/default',
  revoke: '/api/candy/provider-accounts/revoke',
  delete: '/api/candy/provider-accounts/delete',
} as const

/** Where the OAuth session is read and ended. */
const SESSION_PATH = '/auth/session'
const LOGOUT_PATH = '/auth/logout'
const START_PATH = '/auth/oauth/start'

/** Header the Host envelope requires a write to echo the CSRF cookie in. */
const CSRF_HEADER = 'x-candy-csrf'

/** Cookie the OAuth callback set the CSRF token in. */
const CSRF_COOKIE = '__Host-candy-csrf'

/** Providers a Candy account can authenticate with. */
export const PROVIDERS = ['deepseek-api', 'claude-cli', 'codex-cli'] as const

/** Which provider one account authenticates with. */
export type CandyProvider = (typeof PROVIDERS)[number]

/** One account exactly as the control plane reports it; no secret field exists. */
export interface CandyAccountView {
  readonly id: string
  readonly provider: CandyProvider
  readonly label: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly validatedAt: number | undefined
  readonly revokedAt: number | undefined
  readonly isDefault: boolean
}

/** Who the session belongs to, as `/auth/session` reports it. */
export interface CandyIdentity {
  readonly userId: string
  readonly role: 'member' | 'administrator'
  readonly expiresAt: number
}

/** Whether the stored credential still authenticates with its provider. */
export interface CandyValidation {
  readonly valid: boolean
  readonly reason?: string
}

/**
 * Why a call did not answer.
 *
 * `signedOut` is the one the page reacts to rather than reports: the session
 * expired or was revoked, and every row on screen belongs to nobody now.
 */
export type CandyFailureKind = 'signedOut' | 'forbidden' | 'gone' | 'refused' | 'unavailable'

/** A call that did not answer, and why. */
export class CandyApiError extends Error {
  /** Which failure the page renders. */
  readonly kind: CandyFailureKind

  /**
   * @param kind - which failure the page renders.
   * @param message - the control plane's own reason, or a fixed one.
   */
  constructor(kind: CandyFailureKind, message: string) {
    super(message)
    this.name = 'CandyApiError'
    this.kind = kind
  }
}

/** The operations the page calls; each throws {@link CandyApiError}. */
export interface CandyAccountApi {
  /** Who the browser is signed in as. */
  identity: () => Promise<CandyIdentity>
  /** Every account this tenant owns that is not deleted, revoked ones included. */
  list: () => Promise<readonly CandyAccountView[]>
  /** Create one account and seal its credential. */
  create: (input: {
    provider: CandyProvider
    label: string
    secret: string
    isDefault: boolean
  }) => Promise<CandyAccountView>
  /** Ask the provider whether the stored credential still authenticates. */
  validate: (id: string) => Promise<CandyValidation>
  /** Make one account its provider's default for this tenant. */
  makeDefault: (id: string) => Promise<CandyAccountView>
  /** Revoke one account's credential, keeping the record readable. */
  revoke: (id: string) => Promise<CandyAccountView>
  /** Delete one account, keeping its id blocked. */
  remove: (id: string) => Promise<CandyAccountView>
  /** End the browser session and return to the sign-in entry point. */
  signOut: () => Promise<void>
}

/** What {@link createCandyAccountApi} reads the browser through. */
export interface CandyBrowser {
  /** Same-origin transport. */
  fetch: typeof globalThis.fetch
  /** The document's cookie header, for the CSRF token the writes echo. */
  cookie: () => string
  /** Send the browser to the sign-in entry point after a session ends. */
  restart: () => void
}

/**
 * The CSRF token the callback stored, or the empty string when no cookie
 * carries it. An absent token is not corrected here: the write goes out and
 * the Host envelope refuses it, which is the same answer as a stale one.
 * @param cookie - the document cookie header.
 * @returns the token, or the empty string.
 */
function csrfToken(cookie: string): string {
  for (const segment of cookie.split(';')) {
    const at = segment.indexOf('=')
    if (at !== -1 && segment.slice(0, at).trim() === CSRF_COOKIE) return segment.slice(at + 1).trim()
  }
  return ''
}

/**
 * Which failure a status means to this page.
 * @param status - the HTTP status the control plane answered.
 * @returns the failure the page renders.
 */
function failureOf(status: number): CandyFailureKind {
  if (status === 401) return 'signedOut'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'gone'
  if (status === 400 || status === 409 || status === 413) return 'refused'
  return 'unavailable'
}

/**
 * Build the page's operations over one browser.
 * @param browser - transport, cookie reader, and sign-in redirect.
 * @returns the operations, each throwing {@link CandyApiError} on refusal.
 */
export function createCandyAccountApi(browser: CandyBrowser): CandyAccountApi {
  const call = async (path: string, body?: unknown): Promise<unknown> => {
    let response: Response
    try {
      response = await browser.fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        headers: body === undefined
          ? { accept: 'application/json' }
          : {
            accept: 'application/json',
            'content-type': 'application/json',
            [CSRF_HEADER]: csrfToken(browser.cookie()),
          },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch {
      // The control plane's own reason never reached the page; only that the
      // request did not complete did.
      throw new CandyApiError('unavailable', 'network')
    }
    if (!response.ok) {
      const kind = failureOf(response.status)
      // A refusal carries a one-line reason; every other status carries text
      // the page does not render, so it is not read.
      const reason = kind === 'refused' ? (await response.text()).trim() : ''
      throw new CandyApiError(kind, reason === '' ? `status ${String(response.status)}` : reason)
    }
    if (response.status === 204) return undefined
    return await response.json()
  }

  return {
    identity: async () => await call(SESSION_PATH) as CandyIdentity,
    list: async () => await call(ACCOUNT_PATHS.list) as readonly CandyAccountView[],
    create: async input => await call(ACCOUNT_PATHS.create, input) as CandyAccountView,
    validate: async id => await call(ACCOUNT_PATHS.validate, { id }) as CandyValidation,
    makeDefault: async id => await call(ACCOUNT_PATHS.default, { id }) as CandyAccountView,
    revoke: async id => await call(ACCOUNT_PATHS.revoke, { id }) as CandyAccountView,
    remove: async id => await call(ACCOUNT_PATHS.delete, { id }) as CandyAccountView,
    signOut: async () => {
      await call(LOGOUT_PATH, {})
      browser.restart()
    },
  }
}

/** The sign-in entry point a signed-out page sends the browser to. */
export const CANDY_SIGN_IN_PATH = START_PATH
