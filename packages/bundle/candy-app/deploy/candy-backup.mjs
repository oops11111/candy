/**
 * Online backup of the Candy control-plane database.
 *
 * SQLite's own backup copies a live database page by page while the runtime
 * keeps writing, which `cp` cannot do: a copy taken mid-write opens and is
 * missing rows. This uses `node:sqlite`'s `backup()`, so the only thing it
 * needs is the Node that already runs the service — not the `sqlite3` package,
 * which a Debian install does not ship and this page never asked an operator
 * to add.
 *
 * The destination is written to a temporary name in its own directory and
 * renamed only after the copy finishes, so a backup interrupted half way
 * leaves no file that looks complete.
 *
 * Usage:
 *   node candy-backup.mjs <source.db> <destination.db>
 *
 * Exits non-zero with a message on stderr and writes nothing on failure.
 */

import { backup, DatabaseSync } from 'node:sqlite'
import { renameSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const [source, destination] = process.argv.slice(2)
if (source === undefined || destination === undefined) {
  process.stderr.write('usage: node candy-backup.mjs <source.db> <destination.db>\n')
  process.exit(2)
}

// Same directory as the destination, so the rename is atomic rather than a
// cross-filesystem copy that can half-land.
const pending = join(dirname(destination), `.${basename(destination)}.partial`)

let database
try {
  // Read-only: a backup must not create a database that was not there, and
  // must not be what repairs a corrupt one.
  database = new DatabaseSync(source, { readOnly: true })
} catch (error) {
  process.stderr.write(`candy-backup: cannot open ${source}: ${String(error)}\n`)
  process.exit(1)
}

try {
  const pages = await backup(database, pending)
  renameSync(pending, destination)
  process.stdout.write(`candy-backup: copied ${String(pages)} page(s) to ${destination}\n`)
} catch (error) {
  rmSync(pending, { force: true })
  process.stderr.write(`candy-backup: backup failed: ${String(error)}\n`)
  process.exit(1)
} finally {
  database.close()
}
