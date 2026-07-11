import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCache } from "../core/file-cache";
import { UpstreamSchemaError } from "../errors/spacedata-error";
import { computeAurora, computeSpaceWeather } from "./space-weather.compute";

// A fixed "now" between the fixture's forecast bins keeps the test
// independent of the wall clock.
const now = new Date("2026-07-11T12:00:00Z");

const kp1mFixture = [
	{ time_tag: "2026-07-11T11:59:00", kp_index: 6, estimated_kp: 5.67 },
];

const kpForecastFixture = [
	// Observed history must never win the 24h forecast maximum.
	{
		time_tag: "2026-07-11T09:00:00",
		kp: 9.0,
		observed: "observed",
		noaa_scale: "G5",
	},
	{
		time_tag: "2026-07-11T15:00:00",
		kp: 6.33,
		observed: "predicted",
		noaa_scale: "G2",
	},
	{
		time_tag: "2026-07-11T18:00:00",
		kp: 4.33,
		observed: "predicted",
		noaa_scale: null,
	},
	// Outside the 24h window: ignored.
	{
		time_tag: "2026-07-13T00:00:00",
		kp: 8.0,
		observed: "predicted",
		noaa_scale: "G4",
	},
];

const scalesFixture = {
	"0": {
		DateStamp: "2026-07-11",
		TimeStamp: "10:21:00",
		R: { Scale: "1", Text: "minor", MinorProb: null, MajorProb: null },
		S: { Scale: "0", Text: "none", Prob: null },
		G: { Scale: "2", Text: "moderate" },
	},
	"1": {
		DateStamp: "2026-07-11",
		TimeStamp: "10:21:00",
		R: { Scale: null, Text: null, MinorProb: "45", MajorProb: "15" },
		S: { Scale: null, Text: null, Prob: "5" },
		G: { Scale: "0", Text: "none" },
	},
};

const windFixture = [{ proton_speed: 612, time_tag: "2026-07-11T11:55:00Z" }];
const magFixture = [{ bt: 12, bz_gsm: -8, time_tag: "2026-07-11T11:55:00Z" }];
const xrayFixture = [
	{ time_tag: "2026-07-11T11:58:00Z", flux: 5.6e-5, energy: "0.1-0.8nm" },
];

const ovationFixture = {
	"Observation Time": "2026-07-11T11:50:00Z",
	"Forecast Time": "2026-07-11T12:40:00Z",
	coordinates: [
		[356, 40, 3],
		[338, 64, 78],
	],
};

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

function makeCache(): FileCache {
	return new FileCache(mkdtempSync(join(tmpdir(), "spacedata-spaceweather-")));
}

function mockSwpc(overrides?: { failing?: string }): ReturnType<typeof mock> {
	const fetchMock = mock(async (input: string | URL | Request) => {
		const url = String(input);
		if (overrides?.failing !== undefined && url.includes(overrides.failing)) {
			return new Response("boom", { status: 500 });
		}
		if (url.includes("planetary_k_index_1m")) {
			return ok(kp1mFixture);
		}
		if (url.includes("k-index-forecast")) {
			return ok(kpForecastFixture);
		}
		if (url.includes("noaa-scales")) {
			return ok(scalesFixture);
		}
		if (url.includes("solar-wind-speed")) {
			return ok(windFixture);
		}
		if (url.includes("solar-wind-mag-field")) {
			return ok(magFixture);
		}
		if (url.includes("xrays-6-hour")) {
			return ok(xrayFixture);
		}
		if (url.includes("ovation_aurora_latest")) {
			return ok(ovationFixture);
		}
		return new Response("unexpected url", { status: 404 });
	});
	globalThis.fetch = fetchMock as unknown as typeof fetch;
	return fetchMock;
}

function ok(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200 });
}

describe("computeSpaceWeather", () => {
	test("aggregates every SWPC section into one report", async () => {
		mockSwpc();

		const result = await computeSpaceWeather(
			{ cache: makeCache(), fresh: false },
			now,
		);

		const value = result._unsafeUnwrap();
		expect(value.source).toBe("noaa-swpc");
		expect(value.cached).toBe(false);
		expect(value.data.kp).toEqual({
			estimated: 5.67,
			time: "2026-07-11T11:59:00.000Z",
			noaaScale: "G1",
		});
		// Max of the *predicted* bins inside 24h: 6.33 (G2), not the observed
		// 9.0 nor the +36h 8.0.
		expect(value.data.forecastMax24h).toEqual({
			kp: 6.33,
			time: "2026-07-11T15:00:00.000Z",
			noaaScale: "G2",
		});
		expect(value.data.scales?.geomagneticStorm).toEqual({
			scale: "G2",
			text: "moderate",
		});
		expect(value.data.solarWind?.speedKmS).toBe(612);
		expect(value.data.magneticField?.bzNt).toBe(-8);
		expect(value.data.xray).toEqual({
			fluxWm2: 5.6e-5,
			flareClass: "M5.6",
			time: "2026-07-11T11:58:00Z",
		});
		expect(value.data.warnings).toHaveLength(0);
	});

	test("degrades gracefully when a non-core product is down", async () => {
		mockSwpc({ failing: "xrays-6-hour" });

		const result = await computeSpaceWeather(
			{ cache: makeCache(), fresh: false },
			now,
		);

		const value = result._unsafeUnwrap();
		expect(value.data.xray).toBeUndefined();
		expect(value.data.kp.estimated).toBe(5.67);
		expect(value.data.warnings).toHaveLength(1);
		expect(value.data.warnings[0]).toContain("X-ray");
	});

	test("fails when the core Kp product is down", async () => {
		mockSwpc({ failing: "planetary_k_index_1m" });

		const result = await computeSpaceWeather(
			{ cache: makeCache(), fresh: false },
			now,
		);

		expect(result.isErr()).toBe(true);
	});
});

describe("computeAurora", () => {
	test("reports the OVATION probability for the observer's cell", async () => {
		mockSwpc();

		// Reykjavik at local midnight in January: dark sky.
		const result = await computeAurora(
			{ latitudeDeg: 64.13, longitudeDeg: -21.9, altitudeM: 0 },
			{ cache: makeCache(), fresh: false },
			new Date("2026-01-11T00:00:00Z"),
		);

		const value = result._unsafeUnwrap();
		expect(value.source).toBe("noaa-swpc");
		expect(value.data.probabilityPct).toBe(78);
		expect(value.data.kpNow).toBe(5.67);
		expect(value.data.observationTime).toBe("2026-07-11T11:50:00Z");
		expect(value.data.darkSky).toBe(true);
		expect(value.data.sunElevationDeg).toBeLessThan(-6);
		expect(value.data.warnings).toHaveLength(0);
	});

	test("daylight yields darkSky false", async () => {
		mockSwpc();

		// Madrid at midday in July: bright sky.
		const result = await computeAurora(
			{ latitudeDeg: 40.4168, longitudeDeg: -3.7038, altitudeM: 650 },
			{ cache: makeCache(), fresh: false },
			new Date("2026-07-11T12:00:00Z"),
		);

		const value = result._unsafeUnwrap();
		expect(value.data.probabilityPct).toBe(3);
		expect(value.data.darkSky).toBe(false);
		expect(value.data.sunElevationDeg).toBeGreaterThan(0);
	});

	test("a grid without the observer's cell is a schema violation", async () => {
		mockSwpc();

		const result = await computeAurora(
			{ latitudeDeg: 10, longitudeDeg: 10, altitudeM: 0 },
			{ cache: makeCache(), fresh: false },
			now,
		);

		expect(result._unsafeUnwrapErr()).toBeInstanceOf(UpstreamSchemaError);
	});

	test("a failing Kp product degrades to a warning, not an error", async () => {
		mockSwpc({ failing: "planetary_k_index_1m" });

		const result = await computeAurora(
			{ latitudeDeg: 64.13, longitudeDeg: -21.9, altitudeM: 0 },
			{ cache: makeCache(), fresh: false },
			now,
		);

		const value = result._unsafeUnwrap();
		expect(value.data.probabilityPct).toBe(78);
		expect(value.data.kpNow).toBeUndefined();
		expect(value.data.warnings).toHaveLength(1);
	});
});
