import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Result } from "neverthrow";
import { z } from "zod";
import { defaultCacheDir, FileCache } from "../core/file-cache";
import type { SourceResult } from "../core/source-fetch";
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
