import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCache } from "../core/file-cache";
import {
	CircuitOpenError,
	UpstreamSchemaError,
} from "../errors/spacedata-error";
import {
	fetchAuroraGrid,
	fetchEstimatedKp,
	fetchKpForecast,
	fetchScales,
	fetchSolarWindMag,
	fetchSolarWindSpeed,
	fetchXrayFlux,
} from "./swpc.source";

// Fixtures trimmed from real SWPC responses (2026-07-11).
const kp1mFixture = [
	{
		time_tag: "2026-07-11T04:25:00",
		kp_index: 2,
		estimated_kp: 1.67,
		kp: "2M",
	},
	{
		time_tag: "2026-07-11T04:26:00",
		kp_index: 2,
		estimated_kp: 2.33,
		kp: "2M",
	},
];

const kpForecastFixture = [
	{
		time_tag: "2026-07-11T09:00:00",
		kp: 7.0,
		observed: "observed",
		noaa_scale: "G3",
	},
	{
		time_tag: "2026-07-11T15:00:00",
		kp: 5.67,
		observed: "predicted",
		noaa_scale: "G2",
	},
	{
		time_tag: "2026-07-11T18:00:00",
		kp: 4.33,
		observed: "predicted",
		noaa_scale: null,
	},
];

const scalesFixture = {
	"0": {
		DateStamp: "2026-07-11",
		TimeStamp: "10:21:00",
		R: { Scale: "0", Text: "none", MinorProb: null, MajorProb: null },
		S: { Scale: "0", Text: "none", Prob: null },
		G: { Scale: "0", Text: "none" },
	},
	"1": {
		DateStamp: "2026-07-11",
		TimeStamp: "10:21:00",
		R: { Scale: null, Text: null, MinorProb: "30", MajorProb: "10" },
		S: { Scale: null, Text: null, Prob: "1" },
		G: { Scale: "0", Text: "none" },
	},
	"2": {
		DateStamp: "2026-07-12",
		TimeStamp: "00:00:00",
		R: { Scale: null, Text: null, MinorProb: "30", MajorProb: "10" },
		S: { Scale: null, Text: null, Prob: "1" },
		G: { Scale: "1", Text: "minor" },
	},
	"-1": {
		DateStamp: "2026-07-10",
		TimeStamp: "10:21:00",
		R: { Scale: "0", Text: "none", MinorProb: null, MajorProb: null },
		S: { Scale: "0", Text: "none", Prob: null },
		G: { Scale: "0", Text: "none" },
	},
};

const windFixture = [{ proton_speed: 493, time_tag: "2026-07-11T10:17:00Z" }];
const magFixture = [{ bt: 5, bz_gsm: -2, time_tag: "2026-07-11T10:17:00Z" }];

const xrayFixture = [
	{ time_tag: "2026-07-11T10:22:00Z", flux: 2.2e-8, energy: "0.05-0.4nm" },
	{ time_tag: "2026-07-11T10:22:00Z", flux: 4.47e-7, energy: "0.1-0.8nm" },
	{ time_tag: "2026-07-11T10:23:00Z", flux: 4.5e-7, energy: "0.1-0.8nm" },
	{ time_tag: "2026-07-11T10:23:00Z", flux: 2.3e-8, energy: "0.05-0.4nm" },
];

const ovationFixture = {
	"Observation Time": "2026-07-11T10:17:00Z",
	"Forecast Time": "2026-07-11T11:10:00Z",
	"Data Format": "[Longitude, Latitude, Aurora]",
	coordinates: [
		[356, 40, 42],
		[338, 64, 78],
		[0, -90, 5],
	],
};

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

function makeCache(): FileCache {
	return new FileCache(mkdtempSync(join(tmpdir(), "spacedata-swpc-")));
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

function respond(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200 });
}

describe("swpc source", () => {
	// SWPC products have no not-found sentinel: every product URL always
	// exists, so the not-found case of the testing convention does not apply.

	test("reduces the estimated Kp series to its latest sample", async () => {
		mockFetch((url) => {
			expect(url).toContain("planetary_k_index_1m.json");
			return respond(kp1mFixture);
		});

		const result = await fetchEstimatedKp({ cache: makeCache(), fresh: false });

		const value = result._unsafeUnwrap();
		expect(value.source).toBe("noaa-swpc-kp-1m");
		// The zoneless upstream time_tag is normalized to explicit UTC.
		expect(value.data).toEqual({
			time: "2026-07-11T04:26:00.000Z",
			estimatedKp: 2.33,
		});
	});

	test("picks the latest sample even when the series is unordered", async () => {
		mockFetch(() => respond([kp1mFixture[1], kp1mFixture[0]].filter(Boolean)));

		const result = await fetchEstimatedKp({ cache: makeCache(), fresh: false });

		expect(result._unsafeUnwrap().data.time).toBe("2026-07-11T04:26:00.000Z");
	});

	test("keeps every Kp forecast bin with its kind and scale", async () => {
		mockFetch(() => respond(kpForecastFixture));

		const result = await fetchKpForecast({ cache: makeCache(), fresh: false });

		const entries = result._unsafeUnwrap().data.entries;
		expect(entries).toHaveLength(3);
		expect(entries[1]).toEqual({
			time: "2026-07-11T15:00:00",
			kp: 5.67,
			kind: "predicted",
			noaaScale: "G2",
		});
		expect(entries[2]?.noaaScale).toBeUndefined();
	});

	test("normalizes the NOAA scales product", async () => {
		mockFetch(() => respond(scalesFixture));

		const result = await fetchScales({ cache: makeCache(), fresh: false });

		expect(result._unsafeUnwrap().data).toEqual({
			observedAt: "2026-07-11T10:21:00Z",
			radioBlackouts: { scale: "R0", text: "none" },
			solarRadiation: { scale: "S0", text: "none" },
			geomagneticStorm: { scale: "G0", text: "none" },
			todayProbabilities: {
				radioBlackoutMinorPct: 30,
				radioBlackoutMajorPct: 10,
				solarRadiationPct: 1,
			},
			geomagneticOutlook: [{ date: "2026-07-12", scale: "G1", text: "minor" }],
		});
	});

	test("reads solar wind speed and magnetic field summaries", async () => {
		mockFetch((url) =>
			url.includes("solar-wind-speed")
				? respond(windFixture)
				: respond(magFixture),
		);
		const cache = makeCache();

		const wind = await fetchSolarWindSpeed({ cache, fresh: false });
		const mag = await fetchSolarWindMag({ cache, fresh: false });

		expect(wind._unsafeUnwrap().data.speedKmS).toBe(493);
		expect(mag._unsafeUnwrap().data).toEqual({
			btNt: 5,
			bzNt: -2,
			time: "2026-07-11T10:17:00Z",
		});
	});

	test("picks the latest flare-band X-ray flux sample", async () => {
		mockFetch((url) => {
			expect(url).toContain("xrays-6-hour.json");
			return respond(xrayFixture);
		});

		const result = await fetchXrayFlux({ cache: makeCache(), fresh: false });

		expect(result._unsafeUnwrap().data).toEqual({
			fluxWm2: 4.5e-7,
			time: "2026-07-11T10:23:00Z",
		});
	});

	test("parses the OVATION aurora grid", async () => {
		mockFetch(() => respond(ovationFixture));

		const result = await fetchAuroraGrid({ cache: makeCache(), fresh: false });

		const value = result._unsafeUnwrap();
		expect(value.data.observationTime).toBe("2026-07-11T10:17:00Z");
		expect(value.data.coordinates).toHaveLength(3);
	});

	test("serves a repeated query from cache", async () => {
		const fetchMock = mockFetch(() => respond(kp1mFixture));
		const cache = makeCache();

		await fetchEstimatedKp({ cache, fresh: false });
		const second = await fetchEstimatedKp({ cache, fresh: false });

		expect(second._unsafeUnwrap().cached).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("opens the circuit breaker on non-200 and refuses the next call", async () => {
		const fetchMock = mockFetch(() => new Response("boom", { status: 500 }));
		const cache = makeCache();

		const first = await fetchEstimatedKp({ cache, fresh: false });
		const second = await fetchEstimatedKp({ cache, fresh: false });

		expect(first.isErr()).toBe(true);
		expect(second._unsafeUnwrapErr()).toBeInstanceOf(CircuitOpenError);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("one product's open breaker does not block its siblings", async () => {
		const cache = makeCache();
		mockFetch(() => new Response("boom", { status: 500 }));
		await fetchEstimatedKp({ cache, fresh: false }); // opens kp-1m breaker

		mockFetch(() => respond(scalesFixture));
		const scales = await fetchScales({ cache, fresh: false });

		// The scales product must stay reachable while kp-1m cools down.
		expect(scales.isOk()).toBe(true);
	});

	test("rejects payloads that do not match the product schema", async () => {
		mockFetch(() => respond([{ time_tag: 42 }]));

		const result = await fetchEstimatedKp({ cache: makeCache(), fresh: false });

		expect(result._unsafeUnwrapErr()).toBeInstanceOf(UpstreamSchemaError);
	});

	test("rejects an empty series as a schema violation", async () => {
		mockFetch(() => respond([]));

		const result = await fetchEstimatedKp({ cache: makeCache(), fresh: false });

		const error = result._unsafeUnwrapErr();
		expect(error).toBeInstanceOf(UpstreamSchemaError);
		expect(error.message).toContain("empty");
	});
});
