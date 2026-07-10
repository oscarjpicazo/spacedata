#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import type { Result } from "neverthrow";
import packageJson from "../package.json";
import {
	computeOverhead,
	computePasses,
	computePosition,
} from "./compute/propagation.compute";
import { defaultCacheDir, FileCache } from "./core/file-cache";
import { emit, fail } from "./core/output";
import type { SourceResult } from "./core/source-fetch";
import { type Observer, parseInstant } from "./domain/propagation";
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
		"Aggregated public space data (satellite orbits, positions, passes, catalogs, launches) as an AI-friendly CLI.\n" +
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
  spacedata position 25544                    where is the ISS right now (SGP4-propagated)
  spacedata passes 25544 --lat 40.42 --lon -3.70   when does the ISS pass over Madrid
  spacedata overhead --lat 40.42 --lon -3.70  bright satellites above that spot right now
  spacedata sat search "ZARYA"                find objects by name
  spacedata sat catalog 25544                 catalog record: type, status, owner, launch, RCS
  spacedata conjunctions --limit 10           closest upcoming approaches (public SOCRATES data)
  spacedata launches upcoming --search ariane upcoming launches, filtered
  spacedata --pretty tle 25544                human-readable JSON

Only 'sat history', 'reentries' and 'conjunctions --source spacetrack' need a free
Space-Track account (SPACEDATA_SPACETRACK_IDENTITY / SPACEDATA_SPACETRACK_PASSWORD);
everything else works with no account or API key.

Exit codes: 0 ok · 1 usage · 2 not found · 3 upstream/network · 4 cooldown/rate limit ·
5 unexpected upstream schema · 6 missing/rejected credentials · 7 computation failed`,
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
	.command("position")
	.description(
		"Geodetic position of one object right now (or at --at), propagated locally with SGP4 " +
			"from the latest CelesTrak elements: latitude, longitude, altitude (km), speed (km/s) " +
			"and whether it is sunlit. No account needed. Example: spacedata position 25544",
	)
	.argument("<norad-id>", "NORAD catalog id", parseNoradId)
	.option(
		"--at <time>",
		"instant to propagate to (ISO 8601, e.g. 2026-07-10T21:30:00Z; UTC assumed when no zone is given; default: now)",
		parseAt,
	)
	.action(async (noradId: number, options: { at?: Date }, command: Command) => {
		const globals = command.optsWithGlobals<GlobalOptions>();
		const result = await computePosition(
			noradId,
			options.at,
			sourceOptions(globals),
		);
		finish(result, globals.pretty);
	});

const passesCommand = program
	.command("passes")
	.description(
		"Upcoming passes of one object over a ground location, computed locally with SGP4 from " +
			"the latest CelesTrak elements: AOS/culmination/LOS times and azimuths, max elevation, " +
			"duration, and whether each pass is optically visible (satellite sunlit while the " +
			"observer's sky is dark). No account needed. " +
			"Example: spacedata passes 25544 --lat 40.4168 --lon -3.7038",
	)
	.argument("<norad-id>", "NORAD catalog id", parseNoradId);
addObserverOptions(passesCommand)
	.option("--days <n>", "search window in days (1-10)", parseDays, 3)
	.option(
		"--min-elevation <degrees>",
		"elevation mask (0-90): a pass spans the time above this elevation, with AOS/LOS at its crossings",
		parseMinElevation,
		10,
	)
	.option("--visible-only", "only report optically visible passes", false)
	.action(
		async (
			noradId: number,
			options: ObserverOptions & {
				days: number;
				minElevation: number;
				visibleOnly: boolean;
			},
			command: Command,
		) => {
			const globals = command.optsWithGlobals<GlobalOptions>();
			const result = await computePasses(
				noradId,
				toObserver(options),
				{
					days: options.days,
					minElevationDeg: options.minElevation,
					visibleOnly: options.visibleOnly,
				},
				sourceOptions(globals),
			);
			finish(result, globals.pretty);
		},
	);

const overheadCommand = program
	.command("overhead")
	.description(
		"Satellites of a CelesTrak group above a ground location right now, sorted by elevation, " +
			"computed locally with SGP4. Default group 'visual' (the brightest objects); other " +
			"groups include 'stations', 'starlink', 'gnss' or 'active' (the full catalog, heavy). " +
			"No account needed. Example: spacedata overhead --lat 40.4168 --lon -3.7038",
	);
addObserverOptions(overheadCommand)
	.option("--group <name>", "CelesTrak group to scan", parseGroup, "visual")
	.option(
		"--min-elevation <degrees>",
		"minimum elevation over the horizon (0-90)",
		parseMinElevation,
		10,
	)
	.option(
		"--limit <n>",
		"maximum number of satellites to return (1-500)",
		parseOverheadLimit,
		50,
	)
	.action(
		async (
			options: ObserverOptions & {
				group: string;
				minElevation: number;
				limit: number;
			},
			command: Command,
		) => {
			const globals = command.optsWithGlobals<GlobalOptions>();
			const result = await computeOverhead(
				toObserver(options),
				{
					group: options.group,
					minElevationDeg: options.minElevation,
					limit: options.limit,
				},
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

program
	.command("serve")
	.description(
		"Run as an MCP (Model Context Protocol) server over stdio, exposing every data source " +
			"as MCP tools for Claude Desktop, Claude Code, Cursor and other MCP clients. " +
			"Same caching and rate-limit protection as the CLI commands.",
	)
	.action(async () => {
		const { serveMcp } = await import("./mcp/mcp-server");
		await serveMcp(packageJson.version);
	});

interface ObserverOptions {
	lat: number;
	lon: number;
	alt: number;
}

/** The shared observer option trio of `passes` and `overhead`. */
function addObserverOptions(command: Command): Command {
	return command
		.requiredOption(
			"--lat <degrees>",
			"observer latitude in decimal degrees (-90 to 90)",
			parseLatitude,
		)
		.requiredOption(
			"--lon <degrees>",
			"observer longitude in decimal degrees (-180 to 180)",
			parseLongitude,
		)
		.option(
			"--alt <meters>",
			"observer altitude above sea level in meters",
			parseAltitudeM,
			0,
		);
}

function toObserver(options: ObserverOptions): Observer {
	return {
		latitudeDeg: options.lat,
		longitudeDeg: options.lon,
		altitudeM: options.alt,
	};
}

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

function parseAt(raw: string): Date {
	const value = parseInstant(raw);
	if (value === undefined) {
		throw new InvalidArgumentError(
			"must be an ISO 8601 timestamp (e.g. 2026-07-10T21:30:00Z; UTC assumed when no zone is given)",
		);
	}
	return value;
}

// Like the pre-existing parseNoradId, these reject any token that is not
// entirely numeric — Number.parseFloat/parseInt alone would silently accept
// trailing garbage ("40abc" → 40) or truncate ("3.9" → 3, "1e3" → 1).
const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;
const INTEGER_PATTERN = /^-?\d+$/;

function parseBoundedFloat(
	raw: string,
	min: number,
	max: number,
	message: string,
): number {
	const trimmed = raw.trim();
	const value = Number.parseFloat(trimmed);
	if (!DECIMAL_PATTERN.test(trimmed) || value < min || value > max) {
		throw new InvalidArgumentError(message);
	}
	return value;
}

function parseBoundedInt(
	raw: string,
	min: number,
	max: number,
	message: string,
): number {
	const trimmed = raw.trim();
	const value = Number.parseInt(trimmed, 10);
	if (!INTEGER_PATTERN.test(trimmed) || value < min || value > max) {
		throw new InvalidArgumentError(message);
	}
	return value;
}

function parseLatitude(raw: string): number {
	return parseBoundedFloat(
		raw,
		-90,
		90,
		"must be a latitude in decimal degrees between -90 and 90",
	);
}

function parseLongitude(raw: string): number {
	return parseBoundedFloat(
		raw,
		-180,
		180,
		"must be a longitude in decimal degrees between -180 and 180",
	);
}

function parseAltitudeM(raw: string): number {
	return parseBoundedFloat(
		raw,
		-500,
		10000,
		"must be an altitude in meters between -500 and 10000",
	);
}

function parseMinElevation(raw: string): number {
	return parseBoundedFloat(
		raw,
		0,
		90,
		"must be an elevation in degrees between 0 and 90",
	);
}

function parseDays(raw: string): number {
	return parseBoundedInt(raw, 1, 10, "must be an integer between 1 and 10");
}

function parseOverheadLimit(raw: string): number {
	return parseBoundedInt(raw, 1, 500, "must be an integer between 1 and 500");
}

function parseGroup(raw: string): string {
	if (!/^[a-z0-9-]+$/i.test(raw)) {
		throw new InvalidArgumentError(
			"must be a CelesTrak group name (letters, digits and dashes, e.g. visual, starlink, gps-ops)",
		);
	}
	return raw.toLowerCase();
}

program.parseAsync();
