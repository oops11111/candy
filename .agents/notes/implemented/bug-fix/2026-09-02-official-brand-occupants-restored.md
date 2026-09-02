# Agent Note: Official brand occupants restored

Status: implemented

English | [中文](2026-09-02-official-brand-occupants-restored.zh.md)

## Problem

The Candy shell rebrand replaced `dsh-client-ui-brand-official`'s sidebar occupants with a hand-drawn mark and the literal JSX text `Candy`, and dropped the `DSH_CLIENT_BUILD_PROFILE !== 'official'` guard that had kept those occupants out of non-official builds. Literal product copy in Client source is exactly what `verify-client-ui-i18n` rejects, so `pnpm run hygiene` failed on every branch carrying the rebrand. The gate has no exemption list: locale dictionaries are its only sanctioned owner of translated text, and a product name rendered as JSX text cannot satisfy it.

## Decision

`packages/client/ui-brand-official` returns to the occupants it had before the rebrand: `OfficialBrandMark` renders `FishLogo` and `OfficialBrandName` renders `BrandWordmark` with `includeMark={false}`. Both are `aria-hidden` vector artwork from `dsh-client-ui-primitives`, so the package contributes no translatable string and the i18n gate passes without a locale entry for a product name.

Restoring the artwork restores its build-profile guard with it. The two are one decision: artwork that spells a specific vendor's name belongs only in that vendor's builds, and the package README's profile prose describes exactly that arrangement. Without the guard, official artwork would render in every deployment that composes this package, including one that meant to keep the shell fallbacks.

The Candy product label is unaffected and stays where it already lived — the `brand.localBuild` locale key, which the sidebar shell and `AppFrame` read for the fallback name and the document title. A build that occupies no brand slot therefore still shows `Candy`, and only an `official` build shows the vendor wordmark.

## Alternatives considered

**Add a locale entry for the product name and render it through `t`.** This is the gate's sanctioned route and would have kept the Candy wordmark. It lost because `sidebar.brand.name` passes its occupant no `t`: the slot's owner props are deliberately empty (`children?: never`, "the occupant owns its own content and width"), so the package would have needed either a widened slot contract or its own locale dictionary — a larger change than the branding question warranted, and one that treats a product name as translatable copy.

**Reuse the existing `brand.localBuild` key inside the occupant.** One line, and the key already reads `Candy`. Rejected because the key names the local-build label the shell falls back to, not the product wordmark; binding the official occupant to it would make the two surfaces impossible to change independently.

**Restore the artwork but leave the guard removed.** Rejected as an incoherent middle: the README's profile section would have described gating the code no longer performed, and vendor artwork would render in third-party deployments.

## Consequences

`pnpm run hygiene` passes at 15/15 and `pnpm run doc-sync` at 32/32; the package's own suite pins the wordmark `viewBox` and the profile gating again, and the sidebar, layout, and snapshot suites that assert `Candy` keep passing because they read the locale key rather than this package.

Product presentation is now split by build profile, which is the arrangement the package README documents: an `official` build shows the vendor mark and wordmark, every other build shows the fish mark and the `Candy` label. A deployment that wants the Candy name in the sidebar slot itself — rather than through the fallback — needs a brand package of its own occupying those slots, which is the composition route the README already names.
