# spacedata

## General

- `AGENTS.md` is the source of truth. All `CLAUDE.md` files are references to it — make changes here, not in `CLAUDE.md`.
- Never add `Co-Authored-By` in commits or PR bodies.

## Architecture

Bun monorepo (`packages/*`). One package for now:

| Package | What it does | Stack |
|---------|-------------|-------|
| `cli` | The `spacedata` command | TypeScript, commander, Zod, neverthrow, satellite.js (SGP4) |

The MCP server lives inside the cli package (`spacedata serve`, `src/mcp/mcp-server.ts`): a lean 14-tool surface over stdio that reuses the source layer verbatim. Tool results carry the same `{ok, source, cached, fetchedAt, data}` / `{ok: false, error}` envelopes as the CLI; new sources should be exposed in both surfaces. In serve mode stdout belongs to the MCP transport — never write anything else to it.

Locally computed results (SGP4 position/passes/overhead) are layered: pure math in `src/domain/propagation.ts` (no I/O, like `derive.ts`), fetch+compute orchestration in `src/compute/`, reusing the CelesTrak source. Their envelope uses `source: "celestrak+sgp4"`; `cached`/`fetchedAt` describe the underlying element fetch.

Aggregated reports (`spaceweather`, `aurora`, `events`) fetch several products in parallel; only the core product's failure fails the command — every other section degrades to `undefined` plus an entry in `data.warnings`. Their envelope (`src/core/aggregate.ts`) reports `cached: true` only when every contributing fetch was cached, and the most recent `fetchedAt`.

Orbital events combine both patterns. `sat events` (`compute/satellite-events.compute.ts`, envelope `spacetrack+gfz+analysis`): detectors are pure math in `domain/events.ts` — element jumps against the object's own median/MAD noise floor (drag-detrended, gap-aware), SGP4 propagation residuals (`propagationResidualKm` in `domain/propagation.ts`) as corroboration, planetary Kp (GFZ, `sources/gfz.source.ts`) to separate storms from maneuvers. Events are **inferences**: they must always carry `evidence` and `confidence`, never a bare verdict, and thresholds/heuristics live as named constants with comments. `events` (`compute/orbital-events.compute.ts`, envelope `spacetrack+launch-library+gfz`) is the administrative digest — satcat_debut/satcat_change/TIP/LL2 previous, nothing inferred; grouping/classification helpers are pure in `domain/catalog-events.ts`. `domain/iss-history.fixture.ts` is real ISS gp_history (30 days around the 2026-07-02 reboost) and is the detector's ground-truth regression fixture — extend it, don't replace it, when recalibrating.

Linting: Biome. Results: `neverthrow`. Prefer `undefined` over `null` to represent absence/empty state.

## Product invariants (CRITICAL)

- **Output contract is stable — agents depend on it.** stdout: one JSON document `{ok: true, source, cached, fetchedAt, data}`. stderr: `{ok: false, error: {code, message}}`. Exit codes: 0 ok, 1 usage, 2 not found, 3 upstream/network, 4 circuit open or rate limited, 5 upstream schema, 6 missing/rejected credentials, 7 computation failed (e.g. SGP4 on decayed/invalid elements). Never print anything else to stdout, never add interactive prompts.
- **Every upstream source goes through `sourceFetch`** (`packages/cli/src/core/source-fetch.ts`): cache → circuit breaker → rate limit → HTTP → Zod validation → cache write. New sources must declare a TTL and breaker cooldown derived from the provider's documented usage policy, with a comment citing that policy.
- **Never embed credentials.** Sources that need auth (Space-Track today via `SPACEDATA_SPACETRACK_IDENTITY`/`_PASSWORD`, DISCOSweb next) take the user's own credentials via env vars. Credentials must never reach the cache: authenticated sources set an explicit `cacheKey` that identifies the query only (see `spacetrack.source.ts`).
- **Window queries must have stable cache keys.** When a window bound is computed client-side (GFZ start/end, LL2 `net__gte`), round it (hour / 3h bin) so the URL — and with it the cache key — stays constant for a whole TTL; a raw `Date.now()` in a URL defeats the cache entirely. Space-Track windows use the server-evaluated `>now-N` literal, which is stable by construction.
- **Space-Track serializes all JSON values as strings.** Its schemas convert string→number explicitly at the boundary (`spacetrack.schema.ts` helpers); never `z.coerce` there — null would silently become 0.

## External data validation (CRITICAL)

**Every piece of data that enters the system from outside must be validated with Zod (`safeParse`) before use.** Never use `as` type assertions or trust the shape of external data — define a Zod schema in `packages/cli/src/domain/` and validate first.

## Conventions

- **Type intentionality**: every `| undefined` must reflect a real reason (an upstream field that can be absent), never a workaround. Convert upstream `null` to `undefined` explicitly at the source boundary.
- **Errors**: throw/return classes extending `SpaceDataError` (`packages/cli/src/errors/spacedata-error.ts`), each with a stable `code` and `exitCode`. Never `new Error(...)`.
- **File naming**: kebab-case with dot notation for the type: `celestrak.source.ts`, `omm.schema.ts`, `file-cache.ts`.
- **Testing**: every change ships with its tests (`bun test`). Sources are tested by mocking `globalThis.fetch`; cover the happy path, cache hit, not-found, breaker open and schema mismatch for every source.

## Key commands

```bash
make setup / build / test / check / check.fix    # root, runs across packages
cd packages/cli && bun src/cli.ts tle 25544      # run from source
cd packages/cli && bun test                      # package tests
```
