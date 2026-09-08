# The audit window has a door

English | [中文](2026-09-09-the-audit-window-has-a-door.zh.md)

Candy now exposes the retained tenant and runtime audit windows through `GET /api/candy/audits`. The inherited management envelope derives identity from the OAuth session and admits administrators only. The response carries `retention` and `completeHistory: false`; it never implies that records displaced from the bounded store can be paged back.

The DSH settings shell receives a second `candy-audit` section beside, not inside, the provider-account page. It uses the existing navigation, renderer, locale, responsive layout, and theme rather than creating another Web surface.

Tests prove that a member receives 403 and an administrator receives both windows. A requested security-negative mutation that weakened the route role was rejected by the execution policy before it could be written; no weakened authorization state was run or retained.
