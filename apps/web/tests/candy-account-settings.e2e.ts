// Web e2e scenario: the Candy account page inside the real settings panel, at
// a desktop width and at a phone width. The shell, navigation, theme and
// responsive layout are the panel's own, so this is what proves the page
// reuses them rather than bringing its own — it is mounted through the shipped
// Web surface and driven with a real browser.
//
// The control-plane answers are scripted at the network boundary. The routes
// themselves are proved server-side, against a real Loader composition of the
// storage stack, the durable store and dsh-host-webserver with two tenants, by
// packages/control-plane/provider-account-api/tests/loader-composition.spec.ts;
// what a browser cannot be shown there is what this covers, and no Candy Host
// plugin composes into a shipped bundle yet.
//
// Zero model calls: the page is pure client state over scripted HTTP, so there
// is no fixture and a stray stream would fail loud on the open llm seam.
import { fileURLToPath } from 'node:url'
import type { Browser, Page, Route } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

// One layer supplies both halves: its patch inserts the browser row, and its
// dependency is what makes that row resolvable from the scaffold profile.
const LAYER_DIR = new URL('../../../packages/experimental/candy-web-profile/', import.meta.url)
const OVERLAY = fileURLToPath(new URL('cordis.patch.yml', LAYER_DIR))
const INSTALL_ANCHORS = [fileURLToPath(new URL('package.json', LAYER_DIR))]

/** One account exactly as the control plane reports it. */
interface Account {
  id: string
  provider: string
  label: string
  createdAt: number
  updatedAt: number
  validatedAt: number | undefined
  revokedAt: number | undefined
  isDefault: boolean
}

/** The scripted control plane: the roster it answers, and what it was asked. */
interface ControlPlane {
  accounts: Account[]
  /** Path and parsed body of every write, in order. */
  writes: { path: string; body: unknown; csrf: string | null }[]
}

const NOW = 1_800_000_000_000

/** Install the scripted Candy routes on one page, plus the session cookie a real callback would set. */
async function scriptControlPlane(page: Page, origin: string): Promise<ControlPlane> {
  const plane: ControlPlane = {
    accounts: [{
      id: 'account-existing',
      provider: 'claude-cli',
      label: 'work laptop',
      createdAt: NOW,
      updatedAt: NOW,
      validatedAt: NOW,
      revokedAt: undefined,
      isDefault: true,
    }],
    writes: [],
  }
  const json = async (route: Route, body: unknown, status = 200): Promise<void> => {
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  }
  await page.route(`${origin}/auth/session`, async (route) => {
    await json(route, { userId: 'user-alice', role: 'member', expiresAt: NOW + 3_600_000 })
  })
  await page.route(`${origin}/api/candy/provider-accounts`, async (route) => {
    await json(route, plane.accounts)
  })
  await page.route(`${origin}/api/candy/provider-accounts/*`, async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    plane.writes.push({
      path,
      body: request.postDataJSON() as unknown,
      csrf: await request.headerValue('x-candy-csrf'),
    })
    if (path.endsWith('/create')) {
      const sent = request.postDataJSON() as { provider: string; label: string; isDefault: boolean }
      for (const account of plane.accounts) {
        if (sent.isDefault && account.provider === sent.provider) account.isDefault = false
      }
      const created: Account = {
        id: 'account-created',
        provider: sent.provider,
        label: sent.label,
        createdAt: NOW,
        updatedAt: NOW,
        validatedAt: undefined,
        revokedAt: undefined,
        isDefault: sent.isDefault,
      }
      plane.accounts.push(created)
      await json(route, created, 201)
      return
    }
    if (path.endsWith('/validate')) {
      await json(route, { valid: false, reason: 'unsupported-provider' })
      return
    }
    if (path.endsWith('/revoke')) {
      const target = plane.accounts.find(account => account.id === 'account-created')
      if (target !== undefined) {
        target.revokedAt = NOW
        target.isDefault = false
      }
      await json(route, target)
      return
    }
    await route.fulfill({ status: 404, contentType: 'text/plain; charset=utf-8', body: 'not found' })
  })
  return plane
}

/** Open the settings panel on the Candy account page. */
async function openAccountPage(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.waitFor({ timeout: 10_000 })
  await dialog.getByRole('button', { name: 'Account', exact: true }).click()
  await dialog.getByText('Account and credentials').waitFor({ timeout: 10_000 })
}

describe('web e2e: the Candy account page in the settings panel', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let plane: ControlPlane
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, extraInstallAnchors: INSTALL_ANCHORS })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    plane = await scriptControlPlane(page, scaffold.baseUrl.replace(/\/$/u, ''))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('takes its seat in the panel navigation, ahead of Models', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-candy-account-nav'))
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.waitFor({ timeout: 10_000 })
    const nav = await dialog.getByRole('button', { name: /^(General|Account|Models|Agent presets|Plugins)$/u })
      .allTextContents()

    expect(nav).toContain('Account')
    expect(nav.indexOf('Account')).toBeLessThan(nav.indexOf('Models'))
  })

  it('shows the signed-in tenant and the accounts they own', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-candy-account-roster'))
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.getByRole('button', { name: 'Account', exact: true }).click()
    await dialog.getByText('Account and credentials').waitFor({ timeout: 10_000 })

    await expect.poll(async () => dialog.getByText('Signed in as user-alice · Member').count(), { timeout: 10_000 })
      .toBe(1)
    const row = dialog.getByRole('listitem').filter({ hasText: 'work laptop' })
    await row.waitFor({ timeout: 10_000 })
    expect(await row.getByText('Default').count()).toBe(1)
    const cli = dialog.getByRole('heading', { name: 'Server CLI sign-in state' }).locator('..')
    expect(await cli.getByText('Configured for this tenant: work laptop').count()).toBe(1)
    expect(await cli.getByText('Not configured', { exact: true }).count()).toBe(1)
    expect(await cli.getByText(/do not inspect or reuse/u).count()).toBe(1)
  })

  it('creates an account, sending the credential once and never showing it again', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-candy-account-create'))
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.getByRole('button', { name: 'Add account' }).click()

    await dialog.getByRole('combobox').selectOption('deepseek-api')
    await dialog.getByPlaceholder('Work account').fill('build server')
    await dialog.getByPlaceholder('Paste an API key or token').fill('provider-secret-value')
    await dialog.getByRole('checkbox').check()
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()

    const created = dialog.getByRole('listitem').filter({ hasText: 'build server' })
    await created.waitFor({ timeout: 10_000 })
    const create = plane.writes.find(write => write.path.endsWith('/create'))
    expect(create?.body).toEqual({
      provider: 'deepseek-api', label: 'build server', secret: 'provider-secret-value', isDefault: true,
    })
    // The write carried the CSRF header the control-plane envelope requires.
    expect(create?.csrf).not.toBeNull()
    // The form closed with the secret, and nothing on the page echoes it back.
    expect(await dialog.getByPlaceholder('Paste an API key or token').count()).toBe(0)
    expect(await dialog.textContent()).not.toContain('provider-secret-value')
  })

  it('reports a credential check and a revocation on the row they belong to', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-candy-account-actions'))
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    const row = dialog.getByRole('listitem').filter({ hasText: 'build server' })

    await row.getByRole('button', { name: 'Check credential' }).click()
    await row.getByText('The credential does not work: unsupported-provider').waitFor({ timeout: 10_000 })
    // The answer belongs to one row; the other reports nothing.
    const other = dialog.getByRole('listitem').filter({ hasText: 'work laptop' })
    expect(await other.getByText(/credential does not work/u).count()).toBe(0)

    await row.getByRole('button', { name: 'Revoke credential' }).click()
    await row.getByText('Revoked').waitFor({ timeout: 10_000 })
    // A revoked account has nothing left to revoke or promote.
    expect(await row.getByRole('button', { name: 'Revoke credential' }).count()).toBe(0)
    expect(await row.getByRole('button', { name: 'Make default' }).count()).toBe(0)
  })

  it('confirms a delete before it happens', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-candy-account-delete'))
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    const row = dialog.getByRole('listitem').filter({ hasText: 'build server' })

    await row.getByRole('button', { name: 'Delete' }).click()
    const confirmation = page.getByRole('dialog', { name: 'Delete account' })
    await confirmation.waitFor({ timeout: 10_000 })
    expect(plane.writes.some(write => write.path.endsWith('/delete'))).toBe(false)

    await confirmation.getByRole('button', { name: 'Cancel' }).click()
    await expect.poll(async () => confirmation.count(), { timeout: 10_000 }).toBe(0)
    expect(plane.writes.some(write => write.path.endsWith('/delete'))).toBe(false)
  })

  it('fits a phone viewport without scrolling the panel sideways', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-candy-account-phone'))
    // A common phone width; the settings panel is the shell's, so what this
    // asserts is that the page inside it neither overflows nor loses controls.
    await page.setViewportSize({ width: 390, height: 844 })
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    if (await dialog.count() === 0) await openAccountPage(page)
    await dialog.getByText('Account and credentials').waitFor({ timeout: 10_000 })

    // This account is its provider's default and still live, so it offers
    // every action but the one that would promote it again.
    const row = dialog.getByRole('listitem').filter({ hasText: 'work laptop' })
    await row.waitFor({ timeout: 10_000 })
    expect(await row.getByRole('button').allTextContents())
      .toEqual(['Check credential', 'Revoke credential', 'Delete'])
    expect(await dialog.getByText('Configured for this tenant: work laptop').count()).toBe(1)
    expect(await dialog.getByText('Not configured', { exact: true }).count()).toBe(1)

    const overflow = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      body: document.body.scrollWidth - document.body.clientWidth,
    }))
    expect(overflow).toEqual({ document: 0, body: 0 })

    // Every visible control of the page stays inside the viewport.
    const escapes = await dialog.getByRole('button').evaluateAll((nodes, width) => nodes
      .map(node => node.getBoundingClientRect())
      .filter(box => box.width > 0 && (box.left < 0 || box.right > width))
      .length, 390)
    expect(escapes).toBe(0)
  })

  it('leaves the browser console clean throughout', () => {
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  })
})
