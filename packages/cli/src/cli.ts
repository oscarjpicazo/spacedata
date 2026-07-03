#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import type { Result } from "neverthrow";
import packageJson from "../package.json";
import { defaultCacheDir, FileCache } from "./core/file-cache";
import { emit, fail } from "./core/output";
import type { SourceResult } from "./core/source-fetch";
import type { SpaceDataError } from "./errors/spacedata-error";
import { fetchByCatalogNumber, searchByName } from "./sources/celestrak.source";
import { fetchUpcomingLaunches } from "./sources/launch-library.source";

interface GlobalOptions {
	pretty: boolean;
	fresh: boolean;
	cacheDir: string;
}

const program = new Command();

program
	.name("spacedata")
	.description(
		"Aggregated public space data (satellite orbits, catalogs, launches) as an AI-friendly CLI.\n" +
			"Output is always a single JSON document: {ok, source, cached, fetchedAt, data} on stdout,\n" +
			"{ok: false, error: {code, message}} on stderr. Results are cached locally to respect each\n" +
			"upstream source's usage policy; use --fresh only when stale data is unacceptable.",
	)
	.version(packageJson.version)
	.option("--pretty", "pretty-print the JSON output", false)
	.option(
		"--fresh",
		"bypass the local cache and fetch from the upstream source",
		false,
	)
	.option(
		"--cache-dir <dir>",
		"directory for the local cache",
		defaultCacheDir(),
	);

program
	.command("tle")
	.description(
		"Latest orbital elements (GP/OMM) for one object by NORAD catalog id, " +
			"with derived perigee/apogee altitude (km), period (min) and semi-major axis. " +
			"Source: CelesTrak (no API key needed). Example: spacedata tle 25544",
	)
	.argument(
		"<norad-id>",
		"NORAD catalog id (e.g. 25544 for the ISS)",
		parseNoradId,
	)
	.action(async (noradId: number, _options: unknown, command: Command) => {
		const globals = command.optsWithGlobals<GlobalOptions>();
		const result = await fetchByCatalogNumber(noradId, sourceOptions(globals));
		finish(result, globals.pretty);
	});

const sat = program.command("sat").description("Satellite catalog queries");

sat
	.command("search")
	.description(
		"Search objects by name in the CelesTrak GP catalog. Returns every match with its " +
			"orbital elements and derived orbit geometry. Example: spacedata sat search STARLINK-32000",
	)
	.argument("<query>", "object name or name fragment (case-insensitive)")
	.action(async (query: string, _options: unknown, command: Command) => {
		const globals = command.optsWithGlobals<GlobalOptions>();
		const result = await searchByName(query, sourceOptions(globals));
		finish(result, globals.pretty);
	});

const launches = program
	.command("launches")
	.description("Orbital launch data (Launch Library 2)");

launches
	.command("upcoming")
	.description(
		"Upcoming orbital launches with status, provider, rocket, pad and mission. " +
			"Source: Launch Library 2 (free tier: 15 calls/hour per IP; responses are cached 1h). " +
			"Example: spacedata launches upcoming --limit 5 --search starlink",
	)
	.option(
		"--limit <n>",
		"maximum number of launches to return (1-100)",
		parseLimit,
		10,
	)
	.option(
		"--search <text>",
		"filter by launch, rocket, mission or provider name",
	)
	.action(
		async (options: { limit: number; search?: string }, command: Command) => {
			const globals = command.optsWithGlobals<GlobalOptions>();
			const result = await fetchUpcomingLaunches({
				cache: new FileCache(globals.cacheDir),
				fresh: globals.fresh,
				limit: options.limit,
				search: options.search,
			});
			finish(result, globals.pretty);
		},
	);

function sourceOptions(globals: GlobalOptions): {
	cache: FileCache;
	fresh: boolean;
} {
	return { cache: new FileCache(globals.cacheDir), fresh: globals.fresh };
}

function finish<T>(
	result: Result<SourceResult<T>, SpaceDataError>,
	pretty: boolean,
): void {
	result.match(
		(value) => emit(value, pretty),
		(error) => fail(error, pretty),
	);
}

function parseNoradId(raw: string): number {
	const value = Number.parseInt(raw, 10);
	if (Number.isNaN(value) || value <= 0 || String(value) !== raw.trim()) {
		throw new InvalidArgumentError(
			"must be a positive integer NORAD catalog id (e.g. 25544)",
		);
	}
	return value;
}

function parseLimit(raw: string): number {
	const value = Number.parseInt(raw, 10);
	if (Number.isNaN(value) || value < 1 || value > 100) {
		throw new InvalidArgumentError("must be an integer between 1 and 100");
	}
	return value;
}

program.parseAsync();
