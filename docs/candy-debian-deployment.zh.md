# Debian 上的 Candy

[English](candy-debian-deployment.md) | 中文

## 概述

Candy 在 Debian 上作为一个绑定 loopback 的 systemd 服务运行，前面是 Nginx，由它终结 TLS 并拥有公开域名。该服务持有两把密钥以及每个租户已封存的服务商凭据，所以这一页讲「什么在约束它」的篇幅不亚于讲「什么在启动它」。运维需要复制的三个文件就放在它们所配置的那一层旁边，位于 [`packages/bundle/candy-app/deploy/`](../packages/bundle/candy-app/deploy)，并由 [`verify-candy-deployment`](../scripts/verify-candy-deployment.ts) 保持与之一致。

这里刻意不采用 Docker 作为部署形态：Candy 需要的隔离是同一个进程树内部的按租户隔离，而围绕整个服务的容器边界既不提供它，也不能替代它。

## 目录

- [安装](#install)
- [HTTPS 与流式传输](#https-and-streaming)
- [什么把一个租户与另一个隔开](#what-isolates-one-tenant-from-another)
- [健康检查、灰度与回滚](#health-canary-and-rollback)
- [备份与恢复](#backup-and-restore)
- [本页不涵盖的内容](#what-this-page-does-not-cover)
- [开发备注](#dev-note)

-----

<a id="install"></a>
## 安装

### 服务账号及其状态目录

```sh
sudo adduser --system --group --home /var/lib/candy --shell /usr/sbin/nologin candy
sudo install -d -o candy -g candy -m 0700 /var/lib/candy /var/lib/candy/pools
sudo install -d -o root -g candy -m 0750 /etc/candy
```

`/var/lib/candy` 存放控制面数据库和每个租户的运行时池。`/etc/candy` 存放环境文件和身份提供方的密钥集，仅该服务可读，其他任何人都不可读。

### 环境

把 [`candy.env.example`](../packages/bundle/candy-app/deploy/candy.env.example) 复制到 `/etc/candy/candy.env`，填好可选区块之前的每一项，并收紧权限：

```sh
sudo install -o root -g candy -m 0640 candy.env.example /etc/candy/candy.env
sudo openssl rand -base64 24   # CANDY_CREDENTIAL_KEY, exactly 32 characters
sudo openssl rand -base64 32   # CANDY_ASSERTION_SECRET
```

凭据密钥按该变量文本自身的原始字节读取，因此必须是 32 个字符——而不是某种编码下的 32 字节值。[bundle 的 README](../packages/bundle/candy-app/README.zh.md) 解释了每一个变量。

环境中缺少任何一个必需变量时，Candy 进程都拒绝启动。这是刻意的，也是安装自带的检查：`systemctl start candy` 失败并在 journal 中点名某个条目，意味着环境不完整，而不是服务坏了。

### unit 与站点

下面这三个文件在仓库里，不在发布的包中；请在你所部署的那个 checkout 的 `packages/bundle/candy-app/deploy/` 目录下执行这些命令。

```sh
sudo install -m 0644 candy.service /etc/systemd/system/candy.service
sudo install -m 0644 candy.nginx.conf /etc/nginx/sites-available/candy
sudo ln -sfn /etc/nginx/sites-available/candy /etc/nginx/sites-enabled/candy
sudo systemctl daemon-reload
sudo nginx -t && sudo systemctl reload nginx
sudo systemctl enable --now candy
```

站点文件末尾的 `map $http_upgrade $connection_upgrade` 块属于 Nginx 的 `http` 块，不属于 server 块；没有它站点无法加载。

### 第一位管理员

只在首次启动时设置 `CANDY_BOOTSTRAP_ADMIN_SUBJECT` 和 `CANDY_BOOTSTRAP_ADMIN_USER_ID`。要么都给要么都不给：这一对会在加载时把一个提供方 subject 登记为管理员。一旦该管理员存在并录入了其他所有人，就把两者都取消——目录随后保持原样；继续设置它们意味着每次重启都会重新断言一份可能已被有意更改的登记。

-----

<a id="https-and-streaming"></a>
## HTTPS 与流式传输

Candy 设置带 `__Host-` 前缀的会话 Cookie，浏览器只在 HTTPS 上接受它。站点把 80 端口重定向到 443 正是为此：一次明文服务的首个请求，就是一次把会话交出去的请求。

Candy 还把每个路由钉在 `CANDY_PUBLIC_ORIGIN` 上——每个请求的 `Host` 头，以及每次写入的精确 `Origin` 头。转发这两者的两行 `proxy_set_header` 不是装饰。少了第一行，每个路由都回答 `403`；少了第二行，读取正常而每次保存失败——这正是看起来像页面 bug 的那种故障形态。

浏览器还会为一个会话的整个生命周期保持一条 Server-Sent Events 流，Remote 网关则升级为 WebSocket。`proxy_buffering off` 以及 `Upgrade`/`Connection` 这一对，是让两者通过的关键。会缓冲的代理只会在对话结束时才把它交付出去。

-----

<a id="what-isolates-one-tenant-from-another"></a>
## 什么把一个租户与另一个隔开

两层，而且值得把各自的职责说清楚。

**进程内部，是控制面。** 每次运行都携带一份执行断言，指明它的租户、账户、设备与工作区授权；准入会拒绝租户或账户与父级不同的子运行，拒绝属于其他租户或设备的授权，并把断言的 nonce 恰好花掉一次。服务商 CLI 被启动进由 `userId + provider + accountId` 推导出的运行时池，该池被创建为私有，`HOME` 与每一个状态变量都指向其内部——因此两个租户绝不共享登录目录、令牌、配置文件或含私有内容的缓存。共享的只有不可变的二进制文件和公共缓存。

**进程外部，是 systemd。** `ProtectSystem=strict` 与 `ProtectHome=yes` 让服务只看到只读的文件系统，除了它自己那个以 `0700` 创建的 `StateDirectory`。`PrivateTmp`、`NoNewPrivileges`、`RestrictSUIDSGID` 与系统调用过滤器，是一个持有密钥的服务应得的常规加固。

它不是什么：每个租户的 agent 都以同一个操作系统用户身份运行。一个让某租户进程读到另一租户池目录的缺陷，只被文件权限所遏制，没有更强的东西。[边界页](candy-runtime-boundaries.zh.md)把这记为一项待测量后再定的既定限制；若测量结果如此，下一步就是按租户分配操作系统用户或更强的沙箱。

-----

<a id="health-canary-and-rollback"></a>
## 健康检查、灰度与回滚

### 它起来了吗

```sh
systemctl is-active candy
journalctl -u candy -n 50 --no-pager
curl -sS -o /dev/null -w '%{http_code}\n' -H 'Host: candy.example.com' http://127.0.0.1:8787/auth/session
```

最后一条返回 `401` 是未认证请求的健康答案：控制面已起并在拒绝。`403` 说明部署自身的域名与 `CANDY_PUBLIC_ORIGIN` 不匹配。连接被拒绝说明服务没在监听。

### 灰度

把新版本作为第二个 unit 运行，用它自己的端口、自己的数据库、自己的池根目录，以及自己的 `CANDY_RUNTIME_AUDIENCE`——共用 audience 正是让一个运行时接受为另一个运行时签发的断言的原因。用另一个 Nginx `server` 块以不同域名指向它，把一位运维的流量切过去，观察 journal 和那位运维的运行情况，再切其余流量。

灰度实例绝不能与线上服务共用 `CANDY_DATABASE_PATH`。两个进程共用一个控制面是受支持的形态，但只适用于 schema 相符的版本；而灰度按定义就是你尚未信任其 schema 的那个版本。

### 回滚

```sh
sudo systemctl stop candy
sudo cp /var/backups/candy/control-plane-<stamp>.db /var/lib/candy/control-plane.db
sudo chown candy:candy /var/lib/candy/control-plane.db
# restore the previous /opt/candy tree
sudo systemctl start candy
```

数据库要与代码一起回滚，绝不单独回滚。SQLite schema 带有单调递增的版本，而持久会话格式在首个正式发布之前没有兼容承诺：旧二进制配新数据库不是受支持的组合，而且没有任何东西会阻止你去试。

凭据密钥是唯一一个不能跟着一起回滚的东西。每个信封都记着自己被封存时的版本，因此把 `CANDY_CREDENTIAL_KEY_VERSION` 换回旧值而没有保留较新的密钥，会把每个租户锁在此后配置的账户之外。在每个信封都被重新封装之前，保持退役密钥可达。

-----

<a id="backup-and-restore"></a>
## 备份与恢复

控制面数据库是唯一无法重建的东西。用 SQLite 自带的在线备份来备份它，不要用 `cp`——写入过程中拿到的副本是一个能打开但缺行的文件：

```sh
sudo -u candy sqlite3 /var/lib/candy/control-plane.db \
  ".backup '/var/backups/candy/control-plane-$(date -u +%Y%m%dT%H%M%SZ).db'"
```

`/etc/candy` 要单独备份，并且备到别处：它持有那两把密钥，而一份没有它们的数据库备份，是一份没有任何东西能打开其记录的备份。

`/var/lib/candy/pools` 下的运行时池是服务商 CLI 的状态——登录、缓存、工作文件。它们按需重建，池被清掉的租户会重新登录一次服务商。如果那次重新登录代价高就备份它们；其他任何东西都不依赖它们。

-----

<a id="what-this-page-does-not-cover"></a>
## 本页不涵盖的内容

- **资源看板与安全告警。** 审计轨迹按租户划分、有界，并可通过 store 读取；目前还没有任何东西把它导出到指标或告警系统。
- **打好包的安装。** 没有 `.deb`；`/opt/candy` 是一个 checkout 或解包后的构建产物，你要回滚到的版本是你自己留下来的那个。
- **服务商凭据检查。** 没有任何东西注册了检查，因此账户页的检查回答的是没有服务商可问。
- **多运行时调度。** 共用一个控制面的两个运行时各需自己的 audience 和池根目录；没有任何东西协调一个租户的运行落到它们中的哪一个上。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

`deploy/` 下的三个文件和这一页对代码做出了断言——存在哪些变量、写入需要被转发的 `Origin`、unit 约束了服务。[`verify-candy-deployment`](../scripts/verify-candy-deployment.ts) 正是保持这些断言为真的东西：它从补丁以及被组合插件自身的 `credential-ref` 默认值中读取变量名，并在模板、任一 README、unit 或站点与之不符时失败。

</details>
