# Agent Note: Remote upgrade authorizer seam

Status: implemented

English | [中文](2026-09-13-remote-upgrade-authorizer.zh.md)

`dsh-api-gateway` now accepts an optional `RemoteStreamUpgradeAuthorizer` for the existing WebSocket upgrade. The callback runs on every upgrade, including reconnects, before ownership is handed to `ws`; a `401` or `403` rejects the carrier and an undefined result accepts it. Candy can therefore validate a short-lived device assertion without adding a second protocol or placing a bearer token in each Remote call. The seam does not implement Candy's assertion minting or DSH capability authorization.
