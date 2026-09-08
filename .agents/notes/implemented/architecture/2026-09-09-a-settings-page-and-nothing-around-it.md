# Agent Note: A settings page and nothing around it

Status: implemented

English | [中文](2026-09-09-a-settings-page-and-nothing-around-it.zh.md)

## Problem

Candy's provider-account API had no surface. A tenant could hold accounts, but only a script with a session cookie could create, check, or revoke one.

The tempting answer is a Candy web app: a page with its own shell, its own navigation, its own palette. The repository already has all three, in a settings panel that exists precisely so a feature that owns a page does not have to build one. So the question was not what to build but what not to.

One thing genuinely had to be decided. Every existing settings page reads its data through `ctx.remote`, the dsh `/api` carrier — and that carrier authenticates a **process launch token**, while Candy's routes authenticate a **browser user** through the session cookie the OAuth callback set. They are two different authorities over the same origin, and a page that reached for the familiar one would be asking the wrong question about who is calling.

## Decision

One `settings.section` contribution, `packages/client/ui-settings-candy-account`, and nothing else. No shell, no navigation, no theme, no responsive framework, no second web surface: the panel supplies all of them, and the section's stylesheet names only `--dsw-alias-*` tokens the theme already declares.

The page speaks same-origin HTTP directly and **injects no Remote namespace**. Its `inject` is `['slots', 'locale']` — the two services it actually reads. A Remote injection would have made the page wait on a transport it never uses, and would have suggested that Candy's routes and the dsh carrier are the same authority.

`src/client/api.ts` is the only place the page carries authority: it sends the session cookie, and echoes the CSRF cookie in `x-candy-csrf` on every write, which is the pair `dsh-control-plane-api` checks. An absent CSRF cookie sends an empty header rather than a corrected one — an absent token and a stale one get the same answer from the envelope, and inventing one here would hide that.

Three decisions in the state machine:

**A failure is state, not an exception.** Every operation settles the store and resolves. The only caller that could catch is a component, and a component here holds no state of its own; the page renders what happened instead of a click handler deciding.

**A session that ended is reacted to, not reported.** A `401` clears the identity, the roster and the open form — those rows belong to a session that no longer exists, and leaving them on screen invites a click that cannot land. Every other failure keeps what is on screen and offers a retry.

**A call that did not go through is worded as exactly that.** A credential check that answers "invalid" and a request that never reached the control plane are different facts; conflating them would tell a tenant their credential is bad when the network is.

The roster is re-read after any mutation that can move another row: making one account the default clears the flag on another and deleting one promotes a replacement, and no single answer says which row moved. A credential check reports on one row alone and re-reads nothing.

`ordering: 5` places the page ahead of Models. Which provider account a run bills to is decided before which model it asks for.

## Consequences

A tenant manages their own provider accounts inside the panel they already use, in both shipped languages, with the whole page at per-file 100% coverage across sixty-three cases: the transport's status mapping and CSRF echo, the state machine's re-read and signed-out rules, the page's rendering and every click, the registration's slot injection and fiber disposal, and the stylesheet's tokens and phone-width wrapping.

The credential is write-only end to end and the tests pin it there: the create form is the only field that holds one, it is a `password` input with autocomplete off, it is cleared when the form closes, and the transport spec asserts the secret it sent appears nowhere in what came back.

What this does not add: no administrator view of another tenant's accounts (the API has none either), no pagination, no in-place recovery from an expired session — the sign-in entry point is a full navigation — and no Candy deployment composition. The page ships as a client plugin registered in the workspace; no shipped bundle mounts it, because no bundle composes Candy's Host plugins yet.

## Alternatives considered

**Build a Candy web surface.** Rejected outright by the brief and by the code: the panel already owns chrome, navigation, theme and responsive layout, and a second surface would be four things to keep in step with one.

**Reach the accounts through `ctx.remote`.** Rejected: the carrier authenticates a process launch token, not a browser user. Making Candy's routes reachable through it would mean giving that carrier a second authority, which is the opposite of what the session cookie exists for.

**Store the page's state in the settings document.** Rejected: none of it is a preference. The accounts are the control plane's, and the settings transport is additionally disabled for non-loopback pages — which is every Candy deployment.

**Add a `danger` button variant.** Rejected: the shared button has four variants and destructive actions elsewhere in the panel take a class that colors the ghost variant. A fifth variant for one page is a shared primitive changed for a private need.

**Render deleted accounts as a tombstone row.** Rejected once the domain was read: `listProviderAccounts` hides deleted records and keeps revoked ones, which is already the right split — a revoked account explains why a provider stopped working, and a deleted one is gone. The API's own doc comment claimed otherwise and was corrected.
