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
import { fetchKpHistory } from "./gfz.source";

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

function makeCache(): FileCache {
	return new FileCache(mkdtempSync(join(tmpdir(), "spacedata-gfz-")));
}

function mockFetch(
	handler: (url: string) => Response,
): ReturnType<typeof mock> {
	const fetchMock = mock(async (input: string | URL | Request) =>
		handler(String(input)),
	);
	globalThis.fetch = fetchMock as unknown as typeof fetch;
	return fetchMock;
}

const NOW = new Date("2026-07-19T10:00:00Z");

const body = JSON.stringify({
	Kp: [2.667, 5.333, null],
	datetime: [
		"2026-07-18T00:00:00Z",
		"2026-07-18T03:00:00Z",
		"2026-07-18T06:00:00Z",
	],
	status: ["def", "pre", "pre"],
	meta: { license: "CC BY 4.0", source: "GFZ Potsdam" },
});

describe("gfz source", () => {
	test("requests a bin-aligned window and parses the parallel arrays", async () => {
		const fetchMock = mockFetch((url) => {
			// End rounds up to the next 3h bin; start floors to UTC midnight.
			expect(url).toContain("start=2026-07-16T00%3A00%3A00Z");
			expect(url).toContain("end=2026-07-19T12%3A00%3A00Z");
			expect(url).toContain("index=Kp");
			return new Response(body, { status: 200 });
		});

		const result = await fetchKpHistory(
			3,
			{ cache: makeCache(), fresh: false },
			NOW,
		);
		expect(result.isOk()).toBe(true);
		if (result.isOk()) {
			expect(result.value.source).toBe("gfz-kp");
			// The null (not yet issued) bin is skipped.
			expect(result.value.data.samples).toHaveLength(2);
			expect(result.value.data.samples[0]).toEqual({
				time: "2026-07-18T00:00:00Z",
				kp: 2.667,
				definitive: true,
			});
			expect(result.value.data.samples[1]?.definitive).toBe(false);
		}
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("serves the second call from cache", async () => {
		const cache = makeCache();
		const fetchMock = mockFetch(() => new Response(body, { status: 200 }));

		const first = await fetchKpHistory(3, { cache, fresh: false }, NOW);
		const second = await fetchKpHistory(3, { cache, fresh: false }, NOW);
		expect(first.isOk() && !first.value.cached).toBe(true);
		expect(second.isOk() && second.value.cached).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("opens the breaker after an upstream error", async () => {
		const cache = makeCache();
		mockFetch(() => new Response("boom", { status: 500 }));

		const first = await fetchKpHistory(3, { cache, fresh: false }, NOW);
		expect(first.isErr() && first.error).toBeInstanceOf(UpstreamHttpError);

		const second = await fetchKpHistory(3, { cache, fresh: false }, NOW);
		expect(second.isErr() && second.error).toBeInstanceOf(CircuitOpenError);
	});

	test("rejects a payload with mismatched array lengths", async () => {
		mockFetch(
			() =>
				new Response(JSON.stringify({ Kp: [1], datetime: ["a", "b"] }), {
					status: 200,
				}),
		);
		const result = await fetchKpHistory(
			3,
			{ cache: makeCache(), fresh: false },
			NOW,
		);
		expect(result.isErr() && result.error).toBeInstanceOf(UpstreamSchemaError);
	});

	test("rejects a non-JSON body", async () => {
		mockFetch(() => new Response("<html>", { status: 200 }));
		const result = await fetchKpHistory(
			3,
			{ cache: makeCache(), fresh: false },
			NOW,
		);
		expect(result.isErr() && result.error).toBeInstanceOf(UpstreamSchemaError);
	});
});
