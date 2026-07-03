# spacecli

## General

- `AGENTS.md` is the source of truth. All `CLAUDE.md` files are references to it — make changes here, not in `CLAUDE.md`.
- Never add `Co-Authored-By` in commits or PR bodies.

## Architecture

Bun monorepo (`packages/*`). One package for now:

| Package | What it does | Stack |
|---------|-------------|-------|
| `cli` | The `spacecli` command | TypeScript, commander, Zod, neverthrow |

Planned packages: `mcp` (MCP server reusing the cli's source layer).

Linting: Biome. Results: `neverthrow`. Prefer `undefined` over `null` to represent absence/empty state.

## Product invariants (CRITICAL)

- **Output contract is stable — agents depend on it.** stdout: one JSON document `{ok: true, source, cached, fetchedAt, data}`. stderr: `{ok: false, error: {code, message}}`. Exit codes: 0 ok, 1 usage, 2 not found, 3 upstream/network, 4 circuit open, 5 upstream schema. Never print anything else to stdout, never add interactive prompts.
- **Every upstream source goes through `sourceFetch`** (`packages/cli/src/core/source-fetch.ts`): circuit breaker → cache → HTTP → Zod validation → cache write. New sources must declare a TTL and breaker cooldown derived from the provider's documented usage policy, with a comment citing that policy.
- **Never embed credentials.** Sources that need auth (future Space-Track, DISCOSweb) take the user's own credentials via env vars.

## External data validation (CRITICAL)

**Every piece of data that enters the system from outside must be validated with Zod (`safeParse`) before use.** Never use `as` type assertions or trust the shape of external data — define a Zod schema in `packages/cli/src/domain/` and validate first.

## Conventions

- **Type intentionality**: every `| undefined` must reflect a real reason (an upstream field that can be absent), never a workaround. Convert upstream `null` to `undefined` explicitly at the source boundary.
- **Errors**: throw/return classes extending `SpaceCliError` (`packages/cli/src/errors/space-cli-error.ts`), each with a stable `code` and `exitCode`. Never `new Error(...)`.
- **File naming**: kebab-case with dot notation for the type: `celestrak.source.ts`, `omm.schema.ts`, `file-cache.ts`.
- **Testing**: every change ships with its tests (`bun test`). Sources are tested by mocking `globalThis.fetch`; cover the happy path, cache hit, not-found, breaker open and schema mismatch for every source.

## Key commands

```bash
make setup / build / test / check / check.fix    # root, runs across packages
cd packages/cli && bun src/cli.ts tle 25544      # run from source
cd packages/cli && bun test                      # package tests
```
