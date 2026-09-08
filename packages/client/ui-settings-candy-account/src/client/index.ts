/**
 * Candy account settings plugin, browser half. It contributes one page to the
 * dsh settings panel — the shell, navigation, theme and responsive layout are
 * the panel's, and this package adds nothing of its own to them.
 *
 * The page's data does not ride `ctx.remote`. Candy's control-plane routes
 * authenticate a browser user through the session cookie its OAuth callback
 * set, while the dsh `/api` carrier authenticates a process launch token; the
 * two are different authorities over the same origin, so this plugin speaks
 * same-origin HTTP directly and injects no Remote namespace.
 * Export discipline: packages/client/AGENTS.md.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { CANDY_SIGN_IN_PATH, createCandyAccountApi, type CandyBrowser } from './api.ts'
import { CandyAccountController } from './store.ts'
import { CandyAccountSection } from './CandyAccountSection.tsx'
import { CandyAuditSection } from './CandyAuditSection.tsx'
import type { CandyAccountInjected } from './CandyAccountSection.tsx'
import { en, NS, zh, type CandyAccountKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Candy account page's copy. */
    'settings.candyAccount': CandyAccountKey
  }
}

export type { CandyAccountInjected, CandyAccountSectionProps } from './CandyAccountSection.tsx'
export type {
  CandyAccountApi, CandyAccountView, CandyBrowser, CandyFailureKind, CandyIdentity, CandyProvider,
} from './api.ts'
export type { CandyAccountDraft, CandyAccountNotice, CandyAccountState } from './store.ts'
export type { CandyAccountKey } from './locales.ts'

/**
 * Required services (cordis fiber inject). The target slot is declared by
 * ui-settings' apply, whose activation order relative to this one is NOT
 * constrained; registration depends on that slot through `slots.inject()`.
 */
export const inject = ['slots', 'locale']

/** How the page reaches the browser it runs in. */
function windowBrowser(): CandyBrowser {
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    cookie: () => globalThis.document.cookie,
    restart: () => { globalThis.location.assign(CANDY_SIGN_IN_PATH) },
  }
}

/**
 * Register the Candy account page once the `settings.section` declaration is
 * on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-candy-account: copy dictionaries')

  const browser = windowBrowser()
  const controller = new CandyAccountController(createCandyAccountApi(browser))
  // Bound once, at the registration site that owns the locale injection; the
  // page receives callbacks and never a context.
  const t = ctx.locale.bind(NS)
  // A timestamp reads in the viewer's own locale and zone, which is the
  // browser's, not the deployment's.
  const timestamps = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  const injected = (): CandyAccountInjected => ({
    hooks: { candyAccount: controller.store },
    load: () => controller.load(),
    beginCreate: (provider) => { controller.beginCreate(provider) },
    editDraft: (patch) => { controller.editDraft(patch) },
    cancelCreate: () => { controller.cancelCreate() },
    confirmCreate: () => controller.confirmCreate(),
    validate: id => controller.validate(id),
    makeDefault: id => controller.makeDefault(id),
    revoke: id => controller.revoke(id),
    confirmDelete: (id) => { controller.confirmDelete(id) },
    remove: () => controller.remove(),
    signOut: () => controller.signOut(),
    signIn: () => { browser.restart() },
    formatTime: at => timestamps.format(at),
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'candy-account',
    // Ahead of Models: which provider account a run bills to is decided before
    // which model it asks for.
    order: 5,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, CandyAccountSection))

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'candy-audit', order: 6,
    label: () => t('auditNav'), locale: NS, inject: () => ({}),
  }, CandyAuditSection))
}
