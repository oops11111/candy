/**
 * Keep the Candy deployment artifacts agreeing with the layer they deploy.
 *
 * What a Candy process reads is decided by the patch file and by the
 * `credential-ref` defaults of the plugins it composes — never by a template.
 * An operator template that has drifted from those fails in the one way a
 * template must not: silently, on a first install, with a variable that is
 * either never read or never set.
 *
 * So this reads the variable names out of those sources and checks that the
 * environment template, both README tables and the systemd unit line up with
 * them — and that the two files an operator copies do not contradict the
 * confinement and origin rules the composed rows enforce.
 * @module scripts/verify-candy-deployment
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const BUNDLE = fileURLToPath(new URL('../packages/bundle/candy-app/', import.meta.url))
const PATCH = `${BUNDLE}cordis.patch.yml`
const ENVIRONMENT = `${BUNDLE}deploy/candy.env.example`
const UNIT = `${BUNDLE}deploy/candy.service`
const SITE = `${BUNDLE}deploy/candy.nginx.conf`
const README = `${BUNDLE}README.md`
const README_ZH = `${BUNDLE}README.zh.md`

/** One thing that has to hold, and where it did not. */
interface Failure {
  readonly file: string
  readonly message: string
}

const failures: Failure[] = []

/**
 * Record a failed check.
 * @param file - the file the check is about.
 * @param condition - whether the check held.
 * @param message - what did not hold.
 */
function check(file: string, condition: boolean, message: string): void {
  if (!condition) failures.push({ file, message })
}

const patch = readFileSync(PATCH, 'utf8')
const environment = readFileSync(ENVIRONMENT, 'utf8')
const unit = readFileSync(UNIT, 'utf8')
const site = readFileSync(SITE, 'utf8')
const readme = readFileSync(README, 'utf8')
const readmeZh = readFileSync(README_ZH, 'utf8')

/**
 * Sources whose `credential-ref` schema defaults name a variable the layer
 * relies on without restating it.
 *
 * The key and the secret are read by the plugins themselves, through the
 * default of a config field the layer leaves unset. Restating the name in the
 * patch would be a second place for one fact; reading it out of the source
 * that owns it keeps the template honest when that name changes.
 */
const DEFAULTED_BY = [
  '../packages/control-plane/run-scheduler/src/index.ts',
  '../packages/control-plane/provider-account-api/src/index.ts',
]

/** Variables the patch names outright. */
const named = [...new Set([...patch.matchAll(/process\.env\.(CANDY_\w+)/gu)].map(match => match[1] as string))]

/** Variables a composed plugin's own `credential-ref` default names. */
const defaulted = [...new Set(DEFAULTED_BY.flatMap((source) => {
  const text = readFileSync(fileURLToPath(new URL(source, import.meta.url)), 'utf8')
  return [...text.matchAll(/role\('credential-ref'\)\.default\('(CANDY_\w+)'\)/gu)].map(match => match[1] as string)
}))]

/** Every variable a Candy deployment has to supply. */
const read = [...named, ...defaulted.filter(name => !named.includes(name))]

check(PATCH, named.length > 0, 'the layer reads no CANDY_* variable, so this gate is checking nothing')
check(
  PATCH,
  defaulted.length > 0,
  'no composed plugin defaults a CANDY_* credential reference, so the key and secret checks are checking nothing',
)

// An operator fills in the template, so a variable the layer reads and the
// template omits is one nobody will set.
for (const name of read) {
  check(
    ENVIRONMENT,
    new RegExp(`^#?${name}=`, 'mu').test(environment),
    `${name} is required by the deployment but the environment template never names it`,
  )
  for (const [file, text] of [[README, readme], [README_ZH, readmeZh]] as const) {
    check(file, text.includes(`\`${name}\``), `${name} is required by the deployment but this README never documents it`)
  }
}

// And a template variable nothing reads is one nobody will use: the operator
// sets it, nothing consults it, and the deployment is wrong in a way no error
// reports. `CANDY_OIDC_CLIENT_SECRET` is the exception — the layer passes the
// NAME of that variable, so its value is read through whatever it names.
const templated = [...new Set([...environment.matchAll(/^#?(CANDY_\w+)=/gmu)].map(match => match[1] as string))]
for (const name of templated) {
  check(
    ENVIRONMENT,
    read.includes(name) || name === 'CANDY_OIDC_CLIENT_SECRET',
    `${name} is in the environment template but nothing in the deployment reads it`,
  )
}

// The unit must load the file the template becomes, or every variable above is
// documented and never delivered.
check(UNIT, /^EnvironmentFile=/mu.test(unit), 'the unit loads no EnvironmentFile, so the layer gets no configuration')

// Candy checks the Host header of every request and the exact Origin of every
// write against CANDY_PUBLIC_ORIGIN. A proxy that does not forward both makes
// every authenticated write answer 403, which is a whole deployment that
// appears to work until someone saves something.
check(SITE, /proxy_set_header\s+Host\s+\$host;/u.test(site), 'the site does not forward Host, so every route refuses')
check(
  SITE,
  /proxy_set_header\s+Origin\s+\$http_origin;/u.test(site),
  'the site does not forward Origin, so every authenticated write refuses',
)

// The session cookies carry the `__Host-` prefix, which a browser honours only
// over HTTPS; a site that serves the origin on port 80 hands them out in the
// clear on the first request.
check(SITE, /return\s+30[18]\s+https:/u.test(site), 'the site does not redirect plaintext to HTTPS')
check(SITE, /listen\s+443\s+ssl;/u.test(site), 'the site does not terminate TLS')

// The browser holds an event stream open for the life of a session; a
// buffering proxy delivers none of it.
check(SITE, /proxy_buffering\s+off;/u.test(site), 'the site buffers, so streamed responses never reach the browser')
check(SITE, /proxy_set_header\s+Upgrade\s+\$http_upgrade;/u.test(site), 'the site does not carry a WebSocket upgrade')

// The service holds two keys and every tenant's sealed credentials, and a
// tenant's provider CLI runs inside it. These are the confinement claims the
// deployment page makes; a unit that lost one would make that page wrong.
for (const directive of [
  'User=candy',
  'ProtectSystem=strict',
  'ProtectHome=yes',
  'PrivateTmp=yes',
  'NoNewPrivileges=yes',
  'StateDirectoryMode=0700',
]) {
  check(UNIT, unit.includes(directive), `the unit no longer sets ${directive}, which the deployment page claims`)
}

// Loopback only: the public port is the proxy's, and a unit that binds every
// interface publishes an origin with no TLS in front of it.
check(UNIT, /--host\s+127\.0\.0\.1/u.test(unit), 'the unit does not bind loopback, so the process is reachable untermed')

if (failures.length > 0) {
  process.stdout.write('verify-candy-deployment failed:\n')
  for (const failure of failures) {
    process.stdout.write(`  ${failure.file.replace(BUNDLE, 'packages/bundle/candy-app/')}: ${failure.message}\n`)
  }
  process.exitCode = 1
} else {
  process.stdout.write(
    `verify-candy-deployment: ${String(read.length)} environment variable(s) agree across the layer, `
    + 'the template and both READMEs; unit and site checks pass.\n',
  )
}
