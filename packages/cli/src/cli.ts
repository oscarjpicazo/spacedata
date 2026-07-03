#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import type { Result } from "neverthrow";
import packageJson from "../package.json";
import { defaultCacheDir, FileCache } from "./core/file-cache";
import { emit, fail } from "./core/output";
import type { SourceResult } from "./core/source-fetch";
import type { SpaceDataError } from "./errors/spacedata-error";
import {
	fetchByCatalogNumber,
	fetchCatalogRecord,
	searchByName,
} from "./sources/celestrak.source";
import { fetchUpcomingLaunches } from "./sources/launch-library.source";
import { fetchSocratesConjunctions } from "./sources/socrates.source";
import {
	fetchConjunctions,
	fetchElsetHistory,
	fetchReentries,
} from "./sources/spacetrack.source";

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
	)
	.addHelpText(
		"after",
		`
Examples:
  spacedata tle 25544                         orbital elements + perigee/apogee/period (ISS)
  spacedata sat search "ZARYA"                find objects by name
  spacedata sat catalog 25544                 catalog record: type, status, owner, launch, RCS
  spacedata conjunctions --limit 10           closest upcoming approaches (public SOCRATES data)
  spacedata launches upcoming --search ariane upcoming launches, filtered
  spacedata --pretty tle 25544                human-readable JSON

Only 'sat history', 'reentries' and 'conjunctions --source spacetrack' need a free
Space-Track account (SPACEDATA_SPACETRACK_IDENTITY / SPACEDATA_SPACETRACK_PASSWORD);
everything else works with no account or API key.

Exit codes: 0 ok · 1 usage · 2 not found · 3 upstream/network · 4 cooldown/rate limit ·
5 unexpected upstream schema · 6 missing/rejected credentials`,
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

sat
	.command("catalog")
	.description(
		"Full catalog record (SATCAT) for one object: type, operational status, owner, " +
			"launch date/site, decay date, orbit summary and radar cross-section. " +
			"Source: CelesTrak (no account needed). Example: spacedata sat catalog 25544",
	)
	.argument("<norad-id>", "NORAD catalog id", parseNoradId)
	.action(async (noradId: number, _options: unknown, command: Command) => {
		const globals = command.optsWithGlobals<GlobalOptions>();
		const result = await fetchCatalogRecord(noradId, sourceOptions(globals));
		finish(result, globals.pretty);
	});

sat
	.command("history")
	.description(
		"Historical orbital element sets for one object (most recent first), each with " +
			"derived perigee/apogee/period — shows orbit evolution and decay over time. " +
			"Source: Space-Track (account required). Example: spacedata sat history 25544 --limit 30",
	)
	.argument("<norad-id>", "NORAD catalog id", parseNoradId)
	.option(
		"--limit <n>",
		"number of element sets to return (1-100)",
		parseLimit,
		20,
	)
	.action(
		async (noradId: number, options: { limit: number }, command: Command) => {
			const globals = command.optsWithGlobals<GlobalOptions>();
			const result = await fetchElsetHistory(
				noradId,
				options.limit,
				sourceOptions(globals),
			);
			finish(result, globals.pretty);
		},
	);

program
	.command("conjunctions")
	.description(
		"Upcoming close approaches between cataloged objects, with miss distance and " +
			"collision probability, sorted by highest probability. Default source: CelesTrak " +
			"SOCRATES (no account needed, refreshed 3x/day). Use --source spacetrack for " +
			"official public CDMs (requires a free Space-Track account). " +
			"Example: spacedata conjunctions --limit 20",
	)
	.option(
		"--limit <n>",
		"maximum number of conjunctions (1-100)",
		parseLimit,
		20,
	)
	.option(
		"--norad <id>",
		"only conjunctions involving this NORAD catalog id",
		parseNoradId,
	)
	.option(
		"--source <name>",
		"data source: 'socrates' (public) or 'spacetrack' (CDMs, account required)",
		"socrates",
	)
	.action(
		async (
			options: { limit: number; norad?: number; source: string },
			command: Command,
		) => {
			const globals = command.optsWithGlobals<GlobalOptions>();
			if (options.source === "spacetrack") {
				const result = await fetchConjunctions(
					options.limit,
					options.norad,
					sourceOptions(globals),
				);
				finish(result, globals.pretty);
				return;
			}
			const result = await fetchSocratesConjunctions({
				...sourceOptions(globals),
				limit: options.limit,
				noradId: options.norad,
			});
			finish(result, globals.pretty);
		},
	);

program
	.command("reentries")
	.description(
		"Latest atmospheric re-entry predictions (TIP messages): predicted decay epoch, " +
			"uncertainty window and last predicted location. " +
			"Source: Space-Track (account required). Example: spacedata reentries --limit 10",
	)
	.option(
		"--limit <n>",
		"maximum number of predictions (1-100)",
		parseLimit,
		10,
	)
	.action(async (options: { limit: number }, command: Command) => {
		const globals = command.optsWithGlobals<GlobalOptions>();
		const result = await fetchReentries(options.limit, sourceOptions(globals));
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
