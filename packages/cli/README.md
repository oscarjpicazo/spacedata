# spacedata

Aggregated public space data — satellite orbits, catalogs and launches — as a single AI-friendly CLI.

One command vocabulary, always a single JSON document as output, with local caching and circuit breakers built in so heavy automated use (by humans or AI agents) never violates the upstream sources' usage policies. No API keys or accounts needed.

## Install

```bash
npm install -g spacedata
```

## Usage

```bash
spacedata tle 25544                                  # latest orbital elements for the ISS
spacedata sat search "ZARYA"                         # search the catalog by name
spacedata launches upcoming --limit 5                # next 5 orbital launches
spacedata launches upcoming --search starlink        # filter launches
spacedata --pretty tle 25544                         # human-readable JSON
spacedata --fresh tle 25544                          # bypass the local cache
```

```bash
spacedata sat catalog 25544                          # full SATCAT record: type, status, owner, launch, RCS
spacedata conjunctions --limit 20                    # upcoming close approaches (CelesTrak SOCRATES)
spacedata conjunctions --norad 25544                 # conjunctions involving one object
```

Two datasets only exist behind a free [Space-Track](https://www.space-track.org) account (set `SPACEDATA_SPACETRACK_IDENTITY` and `SPACEDATA_SPACETRACK_PASSWORD`):

```bash
spacedata sat history 25544 --limit 30               # orbital element history (orbit evolution/decay)
spacedata reentries --limit 10                       # re-entry predictions (TIP)
spacedata conjunctions --source spacetrack           # official public CDMs instead of SOCRATES
```

`tle`, `sat search` and `sat history` include derived geometry per element set: perigee/apogee altitude (km), period (minutes) and semi-major axis, computed from the mean elements.

## Using with AI agents

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

## Caching and rate limits

Responses are cached in `~/.cache/spacedata` (override with `--cache-dir` or `XDG_CACHE_HOME`): CelesTrak data for 2 h (its GP update cycle), Launch Library 2 for 1 h (free tier: 15 calls/hour per IP), Space-Track for 1 h (SATCAT: 24 h). On any non-200 response the source's circuit breaker opens and spacedata refuses to query it again until the cooldown expires, as the providers' usage policies require.

Space-Track additionally limits accounts to <30 requests/minute and 300/hour; spacedata tracks your request rate across invocations and fails fast with `RATE_LIMITED` (including a `retryAt`) before ever exceeding it, so heavy automated use cannot endanger your account.

## Environment variables

- `SPACEDATA_SPACETRACK_IDENTITY` / `SPACEDATA_SPACETRACK_PASSWORD` — your Space-Track credentials (free account, register at space-track.org). Unlock `sat catalog`, `sat history`, `conjunctions` and `reentries`.
- `SPACEDATA_LL2_TOKEN` — Launch Library 2 API token (Patreon tiers) for higher rate limits.
- `SPACEDATA_LL2_BASE_URL` — override the LL2 base URL, e.g. `https://lldev.thespacedevs.com/2.3.0` while developing.

## Data sources & credits

- Orbital data: [CelesTrak](https://celestrak.org) (Dr. T.S. Kelso)
- Launch data: [Launch Library 2](https://thespacedevs.com/llapi) by The Space Devs
- Catalog, conjunction and re-entry data: [Space-Track.org](https://www.space-track.org) (18th Space Defense Squadron, USSPACECOM)
