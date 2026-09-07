# Agent Note: A home that nothing had to obey

Status: implemented

English | [中文](2026-09-05-a-home-that-nothing-had-to-obey.zh.md)

## Problem

Two tenants running the same provider must not share a writable home or cached private content. Candy separates them by giving each Claude CLI child its own `HOME`, pointed at that tenant's runtime pool root.

That separation is indirect. It holds because the CLI's configuration, caches and account state are located relative to `HOME` — not because anything checks where the child actually writes. A variable that names one of those directories outright breaks the derivation without touching `HOME`.

A probe built the environment a child receives, through the real `dsh-subprocess` merge, with an operator's variables present in the parent:

`PROBE-ENV {"HOME":"/pools/tenant-a","CLAUDE_CONFIG_DIR":"/srv/operator/.claude","XDG_CONFIG_HOME":"/srv/operator/.config"}`

`HOME` is the tenant's. `CLAUDE_CONFIG_DIR`, whose whole purpose is to relocate the CLI's configuration and account state away from `HOME`, is the operator's — and every tenant's child gets the same one. The seam's parent scrub drops credential-shaped and `DSH_*` names, and this is neither; the launch overlay tombstoned provider-routing variables, and this is not one of those either.

## Decision

`SCRUBBED_STATE_VARIABLES` names the variables that redirect a child's state out of its home, and `claudeCliEnvironment` tombstones them beside the routing list: `CLAUDE_CONFIG_DIR`, the four XDG base directories, and `ANTHROPIC_CONFIG_DIR`, which was sitting in the routing list under a name that did not describe it.

The list covers the standard state-directory variables rather than only those a particular CLI version is known to read. The two mistakes are not symmetric. A tombstoned name the CLI ignores changes nothing: with the variable absent the child falls back to the location under the pinned `HOME`, which is the one that was wanted. A name left off the list is a directory two tenants share.

## Consequences

The pinned home is now the only place the child is told to keep state, so pool isolation depends on the pool root rather than on the deployment's environment hygiene.

The negative control — restoring the single-list loop — fails exactly three tests: the two unit assertions and the composed-Loader assertion that the spawn spec carries the tombstone. Removal itself is the subprocess seam's contract, covered there by a real spawn.

`SCRUBBED_ROUTING_VARIABLES` now holds only routing and authentication names, so its documentation is true of its contents.

## Alternatives considered

**An allowlist for the child environment.** Naming the few variables a CLI child may inherit closes this class rather than one member of it. It belongs at the `dsh-subprocess` seam, where `scrubbedParentEnv` is defined for every spawner in the repository, and changing that base would change bash, pwsh and language-server children too — a decision with its own evidence to gather.

**Clearing `HOME`-adjacent variables in the binding.** `dsh-claude-cli-binding` knows the pool root and could scrub there. The knowledge of which variables this CLI reads belongs with the rest of that protocol, in `dsh-claude-cli-protocol`, beside the flags and the routing list.

**Leaving it to deployment.** Documenting that a Candy server must not inherit `CLAUDE_CONFIG_DIR` makes tenant isolation depend on a launch script. The variable is most likely to be set exactly where this runtime is most likely to be developed and run.
