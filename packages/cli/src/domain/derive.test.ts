import { describe, expect, test } from "bun:test";
import { deriveOrbit } from "./derive";

describe("deriveOrbit", () => {
	test("derives ISS-like orbit geometry from mean motion and eccentricity", () => {
		// ISS: ~15.5 rev/day, nearly circular.
		const derived = deriveOrbit(15.5, 0.0003);

		expect(derived.semiMajorAxisKm).toBeGreaterThan(6780);
		expect(derived.semiMajorAxisKm).toBeLessThan(6800);
		expect(derived.perigeeAltitudeKm).toBeGreaterThan(395);
		expect(derived.perigeeAltitudeKm).toBeLessThan(415);
		expect(derived.apogeeAltitudeKm).toBeGreaterThan(derived.perigeeAltitudeKm);
		expect(derived.periodMinutes).toBeCloseTo(1440 / 15.5, 3);
	});

	test("derives geostationary geometry from ~1 rev/day", () => {
		const derived = deriveOrbit(1.0027, 0.0001);

		// GEO altitude is ~35,786 km.
		expect(derived.perigeeAltitudeKm).toBeGreaterThan(35700);
		expect(derived.apogeeAltitudeKm).toBeLessThan(35900);
	});

	test("eccentric orbits separate perigee and apogee", () => {
		// Molniya-like: 2 rev/day, e=0.74.
		const derived = deriveOrbit(2, 0.74);

		expect(derived.perigeeAltitudeKm).toBeLessThan(1500);
		expect(derived.apogeeAltitudeKm).toBeGreaterThan(38000);
	});
});
