import { describe, expect, test } from "bun:test";
import { auroraProbabilityAt, flareClass, kpToGScale } from "./space-weather";

describe("flareClass", () => {
	test("classifies each flux decade with one decimal", () => {
		expect(flareClass(4.47e-7)).toBe("B4.5");
		expect(flareClass(2.3e-6)).toBe("C2.3");
		expect(flareClass(5.6e-5)).toBe("M5.6");
		expect(flareClass(2.5e-4)).toBe("X2.5");
		expect(flareClass(3.2e-9)).toBe("A0.3");
	});

	test("class boundaries belong to the upper class", () => {
		expect(flareClass(1e-6)).toBe("C1.0");
		expect(flareClass(1e-4)).toBe("X1.0");
	});

	test("a magnitude that rounds to 10.0 promotes to the next class", () => {
		// 9.97e-5 is below the X threshold but rounds to 10.0 within M —
		// NOAA calls this X1.0; "M10.0" does not exist.
		expect(flareClass(9.97e-5)).toBe("X1.0");
		expect(flareClass(9.96e-6)).toBe("M1.0");
		expect(flareClass(9.99e-8)).toBe("B1.0");
		// X is open-ended: no promotion above it.
		expect(flareClass(2.8e-3)).toBe("X28.0");
	});
});

describe("kpToGScale", () => {
	test("maps NOAA storm thresholds", () => {
		expect(kpToGScale(1.67)).toBe("G0");
		expect(kpToGScale(4.67)).toBe("G0");
		expect(kpToGScale(5)).toBe("G1");
		expect(kpToGScale(6.33)).toBe("G2");
		expect(kpToGScale(7.33)).toBe("G3");
		expect(kpToGScale(9)).toBe("G5");
		// Kp is capped at 9; anything above still reads G5.
		expect(kpToGScale(9.99)).toBe("G5");
	});
});

describe("auroraProbabilityAt", () => {
	const grid: [number, number, number][] = [
		[356, 40, 42],
		[338, 64, 78],
		[0, -90, 5],
	];

	test("finds the nearest 1° cell, wrapping negative longitudes", () => {
		// Madrid: lat 40.4168 → 40, lon -3.7038 → -4 → 356.
		expect(auroraProbabilityAt(grid, 40.4168, -3.7038)).toBe(42);
		// Reykjavik: lat 64.13 → 64, lon -21.9 → -22 → 338.
		expect(auroraProbabilityAt(grid, 64.13, -21.9)).toBe(78);
	});

	test("clamps latitude at the poles", () => {
		expect(auroraProbabilityAt(grid, -90.4, 0.2)).toBe(5);
	});

	test("returns undefined for a cell the grid lacks", () => {
		expect(auroraProbabilityAt(grid, 10, 10)).toBeUndefined();
	});
});
