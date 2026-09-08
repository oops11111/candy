---
description: "Private Web profile layer that mounts the Candy account settings page over dsh-web-app, so a browser scenario can drive it without a Candy deployment."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-candy-web-profile

English | [中文](README.zh.md)

## Summary

One patch layer, one row: the browser half of [`dsh-client-ui-settings-candy-account`](../../client/ui-settings-candy-account/README.md) over the shipped `dsh-web-app` surface. It exists so `apps/web/tests/candy-account-settings.e2e.ts` can show that page inside the real settings panel, in a real browser, at desktop and phone widths.

It is private and unpublished, and it is not a way to deploy Candy. The Host routes the page calls are deliberately absent: they need a public origin, an OIDC key set and a credential key that no test process can supply as literals, and each is proved in its own package's Loader-composition suite.

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

A web scenario names this layer twice, and each name does a different job:

```text
const LAYER_DIR = new URL('../../../packages/experimental/candy-web-profile/', import.meta.url)
launchWebScaffold({
  extraOverlayPath: fileURLToPath(new URL('cordis.patch.yml', LAYER_DIR)),
  extraInstallAnchors: [fileURLToPath(new URL('package.json', LAYER_DIR))],
})
```

The patch inserts the row. The manifest is the install anchor whose dependency closure links the page package into the scaffold profile, without which the row would fail to import.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

| File | Role |
| --- | --- |
| [`cordis.patch.yml`](cordis.patch.yml) | The one inserted browser row |
| [`package.json`](package.json) | The dependency that makes that row resolvable |
| — | No runtime invariant companion is published; the package carries no runtime code at all. |

### Why the layer and the overlay are one file

The scaffold applies the overlay path and heals modules from the anchor separately, so a scenario could carry its own copy of the row. Pointing both at this layer means there is one place the row is written, and no second copy to drift from it.

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-client-ui-settings-candy-account`](../../client/ui-settings-candy-account/README.md) — the page this layer mounts.
- [`dsh-provider-account-api`](../../control-plane/provider-account-api/README.md) — the routes the page calls, and where they are proved.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package is a test-only composition layer carrying no runtime code.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These are current package constraints, not a task backlog.

- **It composes no Candy Host plugin** — a scenario using this layer scripts the control-plane answers itself. When a Candy deployment bundle exists, a scenario wanting the real routes should compose that instead of extending this.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The package carries no runtime code, registers nothing, and owns no relation to check.
