# Agent Note: 租户设备配额原子性

Status: proposed

[English](2026-09-13-tenant-device-quota-atomicity.md) | 中文

## Problem

当前设备注册与配对码存储缺少跨记录的原子配额决策，无法安全限制每个租户的设备和未消费配对码数量。

## Proposal

Candy 需要限制已配对设备和未消费配对码的数量。当前 `DeviceRegistryStore` 只能对单条记录做 compare-and-exchange，而设备记录、配对码记录和租户计数属于不同键。先读数量再写入会让两个进程同时看到余量并突破上限。另一种失败是消费配对码与写入设备之间发生崩溃，导致计数泄漏或重复。

## DSH 必需的存储接口

存储层应提供一个按租户工作的原子预留原语，并以 SQLite 事务语义实现：

```ts
reserveTenantSlot(userId, kind, limit, reservationId): Promise<boolean>
releaseTenantSlot(userId, kind, reservationId): Promise<void>
commitTenantSlot(userId, kind, reservationId): Promise<void>
```

`kind` 为 `device` 或 `pairing-code`。`reservationId` 是唯一不透明标识，重试时操作必须幂等。预留及其状态必须持久化。上限为零时拒绝所有新预留。该操作必须在同一事务中刷新当前租户行并作出计数决定，确保两个 Candy 进程不能同时赢得最后一个槽位。

## Candy 组合方式

签发配对码时先预留 `pairing-code` 槽位，再写入摘要。写入失败则释放预留；恢复流程通过有界租约释放过期预留。兑换配对码时先预留 `device` 槽位，再执行一次性消费，设备记录持久化后提交预留。消费失败则释放设备预留。若配对码已消费但设备写入失败，不恢复这个持有型配对码：令牌保持已烧毁，同时释放设备预留，重试必须重新签发配对码。

兑换同时在持久事务中释放配对码预留。清理只在删除终态记录时释放预留。撤销操作只在撤销记录持久化后释放设备槽位。所有操作始终按租户隔离，绝不接受客户端提供的租户或计数器。

## Acceptance criteria

- 两个进程竞争最后一个设备槽位时，最终恰好创建一个设备。
- 两个进程竞争最后一个未消费配对码槽位时，最终恰好签发一个配对码；写入失败后，恢复流程不会永久吞掉槽位。
- 配对码消费与设备写入可安全重试：最多创建一个设备，已烧毁配对码不能再次兑换。
- 撤销和终态配对码清理只释放所属租户的槽位。
- 重启恢复只回收过期预留，不回收已提交预留。
- 上限和预留标识不得出现在 HTTP 回复或审计负载中。

## Risks

预留租约必须足以覆盖设备写入，又要足够短以便回收崩溃的签发者。无法提供该事务的部署必须关闭配额并明确失败，不能用进程内计数近似。

## Alternatives considered

- 写入前统计记录。拒绝，因为并发进程可能同时看到余量。
- 只在内存中维护计数。拒绝，因为重启和多进程行为会分叉。

## 明确不包含

该接口不实现 Remote Gateway、WebSocket 传输、Windows 文件操作、沙箱、Agent／Skills／Tools 或第二套 Web 界面。这些仍由 DSH 及其现有扩展点负责。
