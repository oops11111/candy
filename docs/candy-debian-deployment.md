# Candy on Debian

English | [中文](candy-debian-deployment.zh.md)

## Summary

Candy runs on Debian as one systemd service bound to loopback, behind Nginx, which terminates TLS and owns the public name. The service holds two keys and every tenant's sealed provider credentials, so this page is as much about what confines it as about what starts it. The three files an operator copies live beside the layer they configure, in [`packages/bundle/candy-app/deploy/`](../packages/bundle/candy-app/deploy), and [`verify-candy-deployment`](../scripts/verify-candy-deployment.ts) keeps them agreeing with it.

Docker is deliberately not the deployment shape here: the isolation Candy needs is per-tenant inside one process tree, which a container boundary around the whole service does not provide and does not replace.

## Table of Contents

- [Install](#install)
- [HTTPS and streaming](#https-and-streaming)
- [What isolates one tenant from another](#what-isolates-one-tenant-from-another)
- [Health, canary and rollback](#health-canary-and-rollback)
- [Backup and restore](#backup-and-restore)
- [What this page does not cover](#what-this-page-does-not-cover)
- [Dev Note](#dev-note)

-----

<a id="install"></a>
## Install

### The service account and its state

```sh
sudo adduser --system --group --home /var/lib/candy --shell /usr/sbin/nologin candy
sudo install -d -o candy -g candy -m 0700 /var/lib/candy /var/lib/candy/pools
sudo install -d -o root -g candy -m 0750 /etc/candy
```

`/var/lib/candy` holds the control-plane database and every tenant's runtime pool. `/etc/candy` holds the environment file and the identity provider's key set, readable by the service and by nobody else.

### The environment

Copy [`candy.env.example`](../packages/bundle/candy-app/deploy/candy.env.example) to `/etc/candy/candy.env`, fill in every value above its optional block, and lock it down:

```sh
sudo install -o root -g candy -m 0640 candy.env.example /etc/candy/candy.env
sudo openssl rand -base64 24   # CANDY_CREDENTIAL_KEY, exactly 32 characters
sudo openssl rand -base64 32   # CANDY_ASSERTION_SECRET
```

The credential key is read as the raw bytes of the variable's own text, so it must be 32 characters — not a 32-byte value in some encoding. [The bundle README](../packages/bundle/candy-app/README.md) explains every variable.

A Candy process whose environment is missing one of the required variables refuses to start. That is deliberate and it is the install's own check: `systemctl start candy` failing with a named entry in the journal means the environment is incomplete, not that the service is broken.

### The unit and the site

The three files below are in the repository, not in the published package; run these from `packages/bundle/candy-app/deploy/` in the checkout you are deploying.

```sh
sudo install -m 0644 candy.service /etc/systemd/system/candy.service
sudo install -m 0644 candy.nginx.conf /etc/nginx/sites-available/candy
sudo ln -sfn /etc/nginx/sites-available/candy /etc/nginx/sites-enabled/candy
sudo systemctl daemon-reload
sudo nginx -t && sudo systemctl reload nginx
sudo systemctl enable --now candy
```

The `map $http_upgrade $connection_upgrade` block at the foot of the site file belongs in Nginx's `http` block, not in the server block; the site will not load without it.

### The first administrator

Set `CANDY_BOOTSTRAP_ADMIN_SUBJECT` and `CANDY_BOOTSTRAP_ADMIN_USER_ID` for the first start alone. Both or neither: the pair enrolls one provider subject as an administrator at load. Once that administrator exists and has enrolled everyone else, unset both — the directory then stands as it is, and leaving them set means every restart re-asserts an enrollment that may since have been changed deliberately.

-----

<a id="https-and-streaming"></a>
## HTTPS and streaming

Candy sets `__Host-` prefixed session cookies, which a browser accepts only over HTTPS. The site redirects port 80 to 443 for exactly that reason: a first request served in the clear is one that hands out a session.

Candy also pins every route to `CANDY_PUBLIC_ORIGIN` — the `Host` header of every request, and the exact `Origin` header of every write. The two `proxy_set_header` lines that forward them are not cosmetic. Without the first, every route answers `403`; without the second, reads work and every save fails, which is the failure mode that looks like a bug in the page.

The browser holds a Server-Sent Events stream open for the life of a session, and the Remote gateway upgrades to a WebSocket. `proxy_buffering off` and the `Upgrade`/`Connection` pair are what let both through. A proxy that buffers delivers a conversation only when it ends.

-----

<a id="what-isolates-one-tenant-from-another"></a>
## What isolates one tenant from another

Two layers, and it is worth being precise about which does what.

**Inside the process, the control plane.** Every run carries an execution assertion naming its tenant, account, device and workspace grant; admission refuses a child whose tenant or account differs from its parent's, refuses a grant belonging to another tenant or device, and spends the assertion's nonce exactly once. A provider CLI is launched into a runtime pool derived from `userId + provider + accountId`, created private, with `HOME` and every state variable pointed inside it — so two tenants never share a login directory, a token, a config file or a cache with private content. Only immutable binaries and public caches are shared.

**Around the process, systemd.** `ProtectSystem=strict` and `ProtectHome=yes` leave the service a read-only view of the filesystem apart from its own `StateDirectory`, created `0700`. `PrivateTmp`, `NoNewPrivileges`, `RestrictSUIDSGID` and the syscall filter are the ordinary hardening a service holding keys deserves.

What this is not: every tenant's agent runs as the same operating-system user. A defect that lets one tenant's process read another's pool directory is contained by file permissions and by nothing stronger. [The boundaries page](candy-runtime-boundaries.md) records this as an accepted limit pending measurement; per-tenant operating-system users or a stronger sandbox is the next step if that measurement says so.

-----

<a id="health-canary-and-rollback"></a>
## Health, canary and rollback

### Is it up

```sh
systemctl is-active candy
journalctl -u candy -n 50 --no-pager
curl -sS -o /dev/null -w '%{http_code}\n' -H 'Host: candy.example.com' http://127.0.0.1:8787/auth/session
```

`401` from the last one is the healthy answer for an unauthenticated request: the control plane is up and refusing. `403` means the deployment's own name does not match `CANDY_PUBLIC_ORIGIN`. A connection refused means the service is not listening.

### Canary

Run the new version as a second unit on its own port, its own database and its own pool base, with its own `CANDY_RUNTIME_AUDIENCE` — sharing an audience is what lets one runtime admit assertions minted for another. Point a second Nginx `server` block at it under a different name, move one operator's traffic there, and watch the journal and that operator's runs before moving the rest.

A canary must not share `CANDY_DATABASE_PATH` with the live service because a canary is by definition the version whose schema you have not yet trusted. Browser authentication now re-reads the matching session from SQLite, so a logout in one process reaches another already-running process on its next request; assertion nonces likewise remain single-use across both. This does not make mixed-version access safe: give each canary its own database and runtime audience.

### Rollback

```sh
sudo systemctl stop candy
sudo cp /var/backups/candy/control-plane-<stamp>.db /var/lib/candy/control-plane.db
sudo chown candy:candy /var/lib/candy/control-plane.db
# restore the previous /opt/candy tree
sudo systemctl start candy
```

Roll the database back with the code, never separately. The SQLite schema carries a monotonic version and the durable session format has no compatibility promise before the first tagged release: an old binary against a new database is not a supported combination, and nothing will stop you from trying it.

The credential key is the one thing that must not be rolled back with everything else. Every envelope names the version it was sealed under, so a restore that puts back an older `CANDY_CREDENTIAL_KEY_VERSION` without keeping the newer key locks every tenant out of accounts configured since. Keep the retired key reachable until every envelope has been rewrapped.

-----

<a id="backup-and-restore"></a>
## Backup and restore

The control-plane database is the only thing that cannot be rebuilt. Back it up with SQLite's own online backup, which copies a live database page by page while the service keeps writing:

```sh
sudo -u candy node /opt/candy/packages/bundle/candy-app/deploy/candy-backup.mjs \
  /var/lib/candy/control-plane.db \
  "/var/backups/candy/control-plane-$(date -u +%Y%m%dT%H%M%SZ).db"
```

It needs nothing the service does not already have. The backend runs `node:sqlite`, so the Node that runs Candy performs the copy; the `sqlite3` command-line package is not installed by the steps above and is not required. The destination is written under a temporary name and renamed only once the copy finishes, so an interrupted backup leaves no file that looks complete, and the source is opened read-only, so a mistyped path is an error rather than a new empty database.

**Do not back up the database by copying the file.** The backend runs in WAL mode, so commits live in the `-wal` file beside the database until a checkpoint folds them in. A `cp` of `control-plane.db` alone is not a slightly stale backup — on a young database it is a file with no tables in it at all. The [rollback drill](../packages/bundle/candy-app/tests/rollback-drill.spec.ts) takes a backup while the control plane is writing, boots over the restore, and pins that difference.

Back up `/etc/candy` separately and to somewhere else: it holds the two keys, and a backup of the database without them is a backup of records nothing can open.

The runtime pools under `/var/lib/candy/pools` are provider CLI state — logins, caches, working files. They are recreated on demand, and a tenant whose pool is gone signs in to their provider again. Back them up if that re-login is expensive; nothing else depends on them.

-----

<a id="what-this-page-does-not-cover"></a>
## What this page does not cover

- **Resource dashboards and security alerting.** The audit trail is per-tenant, bounded, and readable through the store; nothing exports it to a metrics or alerting system yet.
- **A packaged install.** There is no `.deb`; `/opt/candy` is a checkout or an unpacked build, and the version you roll back to is one you kept.
- **Provider credential checks.** Nothing registers one, so the account page's check reports that no provider could be asked.
- **Multi-runtime scheduling.** Two runtimes over one control plane each need their own audience and pool base; nothing coordinates which of them a tenant's run lands on.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The three files under `deploy/` and this page make claims about the code — which variables exist, that writes need a forwarded `Origin`, that the unit confines the service. [`verify-candy-deployment`](../scripts/verify-candy-deployment.ts) is what keeps those claims true: it reads the variable names out of the patch and out of the composed plugins' own `credential-ref` defaults, and fails when the template, either README, the unit or the site disagrees.

</details>
