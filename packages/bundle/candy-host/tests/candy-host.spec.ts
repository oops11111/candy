/** The standalone Candy Host command bundle's declared tree. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { describe, expect, it } from 'vitest'

describe('dsh-candy-host bundle', () => {
  it('declares only credential, binding, startup, and command rows', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const patches = yaml.load(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'), {
      schema: entryListSchema,
    }) as Array<{ insert?: Array<{ id?: string; name?: string; inject?: string[] }> }>
    expect(patches).toHaveLength(1)
    expect(patches[0]?.insert?.map(row => [row.id, row.name])).toEqual([
      ['credentials', '@deepseek-ai/dsh-credentials-local'],
      ['device-binding', '@deepseek-ai/dsh-device-binding'],
      ['candy-host-startup', '@deepseek-ai/dsh-candy-host/startup'],
      ['candy-host-command', '@deepseek-ai/dsh-candy-host'],
    ])
    expect(patches[0]?.insert?.at(-1)?.inject).toEqual(['candyHostStartup'])
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain('@deepseek-ai/dsh-api-gateway')
  })
})
