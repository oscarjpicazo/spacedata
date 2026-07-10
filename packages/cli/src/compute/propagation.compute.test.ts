import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCache } from "../core/file-cache";
import { propagatePosition } from "../domain/propagation";
import { NotFoundError, PropagationError } from "../errors/spacedata-error";
import {
	computeOverhead,
	computePasses,
	computePosition,
} from "./propagation.compute";

// Real ISS element set (epoch 2024-01-15), as CelesTrak GP JSON serves it.
const issOmm = {
	OBJECT_NAME: "ISS (ZARYA)",
	OBJECT_ID: "1998-067A",
	EPOCH: "2024-01-15T12:00:00.000000",
	MEAN_MOTION: 15.49814641,
	ECCENTRICITY: 0.0004597,
	INCLINATION: 51.6417,
	RA_OF_ASC_NODE: 246.3556,
	ARG_OF_PERICENTER: 47.6467,
	MEAN_ANOMALY: 100.5001,
	EPHEMERIS_TYPE: 0,
	CLASSIFICATION_TYPE: "U",
	NORAD_CAT_ID: 25544,
	ELEMENT_SET_NO: 999,
	REV_AT_EPOCH: 43600,
	BSTAR: 0.00033312,
	MEAN_MOTION_DOT: 0.00019437,
	MEAN_MOTION_DDOT: 0,
};

const epochDate = new Date("2024-01-15T12:00:00.000Z");

/** The same element set in the domain layer's shape. */
const issElements = {
	noradId: 25544,
	name: "ISS (ZARYA)",
	epoch: issOmm.EPOCH,
	meanMotionRevPerDay: issOmm.MEAN_MOTION,
	eccentricity: issOmm.ECCENTRICITY,
	inclinationDeg: issOmm.INCLINATION,
	raOfAscNodeDeg: issOmm.RA_OF_ASC_NODE,
	argOfPericenterDeg: issOmm.ARG_OF_PERICENTER,
	meanAnomalyDeg: issOmm.MEAN_ANOMALY,
	bstar: issOmm.BSTAR,
};

const madrid = { latitudeDeg: 40.4168, longitudeDeg: -3.7038, altitudeM: 650 };

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

function makeCache(): FileCache {
	return new FileCache(mkdtempSync(join(tmpdir(), "spacedata-compute-")));
}

function mockFetch(body: unknown): ReturnType<typeof mock> {
	const fetchMock = mock(
		async () =>
			new Response(typeof body === "string" ? body : JSON.stringify(body), {
				status: 200,
			}),
	);
	globalThis.fetch = fetchMock as unknown as typeof fetch;
	return fetchMock;
}

describe("computePosition", () => {
	test("reports the propagated position with element provenance", async () => {
		mockFetch([issOmm]);

		const result = await computePosition(25544, epochDate, {
			cache: makeCache(),
			fresh: false,
		});

		const value = result._unsafeUnwrap();
		expect(value.source).toBe("celestrak+sgp4");
		expect(value.cached).toBe(false);
		expect(value.data.noradId).toBe(25544);
		expect(value.data.name).toBe("ISS (ZARYA)");
		expect(value.data.at).toBe("2024-01-15T12:00:00.000Z");
		expect(value.data.altitudeKm).toBeGreaterThan(400);
		expect(value.data.altitudeKm).toBeLessThan(440);
		expect(value.data.speedKmS).toBeGreaterThan(7.6);
		expect(value.data.tleAgeHours).toBe(0);
		expect(value.data.warnings).toHaveLength(0);
	});

	test("reuses the cached element set on the second query", async () => {
		const fetchMock = mockFetch([issOmm]);
		const cache = makeCache();

		await computePosition(25544, epochDate, { cache, fresh: false });
		const second = await computePosition(25544, epochDate, {
			cache,
			fresh: false,
		});

		expect(second._unsafeUnwrap().cached).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("warns when the requested time is far from the element epoch", async () => {
		mockFetch([issOmm]);
		const thirtyDaysLater = new Date(epochDate.getTime() + 30 * 86_400_000);

		const result = await computePosition(25544, thirtyDaysLater, {
			cache: makeCache(),
			fresh: false,
		});

		const value = result._unsafeUnwrap();
		expect(value.data.tleAgeHours).toBe(720);
		expect(value.data.warnings).toHaveLength(1);
		expect(value.data.warnings[0]).toContain("SGP4 accuracy");
	});

	test("maps a no-match query to NotFoundError", async () => {
		mockFetch("No GP data found");

		const result = await computePosition(999999, epochDate, {
			cache: makeCache(),
			fresh: false,
		});

		expect(result._unsafeUnwrapErr()).toBeInstanceOf(NotFoundError);
	});

	test("surfaces unpropagatable elements as PropagationError", async () => {
		mockFetch([{ ...issOmm, ECCENTRICITY: 1.5 }]);

		const result = await computePosition(25544, epochDate, {
			cache: makeCache(),
			fresh: false,
		});

		const error = result._unsafeUnwrapErr();
		expect(error).toBeInstanceOf(PropagationError);
		expect(error.exitCode).toBe(7);
	});
});

describe("computePasses", () => {
	test("reports passes over the observer with window metadata", async () => {
		mockFetch([issOmm]);

		const result = await computePasses(
			25544,
			madrid,
			{ days: 1, minElevationDeg: 10, visibleOnly: false, start: epochDate },
			{ cache: makeCache(), fresh: false },
		);

		const value = result._unsafeUnwrap();
		expect(value.source).toBe("celestrak+sgp4");
		expect(value.data.windowStart).toBe("2024-01-15T12:00:00.000Z");
		expect(value.data.windowEnd).toBe("2024-01-16T12:00:00.000Z");
		expect(value.data.alwaysAboveMinElevation).toBe(false);
		expect(value.data.passes.length).toBeGreaterThanOrEqual(1);
	});

	test("warns when the window extends past the SGP4 accuracy horizon", async () => {
		mockFetch([issOmm]);

		// Elements are fresh at the window start, but a 10-day window ends
		// well past the ~7-day SGP4 horizon — the whole window must warn.
		const result = await computePasses(
			25544,
			madrid,
			{ days: 10, minElevationDeg: 10, visibleOnly: false, start: epochDate },
			{ cache: makeCache(), fresh: false },
		);

		const value = result._unsafeUnwrap();
		expect(value.data.tleAgeHours).toBe(0);
		expect(value.data.warnings.some((w) => w.includes("SGP4 accuracy"))).toBe(
			true,
		);
	});

	test("warns when the orbit decays partway through the window", async () => {
		// Extreme drag: SGP4's in-model orbit decays within hours of epoch.
		mockFetch([{ ...issOmm, MEAN_MOTION: 16.4, BSTAR: 0.1 }]);

		const result = await computePasses(
			25544,
			madrid,
			{ days: 3, minElevationDeg: 10, visibleOnly: false, start: epochDate },
			{ cache: makeCache(), fresh: false },
		);

		const value = result._unsafeUnwrap();
		expect(
			value.data.warnings.some((w) => w.includes("may be truncated")),
		).toBe(true);
	});

	test("--visible-only keeps only optically visible passes", async () => {
		mockFetch([issOmm]);
		const cache = makeCache();
		const query = {
			days: 1,
			minElevationDeg: 10,
			visibleOnly: false,
			start: epochDate,
		};

		const all = await computePasses(25544, madrid, query, {
			cache,
			fresh: false,
		});
		const visible = await computePasses(
			25544,
			madrid,
			{ ...query, visibleOnly: true },
			{ cache, fresh: false },
		);

		const allPasses = all._unsafeUnwrap().data.passes;
		const visiblePasses = visible._unsafeUnwrap().data.passes;
		expect(visiblePasses.length).toBeLessThanOrEqual(allPasses.length);
		expect(visiblePasses.every((pass) => pass.visible)).toBe(true);
	});
});

describe("computeOverhead", () => {
	test("lists objects above the mask sorted by elevation, skipping broken ones", async () => {
		// Observer at the ISS subsatellite point: the ISS is near the zenith,
		// its half-orbit twin is below the horizon, the broken clone is skipped.
		const subpoint = propagatePosition(issElements, epochDate)._unsafeUnwrap();
		mockFetch([
			issOmm,
			{
				...issOmm,
				NORAD_CAT_ID: 11111,
				OBJECT_NAME: "HALF-ORBIT-TWIN",
				MEAN_ANOMALY: (issOmm.MEAN_ANOMALY + 180) % 360,
			},
			{
				...issOmm,
				NORAD_CAT_ID: 22222,
				OBJECT_NAME: "BROKEN",
				ECCENTRICITY: 1.5,
			},
		]);

		const result = await computeOverhead(
			{
				latitudeDeg: subpoint.latitudeDeg,
				longitudeDeg: subpoint.longitudeDeg,
				altitudeM: 0,
			},
			{ group: "visual", minElevationDeg: 10, limit: 50, at: epochDate },
			{ cache: makeCache(), fresh: false },
		);

		const value = result._unsafeUnwrap();
		expect(value.source).toBe("celestrak+sgp4");
		expect(value.data.group).toBe("visual");
		expect(value.data.totalAboveMinElevation).toBe(1);
		expect(value.data.satellites).toHaveLength(1);
		expect(value.data.satellites[0]?.noradId).toBe(25544);
		expect(value.data.satellites[0]?.elevationDeg).toBeGreaterThan(85);
		expect(value.data.satellites[0]?.tleAgeHours).toBe(0);
		expect(value.data.skippedObjects).toBe(1);
		expect(value.data.warnings).toHaveLength(0);
	});

	test("warns when objects above the mask carry stale element sets", async () => {
		mockFetch([issOmm]);
		// Evaluate 30 days after the element epoch: the ISS elements are stale.
		const thirtyDaysLater = new Date(epochDate.getTime() + 30 * 86_400_000);
		const position = propagatePosition(
			issElements,
			thirtyDaysLater,
		)._unsafeUnwrap();

		const result = await computeOverhead(
			{
				latitudeDeg: position.latitudeDeg,
				longitudeDeg: position.longitudeDeg,
				altitudeM: 0,
			},
			{
				group: "visual",
				minElevationDeg: 10,
				limit: 50,
				at: thirtyDaysLater,
			},
			{ cache: makeCache(), fresh: false },
		);

		const value = result._unsafeUnwrap();
		expect(value.data.satellites[0]?.tleAgeHours).toBe(720);
		expect(value.data.warnings.some((w) => w.includes("older than"))).toBe(
			true,
		);
	});

	test("caps the list at the limit and says what was dropped", async () => {
		const subpoint = propagatePosition(issElements, epochDate)._unsafeUnwrap();
		// A near twin one degree behind on the same orbit: also high in the sky.
		mockFetch([
			issOmm,
			{
				...issOmm,
				NORAD_CAT_ID: 33333,
				OBJECT_NAME: "NEAR-TWIN",
				MEAN_ANOMALY: (issOmm.MEAN_ANOMALY + 1) % 360,
			},
		]);

		const result = await computeOverhead(
			{
				latitudeDeg: subpoint.latitudeDeg,
				longitudeDeg: subpoint.longitudeDeg,
				altitudeM: 0,
			},
			{ group: "visual", minElevationDeg: 10, limit: 1, at: epochDate },
			{ cache: makeCache(), fresh: false },
		);

		const value = result._unsafeUnwrap();
		expect(value.data.totalAboveMinElevation).toBe(2);
		expect(value.data.satellites).toHaveLength(1);
		// Sorted by elevation: the zenith object wins.
		expect(value.data.satellites[0]?.noradId).toBe(25544);
		expect(value.data.warnings).toHaveLength(1);
	});

	test("propagates a NotFoundError for an unknown group", async () => {
		mockFetch("No GP data found");

		const result = await computeOverhead(
			madrid,
			{ group: "no-such-group", minElevationDeg: 10, limit: 50 },
			{ cache: makeCache(), fresh: false },
		);

		expect(result._unsafeUnwrapErr()).toBeInstanceOf(NotFoundError);
	});
});
