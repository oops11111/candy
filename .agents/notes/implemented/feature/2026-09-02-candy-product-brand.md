# Agent Note: Candy product brand

Status: implemented

English | [中文](2026-09-02-candy-product-brand.zh.md)

## Problem

The fork had a Candy repository name but continued to identify itself as DeepSeek Harness in its Web title, installable application metadata, sidebar, onboarding notice, and primary README. Users could not distinguish the Candy product from its upstream foundation.

## Decision

User-visible product surfaces identify the application as Candy. The existing browser brand slots carry the Candy mark and name, and the existing Harness theme system continues to own all colors and appearance preferences. Candy does not add a palette or a second theme implementation.

The `dsh` command, `DSH_*` compatibility variables, and `@deepseek-ai/dsh-*` internal package names remain unchanged. This keeps runtime protocols and upstream merges stable while product-facing text remains independently branded.

## Alternatives considered

**Rename every internal package, command, environment variable, and protocol identifier.** This would make the source vocabulary match the product immediately, but it would create a large compatibility break and make upstream merges unnecessarily expensive.

**Keep the upstream brand and change only the repository name.** This has the smallest diff but leaves users unable to tell which product they are running.

## Consequences

Candy has a distinct product identity without a duplicate styling system. Maintainers must continue to distinguish stable `dsh` compatibility identifiers from user-visible Candy copy when importing upstream changes.
