# spacecli

Aggregated public space data — satellite orbits, catalogs and launches — as a single AI-friendly CLI.

Instead of teaching an agent (or yourself) four different APIs, query languages and data formats, `spacecli` exposes one command vocabulary and always answers with a single JSON document. Caching and circuit breakers are built in so heavy automated use never violates the upstream sources' usage policies.

## Status

**v0.1 (MVP)** — CelesTrak (orbital elements, catalog search) and Launch Library 2 (upcoming launches). No API keys or accounts needed. Planned next: Space-Track (conjunctions, re-entries, historical catalog) and ESA DISCOSweb (physical metadata) using the user's own credentials.

## Usage

```bash
spacecli tle 25544                                  # latest orbital elements for the ISS
spacecli sat search STARLINK-32000                  # search the catalog by name
spacecli launches upcoming --limit 5                # next 5 orbital launches
spacecli launches upcoming --search starlink        # filter launches
spacecli --pretty tle 25544                         # human-readable JSON
spacecli --fresh tle 25544                          # bypass the local cache
```

### Output contract

Stable, designed for AI agents:

- **stdout**: one JSON document — `{ok: true, source, cached, fetchedAt, data}`
- **stderr**: one JSON document — `{ok: false, error: {code, message, ...}}`
- **exit codes**: `0` ok · `1` usage error · `2` not found · `3` upstream/network error · `4` circuit open (source in cooldown) · `5` unexpected upstream schema

`tle` and `sat search` include derived geometry per object: perigee/apogee altitude (km), period (minutes) and semi-major axis, computed from the mean elements.

### Caching and upstream policies

Responses are cached in `~/.cache/spacecli` (override with `--cache-dir` or `XDG_CACHE_HOME`):

| Source | TTL | Why |
|---|---|---|
| CelesTrak | 2 h | GP data updates every 2 h; policy asks for one download per cycle |
| Launch Library 2 | 1 h | Free tier allows 15 calls/hour per IP |

On any non-200 response the source's circuit breaker opens and `spacecli` refuses to query it again until the cooldown expires (CelesTrak's M2M policy requires stopping immediately on errors; ignoring it gets your IP firewalled).

### Environment variables

- `SPACECLI_LL2_TOKEN` — Launch Library 2 API token (Patreon tiers) for higher rate limits.
- `SPACECLI_LL2_BASE_URL` — override the LL2 base URL, e.g. `https://lldev.thespacedevs.com/2.3.0` (no rate limits, stale data) while developing.

## Development

Bun monorepo (`packages/*`), TypeScript, Biome, Zod for all external data, neverthrow for results.

```bash
make setup     # install deps
make build     # typecheck + bundle to packages/cli/dist
make test      # bun test
make check     # biome lint
```

Run from source without building:

```bash
cd packages/cli && bun src/cli.ts tle 25544
```

## Data sources & credits

- Orbital data: [CelesTrak](https://celestrak.org) (Dr. T.S. Kelso)
- Launch data: [Launch Library 2](https://thespacedevs.com/llapi) by The Space Devs
