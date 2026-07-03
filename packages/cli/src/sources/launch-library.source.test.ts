import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCache } from "../core/file-cache";
import {
	CircuitOpenError,
	UpstreamHttpError,
	UpstreamSchemaError,
} from "../errors/spacedata-error";
import { fetchUpcomingLaunches } from "./launch-library.source";

const launchFixture = {
	id: "abc-123",
	name: "Falcon 9 Block 5 | Starlink Group 12-34",
	net: "2026-07-10T04:00:00Z",
	status: { name: "Go for Launch", abbrev: "Go" },
	launch_service_provider: { name: "SpaceX" },
	rocket: {
		configuration: { name: "Falcon 9", full_name: "Falcon 9 Block 5" },
	},
	pad: { name: "SLC-40", location: { name: "Cape Canaveral SFS, FL, USA" } },
	mission: {
		name: "Starlink Group 12-34",
		type: "Communications",
		orbit: { name: "Low Earth Orbit", abbrev: "LEO" },
	},
};

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

function makeCache(): FileCache {
	return new FileCache(mkdtempSync(join(tmpdir(), "spacedata-ll2-")));
}

function mockFetch(
	handler: (url: string, init?: RequestInit) => Response,
): ReturnType<typeof mock> {
	const fetchMock = mock(
		async (input: string | URL | Request, init?: RequestInit) =>
			handler(String(input), init),
	);
	globalThis.fetch = fetchMock as unknown as typeof fetch;
	return fetchMock;
}

describe("launch-library source", () => {
	test("fetches, validates and flattens upcoming launches", async () => {
		const fetchMock = mockFetch((url) => {
			expect(url).toContain("/launches/upcoming/");
			expect(url).toContain("limit=5");
			expect(url).toContain("search=starlink");
			return new Response(
				JSON.stringify({ count: 1, results: [launchFixture] }),
				{ status: 200 },
			);
		});

		const result = await fetchUpcomingLaunches({
			cache: makeCache(),
			fresh: false,
			limit: 5,
			search: "starlink",
		});

		const value = result._unsafeUnwrap();
		expect(value.source).toBe("launch-library");
		expect(value.data.count).toBe(1);
		expect(value.data.launches[0]).toEqual({
			id: "abc-123",
			name: "Falcon 9 Block 5 | Starlink Group 12-34",
			net: "2026-07-10T04:00:00Z",
			status: "Go for Launch",
			provider: "SpaceX",
			rocket: "Falcon 9 Block 5",
			pad: "SLC-40",
			location: "Cape Canaveral SFS, FL, USA",
			mission: "Starlink Group 12-34",
			orbit: "Low Earth Orbit",
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("tolerates null nested objects from the API", async () => {
		mockFetch(() => {
			const bare = {
				id: "x",
				name: "Launch",
				net: null,
				status: null,
				rocket: null,
				pad: null,
				mission: null,
			};
			return new Response(JSON.stringify({ count: 1, results: [bare] }), {
				status: 200,
			});
		});

		const result = await fetchUpcomingLaunches({
			cache: makeCache(),
			fresh: false,
			limit: 10,
		});

		const launch = result._unsafeUnwrap().data.launches[0];
		expect(launch.net).toBeUndefined();
		expect(launch.status).toBeUndefined();
		expect(launch.rocket).toBeUndefined();
	});

	test("serves repeated queries from cache to protect the 15 calls/hour budget", async () => {
		const fetchMock = mockFetch(
			() =>
				new Response(JSON.stringify({ count: 1, results: [launchFixture] }), {
					status: 200,
				}),
		);
		const cache = makeCache();

		await fetchUpcomingLaunches({ cache, fresh: false, limit: 10 });
		const second = await fetchUpcomingLaunches({
			cache,
			fresh: false,
			limit: 10,
		});

		expect(second._unsafeUnwrap().cached).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("sends the Authorization header when a token is provided", async () => {
		mockFetch((_url, init) => {
			expect((init?.headers as Record<string, string>).Authorization).toBe(
				"Token secret",
			);
			return new Response(JSON.stringify({ count: 0, results: [] }), {
				status: 200,
			});
		});

		const result = await fetchUpcomingLaunches({
			cache: makeCache(),
			fresh: false,
			limit: 10,
			token: "secret",
		});

		expect(result.isOk()).toBe(true);
	});

	test("opens the circuit breaker on 429 and refuses the next call", async () => {
		const fetchMock = mockFetch(
			() => new Response("throttled", { status: 429 }),
		);
		const cache = makeCache();

		const first = await fetchUpcomingLaunches({
			cache,
			fresh: false,
			limit: 10,
		});
		const second = await fetchUpcomingLaunches({
			cache,
			fresh: false,
			limit: 10,
		});

		expect(first._unsafeUnwrapErr()).toBeInstanceOf(UpstreamHttpError);
		expect(second._unsafeUnwrapErr()).toBeInstanceOf(CircuitOpenError);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("rejects payloads that do not match the launch schema", async () => {
		mockFetch(
			() => new Response(JSON.stringify({ results: "nope" }), { status: 200 }),
		);

		const result = await fetchUpcomingLaunches({
			cache: makeCache(),
			fresh: false,
			limit: 10,
		});

		expect(result._unsafeUnwrapErr()).toBeInstanceOf(UpstreamSchemaError);
	});
});
