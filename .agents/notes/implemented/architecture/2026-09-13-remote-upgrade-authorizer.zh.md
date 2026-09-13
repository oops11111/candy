# Agent Note：Remote 升级授权器扩展点

状态：已实现

English | [中文](2026-09-13-remote-upgrade-authorizer.md)

`dsh-api-gateway` 现在为现有 WebSocket 升级接受可选的 `RemoteStreamUpgradeAuthorizer`。回调会在每次升级（包括重连）中执行，并且发生在连接交给 `ws` 之前；返回 `401` 或 `403` 会拒绝连接，返回 `undefined` 则接受连接。因此 Candy 可以校验短期设备断言，而无需新增第二套协议，也不会把 bearer token 放进每个 Remote 调用。该扩展点不负责实现 Candy 的断言签发或 DSH 能力授权。
