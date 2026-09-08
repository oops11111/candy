/**
 * Account page stylesheet contract, asserted against the CSS text on disk.
 *
 * The page paints in both themes and at phone width, and a `--dsw-*` name the
 * theme does not declare fails silently: the browser takes the `var()`
 * fallback, so the sheet still renders and only the dark theme looks wrong.
 * Checking the names against the sheet that declares them is what turns that
 * into a test failure.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  fileURLToPath(new URL('../src/client/CandyAccountSection.module.css', import.meta.url)),
  'utf8',
)
// Every theme sheet, not just the platform tokens: font and scrollbar
// variables are declared in siblings, and a gate reading one file would call
// their names undeclared.
const tokens = readdirSync(fileURLToPath(new URL('../../ui-theme/src/styles/', import.meta.url)))
  .filter(name => name.endsWith('.css'))
  .map(name => readFileSync(fileURLToPath(new URL(`../../ui-theme/src/styles/${name}`, import.meta.url)), 'utf8'))
  .join('\n')

describe('CandyAccountSection theme styles', () => {
  it('names only theme variables the token sheet defines', () => {
    const named = [...css.matchAll(/var\((--(?:dsw|dsh|ds)-[a-z0-9-]+)/g)].map(match => match[1])
    const undeclared = [...new Set(named)].filter(name => !tokens.includes(`  ${String(name)}:`))
    expect(undeclared).toEqual([])
  })

  it('never falls back to a literal colour', () => {
    // A token that resolves is never the problem; an undeclared one takes this
    // branch, and a literal here is a single colour for both themes.
    expect(css).not.toMatch(/var\(--dsw-[a-z0-9-]+\s*,\s*(?:#|rgb|rgba|hsl|hsla)/)
    expect(css).not.toMatch(/:\s*(?:#[0-9a-f]{3,8}|rgba?\(|hsla?\()/i)
  })

  it('closes every block, so no rule is swallowed by the one above it', () => {
    // A missing `}` on an `@media` block is not a parse error: every rule after
    // it silently becomes conditional. Nothing downstream reports this — the
    // sheet loads and the classes still attach.
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect((bare.match(/\}/g) ?? []).length).toBe((bare.match(/\{/g) ?? []).length)
  })

  it('stacks the identity strip and its action at phone width', () => {
    // The settings panel narrows to the viewport on a phone; a row that keeps
    // its label and its button on one line pushes the button off the panel.
    const phone = /@media \(max-width: 560px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
    expect(phone).toContain('.identity')
    expect(phone).toContain('flex-direction: column')
  })

  it('lets every wrapping row wrap rather than overflow', () => {
    // A user id, a provider label, and four action buttons all have to fit a
    // 390px column; each of their containers wraps instead of scrolling the
    // panel sideways.
    for (const selector of ['.identity', '.rowHead', '.rowActions', '.formActions']) {
      const block = new RegExp(`^\\${selector} \\{([^}]*)\\}`, 'm').exec(css)?.[1] ?? ''
      expect(block, selector).toContain('flex-wrap: wrap')
    }
    for (const selector of ['.identityText', '.rowLabel', '.error']) {
      const block = new RegExp(`^\\${selector} \\{([^}]*)\\}`, 'm').exec(css)?.[1] ?? ''
      expect(block, selector).toContain('overflow-wrap: anywhere')
    }
  })
})
