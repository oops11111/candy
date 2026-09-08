---
description: "Candy account settings page: the signed-in tenant's provider accounts, managed inside the dsh settings panel over the control plane's own authenticated routes."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-candy-account

English | [中文](README.zh.md)

## Summary

This package contributes one page to the dsh settings panel: who this browser is signed in to Candy as, and the provider accounts that tenant owns. It adds no shell, no navigation, no theme and no layout of its own — the settings panel already has all four, and a section is exactly the seat it offers a feature that owns a page.

Its data does not ride `ctx.remote`. Candy's control-plane routes authenticate a browser user through the session cookie its OAuth callback set, while the dsh `/api` carrier authenticates a process launch token; the two are different authorities over the same origin, so the page speaks same-origin HTTP and injects no Remote namespace.

A credential goes in and never comes back. The create form is the only field that holds one, it is cleared when the form closes, and every row is drawn from the control plane's secret-free account view.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this browser plugin in a deployment whose Host serves [`dsh-provider-account-api`](../../control-plane/provider-account-api/README.md) and [`dsh-oauth-sign-in-web`](../../control-plane/oauth-sign-in-web/README.md). The **Account** page then appears in the settings panel, ahead of Models: which provider account a run bills to is decided before which model it asks for.

The page has no configuration. It reads the paths those two plugins mount, at the origin it is served from.

### What a tenant does here

| Action | Effect |
| --- | --- |
| Add account | Seals a credential for one provider under a label, optionally as that provider's default |
| Check credential | Asks the provider whether the stored credential still authenticates |
| Make default | Makes one account its provider's default for this tenant |
| Revoke credential | Ends the credential, keeping the record readable |
| Delete | Removes the account and blocks its identifier from being issued again |
| Sign out | Ends the browser session and returns to the sign-in entry point |

Revoked accounts stay listed, because seeing why a provider stopped working is the reason to come here; deleted ones are gone from the roster entirely.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

| File | Role |
| --- | --- |
| [`src/client/api.ts`](src/client/api.ts) | The control-plane calls, the CSRF echo, and what each status means |
| [`src/client/store.ts`](src/client/store.ts) | Page state and the operations that settle it |
| [`src/client/CandyAccountSection.tsx`](src/client/CandyAccountSection.tsx) | The page itself |
| [`src/client/locales.ts`](src/client/locales.ts) | The `settings.candyAccount` dictionaries |
| — | No runtime invariant companion is published; this package owns no event stream and no cross-plugin mutable relation, and its one slot registration proves disposal in the apply spec. |

### Why a failure is state and not an exception

Every operation settles the store and resolves. A caller that had to catch would be a component, and a component here holds no state of its own — so the page renders what happened instead of a click handler deciding.

One failure is not reported but reacted to: a signed-out answer clears the identity, the roster and the open form, because those rows belong to a session that no longer exists. A call that did not go through is worded as exactly that, never as a statement about the credential it was about.

### Why the control plane is re-read after a mutation

Making one account the default clears the flag on another, and deleting one promotes a replacement. No single answer says which row moved, so the page re-reads rather than patching what it guessed. A credential check reports on one row alone and re-reads nothing.

### Why the account id in a request cannot select a tenant

It never carries one. The tenant is derived from the session cookie by [`dsh-control-plane-api`](../../control-plane/control-plane-api/README.md), and an id that tenant does not own answers `404` — the same answer an id that was never issued gets.

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-settings](../ui-settings/README.md) — the settings domain base and the `settings.section` seat this page fills.
- [dsh-provider-account-api](../../control-plane/provider-account-api/README.md) — the six operations behind this page.
- [dsh-oauth-sign-in-web](../../control-plane/oauth-sign-in-web/README.md) — the sign-in that establishes the session cookie the page sends.
- [Web Client architecture](../../../docs/subsystems/web-client.md) — the layering every client plugin follows.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package is a browser-side settings page and touches no prompt, message, schema, stream, or tool result.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These are current package constraints, not a task backlog.

- **A credential check answers `unsupported-provider` until an integration composes** — nothing registers a provider credential check yet, so the button works as a route and reports that no provider could be asked.
- **No administrator view** — the page acts on the acting tenant's own accounts. An administrator managing another tenant's has no surface here, because the API has none either.
- **The roster is answered whole** — there is no pagination; the count is bounded by what an operator provisions.
- **A signed-out page cannot recover in place** — the sign-in entry point is a full navigation, so an expired session ends the page rather than refreshing it behind a dialog.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. This package registers one settings section over its own store; it emits no cordis events, owns no cross-plugin mutable relation, and its registration proves disposal through the apply spec's fiber-dispose case.
