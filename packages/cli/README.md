# spacedata

Aggregated public space data — satellite orbits, catalogs and launches — as a single AI-friendly CLI.

One command vocabulary, always a single JSON document as output, with local caching and circuit breakers built in so heavy automated use (by humans or AI agents) never violates the upstream sources' usage policies. No API keys or accounts needed.

## Install

```bash
npm install -g spacedata-cli
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

`tle` and `sat search` include derived geometry per object: perigee/apogee altitude (km), period (minutes) and semi-major axis, computed from the mean elements.

## Output contract

Stable, designed for AI agents:

- **stdout**: one JSON document — `{ok: true, source, cached, fetchedAt, data}`
- **stderr**: one JSON document — `{ok: false, error: {code, message, ...}}`
- **exit codes**: `0` ok · `1` usage error · `2` not found · `3` upstream/network error · `4` circuit open (source in cooldown) · `5` unexpected upstream schema

## Caching

Responses are cached in `~/.cache/spacedata` (override with `--cache-dir` or `XDG_CACHE_HOME`): CelesTrak data for 2 h (its GP update cycle), Launch Library 2 for 1 h (free tier: 15 calls/hour per IP). On any non-200 response the source's circuit breaker opens and spacedata refuses to query it again until the cooldown expires, as the providers' usage policies require.

## Environment variables

- `SPACEDATA_LL2_TOKEN` — Launch Library 2 API token (Patreon tiers) for higher rate limits.
- `SPACEDATA_LL2_BASE_URL` — override the LL2 base URL, e.g. `https://lldev.thespacedevs.com/2.3.0` while developing.

## Data sources & credits

- Orbital data: [CelesTrak](https://celestrak.org) (Dr. T.S. Kelso)
- Launch data: [Launch Library 2](https://thespacedevs.com/llapi) by The Space Devs
