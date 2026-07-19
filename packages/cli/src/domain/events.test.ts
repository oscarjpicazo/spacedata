import { describe, expect, test } from "bun:test";
import { type AnalyzableElset, analyzeElsetSeries } from "./events";
import { ISS_GP_HISTORY_RAW } from "./iss-history.fixture";
import type { KpSample } from "./kp";
import { propagationResidualKm } from "./propagation";
import { gpHistoryArraySchema } from "./spacetrack.schema";

const MU_EARTH_KM3_S2 = 398600.4418;

function issElsets(): AnalyzableElset[] {
	const parsed = gpHistoryArraySchema.parse(ISS_GP_HISTORY_RAW);
	return parsed.map((elset) => ({
		noradId: elset.NORAD_CAT_ID,
		name: elset.OBJECT_NAME,
		epoch: elset.EPOCH,
		meanMotionRevPerDay: elset.MEAN_MOTION,
		eccentricity: elset.ECCENTRICITY,
		inclinationDeg: elset.INCLINATION,
		raOfAscNodeDeg: elset.RA_OF_ASC_NODE,
		argOfPericenterDeg: elset.ARG_OF_PERICENTER,
		meanAnomalyDeg: elset.MEAN_ANOMALY,
		bstar: elset.BSTAR,
	}));
}

function revPerDay(semiMajorAxisKm: number): number {
	return (
		(Math.sqrt(MU_EARTH_KM3_S2 / semiMajorAxisKm ** 3) * 86_400) / (2 * Math.PI)
	);
}

/** Deterministic pseudo-noise in [-1, 1) — tests must not use Math.random. */
function noise(seed: number): number {
	const value = Math.sin(seed * 12.9898) * 43758.5453;
	return (value - Math.floor(value)) * 2 - 1;
}

interface SeriesOptions {
	count: number;
	stepHours?: number;
	semiMajorAxisKm?: number;
	/** km/day drift of the baseline (negative = decay). */
	ratePerDay?: number;
	/** km/day drift for the second half; defaults to ratePerDay. */
	recentRatePerDay?: number;
	jumps?: { at: number; deltaAKm?: number; deltaIDeg?: number }[];
	invalidEpochAt?: number;
	duplicateEpochAt?: number[];
}

function mkSeries(options: SeriesOptions): AnalyzableElset[] {
	const stepMs = (options.stepHours ?? 8) * 3_600_000;
	const startMs = Date.UTC(2026, 5, 1);
	const baseA = options.semiMajorAxisKm ?? 6798;
	const rate = options.ratePerDay ?? -0.02;
	const recentRate = options.recentRatePerDay ?? rate;
	const elsets: AnalyzableElset[] = [];
	let aKm = baseA;
	let iDeg = 51.64;
	for (let k = 0; k < options.count; k += 1) {
		const ms = startMs + k * stepMs;
		const stepDays = stepMs / 86_400_000;
		if (k > 0) {
			aKm += (k > options.count / 2 ? recentRate : rate) * stepDays;
		}
		for (const jump of options.jumps ?? []) {
			if (jump.at === k) {
				aKm += jump.deltaAKm ?? 0;
				iDeg += jump.deltaIDeg ?? 0;
			}
		}
		const epoch =
			options.invalidEpochAt === k
				? "not-a-date"
				: new Date(options.duplicateEpochAt?.includes(k) ? startMs : ms)
						.toISOString()
						.slice(0, 19);
		elsets.push({
			noradId: 99999,
			name: "SYNTHETIC",
			epoch,
			meanMotionRevPerDay: revPerDay(aKm + 0.003 * noise(k)),
			eccentricity: 0.0002,
			inclinationDeg: iDeg + 0.001 * noise(k + 100),
			raOfAscNodeDeg: 120,
			argOfPericenterDeg: 30,
			meanAnomalyDeg: (k * 137) % 360,
			bstar: 0.0001,
		});
	}
	return elsets;
}

function mkKp(fromMs: number, hours: number, kp: number): KpSample[] {
	const samples: KpSample[] = [];
	for (let ms = fromMs; ms < fromMs + hours * 3_600_000; ms += 3 * 3_600_000) {
		samples.push({
			time: new Date(ms).toISOString(),
			kp,
			definitive: false,
		});
	}
	return samples;
}

const SYNTHETIC_START_MS = Date.UTC(2026, 5, 1);
const NO_RESIDUALS = { residuals: false };

describe("analyzeElsetSeries on the real ISS history", () => {
	test("detects the 2026-07-02 reboost — and nothing else in 30 days", () => {
		const analysis = analyzeElsetSeries(issElsets(), undefined);

		expect(analysis.events).toHaveLength(1);
		const event = analysis.events[0];
		expect(event?.type).toBe("maneuver");
		expect(event?.subtype).toBe("orbit-raise");
		expect(event?.confidence).toBe("high");
		expect(event?.window.from).toBe("2026-07-01T12:11:46.289760");
		expect(event?.window.to).toBe("2026-07-04T02:07:57.020160");
		expect(event?.evidence.deltaSemiMajorAxisKm ?? 0).toBeGreaterThan(1.7);
		expect(event?.evidence.deltaSemiMajorAxisKm ?? 0).toBeLessThan(2.1);
		// A ~1 m/s burn: the typical ISS reboost magnitude.
		expect(event?.estimatedDvMs ?? 0).toBeGreaterThan(0.9);
		expect(event?.estimatedDvMs ?? 0).toBeLessThan(1.3);
		// The SGP4 residual corroborates the jump by orders of magnitude.
		expect(event?.evidence.sgp4ResidualKm ?? 0).toBeGreaterThan(
			(event?.evidence.residualThresholdKm ?? Number.POSITIVE_INFINITY) * 3,
		);
	});

	test("reports the series statistics of a drag-sensitive LEO", () => {
		const analysis = analyzeElsetSeries(issElsets(), undefined);

		expect(analysis.regime).toBe("leo");
		expect(analysis.dragSensitive).toBe(true);
		// 99 raw rows collapse to 83 unique epochs (upstream re-releases).
		expect(analysis.elsetCount).toBe(83);
		expect(analysis.noiseFloor?.semiMajorAxisKm ?? 1).toBeLessThanOrEqual(0.02);
		expect(analysis.decayRateKmPerDay ?? 0).toBeLessThan(-0.005);
		expect(analysis.decayRateKmPerDay ?? -1).toBeGreaterThan(-0.06);
	});

	test("a storm in the window cannot demote an orbit raise", () => {
		// Kp 6 across the whole window: drag can only lower an orbit, so the
		// raise must still be reported as a maneuver.
		const kp = mkKp(Date.UTC(2026, 5, 19), 31 * 24, 6);
		const analysis = analyzeElsetSeries(issElsets(), kp);

		expect(analysis.events).toHaveLength(1);
		expect(analysis.events[0]?.type).toBe("maneuver");
		expect(analysis.events[0]?.subtype).toBe("orbit-raise");
		expect(analysis.events[0]?.evidence.maxKp).toBe(6);
	});
});

describe("analyzeElsetSeries on synthetic series", () => {
	test("a quiet decaying series produces no events", () => {
		const analysis = analyzeElsetSeries(
			mkSeries({ count: 45 }),
			mkKp(SYNTHETIC_START_MS, 15 * 24, 2),
			NO_RESIDUALS,
		);
		expect(analysis.events).toHaveLength(0);
		expect(analysis.regime).toBe("leo");
		expect(analysis.dragSensitive).toBe(true);
	});

	test("a +0.5 km jump is an orbit-raise maneuver", () => {
		const analysis = analyzeElsetSeries(
			mkSeries({ count: 45, jumps: [{ at: 20, deltaAKm: 0.5 }] }),
			undefined,
			NO_RESIDUALS,
		);
		expect(analysis.events).toHaveLength(1);
		const event = analysis.events[0];
		expect(event?.subtype).toBe("orbit-raise");
		// Anti-drag sign argument: high confidence even without residuals.
		expect(event?.confidence).toBe("high");
		expect(event?.evidence.zScore ?? 0).toBeGreaterThan(5);
	});

	test("a -0.5 km jump under quiet Kp is an orbit-lower maneuver", () => {
		const analysis = analyzeElsetSeries(
			mkSeries({ count: 45, jumps: [{ at: 20, deltaAKm: -0.5 }] }),
			mkKp(SYNTHETIC_START_MS, 15 * 24, 2),
			NO_RESIDUALS,
		);
		expect(analysis.events).toHaveLength(1);
		expect(analysis.events[0]?.type).toBe("maneuver");
		expect(analysis.events[0]?.subtype).toBe("orbit-lower");
		expect(analysis.events[0]?.confidence).toBe("medium");
	});

	test("a small decay step during a Kp 8 storm is a storm response", () => {
		const analysis = analyzeElsetSeries(
			mkSeries({ count: 45, jumps: [{ at: 20, deltaAKm: -0.15 }] }),
			mkKp(SYNTHETIC_START_MS, 15 * 24, 8),
			NO_RESIDUALS,
		);
		expect(analysis.events).toHaveLength(1);
		const event = analysis.events[0];
		expect(event?.type).toBe("drag-anomaly");
		expect(event?.subtype).toBe("storm-response");
		expect(event?.evidence.maxKp).toBe(8);
		expect(event?.evidence.stormPlausibleKm ?? 0).toBeGreaterThanOrEqual(0.15);
		expect(event?.estimatedDvMs).toBeUndefined();
	});

	test("an inclination jump is a plane change with the right Δv scale", () => {
		const analysis = analyzeElsetSeries(
			mkSeries({ count: 45, jumps: [{ at: 20, deltaIDeg: 0.05 }] }),
			undefined,
			NO_RESIDUALS,
		);
		expect(analysis.events).toHaveLength(1);
		const event = analysis.events[0];
		expect(event?.subtype).toBe("plane-change");
		// v·Δi at LEO speed: 7.66 km/s × 0.05° ≈ 6.7 m/s.
		expect(event?.estimatedDvMs ?? 0).toBeGreaterThan(5);
		expect(event?.estimatedDvMs ?? 0).toBeLessThan(8);
	});

	test("a decay rate doubling under quiet Kp is a decay anomaly", () => {
		const analysis = analyzeElsetSeries(
			mkSeries({ count: 45, ratePerDay: -0.01, recentRatePerDay: -0.05 }),
			mkKp(SYNTHETIC_START_MS, 15 * 24, 2),
			NO_RESIDUALS,
		);
		const decay = analysis.events.find((e) => e.type === "decay-anomaly");
		expect(decay?.subtype).toBe("accelerated-decay");
		expect(decay?.confidence).toBe("medium");
		expect(decay?.evidence.recentDecayKmPerDay ?? 0).toBeLessThan(
			2 * (decay?.evidence.baselineDecayKmPerDay ?? 0),
		);
		expect(analysis.decayRateKmPerDay ?? 0).toBeLessThan(-0.03);
	});

	test("the same acceleration during a storm is not an anomaly", () => {
		const analysis = analyzeElsetSeries(
			mkSeries({ count: 45, ratePerDay: -0.01, recentRatePerDay: -0.05 }),
			mkKp(SYNTHETIC_START_MS, 15 * 24, 7),
			NO_RESIDUALS,
		);
		expect(
			analysis.events.find((e) => e.type === "decay-anomaly"),
		).toBeUndefined();
	});

	test("too few element sets disables detection with a warning", () => {
		const analysis = analyzeElsetSeries(
			mkSeries({ count: 5, jumps: [{ at: 2, deltaAKm: 5 }] }),
			undefined,
			NO_RESIDUALS,
		);
		expect(analysis.events).toHaveLength(0);
		expect(analysis.warnings.some((w) => w.includes("needs at least 8"))).toBe(
			true,
		);
	});

	test("duplicate epochs are deduplicated and bad epochs warned about", () => {
		const analysis = analyzeElsetSeries(
			mkSeries({
				count: 12,
				duplicateEpochAt: [5, 6],
				invalidEpochAt: 9,
			}),
			undefined,
			NO_RESIDUALS,
		);
		// 12 rows − 1 invalid − 2 collapsing onto the first epoch.
		expect(analysis.elsetCount).toBe(9);
		expect(analysis.warnings.some((w) => w.includes("unparsable epochs"))).toBe(
			true,
		);
	});
});

describe("propagationResidualKm", () => {
	test("is small across a quiet gap and huge across the reboost", () => {
		const elsets = issElsets();
		const analysis = analyzeElsetSeries(elsets, undefined);
		const rebootFrom = analysis.events[0]?.window.from;
		const rebootTo = analysis.events[0]?.window.to;
		const byEpoch = new Map(elsets.map((e) => [e.epoch, e]));

		const pre = byEpoch.get(rebootFrom ?? "");
		const post = byEpoch.get(rebootTo ?? "");
		expect(pre).toBeDefined();
		expect(post).toBeDefined();

		const toPropagatable = (e: AnalyzableElset) => ({
			noradId: e.noradId,
			name: e.name ?? "",
			epoch: e.epoch,
			meanMotionRevPerDay: e.meanMotionRevPerDay,
			eccentricity: e.eccentricity,
			inclinationDeg: e.inclinationDeg,
			raOfAscNodeDeg: e.raOfAscNodeDeg,
			argOfPericenterDeg: e.argOfPericenterDeg,
			meanAnomalyDeg: e.meanAnomalyDeg,
			bstar: e.bstar ?? 0,
		});

		const across = propagationResidualKm(
			toPropagatable(pre as AnalyzableElset),
			toPropagatable(post as AnalyzableElset),
		);
		expect(across ?? 0).toBeGreaterThan(50);

		// Two consecutive quiet elsets from the start of the series.
		const quiet = propagationResidualKm(
			toPropagatable(elsets[0] as AnalyzableElset),
			toPropagatable(elsets[1] as AnalyzableElset),
		);
		expect(quiet ?? 100).toBeLessThan(2);
	});
});
