import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FileCache } from "../core/file-cache";
import { buildServer, TOOL_DEFINITIONS } from "./mcp-server";

const issOmm = {
	OBJECT_NAME: "ISS (ZARYA)",
	OBJECT_ID: "1998-067A",
	EPOCH: "2026-07-02T12:00:00.000000",
	MEAN_MOTION: 15.5,
	ECCENTRICITY: 0.0003,
	INCLINATION: 51.64,
	RA_OF_ASC_NODE: 100.1,
	ARG_OF_PERICENTER: 200.2,
	MEAN_ANOMALY: 300.3,
	EPHEMERIS_TYPE: 0,
	CLASSIFICATION_TYPE: "U",
	NORAD_CAT_ID: 25544,
	ELEMENT_SET_NO: 999,
	REV_AT_EPOCH: 12345,
	BSTAR: 0.0001,
	MEAN_MOTION_DOT: 0.00001,
	MEAN_MOTION_DDOT: 0,
};

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

async function connectedClient(): Promise<Client> {
	const cache = new FileCache(mkdtempSync(join(tmpdir(), "spacedata-mcp-")));
	const server = buildServer("0.0.0-test", cache);
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client({ name: "test-client", version: "0.0.0" });
	await client.connect(clientTransport);
	return client;
}

function textOf(result: unknown): string {
	const content = (result as { content: { type: string; text: string }[] })
		.content;
	expect(content).toHaveLength(1);
	expect(content[0].type).toBe("text");
	return content[0].text;
}

describe("mcp server", () => {
	test("lists the full lean tool surface with schemas", async () => {
		const client = await connectedClient();

		const { tools } = await client.listTools();

		expect(tools.map((t) => t.name).sort()).toEqual(
			[...TOOL_DEFINITIONS.map((t) => t.name)].sort(),
		);
		for (const tool of tools) {
			expect(tool.description?.length ?? 0).toBeGreaterThan(40);
			expect(tool.inputSchema).toHaveProperty("type", "object");
		}
	});

	test("get_orbit returns the CLI output envelope as JSON text", async () => {
		globalThis.fetch = mock(
			async () => new Response(JSON.stringify([issOmm]), { status: 200 }),
		) as unknown as typeof fetch;
		const client = await connectedClient();

		const result = await client.callTool({
			name: "get_orbit",
			arguments: { noradId: 25544 },
		});

		const payload = JSON.parse(textOf(result));
		expect(payload.ok).toBe(true);
		expect(payload.source).toBe("celestrak");
		expect(payload.data[0].noradId).toBe(25544);
		expect(payload.data[0].derived.perigeeAltitudeKm).toBeGreaterThan(395);
	});

	test("get_satellite_position propagates the orbit to the requested instant", async () => {
		globalThis.fetch = mock(
			async () => new Response(JSON.stringify([issOmm]), { status: 200 }),
		) as unknown as typeof fetch;
		const client = await connectedClient();

		const result = await client.callTool({
			name: "get_satellite_position",
			arguments: { noradId: 25544, at: "2026-07-02T12:00:00Z" },
		});

		const payload = JSON.parse(textOf(result));
		expect(payload.ok).toBe(true);
		expect(payload.source).toBe("celestrak+sgp4");
		expect(payload.data.noradId).toBe(25544);
		expect(payload.data.at).toBe("2026-07-02T12:00:00.000Z");
		expect(payload.data.altitudeKm).toBeGreaterThan(350);
		expect(payload.data.altitudeKm).toBeLessThan(500);
		expect(payload.data.tleAgeHours).toBe(0);
		expect(payload.data.warnings).toHaveLength(0);
	});

	test("get_satellite_passes computes passes over the given observer", async () => {
		// The tool always searches from "now", so the fixture epoch must track
		// the wall clock — a pinned epoch would go stale and start erroring.
		const liveOmm = { ...issOmm, EPOCH: new Date().toISOString() };
		globalThis.fetch = mock(
			async () => new Response(JSON.stringify([liveOmm]), { status: 200 }),
		) as unknown as typeof fetch;
		const client = await connectedClient();

		const result = await client.callTool({
			name: "get_satellite_passes",
			arguments: { noradId: 25544, latitude: 40.4168, longitude: -3.7038 },
		});

		const payload = JSON.parse(textOf(result));
		expect(payload.ok).toBe(true);
		expect(payload.source).toBe("celestrak+sgp4");
		expect(payload.data.observer).toEqual({
			latitudeDeg: 40.4168,
			longitudeDeg: -3.7038,
			altitudeM: 0,
		});
		expect(payload.data.minElevationDeg).toBe(10);
		expect(Array.isArray(payload.data.passes)).toBe(true);
	});

	test("get_satellites_overhead scans a CelesTrak group for the observer", async () => {
		// Like the passes test: "now"-anchored tool, wall-clock-fresh epoch.
		const liveOmm = { ...issOmm, EPOCH: new Date().toISOString() };
		const fetchMock = mock(
			async (_input: string | URL | Request) =>
				new Response(JSON.stringify([liveOmm]), { status: 200 }),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const client = await connectedClient();

		const result = await client.callTool({
			name: "get_satellites_overhead",
			arguments: { latitude: 40.4168, longitude: -3.7038 },
		});

		const payload = JSON.parse(textOf(result));
		expect(payload.ok).toBe(true);
		expect(payload.data.group).toBe("visual");
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain("GROUP=visual");
		expect(typeof payload.data.totalAboveMinElevation).toBe("number");
		expect(Array.isArray(payload.data.satellites)).toBe(true);
	});

	test("get_satellite_passes rejects an out-of-range latitude without fetching", async () => {
		const fetchMock = mock(async () => new Response("[]", { status: 200 }));
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const client = await connectedClient();

		const result = await client.callTool({
			name: "get_satellite_passes",
			arguments: { noradId: 25544, latitude: 120, longitude: 0 },
		});

		expect(result.isError).toBe(true);
		const payload = JSON.parse(textOf(result));
		expect(payload.error.code).toBe("INVALID_ARGUMENTS");
		expect(fetchMock).toHaveBeenCalledTimes(0);
	});

	test("upstream errors map to isError with the CLI error envelope", async () => {
		globalThis.fetch = mock(
			async () => new Response("boom", { status: 500 }),
		) as unknown as typeof fetch;
		const client = await connectedClient();

		const result = await client.callTool({
			name: "get_orbit",
			arguments: { noradId: 25544 },
		});

		expect(result.isError).toBe(true);
		const payload = JSON.parse(textOf(result));
		expect(payload.ok).toBe(false);
		expect(payload.error.code).toBe("UPSTREAM_HTTP");
	});

	test("invalid arguments are rejected without hitting the network", async () => {
		const fetchMock = mock(async () => new Response("[]", { status: 200 }));
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const client = await connectedClient();

		const result = await client.callTool({
			name: "get_orbit",
			arguments: { noradId: -5 },
		});

		expect(result.isError).toBe(true);
		const payload = JSON.parse(textOf(result));
		expect(payload.error.code).toBe("INVALID_ARGUMENTS");
		expect(fetchMock).toHaveBeenCalledTimes(0);
	});

	test("missing Space-Track credentials surface the actionable error", async () => {
		delete process.env.SPACEDATA_SPACETRACK_IDENTITY;
		delete process.env.SPACEDATA_SPACETRACK_PASSWORD;
		const client = await connectedClient();

		const result = await client.callTool({
			name: "get_reentries",
			arguments: {},
		});

		expect(result.isError).toBe(true);
		const payload = JSON.parse(textOf(result));
		expect(payload.error.code).toBe("MISSING_CREDENTIALS");
		expect(payload.error.message).toContain("space-track.org");
	});
});
