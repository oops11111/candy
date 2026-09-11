# Agent Note: A caller with no session

Status: implemented

English | [中文](2026-09-10-a-caller-with-no-session.zh.md)

## Problem

`dsh-device-registry` could pair a host, and nothing could reach it. Every Candy management route goes through one envelope whose whole guarantee is that identity comes from a session cookie the store authenticated, and a Harness Host exchanging a pairing code has no cookie, no browser, and no prior identity of any kind. The code in its body is the whole of its claim.

Two ways out were both wrong. Loosening `registerApiRoute` to accept some other proof would weaken the sentence the envelope exists to make — that an `Actor` means an authenticated session — for every route at once, to admit one. Registering the exchange directly on the web server would duplicate the origin check, the bounded body read, the JSON parse, the reply headers and the failure vocabulary, and would put the one route nobody signs in for on the least reviewed transport in the deployment.

A third problem surfaced while building it. The envelope answered a failing handler with `500` and then rethrew, and the Harness Host web server destroys a response whose handler rejects after its headers are sent. The caller therefore received a socket hang-up rather than the status the envelope had just decided. The session routes hid it: two awaits between the reply and the throw were usually enough for the body to flush, so the defect showed up only when a route without those awaits was added.

## Decision

The envelope gains a second registration rather than a looser first one.

`registerAnonymousRoute` shares the transport — the addressed host, the method, the bounded body, the reply headers, the failure vocabulary — and hands the handler no `Actor` at all, only the body and the request. There is no constructor for an `Actor` that a credential can reach, so the guarantee about sessions is unchanged; a route registered this way derives whatever identity its own credential proves, and the type system stops it from pretending that identity is a session.

Its origin check is by `Host` alone. `Origin` is what separates this deployment's page from a page that merely knows the URL, and it matters because a browser attaches the session cookie by itself. There is no cookie here and the caller is not a browser: requiring the header would refuse every real client, and a page that forges this request must already hold the code and cannot read the reply.

Nothing is filed against a tenant by the envelope for such a route, because it has none to file against. The device exchange records its own success once the code resolves to a tenant, and a refused exchange reaches the deployment's log alone — an unknown code names nobody, and a trail that took a record per guess would be floodable by whoever guessed.

`dsh-device-api` mounts the three tenant operations and the exchange. The pairing code is sixteen glyphs of five bits from a thirty-two glyph alphabet with no `I`, `L`, `O` or `U`. Eighty bits is fixed rather than configured: the code is a bearer credential presented over the public internet with no rate limit between a guess and an attempt, and that is what makes guessing one within its lifetime impossible rather than slow. The alphabet's size divides 256, so masking a random byte picks a glyph without the bias a remainder against 26 or 36 would introduce. The device id and the token are minted on the server for the reason the account API mints an account id: a host that chose its own could name another tenant's device and overwrite the record binding it.

The rethrow is gone from both registrations. The error goes to a new `ApiHost.report`, so the deployment still reads what failed while the caller receives the answer the envelope decided. That member is required: a mounting plugin that omitted it would turn every handler failure into a `500` nobody can explain, which is worse than the hang-up the rethrow caused.

## Consequences

A tenant can now bring a machine into their deployment, and take it out again. Pairing exists end to end: a code issued from a browser session, carried by a person, exchanged once by a host that had no identity, producing a device bound to that tenant and a token only that host holds.

Every route on the envelope now answers a failing handler rather than hanging up on it. That is a behaviour change for the account and audit APIs as much as this one, and it is the behaviour their tests already asserted — they passed before only because two awaits happened to intervene.

Nothing consumes the device token yet. A host holds it and no route accepts it, because what a paired host does next — reach the Remote Gateway, run a tool, resolve a workspace root — is inherited Harness behaviour that R5 still has to bind to a device. Admission resolves the device: `admitDevice` runs as its own stage, so a revoked device loses its runs immediately.

Two costs are worth naming. A tenant can issue codes and pair devices without limit, exactly as they can create provider accounts, and nothing sweeps a spent code off the medium. Both are bounded by an authenticated member's own restraint until something bounds a tenant's footprint generally.

## Alternatives considered

**Add an `authenticate` hook to `ApiRoute`.** Rejected. It reads as a generalization and is a weakening: every route would then be one config line away from accepting something other than a session, and the invariant would live in whichever handler was written last rather than in the type.

**Require `Origin` on the exchange too.** Rejected because no HTTP client that is not a browser sends one, and the header protects against a cookie the browser attaches by itself — which this route has not got.

**Rate-limit the exchange instead of lengthening the code.** Rejected as the primary defence. A limiter is state to hold, share across processes, and get wrong; eighty bits needs none of that and does not degrade when a second runtime is added. A limiter in front of the deployment remains useful and is the reverse proxy's, as it is for every other route.

**Let the host choose its device id, so a re-pair keeps the same one.** Rejected: an id a caller chooses can name another tenant's device, and the record it would overwrite is the binding itself.

**Keep the rethrow and let the web server log it.** Rejected once it was measured. The server logs the error and then destroys the response, so the caller loses the `500` — a hang-up it cannot tell from a crash, for a request the envelope answered correctly.

## Verification

`packages/control-plane/device-api/tests/loader-composition.spec.ts` boots the storage stack, the durable control plane, the real Harness Host web server and this plugin through the Loader, and every case is an HTTP request against the listening port. It covers pairing end to end, the code and token appearing exactly once, the minted code's shape and a host spelling it differently, one code exchanged once, an unknown and an expired code, a body that tries to name a tenant or a device id, revocation and another tenant's `404`, every managed route without a session, a request addressed to another authority, malformed submissions, the audit trail, an audit sink that rejects, a medium that throws, and route removal with the fiber — at 100% of the package.

`packages/control-plane/control-plane-api/tests/control-plane-api.spec.ts` adds nine cases for the second registration and the failure path, reaching 100% of the envelope. `packages/bundle/candy-app/tests/loader-composition.spec.ts` proves the shipped layer mounts all four routes on the configured origin.

Four mutation controls establish that the cases decide something: accepting a device id from the body, taking the tenant from the body, revoking against the record's own tenant instead of the session's, and restoring the rethrow each fail a case before the implementation is restored.
