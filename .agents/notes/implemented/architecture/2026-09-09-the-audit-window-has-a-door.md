# Agent Note: The audit window has a door

Status: implemented

English | [中文](2026-09-09-the-audit-window-has-a-door.zh.md)

## Problem

Candy retained tenant and runtime audit records, but operators had no authenticated read surface. Exposing them also risked suggesting that the bounded window was a complete archive or creating a second management UI outside DSH.

## Decision

Candy exposes the retained tenant and runtime audit windows through `GET /api/candy/audits`. The inherited management envelope derives identity from the OAuth session and admits administrators only. The response carries `retention` and `completeHistory: false`; it never implies that records displaced from the bounded store can be paged back.

The DSH settings shell receives a separate `candy-audit` section beside, not inside, the provider-account page. It uses the existing navigation, renderer, locale, responsive layout, and theme rather than creating another Web surface.

## Alternatives considered

**Put audit records on the provider-account page.** This would mix an operator-only cross-runtime concern into tenant account management and make their authorization boundaries harder to distinguish.

**Build a Candy-specific administration application.** This would duplicate the DSH Web surface, responsive layout, settings framework, and theme that the project boundary explicitly assigns to DSH.

**Present the window as pageable history.** Records beyond retention no longer exist in the control-plane store, so pagination would promise data the implementation cannot supply.

## Consequences

Administrators can inspect both bounded windows through the existing Web settings framework, while members receive 403. Operators must treat the response as a current diagnostic window rather than durable compliance storage. The role boundary and bounded response are covered by API tests.
