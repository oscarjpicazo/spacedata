import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCache } from "../core/file-cache";
import {
	CircuitOpenError,
	NotFoundError,
	UpstreamHttpError,
	UpstreamSchemaError,
} from "../errors/space-cli-error";
import { fetchByCatalogNumber, searchByName } from "./celestrak.source";

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

function makeCache(): FileCache {
	return new FileCache(mkdtempSync(join(tmpdir(), "spacecli-celestrak-")));
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

describe("celestrak source", () => {
	test("fetches, validates and normalizes a GP record by catalog number", async () => {
		const fetchMock = mockFetch((url) => {
			expect(url).toContain("CATNR=25544");
			expect(url).toContain("FORMAT=json");
			return new Response(JSON.stringify([issOmm]), { status: 200 });
		});

		const result = await fetchByCatalogNumber(25544, {
			cache: makeCache(),
			fresh: false,
		});

		expect(result.isOk()).toBe(true);
		const value = result._unsafeUnwrap();
		expect(value.source).toBe("celestrak");
		expect(value.cached).toBe(false);
		expect(value.data).toHaveLength(1);
		const record = value.data[0];
		expect(record.noradId).toBe(25544);
		expect(record.name).toBe("ISS (ZARYA)");
		expect(record.internationalDesignator).toBe("1998-067A");
		expect(record.derived.perigeeAltitudeKm).toBeGreaterThan(395);
		expect(record.derived.perigeeAltitudeKm).toBeLessThan(415);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("serves the second identical query from cache without hitting the network", async () => {
		const fetchMock = mockFetch(
			() => new Response(JSON.stringify([issOmm]), { status: 200 }),
		);
		const cache = makeCache();

		const first = await fetchByCatalogNumber(25544, { cache, fresh: false });
		const second = await fetchByCatalogNumber(25544, { cache, fresh: false });

		expect(first._unsafeUnwrap().cached).toBe(false);
		expect(second._unsafeUnwrap().cached).toBe(true);
		expect(second._unsafeUnwrap().data[0].noradId).toBe(25544);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("--fresh bypasses the cache", async () => {
		const fetchMock = mockFetch(
			() => new Response(JSON.stringify([issOmm]), { status: 200 }),
		);
		const cache = makeCache();

		await fetchByCatalogNumber(25544, { cache, fresh: false });
		const refreshed = await fetchByCatalogNumber(25544, { cache, fresh: true });

		expect(refreshed._unsafeUnwrap().cached).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	test("maps the 'No GP data found' sentinel to NotFoundError", async () => {
		mockFetch(() => new Response("No GP data found", { status: 200 }));

		const result = await searchByName("DOES-NOT-EXIST", {
			cache: makeCache(),
			fresh: false,
		});

		expect(result._unsafeUnwrapErr()).toBeInstanceOf(NotFoundError);
	});

	test("maps HTTP 404 to NotFoundError without opening the circuit breaker", async () => {
		const cache = makeCache();
		mockFetch(() => new Response("Not found", { status: 404 }));

		const missing = await fetchByCatalogNumber(999999, { cache, fresh: false });
		expect(missing._unsafeUnwrapErr()).toBeInstanceOf(NotFoundError);

		// The source must remain queryable: a bad id is not an upstream failure.
		const fetchMock = mockFetch(
			() => new Response(JSON.stringify([issOmm]), { status: 200 }),
		);
		const next = await fetchByCatalogNumber(25544, { cache, fresh: false });
		expect(next.isOk()).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("opens the circuit breaker on non-200 and refuses the next call", async () => {
		const fetchMock = mockFetch(() => new Response("boom", { status: 500 }));
		const cache = makeCache();

		const first = await fetchByCatalogNumber(25544, { cache, fresh: false });
		const second = await fetchByCatalogNumber(25544, { cache, fresh: false });

		expect(first._unsafeUnwrapErr()).toBeInstanceOf(UpstreamHttpError);
		const secondError = second._unsafeUnwrapErr();
		expect(secondError).toBeInstanceOf(CircuitOpenError);
		expect((secondError as CircuitOpenError).retryAt).toBeDefined();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("rejects payloads that do not match the OMM schema", async () => {
		mockFetch(
			() =>
				new Response(JSON.stringify([{ OBJECT_NAME: 42 }]), { status: 200 }),
		);

		const result = await fetchByCatalogNumber(25544, {
			cache: makeCache(),
			fresh: false,
		});

		expect(result._unsafeUnwrapErr()).toBeInstanceOf(UpstreamSchemaError);
	});
});
