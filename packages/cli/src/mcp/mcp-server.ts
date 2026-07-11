import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Result } from "neverthrow";
import { z } from "zod";
import {
	computeOverhead,
	computePasses,
	computePosition,
} from "../compute/propagation.compute";
import {
	computeAurora,
	computeSpaceWeather,
} from "../compute/space-weather.compute";
import { defaultCacheDir, FileCache } from "../core/file-cache";
import type { SourceResult } from "../core/source-fetch";
import { type Observer, parseInstant } from "../domain/propagation";
import type { SpaceDataError } from "../errors/spacedata-error";
import {
	fetchByCatalogNumber,
	fetchCatalogRecord,
	searchByName,
} from "../sources/celestrak.source";
import { fetchUpcomingLaunches } from "../sources/launch-library.source";
import { fetchSocratesConjunctions } from "../sources/socrates.source";
import {
	fetchConjunctions,
	fetchElsetHistory,
	fetchReentries,
} from "../sources/spacetrack.source";

const noradIdSchema = z.number().int().positive();
const limitSchema = z.number().int().min(1).max(100);
const latitudeSchema = z.number().min(-90).max(90);
const longitudeSchema = z.number().min(-180).max(180);
const altitudeMSchema = z.number().min(-500).max(10000);
const minElevationSchema = z.number().min(0).max(90);
// parseInstant treats zone-less date-times as UTC — never host-local time.
const isoTimeSchema = z
	.string()
	.refine((value) => parseInstant(value) !== undefined, {
		message: "must be an ISO 8601 timestamp (e.g. 2026-07-10T21:30:00Z)",
	});

const observerArgsSchema = {
	latitude: latitudeSchema,
	longitude: longitudeSchema,
	altitudeM: altitudeMSchema.optional(),
};

function toObserver(parsed: {
	latitude: number;
	longitude: number;
	altitudeM?: number;
}): Observer {
	return {
		latitudeDeg: parsed.latitude,
		longitudeDeg: parsed.longitude,
		altitudeM: parsed.altitudeM ?? 0,
	};
}

const observerProperties = {
	latitude: {
		type: "number",
		description: "observer latitude in decimal degrees (-90 to 90)",
	},
	longitude: {
		type: "number",
		description: "observer longitude in decimal degrees (-180 to 180)",
	},
	altitudeM: {
		type: "number",
		description: "observer altitude above sea level in meters (default 0)",
	},
} as const;

interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	handler: (
		args: unknown,
		cache: FileCache,
	) => Promise<Result<SourceResult<unknown>, SpaceDataError>>;
}

interface ToolCallResult {
	content: { type: "text"; text: string }[];
	isError?: boolean;
	[key: string]: unknown;
}

/**
 * The MCP tool surface mirrors the CLI commands and reuses the exact same
 * source layer (cache, circuit breakers, rate limiting included). Kept
 * deliberately lean: tool schemas live in the agent's context window.
 */
export const TOOL_DEFINITIONS: ToolDefinition[] = [
	{
		name: "get_orbit",
		description:
			"Latest orbital elements (GP/OMM) for one satellite or orbital object by NORAD catalog id, " +
			"with derived perigee/apogee altitude (km), period (min) and semi-major axis. " +
			"Public data (CelesTrak), no account needed. Example: the ISS is NORAD id 25544.",
		inputSchema: {
			type: "object",
			properties: {
				noradId: {
					type: "integer",
					description: "NORAD catalog id (e.g. 25544 for the ISS)",
				},
			},
			required: ["noradId"],
		},
		handler: (args, cache) => {
			const parsed = z.object({ noradId: noradIdSchema }).parse(args);
			return fetchByCatalogNumber(parsed.noradId, { cache, fresh: false });
		},
	},
	{
		name: "search_satellites",
		description:
			"Search satellites and orbital objects by name (case-insensitive fragment) in the CelesTrak " +
			"catalog. Returns every match with orbital elements and derived orbit geometry. Public data.",
		inputSchema: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description:
						"object name or name fragment (e.g. 'ZARYA', 'STARLINK-32')",
				},
			},
			required: ["query"],
		},
		handler: (args, cache) => {
			const parsed = z.object({ query: z.string().min(1) }).parse(args);
			return searchByName(parsed.query, { cache, fresh: false });
		},
	},
	{
		name: "get_satellite_catalog",
		description:
			"Full catalog record (SATCAT) for one object: type (payload/rocket body/debris), operational " +
			"status, owner, launch date and site, decay date, orbit summary and radar cross-section (m²). " +
			"Public data (CelesTrak), no account needed.",
		inputSchema: {
			type: "object",
			properties: {
				noradId: { type: "integer", description: "NORAD catalog id" },
			},
			required: ["noradId"],
		},
		handler: (args, cache) => {
			const parsed = z.object({ noradId: noradIdSchema }).parse(args);
			return fetchCatalogRecord(parsed.noradId, { cache, fresh: false });
		},
	},
	{
		name: "get_satellite_position",
		description:
			"Where a satellite is right now (or at a given instant): latitude, longitude, altitude (km), " +
			"speed (km/s) and whether it is sunlit. Propagated locally with SGP4 from the latest public " +
			"CelesTrak elements; no account needed. The ISS is NORAD id 25544.",
		inputSchema: {
			type: "object",
			properties: {
				noradId: { type: "integer", description: "NORAD catalog id" },
				at: {
					type: "string",
					description:
						"instant to propagate to, ISO 8601 (e.g. 2026-07-10T21:30:00Z; UTC assumed when no zone is given); default: now",
				},
			},
			required: ["noradId"],
		},
		handler: (args, cache) => {
			const parsed = z
				.object({ noradId: noradIdSchema, at: isoTimeSchema.optional() })
				.parse(args);
			return computePosition(
				parsed.noradId,
				parsed.at === undefined ? undefined : parseInstant(parsed.at),
				{ cache, fresh: false },
			);
		},
	},
	{
		name: "get_satellite_passes",
		description:
			"Upcoming passes of a satellite over a ground location: AOS/culmination/LOS times (UTC) and " +
			"azimuths, max elevation, duration, and whether each pass is optically visible from the " +
			"ground (satellite sunlit while the observer's sky is dark). Answers questions like 'when " +
			"can I see the ISS from Madrid?' — ask the user for their location if unknown. Computed " +
			"locally with SGP4 from public CelesTrak elements; no account needed.",
		inputSchema: {
			type: "object",
			properties: {
				noradId: { type: "integer", description: "NORAD catalog id" },
				...observerProperties,
				days: {
					type: "integer",
					description: "search window in days, 1-10 (default 3)",
				},
				minElevationDeg: {
					type: "number",
					description:
						"elevation mask in degrees, 0-90 (default 10): a pass spans the time above this elevation, with AOS/LOS at its crossings",
				},
				visibleOnly: {
					type: "boolean",
					description: "only report optically visible passes (default false)",
				},
			},
			required: ["noradId", "latitude", "longitude"],
		},
		handler: (args, cache) => {
			const parsed = z
				.object({
					noradId: noradIdSchema,
					...observerArgsSchema,
					days: z.number().int().min(1).max(10).optional(),
					minElevationDeg: minElevationSchema.optional(),
					visibleOnly: z.boolean().optional(),
				})
				.parse(args);
			return computePasses(
				parsed.noradId,
				toObserver(parsed),
				{
					days: parsed.days ?? 3,
					minElevationDeg: parsed.minElevationDeg ?? 10,
					visibleOnly: parsed.visibleOnly ?? false,
				},
				{ cache, fresh: false },
			);
		},
	},
	{
		name: "get_satellites_overhead",
		description:
			"Which satellites of a CelesTrak group are above a ground location right now, sorted by " +
			"elevation, with azimuth, range and whether each is sunlit. Default group 'visual' (the " +
			"brightest objects — best for 'what can I see above me?'); other groups include 'stations', " +
			"'starlink', 'gnss' and 'active' (the full catalog, heavy). Computed locally with SGP4 from " +
			"public CelesTrak elements; no account needed.",
		inputSchema: {
			type: "object",
			properties: {
				...observerProperties,
				group: {
					type: "string",
					description: "CelesTrak group name (default 'visual')",
				},
				minElevationDeg: {
					type: "number",
					description:
						"minimum elevation over the horizon in degrees, 0-90 (default 10)",
				},
				limit: {
					type: "integer",
					description: "maximum satellites to return, 1-500 (default 50)",
				},
			},
			required: ["latitude", "longitude"],
		},
		handler: (args, cache) => {
			const parsed = z
				.object({
					...observerArgsSchema,
					group: z
						.string()
						.regex(
							/^[a-z0-9-]+$/i,
							"must be a CelesTrak group name (letters, digits and dashes)",
						)
						.optional(),
					minElevationDeg: minElevationSchema.optional(),
					limit: z.number().int().min(1).max(500).optional(),
				})
				.parse(args);
			return computeOverhead(
				toObserver(parsed),
				{
					group: parsed.group?.toLowerCase() ?? "visual",
					minElevationDeg: parsed.minElevationDeg ?? 10,
					limit: parsed.limit ?? 50,
				},
				{ cache, fresh: false },
			);
		},
	},
	{
		name: "get_space_weather",
		description:
			"Current space weather snapshot (NOAA SWPC): estimated planetary Kp with its NOAA G scale, " +
			"max Kp forecast for the next 24h, current R/S/G scales (radio blackouts, solar radiation, " +
			"geomagnetic storm) with today's probabilities and 2-day outlook, solar wind speed, " +
			"interplanetary magnetic field (Bt/Bz) and latest GOES X-ray flux with flare class. " +
			"Public data, no account needed.",
		inputSchema: { type: "object", properties: {} },
		handler: (_args, cache) => computeSpaceWeather({ cache, fresh: false }),
	},
	{
		name: "get_aurora_forecast",
		description:
			"Aurora visibility outlook for a ground location: OVATION model probability (0-100) at the " +
			"observer's 1° grid cell, current Kp, sun elevation and whether the sky is dark enough to " +
			"see an aurora (sun below civil twilight). Answers 'can I see the northern lights tonight?' " +
			"— ask the user for their location if unknown. Source: NOAA SWPC; no account needed.",
		inputSchema: {
			type: "object",
			properties: { ...observerProperties },
			required: ["latitude", "longitude"],
		},
		handler: (args, cache) => {
			const parsed = z.object(observerArgsSchema).parse(args);
			return computeAurora(toObserver(parsed), { cache, fresh: false });
		},
	},
	{
		name: "get_conjunctions",
		description:
			"Upcoming close approaches between orbital objects, with miss distance (km) and collision " +
			"probability, sorted by highest probability. Default source is CelesTrak SOCRATES (public, " +
			"no account). Set source='spacetrack' for official CDMs (requires SPACEDATA_SPACETRACK_IDENTITY " +
			"and SPACEDATA_SPACETRACK_PASSWORD env vars, free account).",
		inputSchema: {
			type: "object",
			properties: {
				limit: {
					type: "integer",
					description: "max results, 1-100 (default 20)",
				},
				noradId: {
					type: "integer",
					description: "only conjunctions involving this NORAD id",
				},
				source: {
					type: "string",
					enum: ["socrates", "spacetrack"],
					description: "data source (default 'socrates')",
				},
			},
		},
		handler: (args, cache) => {
			const parsed = z
				.object({
					limit: limitSchema.optional(),
					noradId: noradIdSchema.optional(),
					source: z.enum(["socrates", "spacetrack"]).optional(),
				})
				.parse(args ?? {});
			const limit = parsed.limit ?? 20;
			if (parsed.source === "spacetrack") {
				return fetchConjunctions(limit, parsed.noradId, {
					cache,
					fresh: false,
				});
			}
			return fetchSocratesConjunctions({
				cache,
				fresh: false,
				limit,
				noradId: parsed.noradId,
			});
		},
	},
	{
		name: "get_upcoming_launches",
		description:
			"Upcoming orbital launches with status, provider, rocket, pad, location and mission. " +
			"Public data (Launch Library 2), no account needed.",
		inputSchema: {
			type: "object",
			properties: {
				limit: {
					type: "integer",
					description: "max results, 1-100 (default 10)",
				},
				search: {
					type: "string",
					description: "filter by launch, rocket, mission or provider name",
				},
			},
		},
		handler: (args, cache) => {
			const parsed = z
				.object({
					limit: limitSchema.optional(),
					search: z.string().optional(),
				})
				.parse(args ?? {});
			return fetchUpcomingLaunches({
				cache,
				fresh: false,
				limit: parsed.limit ?? 10,
				search: parsed.search,
			});
		},
	},
	{
		name: "get_orbit_history",
		description:
			"Historical orbital element sets for one object (most recent first), each with derived " +
			"perigee/apogee/period — shows orbit evolution and decay over time. Requires a free " +
			"Space-Track account (SPACEDATA_SPACETRACK_IDENTITY and SPACEDATA_SPACETRACK_PASSWORD env vars).",
		inputSchema: {
			type: "object",
			properties: {
				noradId: { type: "integer", description: "NORAD catalog id" },
				limit: {
					type: "integer",
					description: "max element sets, 1-100 (default 20)",
				},
			},
			required: ["noradId"],
		},
		handler: (args, cache) => {
			const parsed = z
				.object({ noradId: noradIdSchema, limit: limitSchema.optional() })
				.parse(args);
			return fetchElsetHistory(parsed.noradId, parsed.limit ?? 20, {
				cache,
				fresh: false,
			});
		},
	},
	{
		name: "get_reentries",
		description:
			"Latest atmospheric re-entry predictions (TIP messages): predicted decay epoch, uncertainty " +
			"window and last predicted location. Requires a free Space-Track account " +
			"(SPACEDATA_SPACETRACK_IDENTITY and SPACEDATA_SPACETRACK_PASSWORD env vars).",
		inputSchema: {
			type: "object",
			properties: {
				limit: {
					type: "integer",
					description: "max predictions, 1-100 (default 10)",
				},
			},
		},
		handler: (args, cache) => {
			const parsed = z
				.object({ limit: limitSchema.optional() })
				.parse(args ?? {});
			return fetchReentries(parsed.limit ?? 10, { cache, fresh: false });
		},
	},
];

export function buildServer(version: string, cache: FileCache): Server {
	const server = new Server(
		{ name: "spacedata", version },
		{ capabilities: { tools: {} } },
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: TOOL_DEFINITIONS.map(({ name, description, inputSchema }) => ({
			name,
			description,
			inputSchema,
		})),
	}));

	server.setRequestHandler(
		CallToolRequestSchema,
		async (request): Promise<ToolCallResult> => {
			const tool = TOOL_DEFINITIONS.find((t) => t.name === request.params.name);
			if (tool === undefined) {
				return errorResult({
					code: "UNKNOWN_TOOL",
					message: `unknown tool: ${request.params.name}`,
				});
			}

			let result: Result<SourceResult<unknown>, SpaceDataError>;
			try {
				result = await tool.handler(request.params.arguments ?? {}, cache);
			} catch (cause) {
				return errorResult({
					code: "INVALID_ARGUMENTS",
					message: cause instanceof Error ? cause.message : String(cause),
				});
			}

			return result.match(
				(value): ToolCallResult => ({
					content: [
						{ type: "text", text: JSON.stringify({ ok: true, ...value }) },
					],
				}),
				(error): ToolCallResult => errorResult(error.toJSON()),
			);
		},
	);

	return server;
}

function errorResult(error: Record<string, unknown>): ToolCallResult {
	return {
		content: [{ type: "text", text: JSON.stringify({ ok: false, error }) }],
		isError: true,
	};
}

/** Entry point for `spacedata serve`: MCP server over stdio. */
export async function serveMcp(version: string): Promise<void> {
	const server = buildServer(version, new FileCache(defaultCacheDir()));
	await server.connect(new StdioServerTransport());
}
