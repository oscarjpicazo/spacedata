import { describe, expect, test } from "bun:test";
import { type KpSample, maxKpInWindow, summarizeKp } from "./kp";

function sample(time: string, kp: number): KpSample {
	return { time, kp, definitive: false };
}

describe("maxKpInWindow", () => {
	const samples = [
		sample("2026-07-01T00:00:00Z", 2),
		sample("2026-07-01T03:00:00Z", 5),
		sample("2026-07-01T06:00:00Z", 3),
	];

	test("returns the highest Kp of the overlapping bins", () => {
		expect(
			maxKpInWindow(samples, Date.UTC(2026, 6, 1, 2), Date.UTC(2026, 6, 1, 7)),
		).toBe(5);
	});

	test("a bin overlapping only the window start still counts", () => {
		// The 03:00 bin covers [03:00, 06:00); a window starting 05:00 is in it.
		expect(
			maxKpInWindow(
				samples,
				Date.UTC(2026, 6, 1, 5),
				Date.UTC(2026, 6, 1, 5, 30),
			),
		).toBe(5);
	});

	test("returns undefined when no bin overlaps", () => {
		expect(
			maxKpInWindow(samples, Date.UTC(2026, 6, 2), Date.UTC(2026, 6, 3)),
		).toBeUndefined();
	});
});

describe("summarizeKp", () => {
	test("groups consecutive storm-level bins into one storm", () => {
		const summary = summarizeKp([
			sample("2026-07-01T00:00:00Z", 3),
			sample("2026-07-01T03:00:00Z", 5.333),
			sample("2026-07-01T06:00:00Z", 6.667),
			sample("2026-07-01T09:00:00Z", 4),
			sample("2026-07-01T12:00:00Z", 5),
		]);
		expect(summary?.maxKp).toBe(6.667);
		expect(summary?.storms).toHaveLength(2);
		expect(summary?.storms[0]?.start).toBe("2026-07-01T03:00:00.000Z");
		expect(summary?.storms[0]?.end).toBe("2026-07-01T09:00:00.000Z");
		expect(summary?.storms[0]?.maxKp).toBe(6.667);
		expect(summary?.storms[0]?.noaaScale).toBe("G2");
		expect(summary?.storms[1]?.noaaScale).toBe("G1");
	});

	test("a quiet series has a max but no storms", () => {
		const summary = summarizeKp([
			sample("2026-07-01T00:00:00Z", 2),
			sample("2026-07-01T03:00:00Z", 3.667),
		]);
		expect(summary?.maxKp).toBe(3.667);
		expect(summary?.maxKpTime).toBe("2026-07-01T03:00:00.000Z");
		expect(summary?.storms).toHaveLength(0);
	});

	test("an empty series summarizes to undefined", () => {
		expect(summarizeKp([])).toBeUndefined();
	});
});
