import { describe, expect, test } from "bun:test";
import { PropagationError } from "../errors/spacedata-error";
import {
	elementAgeHours,
	findPasses,
	type Observer,
	observerView,
	type PropagatableElements,
	parseEpoch,
	parseInstant,
	propagatePosition,
	sunElevationDeg,
} from "./propagation";

// Real ISS element set (epoch 2024-01-15). Every expected value below is a
// physical invariant of that orbit, not a snapshot of library output.
const iss: PropagatableElements = {
	noradId: 25544,
	name: "ISS (ZARYA)",
	epoch: "2024-01-15T12:00:00.000000",
	meanMotionRevPerDay: 15.49814641,
	eccentricity: 0.0004597,
	inclinationDeg: 51.6417,
	raOfAscNodeDeg: 246.3556,
	argOfPericenterDeg: 47.6467,
	meanAnomalyDeg: 100.5001,
	bstar: 0.00033312,
};

const epochDate = new Date("2024-01-15T12:00:00.000Z");

const madrid: Observer = {
	latitudeDeg: 40.4168,
	longitudeDeg: -3.7038,
	altitudeM: 650,
};

describe("propagatePosition", () => {
	test("puts the ISS at its known altitude, speed and latitude band", () => {
		const position = propagatePosition(iss, epochDate)._unsafeUnwrap();

		expect(position.altitudeKm).toBeGreaterThan(400);
		expect(position.altitudeKm).toBeLessThan(440);
		expect(position.speedKmS).toBeGreaterThan(7.6);
		expect(position.speedKmS).toBeLessThan(7.72);
		// The ground track never exceeds the orbital inclination.
		expect(Math.abs(position.latitudeDeg)).toBeLessThanOrEqual(51.7);
		expect(position.longitudeDeg).toBeGreaterThanOrEqual(-180);
		expect(position.longitudeDeg).toBeLessThanOrEqual(180);
	});

	test("shifts the ground track west by Earth's rotation after one orbit", () => {
		const periodMinutes = 1440 / iss.meanMotionRevPerDay;
		const first = propagatePosition(iss, epochDate)._unsafeUnwrap();
		const second = propagatePosition(
			iss,
			new Date(epochDate.getTime() + periodMinutes * 60_000),
		)._unsafeUnwrap();

		// Same point of the orbit → same latitude; longitude drifts west by
		// ~360° × period / sidereal day ≈ 23.3°.
		expect(Math.abs(second.latitudeDeg - first.latitudeDeg)).toBeLessThan(3);
		const westShift =
			(((first.longitudeDeg - second.longitudeDeg) % 360) + 360) % 360;
		expect(westShift).toBeGreaterThan(21);
		expect(westShift).toBeLessThan(26);
	});

	test("sees both sunlight and Earth's shadow along one LEO orbit", () => {
		let sunlitMinutes = 0;
		let eclipsedMinutes = 0;
		for (let minute = 0; minute < 93; minute += 1) {
			const at = new Date(epochDate.getTime() + minute * 60_000);
			const position = propagatePosition(iss, at)._unsafeUnwrap();
			if (position.sunlit) {
				sunlitMinutes += 1;
			} else {
				eclipsedMinutes += 1;
			}
		}

		// A ~400 km orbit spends roughly a third of its period in eclipse.
		const eclipsedFraction =
			eclipsedMinutes / (sunlitMinutes + eclipsedMinutes);
		expect(eclipsedFraction).toBeGreaterThan(0.2);
		expect(eclipsedFraction).toBeLessThan(0.5);
	});

	test("rejects elements with an out-of-range eccentricity", () => {
		const error = propagatePosition(
			{ ...iss, eccentricity: 1.5 },
			epochDate,
		)._unsafeUnwrapErr();

		expect(error).toBeInstanceOf(PropagationError);
		expect(error.code).toBe("PROPAGATION_FAILED");
		expect(error.exitCode).toBe(7);
	});

	test("rejects elements with an unparseable epoch", () => {
		const error = propagatePosition(
			{ ...iss, epoch: "not-a-date" },
			epochDate,
		)._unsafeUnwrapErr();

		expect(error).toBeInstanceOf(PropagationError);
		expect(error.message).toContain("epoch");
	});
});

describe("observerView", () => {
	test("shows ~90° elevation to an observer at the subsatellite point", () => {
		const position = propagatePosition(iss, epochDate)._unsafeUnwrap();
		const view = observerView(
			iss,
			{
				latitudeDeg: position.latitudeDeg,
				longitudeDeg: position.longitudeDeg,
				altitudeM: 0,
			},
			epochDate,
		)._unsafeUnwrap();

		expect(view.elevationDeg).toBeGreaterThan(85);
		// Straight up: the slant range equals the altitude.
		expect(Math.abs(view.rangeKm - view.altitudeKm)).toBeLessThan(30);
	});

	test("puts the satellite below the horizon for the antipodal observer", () => {
		const position = propagatePosition(iss, epochDate)._unsafeUnwrap();
		const view = observerView(
			iss,
			{
				latitudeDeg: -position.latitudeDeg,
				longitudeDeg:
					position.longitudeDeg > 0
						? position.longitudeDeg - 180
						: position.longitudeDeg + 180,
				altitudeM: 0,
			},
			epochDate,
		)._unsafeUnwrap();

		expect(view.elevationDeg).toBeLessThan(0);
	});
});

describe("sunElevationDeg", () => {
	test("matches the midday winter sun over Madrid", () => {
		// Solar noon in Madrid on Jan 15 puts the sun at ~28° elevation.
		const elevation = sunElevationDeg(madrid, epochDate);
		expect(elevation).toBeGreaterThan(26);
		expect(elevation).toBeLessThan(30);
	});

	test("puts the sun well below the horizon over Madrid at midnight", () => {
		const elevation = sunElevationDeg(
			madrid,
			new Date("2024-01-15T00:00:00.000Z"),
		);
		expect(elevation).toBeLessThan(-60);
	});

	test("puts the equinox sun near the zenith at the equator at noon", () => {
		const elevation = sunElevationDeg(
			{ latitudeDeg: 0, longitudeDeg: 0, altitudeM: 0 },
			new Date("2024-03-20T12:00:00.000Z"),
		);
		expect(elevation).toBeGreaterThan(84);
	});
});

describe("findPasses", () => {
	test("finds well-formed ISS passes over Madrid within a day", () => {
		const search = findPasses(iss, madrid, epochDate, 1, 10)._unsafeUnwrap();

		expect(search.alwaysAboveMinElevation).toBe(false);
		expect(search.failedSamples).toBe(0);
		// A mid-latitude site sees the ISS several times per day above 10°.
		expect(search.passes.length).toBeGreaterThanOrEqual(1);
		expect(search.passes.length).toBeLessThanOrEqual(8);

		let previousLosMs = 0;
		for (const pass of search.passes) {
			const aosMs = new Date(pass.aos.time).getTime();
			const tcaMs = new Date(pass.tca.time).getTime();
			const losMs = new Date(pass.los.time).getTime();

			// Chronological, non-overlapping, and bounded like an ISS pass.
			expect(aosMs).toBeGreaterThan(previousLosMs);
			expect(tcaMs).toBeGreaterThanOrEqual(aosMs);
			expect(losMs).toBeGreaterThanOrEqual(tcaMs);
			expect(pass.durationSeconds).toBeGreaterThan(20);
			expect(pass.durationSeconds).toBeLessThan(900);
			expect(pass.tca.elevationDeg).toBeGreaterThanOrEqual(10);
			expect(pass.tca.elevationDeg).toBeLessThanOrEqual(90);
			expect(pass.tca.rangeKm).toBeGreaterThan(400);
			expect(typeof pass.visible).toBe("boolean");
			previousLosMs = losMs;
		}
	});

	test("a lower elevation mask never yields fewer passes", () => {
		const low = findPasses(iss, madrid, epochDate, 1, 0)._unsafeUnwrap();
		const high = findPasses(iss, madrid, epochDate, 1, 30)._unsafeUnwrap();

		expect(low.passes.length).toBeGreaterThanOrEqual(high.passes.length);
	});

	test("reports a geostationary object overhead as always above the mask", () => {
		const geo: PropagatableElements = {
			noradId: 99999,
			name: "SYNTHETIC-GEO",
			epoch: iss.epoch,
			meanMotionRevPerDay: 1.0027,
			eccentricity: 0.0002,
			inclinationDeg: 0.05,
			raOfAscNodeDeg: 0,
			argOfPericenterDeg: 0,
			meanAnomalyDeg: 0,
			bstar: 0,
		};
		const subpoint = propagatePosition(geo, epochDate)._unsafeUnwrap();

		const underneath = findPasses(
			geo,
			{
				latitudeDeg: 0,
				longitudeDeg: subpoint.longitudeDeg,
				altitudeM: 0,
			},
			epochDate,
			1,
			10,
		)._unsafeUnwrap();
		expect(underneath.alwaysAboveMinElevation).toBe(true);
		expect(underneath.passes).toHaveLength(0);

		const antipodal = findPasses(
			geo,
			{
				latitudeDeg: 0,
				longitudeDeg:
					subpoint.longitudeDeg > 0
						? subpoint.longitudeDeg - 180
						: subpoint.longitudeDeg + 180,
				altitudeM: 0,
			},
			epochDate,
			1,
			10,
		)._unsafeUnwrap();
		expect(antipodal.alwaysAboveMinElevation).toBe(false);
		expect(antipodal.passes).toHaveLength(0);
	});

	test("propagation failures surface as PropagationError", () => {
		const error = findPasses(
			{ ...iss, eccentricity: 1.5 },
			madrid,
			epochDate,
			1,
			10,
		)._unsafeUnwrapErr();

		expect(error).toBeInstanceOf(PropagationError);
	});

	test("counts the samples lost when the orbit decays mid-window", () => {
		// Extreme drag: SGP4's in-model orbit decays within hours of epoch, so
		// most of a 3-day window fails to propagate. SGP4 is deterministic —
		// this fixture always decays at the same instant.
		const decaying: PropagatableElements = {
			...iss,
			noradId: 99998,
			name: "SYNTHETIC-DECAYING",
			meanMotionRevPerDay: 16.4,
			bstar: 0.1,
		};

		const search = findPasses(
			decaying,
			madrid,
			epochDate,
			3,
			10,
		)._unsafeUnwrap();

		expect(search.failedSamples).toBeGreaterThan(0);
	});

	test("rejects a non-finite search window instead of hanging", () => {
		const error = findPasses(
			iss,
			madrid,
			new Date(Number.NaN),
			1,
			10,
		)._unsafeUnwrapErr();

		expect(error).toBeInstanceOf(PropagationError);
		expect(error.message).toContain("window");
	});
});

describe("epoch helpers", () => {
	test("parses CelesTrak epochs (no zone suffix) as UTC", () => {
		const parsed = parseEpoch("2024-01-15T12:00:00.000000");
		expect(parsed?.toISOString()).toBe("2024-01-15T12:00:00.000Z");
		expect(parseEpoch("garbage")).toBeUndefined();
	});

	test("parses user instants as UTC regardless of the host timezone", () => {
		// Zone-less date-times must NOT be read as host-local time.
		expect(parseInstant("2026-07-10T21:30:00")?.toISOString()).toBe(
			"2026-07-10T21:30:00.000Z",
		);
		// An explicit offset is respected.
		expect(parseInstant("2026-07-10T21:30:00+02:00")?.toISOString()).toBe(
			"2026-07-10T19:30:00.000Z",
		);
		expect(parseInstant("2026-07-10")?.toISOString()).toBe(
			"2026-07-10T00:00:00.000Z",
		);
		expect(parseInstant("garbage")).toBeUndefined();
	});

	test("measures element age relative to the requested instant", () => {
		const at = new Date("2024-01-17T00:00:00.000Z");
		expect(
			elementAgeHours(
				{ noradId: 25544, epoch: "2024-01-15T12:00:00.000000" },
				at,
			)._unsafeUnwrap(),
		).toBe(36);
		const error = elementAgeHours(
			{ noradId: 25544, epoch: "garbage" },
			at,
		)._unsafeUnwrapErr();
		expect(error).toBeInstanceOf(PropagationError);
		expect(error.message).toContain("epoch");
	});
});
