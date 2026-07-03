# spacedata

[![CI](https://github.com/oscarjpicazo/spacedata/actions/workflows/ci.yml/badge.svg)](https://github.com/oscarjpicazo/spacedata/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/spacedata)](https://www.npmjs.com/package/spacedata) [![license](https://img.shields.io/npm/l/spacedata)](LICENSE)

Aggregated public space data — satellite orbits, catalogs and launches — as a single AI-friendly CLI.

Instead of teaching an agent (or yourself) four different APIs, query languages and data formats, `spacedata` exposes one command vocabulary and always answers with a single JSON document. Caching and circuit breakers are built in so heavy automated use never violates the upstream sources' usage policies.

## Status

**v0.2** — CelesTrak (orbital elements, catalog search) and Launch Library 2 (upcoming launches) with no account needed, plus Space-Track (SATCAT, element history, conjunctions, re-entry predictions) using your own free account. Planned next: ESA DISCOSweb (physical metadata) and a cross-source `sat info`.

## Usage

```bash
spacedata tle 25544                                  # latest orbital elements for the ISS
spacedata sat search STARLINK-32000                  # search the catalog by name
spacedata launches upcoming --limit 5                # next 5 orbital launches
spacedata launches upcoming --search starlink        # filter launches
spacedata --pretty tle 25544                         # human-readable JSON
spacedata --fresh tle 25544                          # bypass the local cache
spacedata sat catalog 25544                          # full SATCAT record: type, status, owner, launch, RCS
spacedata conjunctions --limit 20                    # upcoming close approaches (CelesTrak SOCRATES)
```

Two datasets only exist behind a free [Space-Track](https://www.space-track.org) account (set `SPACEDATA_SPACETRACK_IDENTITY` and `SPACEDATA_SPACETRACK_PASSWORD`):

```bash
spacedata sat history 25544 --limit 30               # orbital element history (orbit evolution/decay)
spacedata reentries --limit 10                       # re-entry predictions (TIP)
spacedata conjunctions --source spacetrack           # official public CDMs instead of SOCRATES
```

### Using with AI agents

`spacedata` is designed to be driven by AI agents: single JSON document per invocation, semantic exit codes, no interactive prompts, and built-in caching/rate limiting so an agent in a loop can never get you banned from an upstream source.

For Claude Code, add this to your `~/.claude/CLAUDE.md` (or a project `CLAUDE.md`); other agents (Cursor, etc.) have equivalent instruction files:

```markdown
- `spacedata` — CLI for public space data (no API keys needed). Use it via the shell
  for anything about satellites, orbits, conjunctions or launches:
  `spacedata tle <norad-id>`, `spacedata sat search <name>`, `spacedata sat catalog <norad-id>`,
  `spacedata conjunctions [--norad id]`, `spacedata launches upcoming [--search text]`.
  Always outputs one JSON document; exit 2 = not found. Run `spacedata --help` for details.
```

Example output (`spacedata tle 25544`):

```json
{"ok":true,"source":"celestrak","cached":false,"fetchedAt":"2026-07-03T14:20:17.278Z",
 "data":[{"noradId":25544,"name":"ISS (ZARYA)","internationalDesignator":"1998-067A",
 "epoch":"2026-07-01T12:11:46.289760","meanMotionRevPerDay":15.49503254,
 "eccentricity":0.00042241,"inclinationDeg":51.6311,
 "derived":{"semiMajorAxisKm":6796.315,"perigeeAltitudeKm":415.307,
 "apogeeAltitudeKm":421.049,"periodMinutes":92.933}}]}
```

## Output contract

Stable, designed for AI agents:

- **stdout**: one JSON document — `{ok: true, source, cached, fetchedAt, data}`
- **stderr**: one JSON document — `{ok: false, error: {code, message, ...}}`
- **exit codes**: `0` ok · `1` usage error · `2` not found · `3` upstream/network error · `4` circuit open or rate limited · `5` unexpected upstream schema · `6` missing or rejected credentials

`tle` and `sat search` include derived geometry per object: perigee/apogee altitude (km), period (minutes) and semi-major axis, computed from the mean elements.

### Caching and upstream policies

Responses are cached in `~/.cache/spacedata` (override with `--cache-dir` or `XDG_CACHE_HOME`):

| Source | TTL | Why |
|---|---|---|
| CelesTrak | 2 h | GP data updates every 2 h; policy asks for one download per cycle |
| Launch Library 2 | 1 h | Free tier allows 15 calls/hour per IP |

On any non-200 response the source's circuit breaker opens and `spacedata` refuses to query it again until the cooldown expires (CelesTrak's M2M policy requires stopping immediately on errors; ignoring it gets your IP firewalled).

### Environment variables

- `SPACEDATA_LL2_TOKEN` — Launch Library 2 API token (Patreon tiers) for higher rate limits.
- `SPACEDATA_LL2_BASE_URL` — override the LL2 base URL, e.g. `https://lldev.thespacedevs.com/2.3.0` (no rate limits, stale data) while developing.

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
