# spacedata

[![CI](https://github.com/oscarjpicazo/spacedata/actions/workflows/ci.yml/badge.svg)](https://github.com/oscarjpicazo/spacedata/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/spacedata)](https://www.npmjs.com/package/spacedata) [![license](https://img.shields.io/npm/l/spacedata)](LICENSE)

Aggregated public space data — satellite positions, passes, orbits, catalogs and launches — as a single AI-friendly CLI.

Instead of teaching an agent (or yourself) four different APIs, query languages and data formats, `spacedata` exposes one command vocabulary and always answers with a single JSON document. Caching and circuit breakers are built in so heavy automated use never violates the upstream sources' usage policies.

## Status

**v0.6** — CelesTrak (orbital elements, catalog search), Launch Library 2 (launches) and NOAA SWPC (space weather, aurora) with no account needed, plus Space-Track (SATCAT, element history, conjunctions, re-entry predictions) using your own free account. New in 0.6: **orbital events** — `sat events` detects maneuvers, storm-driven drag responses and decay anomalies in any object's element history (locally, with evidence and confidence per event), and `events` digests what happened in orbit: newly cataloged objects grouped by launch with fragmentation signals, confirmed decays, re-entries, past launches and geomagnetic storms (GFZ Kp). Planned next: ESA DISCOSweb (physical metadata) and a cross-source `sat info`.

## Usage

```bash
spacedata position 25544                             # where is the ISS right now (lat/lon/alt, sunlit?)
spacedata passes 25544 --lat 40.42 --lon -3.70       # when does the ISS pass over Madrid (next 3 days)
spacedata passes 25544 --lat 40.42 --lon -3.70 --visible-only   # only passes you can actually see
spacedata overhead --lat 40.42 --lon -3.70           # bright satellites above that spot right now
spacedata spaceweather                               # Kp + forecast, NOAA scales, solar wind, flare class
spacedata aurora --lat 64.13 --lon -21.90            # aurora probability over Reykjavik right now
spacedata tle 25544                                  # latest orbital elements for the ISS
spacedata sat search STARLINK-32000                  # search the catalog by name
spacedata launches upcoming --limit 5                # next 5 orbital launches
spacedata launches upcoming --search starlink        # filter launches
spacedata --pretty tle 25544                         # human-readable JSON
spacedata --fresh tle 25544                          # bypass the local cache
spacedata sat catalog 25544                          # full SATCAT record: type, status, owner, launch, RCS
spacedata conjunctions --limit 20                    # upcoming close approaches (CelesTrak SOCRATES)
```

`position`, `passes` and `overhead` are computed locally with SGP4 ([satellite.js](https://github.com/shashwatak/satellite-js)) from the latest CelesTrak elements — pass predictions include AOS/culmination/LOS times, azimuths, max elevation and whether each pass is *optically visible* (satellite sunlit while your sky is dark).

Some datasets only exist behind a free [Space-Track](https://www.space-track.org) account (set `SPACEDATA_SPACETRACK_IDENTITY` and `SPACEDATA_SPACETRACK_PASSWORD`):

```bash
spacedata sat history 25544 --limit 30               # orbital element history (orbit evolution/decay)
spacedata sat events 25544 --days 30                 # detected maneuvers, storm responses, decay anomalies
spacedata events --days 7                            # what happened in orbit: new objects, decays, storms
spacedata reentries --limit 10                       # re-entry predictions (TIP)
spacedata conjunctions --source spacetrack           # official public CDMs instead of SOCRATES
```

### Orbital events

`sat events` turns an object's raw element history into a timeline: impulsive maneuvers (orbit raise/lower, plane change) with estimated Δv, storm-driven drag responses and decay-rate anomalies. Detection runs locally — element jumps against the object's own noise floor (median/MAD), corroborated by SGP4 propagation residuals, and cross-checked against planetary Kp ([GFZ Potsdam](https://kp.gfz.de)) so a geomagnetic storm is not mistaken for a maneuver. These are **inferences from public mean elements, not telemetry**: every event carries its evidence (element deltas, z-score, residual, Kp) and a `confidence` level, so an agent can second-guess the verdict. Example — the ISS reboost of 2026-07-02 as detected from real data:

```json
{"type":"maneuver","subtype":"orbit-raise","confidence":"high",
 "window":{"from":"2026-07-01T12:11:46","to":"2026-07-04T02:07:57"},
 "evidence":{"deltaSemiMajorAxisKm":1.91,"zScore":83.4,"noiseFloorKm":0.01,
 "sgp4ResidualKm":622.6,"residualThresholdKm":9.7,"maxKp":5.667},
 "estimatedDvMs":1.081}
```

`events` is the catalog-wide digest ("what happened in orbit this week"): nothing in it is inferred — newly cataloged objects grouped by launch (a burst of new pieces from an *old* launch is flagged as a fragmentation signal), decay dates set, renames, re-entry predictions, past launches and geomagnetic storms.

### MCP server

`spacedata serve` runs the same data layer as an [MCP](https://modelcontextprotocol.io) server over stdio, for Claude Desktop, Claude Code, Cursor and any other MCP client. Fourteen tools: `get_orbit`, `search_satellites`, `get_satellite_catalog`, `get_satellite_position`, `get_satellite_passes`, `get_satellites_overhead`, `get_space_weather`, `get_aurora_forecast`, `get_conjunctions`, `get_upcoming_launches`, `get_orbit_history`, `get_satellite_events`, `get_orbital_events`, `get_reentries` — with the same caching and rate-limit protection as the CLI.

Claude Code:

```bash
claude mcp add spacedata -- npx -y spacedata serve
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "spacedata": {
      "command": "npx",
      "args": ["-y", "spacedata", "serve"]
    }
  }
}
```

To enable the Space-Track tools (`get_orbit_history`, `get_satellite_events`, `get_orbital_events`, `get_reentries` and CDM conjunctions), add `"env": {"SPACEDATA_SPACETRACK_IDENTITY": "...", "SPACEDATA_SPACETRACK_PASSWORD": "..."}` to the server entry.

Tip: if your agent can run shell commands (like Claude Code), the plain CLI is cheaper in context tokens than loading MCP tool schemas — `serve` shines in clients without a shell (Claude Desktop, claude.ai).

## Using with AI agents

`spacedata` is designed to be driven by AI agents: single JSON document per invocation, semantic exit codes, no interactive prompts, and built-in caching/rate limiting so an agent in a loop can never get you banned from an upstream source.

For Claude Code, add this to your `~/.claude/CLAUDE.md` (or a project `CLAUDE.md`); other agents (Cursor, etc.) have equivalent instruction files:

```markdown
- `spacedata` — CLI for public space data (no API keys needed). Use it via the shell
  for anything about satellites, orbits, passes, conjunctions, launches or orbital events:
  `spacedata position <norad-id>` (live location), `spacedata passes <norad-id> --lat .. --lon ..`
  (when it flies over, incl. visibility), `spacedata overhead --lat .. --lon ..` (what's above),
  `spacedata tle <norad-id>`, `spacedata sat search <name>`, `spacedata sat catalog <norad-id>`,
  `spacedata sat events <norad-id>` (detected maneuvers/anomalies, evidence included),
  `spacedata events` (what happened in orbit: new objects, decays, storms),
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
- **exit codes**: `0` ok · `1` usage error · `2` not found · `3` upstream/network error · `4` circuit open or rate limited · `5` unexpected upstream schema · `6` missing or rejected credentials · `7` computation failed

`tle` and `sat search` include derived geometry per object: perigee/apogee altitude (km), period (minutes) and semi-major axis, computed from the mean elements. Locally computed results (`position`, `passes`, `overhead`) report `source: "celestrak+sgp4"` plus the element epoch and age, and warn when element age degrades SGP4 accuracy.

### Caching and upstream policies

Responses are cached in `~/.cache/spacedata` (override with `--cache-dir` or `XDG_CACHE_HOME`):

| Source | TTL | Why |
|---|---|---|
| CelesTrak | 2 h | GP data updates every 2 h; policy asks for one download per cycle |
| Launch Library 2 | 1 h | Free tier allows 15 calls/hour per IP |
| NOAA SWPC | 5 min (real-time) / 30 min (forecasts) | Products refresh every 1-5 min; one cache per refresh cycle |
| Space-Track | 1 h | User agreement caps queries (<30/min, <300/h); GP guidance is at most hourly — also enforced by a persistent rate limiter |
| GFZ Kp | 3 h | Kp is issued in 3-hour bins; one cache per bin |

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
- Catalog, element history, CDMs and TIP data: [Space-Track](https://www.space-track.org) (18 SDS)
- Launch data: [Launch Library 2](https://thespacedevs.com/llapi) by The Space Devs
- Space weather and aurora data: [NOAA SWPC](https://www.swpc.noaa.gov)
- Planetary Kp index: [GFZ German Research Centre for Geosciences](https://kp.gfz.de) (CC BY 4.0)
- SGP4 propagation: [satellite.js](https://github.com/shashwatak/satellite-js)
