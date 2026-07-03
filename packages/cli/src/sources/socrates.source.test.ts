import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCache } from "../core/file-cache";
import { UpstreamSchemaError } from "../errors/spacedata-error";
import { fetchSocratesConjunctions } from "./socrates.source";

const HEADER =
	"NORAD_CAT_ID_1,OBJECT_NAME_1,DSE_1,NORAD_CAT_ID_2,OBJECT_NAME_2,DSE_2,TCA,TCA_RANGE,TCA_RELATIVE_SPEED,MAX_PROB,DILUTION";

const csvFixture = [
	HEADER,
	"50830,STARLINK-3278 [+],5.552,55015,BIRKELAND [+],5.609,2026-07-08 05:14:25.836,0.003,11.860,1.000E+00,0.000",
	"61738,SITRO-AIS 15 [+],0.985,63246,LEMUR-2-LEIA-PHILIP [+],1.120,2026-07-03 13:26:09.434,0.006,6.723,9.698E-02,0.002",
].join("\n");

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

function makeCache(): FileCache {
	return new FileCache(mkdtempSync(join(tmpdir(), "spacedata-socrates-")));
}

function mockFetch(body: string, status = 200): ReturnType<typeof mock> {
	const fetchMock = mock(async () => new Response(body, { status }));
	globalThis.fetch = fetchMock as unknown as typeof fetch;
	return fetchMock;
}

describe("socrates source", () => {
	test("parses the CSV, cleans status suffixes and converts numerics", async () => {
		mockFetch(csvFixture);

		const result = await fetchSocratesConjunctions({
			cache: makeCache(),
			fresh: false,
			limit: 20,
		});

		const value = result._unsafeUnwrap();
		expect(value.source).toBe("celestrak");
		expect(value.data).toHaveLength(2);
		expect(value.data[0]).toEqual({
			tca: "2026-07-08 05:14:25.836",
			minRangeKm: 0.003,
			relativeSpeedKmS: 11.86,
			maxProbability: 1,
			sat1: { noradId: 50830, name: "STARLINK-3278" },
			sat2: { noradId: 55015, name: "BIRKELAND" },
		});
	});

	test("applies limit after parsing", async () => {
		mockFetch(csvFixture);

		const result = await fetchSocratesConjunctions({
			cache: makeCache(),
			fresh: false,
			limit: 1,
		});

		expect(result._unsafeUnwrap().data).toHaveLength(1);
	});

	test("filters by NORAD id on either satellite", async () => {
		mockFetch(csvFixture);

		const result = await fetchSocratesConjunctions({
			cache: makeCache(),
			fresh: false,
			limit: 20,
			noradId: 63246,
		});

		const data = result._unsafeUnwrap().data;
		expect(data).toHaveLength(1);
		expect(data[0].sat2.name).toBe("LEMUR-2-LEIA-PHILIP");
	});

	test("caches the full dataset so limit/filter changes stay local", async () => {
		const cache = makeCache();
		const fetchMock = mockFetch(csvFixture);

		await fetchSocratesConjunctions({ cache, fresh: false, limit: 1 });
		const second = await fetchSocratesConjunctions({
			cache,
			fresh: false,
			limit: 20,
			noradId: 50830,
		});

		expect(second._unsafeUnwrap().cached).toBe(true);
		expect(second._unsafeUnwrap().data).toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("rejects a CSV with an unexpected header", async () => {
		mockFetch("SOMETHING,ELSE\n1,2");

		const result = await fetchSocratesConjunctions({
			cache: makeCache(),
			fresh: false,
			limit: 20,
		});

		expect(result._unsafeUnwrapErr()).toBeInstanceOf(UpstreamSchemaError);
	});
});
