---
description: "The registry a provider integration says through whether one stored credential still authenticates, so a management API can ask without learning the endpoint, the request, or the response."
kind: "package-reference"
---

# @deepseek-ai/dsh-provider-credential-checks

English | [中文](README.zh.md)

## Summary

Checking a credential means talking to that provider, which only the integration for it knows how to do. This registry is the seam between the two: [`dsh-provider-account-api`](../provider-account-api/README.md) asks for a verdict and never learns the endpoint, the request, or the response body, and an integration answers without knowing which tenant or account the secret came from.

A provider nothing registered for answers `unsupported-provider` — not that the credential is invalid, which this deployment has no way to know.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Composing it

```yaml
- id: provider-credential-checks
  name: '@deepseek-ai/dsh-provider-credential-checks'
```

The service takes no configuration: what it holds is whatever the composed integrations register.

### Contributing a check

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-provider-credential-checks'

declare const ctx: Context
declare function authenticates(key: string): Promise<boolean>

export const dispose = ctx.providerCredentialChecks.register('deepseek-api', async (secret) => {
  return await authenticates(Buffer.from(secret).toString('utf8'))
    ? { valid: true }
    : { valid: false, reason: 'invalid-credential' }
})
```

The check receives the opened secret and answers a verdict. Its optional `diagnostic` is the only text that reaches a client, so it must not carry a provider response body, an endpoint, or the credential.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

| File | Role |
| --- | --- |
| [`src/index.ts`](src/index.ts) | The service, its registration effect, and the verdict lookup |
| [`src/types.ts`](src/types.ts) | `ProviderCredentialCheck` |
| — | No runtime invariant companion is published; the registry owns no event stream, and its disposal is proved by the HMR test in its consumer's suite. |

### Why the first registration answers

A deployment composes one integration per provider. A second would be two opinions about one fact with no rule for choosing between them, and picking the newest or merging verdicts would each be a rule nobody stated.

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-provider-account-api`](../provider-account-api/README.md) — the one caller, and where a verdict becomes an HTTP reply.
- [`dsh-provider-accounts`](../provider-accounts/README.md) — the domain operation that opens the credential before asking.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

These are current package constraints, not a task backlog.

- **Nothing registers a check yet** — every provider answers `unsupported-provider` until an integration composes one. The Claude CLI and DeepSeek API routes have no check of their own.
- **No caching or rate limiting** — every validate request reaches the provider. A tenant that asks repeatedly is a load an integration must bound itself.
- **One check per provider** — a second registration for a provider is held but never consulted.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
