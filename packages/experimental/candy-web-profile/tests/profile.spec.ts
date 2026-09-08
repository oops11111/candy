/** The layer stays test-only, and carries exactly one parseable browser row. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

describe('Candy Web test profile layer', () => {
  it('declares a private parseable layer containing only the account page', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      private?: boolean
      publishConfig?: unknown
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    // Private and unpublished: this is scaffolding for a browser scenario, not
    // a way to deploy Candy — the Host routes the page calls are not here.
    expect(manifest.private).toBe(true)
    expect(manifest.publishConfig).toBeUndefined()
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dependencies).toEqual({
      '@deepseek-ai/dsh-client-ui-settings-candy-account': 'workspace:^',
    })

    const patch = manifest.dsh?.bundle?.patch
    if (patch === undefined) throw new Error('the layer declares no patch path')
    const parsed = yaml.load(
      readFileSync(resolve(root, patch), 'utf8'),
      { schema: entryListSchema },
    ) as { insert?: { id?: string; name?: string }[] }[]
    expect(parsed.flatMap(entry => entry.insert ?? [])).toEqual([
      { id: 'ui-settings-candy-account', name: '@deepseek-ai/dsh-client-ui-settings-candy-account' },
    ])
  })
})
