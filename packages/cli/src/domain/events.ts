import { type KpSample, maxKpInWindow } from "./kp";
import {
	type PropagatableElements,
	parseEpoch,
	propagationResidualKm,
} from "./propagation";
import { round } from "./round";

/**
 * One historical element set, as needed by the event detectors. Structurally
 * satisfied by the Space-Track `HistoricalElset` — field names match on
 * purpose. Semi-major axis and perigee are recomputed here at full precision
 * instead of reusing the 3-decimal `derived` block: the detectors work at
 * meter scale, below the output contract's rounding.
 */
export interface AnalyzableElset {
	noradId: number;
	name?: string | undefined;
	/** Element set epoch as served by Space-Track (ISO 8601, no zone = UTC). */
	epoch: string;
	meanMotionRevPerDay: number;
	eccentricity: number;
	inclinationDeg: number;
	raOfAscNodeDeg: number;
	argOfPericenterDeg: number;
	meanAnomalyDeg: number;
	bstar?: number | undefined;
}

export type OrbitRegime = "leo" | "meo" | "geo" | "heo";

export type OrbitalEventType = "maneuver" | "drag-anomaly" | "decay-anomaly";

export type OrbitalEventSubtype =
	| "orbit-raise"
	| "orbit-lower"
	| "plane-change"
	| "storm-response"
	| "accelerated-decay"
	| "unclassified";

export type EventConfidence = "low" | "medium" | "high";

/**
 * The numbers behind an event verdict. Deliberately exhaustive: these are
 * inferences from public mean elements, so every event must carry enough
 * evidence for an agent to second-guess the classification.
 */
export interface OrbitalEventEvidence {
	/** Net semi-major axis change across the window, drag-trend removed (km). */
	deltaSemiMajorAxisKm?: number;
	deltaInclinationDeg?: number;
	/** Highest robust z-score (vs median/MAD noise) inside the window. */
	zScore?: number;
	/** 1-sigma-equivalent noise of this object's Δa series (km). */
	noiseFloorKm?: number;
	sgp4ResidualKm?: number;
	residualThresholdKm?: number;
	/** Largest gap between consecutive element sets inside the window (days). */
	gapDays: number;
	/** Highest planetary Kp overlapping the window (GFZ), when available. */
	maxKp?: number;
	/** Rough upper bound of storm-driven decay for this window (km). */
	stormPlausibleKm?: number;
	baselineDecayKmPerDay?: number;
	recentDecayKmPerDay?: number;
}

export interface OrbitalEvent {
	type: OrbitalEventType;
	subtype: OrbitalEventSubtype;
	confidence: EventConfidence;
	/** The event happened between these two element set epochs (UTC). */
	window: { from: string; to: string };
	evidence: OrbitalEventEvidence;
	/** Impulsive Δv consistent with the element change (m/s); maneuvers only. */
	estimatedDvMs?: number;
}

export interface ElsetSeriesAnalysis {
	regime: OrbitRegime;
	/** Perigee low enough (< 600 km) for storms to move the orbit measurably. */
	dragSensitive: boolean;
	/** Element sets actually analyzed (deduplicated, parsable epochs). */
	elsetCount: number;
	span: { from: string; to: string } | undefined;
	noiseFloor: { semiMajorAxisKm: number; inclinationDeg: number } | undefined;
	/** Median recent da/dt (km/day, negative = decaying); drag-sensitive only. */
	decayRateKmPerDay?: number;
	events: OrbitalEvent[];
	warnings: string[];
}

/** Mirrors derive.ts — the detectors need full precision, not rounded output. */
const MU_EARTH_KM3_S2 = 398600.4418;
const EARTH_EQUATORIAL_RADIUS_KM = 6378.137;

/** Robust z-score above which a detrended element jump is a candidate event. */
const JUMP_Z_THRESHOLD = 5;
/** z at (or above) which a corroborated jump is high-confidence. */
const HIGH_CONFIDENCE_Z = 10;
/** Residual multiple that triggers an event with no element jump. */
const RESIDUAL_ONLY_MULTIPLE = 3;
/** Residuals are only meaningful over gaps SGP4 can bridge accurately. */
const RESIDUAL_MAX_GAP_DAYS = 5;
/** Minimum series length for jump detection to be statistically meaningful. */
const MIN_ELSETS_FOR_DETECTION = 8;

/**
 * Per-regime floors for the noise estimate, in km (Δa) and degrees (Δi):
 * a MAD computed over a handful of quiet deltas can be unrealistically small,
 * and 5x these floors is the smallest jump worth reporting in each regime.
 */
const NOISE_FLOOR: Record<OrbitRegime, { aKm: number; iDeg: number }> = {
	leo: { aKm: 0.01, iDeg: 0.002 },
	meo: { aKm: 0.06, iDeg: 0.004 },
	geo: { aKm: 0.06, iDeg: 0.004 },
	heo: { aKm: 0.1, iDeg: 0.004 },
};

interface Sample {
	elset: AnalyzableElset;
	epochMs: number;
	semiMajorAxisKm: number;
	perigeeAltitudeKm: number;
	periodMinutes: number;
}

interface Pair {
	/** Index of the later sample; the pair spans samples[index-1] → [index]. */
	index: number;
	gapDays: number;
	deltaAKm: number;
	deltaIDeg: number;
	anomalyAKm: number;
	zA: number;
	zI: number;
	residualKm: number | undefined;
	residualThresholdKm: number;
	jump: boolean;
	residualTrigger: boolean;
	corroborated: boolean;
}

/**
 * Detect orbital events in one object's element history: impulsive maneuvers
 * (semi-major axis / inclination jumps beyond the series' own noise,
 * corroborated by SGP4 propagation residuals), storm-driven drag responses
 * (cross-checked against planetary Kp) and decay-rate anomalies.
 *
 * Pass `kpSamples` covering the same window to enable the storm cross-check;
 * without it, decays that coincide with geomagnetic storms are reported as
 * maneuvers with lower confidence.
 */
export function analyzeElsetSeries(
	elsets: AnalyzableElset[],
	kpSamples: KpSample[] | undefined,
	options?: { residuals?: boolean },
): ElsetSeriesAnalysis {
	const warnings: string[] = [];
	const samples = normalize(elsets, warnings);

	if (samples.length < 2) {
		warnings.push(
			`only ${samples.length} usable element set(s) in the window; event detection needs at least ${MIN_ELSETS_FOR_DETECTION}`,
		);
		return {
			regime: samples.length > 0 ? regimeOf(samples) : "leo",
			dragSensitive: samples.length > 0 ? isDragSensitive(samples) : false,
			elsetCount: samples.length,
			span:
				samples.length > 0
					? {
							from: (samples[0] as Sample).elset.epoch,
							to: (samples[samples.length - 1] as Sample).elset.epoch,
						}
					: undefined,
			noiseFloor: undefined,
			events: [],
			warnings,
		};
	}

	const regime = regimeOf(samples);
	const dragSensitive = isDragSensitive(samples);
	const floor = NOISE_FLOOR[regime];

	// Detrend Δa by this object's own median decay rate: drag accumulates with
	// the gap between element sets, so raw deltas over long gaps would look
	// like jumps. What remains after detrending is noise — or an event.
	const rawPairs = buildRawPairs(samples);
	const medianRate = median(rawPairs.map((p) => p.deltaAKm / p.gapDays));
	const anomalies = rawPairs.map((p) => p.deltaAKm - medianRate * p.gapDays);
	const anomalyCenter = median(anomalies);
	const noiseA = Math.max(
		1.4826 * medianAbsoluteDeviation(anomalies, anomalyCenter),
		floor.aKm,
	);

	const deltaIs = rawPairs.map((p) => p.deltaIDeg);
	const medianI = median(deltaIs);
	const noiseI = Math.max(
		1.4826 * medianAbsoluteDeviation(deltaIs, medianI),
		floor.iDeg,
	);

	const detect = samples.length >= MIN_ELSETS_FOR_DETECTION;
	if (!detect) {
		warnings.push(
			`only ${samples.length} usable element sets in the window; event detection needs at least ${MIN_ELSETS_FOR_DETECTION}`,
		);
	}

	const useResiduals = options?.residuals !== false;
	const pairs: Pair[] = rawPairs.map((raw, at) => {
		const anomaly = (anomalies[at] as number) - anomalyCenter;
		// Long gaps accumulate unmodeled drag variation on top of measurement
		// noise; widening sigma with the gap keeps them from flagging.
		const zA = Math.abs(anomaly) / (noiseA * (1 + 0.5 * raw.gapDays));
		const zI = Math.abs((deltaIs[at] as number) - medianI) / noiseI;
		const residualThresholdKm =
			regime === "leo" ? 2 + 3 * raw.gapDays : 5 + 5 * raw.gapDays;
		const residualKm =
			useResiduals && detect && raw.gapDays <= RESIDUAL_MAX_GAP_DAYS
				? residualBetween(samples, raw.index)
				: undefined;
		const jump = detect && (zA >= JUMP_Z_THRESHOLD || zI >= JUMP_Z_THRESHOLD);
		const residualTrigger =
			detect &&
			residualKm !== undefined &&
			residualKm >= RESIDUAL_ONLY_MULTIPLE * residualThresholdKm;
		return {
			index: raw.index,
			gapDays: raw.gapDays,
			deltaAKm: raw.deltaAKm,
			deltaIDeg: raw.deltaIDeg,
			anomalyAKm: anomaly,
			zA,
			zI,
			residualKm,
			residualThresholdKm,
			jump,
			residualTrigger,
			corroborated:
				residualTrigger ||
				(residualKm !== undefined && residualKm >= residualThresholdKm),
		};
	});

	const largestGap = Math.max(...pairs.map((p) => p.gapDays));
	if (largestGap > 3) {
		warnings.push(
			`the series has a ${round(largestGap)}-day tracking gap; events spanning it carry reduced confidence`,
		);
	}

	const events: OrbitalEvent[] = [];
	for (const group of groupFlagged(pairs)) {
		events.push(
			buildEvent(group, samples, {
				regime,
				dragSensitive,
				medianRate,
				noiseA,
				noiseI,
				kpSamples,
			}),
		);
	}

	const decay = decayTrend(
		samples,
		pairs,
		medianRate,
		dragSensitive,
		kpSamples,
	);
	if (decay.event !== undefined) {
		events.push(decay.event);
	}
	events.sort((a, b) => (a.window.from < b.window.from ? -1 : 1));

	return {
		regime,
		dragSensitive,
		elsetCount: samples.length,
		span: {
			from: (samples[0] as Sample).elset.epoch,
			to: (samples[samples.length - 1] as Sample).elset.epoch,
		},
		noiseFloor: {
			semiMajorAxisKm: round(noiseA),
			inclinationDeg: round(noiseI),
		},
		decayRateKmPerDay: decay.recentRate,
		events,
		warnings,
	};
}

function normalize(elsets: AnalyzableElset[], warnings: string[]): Sample[] {
	const byEpoch = new Map<number, Sample>();
	let invalid = 0;
	for (const elset of elsets) {
		const epochDate = parseEpoch(elset.epoch);
		if (epochDate === undefined) {
			invalid += 1;
			continue;
		}
		const meanMotionRadPerSec =
			(elset.meanMotionRevPerDay * 2 * Math.PI) / 86_400;
		const semiMajorAxisKm =
			(MU_EARTH_KM3_S2 / meanMotionRadPerSec ** 2) ** (1 / 3);
		// Re-released element sets share an epoch; the later row supersedes.
		byEpoch.set(epochDate.getTime(), {
			elset,
			epochMs: epochDate.getTime(),
			semiMajorAxisKm,
			perigeeAltitudeKm:
				semiMajorAxisKm * (1 - elset.eccentricity) - EARTH_EQUATORIAL_RADIUS_KM,
			periodMinutes: 1440 / elset.meanMotionRevPerDay,
		});
	}
	if (invalid > 0) {
		warnings.push(`${invalid} element set(s) had unparsable epochs`);
	}
	return [...byEpoch.values()].sort((a, b) => a.epochMs - b.epochMs);
}

function regimeOf(samples: Sample[]): OrbitRegime {
	const eccentricity = median(samples.map((s) => s.elset.eccentricity));
	if (eccentricity >= 0.25) {
		return "heo";
	}
	const period = median(samples.map((s) => s.periodMinutes));
	if (period < 128) {
		return "leo";
	}
	if (period >= 1250 && period <= 1600) {
		return "geo";
	}
	return "meo";
}

function isDragSensitive(samples: Sample[]): boolean {
	return median(samples.map((s) => s.perigeeAltitudeKm)) < 600;
}

function buildRawPairs(
	samples: Sample[],
): { index: number; gapDays: number; deltaAKm: number; deltaIDeg: number }[] {
	const pairs: {
		index: number;
		gapDays: number;
		deltaAKm: number;
		deltaIDeg: number;
	}[] = [];
	for (let index = 1; index < samples.length; index += 1) {
		const previous = samples[index - 1] as Sample;
		const current = samples[index] as Sample;
		pairs.push({
			index,
			// Same-epoch duplicates were removed, but guard the division anyway.
			gapDays: Math.max(
				(current.epochMs - previous.epochMs) / 86_400_000,
				1e-6,
			),
			deltaAKm: current.semiMajorAxisKm - previous.semiMajorAxisKm,
			deltaIDeg: current.elset.inclinationDeg - previous.elset.inclinationDeg,
		});
	}
	return pairs;
}

function residualBetween(samples: Sample[], index: number): number | undefined {
	const from = samples[index - 1] as Sample;
	const to = samples[index] as Sample;
	return propagationResidualKm(
		toPropagatable(from.elset),
		toPropagatable(to.elset),
	);
}

function toPropagatable(elset: AnalyzableElset): PropagatableElements {
	return {
		noradId: elset.noradId,
		name: elset.name ?? "",
		epoch: elset.epoch,
		meanMotionRevPerDay: elset.meanMotionRevPerDay,
		eccentricity: elset.eccentricity,
		inclinationDeg: elset.inclinationDeg,
		raOfAscNodeDeg: elset.raOfAscNodeDeg,
		argOfPericenterDeg: elset.argOfPericenterDeg,
		meanAnomalyDeg: elset.meanAnomalyDeg,
		bstar: elset.bstar ?? 0,
	};
}

/** Consecutive flagged pairs describe one event; merge them into groups. */
function groupFlagged(pairs: Pair[]): Pair[][] {
	const groups: Pair[][] = [];
	let current: Pair[] = [];
	for (const pair of pairs) {
		if (pair.jump || pair.residualTrigger) {
			current.push(pair);
		} else if (current.length > 0) {
			groups.push(current);
			current = [];
		}
	}
	if (current.length > 0) {
		groups.push(current);
	}
	return groups;
}

interface SeriesContext {
	regime: OrbitRegime;
	dragSensitive: boolean;
	medianRate: number;
	noiseA: number;
	noiseI: number;
	kpSamples: KpSample[] | undefined;
}

function buildEvent(
	group: Pair[],
	samples: Sample[],
	context: SeriesContext,
): OrbitalEvent {
	const first = group[0] as Pair;
	const last = group[group.length - 1] as Pair;
	const pre = samples[first.index - 1] as Sample;
	const post = samples[last.index] as Sample;
	const spanDays = (post.epochMs - pre.epochMs) / 86_400_000;

	const netDeltaA =
		post.semiMajorAxisKm - pre.semiMajorAxisKm - context.medianRate * spanDays;
	const netDeltaI = post.elset.inclinationDeg - pre.elset.inclinationDeg;

	const zMax = Math.max(...group.map((p) => Math.max(p.zA, p.zI)));
	const gapMax = Math.max(...group.map((p) => p.gapDays));
	const corroborated = group.some((p) => p.corroborated);
	const residualMax = group.reduce<
		{ residualKm: number; thresholdKm: number } | undefined
	>((best, p) => {
		if (p.residualKm === undefined) {
			return best;
		}
		if (best === undefined || p.residualKm > best.residualKm) {
			return { residualKm: p.residualKm, thresholdKm: p.residualThresholdKm };
		}
		return best;
	}, undefined);

	const maxKp =
		context.kpSamples === undefined
			? undefined
			: maxKpInWindow(context.kpSamples, pre.epochMs, post.epochMs);

	const aSignificant = Math.abs(netDeltaA) >= 5 * context.noiseA;
	const iSignificant = Math.abs(netDeltaI) >= 5 * context.noiseI;
	const stormPlausibleKm =
		context.dragSensitive && maxKp !== undefined && maxKp >= 5
			? plausibleStormDecayKm(maxKp, spanDays)
			: undefined;

	let type: OrbitalEventType = "maneuver";
	let subtype: OrbitalEventSubtype;
	if (iSignificant) {
		subtype = "plane-change";
	} else if (aSignificant && netDeltaA > 0) {
		subtype = "orbit-raise";
	} else if (aSignificant && netDeltaA < 0) {
		if (
			stormPlausibleKm !== undefined &&
			Math.abs(netDeltaA) <= stormPlausibleKm
		) {
			type = "drag-anomaly";
			subtype = "storm-response";
		} else {
			subtype = "orbit-lower";
		}
	} else if (stormPlausibleKm !== undefined && netDeltaA <= 0) {
		// Residual-only trigger during a storm on a drag-sensitive orbit: the
		// along-track surprise is most simply explained by storm drag.
		type = "drag-anomaly";
		subtype = "storm-response";
	} else {
		subtype = "unclassified";
	}

	const evidence: OrbitalEventEvidence = {
		deltaSemiMajorAxisKm: round(netDeltaA),
		deltaInclinationDeg: round(netDeltaI),
		zScore: round(zMax),
		noiseFloorKm: round(context.noiseA),
		sgp4ResidualKm:
			residualMax === undefined ? undefined : round(residualMax.residualKm),
		residualThresholdKm:
			residualMax === undefined ? undefined : round(residualMax.thresholdKm),
		gapDays: round(gapMax),
		maxKp,
		stormPlausibleKm:
			stormPlausibleKm === undefined ? undefined : round(stormPlausibleKm),
	};

	if (type !== "maneuver") {
		return {
			type,
			subtype,
			confidence: gapMax > 3 ? "low" : "medium",
			window: { from: pre.elset.epoch, to: post.elset.epoch },
			evidence,
		};
	}

	// Confidence ladder, deterministic: start at medium, one promotion, then
	// demotions for each independent reason to doubt the verdict.
	let level = 1;
	const antiDragRaise =
		subtype === "orbit-raise" && context.regime === "leo" && zMax >= 7;
	if ((zMax >= HIGH_CONFIDENCE_Z && corroborated) || antiDragRaise) {
		level = 2;
	}
	if (gapMax > 3 && zMax < 20) {
		level -= 1;
	}
	if (zMax < 6.5 && !corroborated) {
		level -= 1;
	}
	if (subtype === "orbit-lower" && stormPlausibleKm !== undefined) {
		level -= 1; // a storm was in progress; drag could explain part of it
	}
	const confidence: EventConfidence =
		level <= 0 ? "low" : level === 1 ? "medium" : "high";

	return {
		type,
		subtype,
		confidence,
		window: { from: pre.elset.epoch, to: post.elset.epoch },
		evidence,
		estimatedDvMs: estimateDvMs(
			(pre.semiMajorAxisKm + post.semiMajorAxisKm) / 2,
			netDeltaA,
			netDeltaI,
		),
	};
}

/**
 * Crude upper bound (km) for storm-driven semi-major-axis loss: ~80 m/day at
 * Kp 5 on a drag-sensitive orbit, doubling per Kp step. A heuristic, not a
 * thermosphere model — which is why it is reported in the evidence rather
 * than silently applied.
 */
function plausibleStormDecayKm(maxKp: number, windowDays: number): number {
	return 0.08 * 2 ** (Math.min(maxKp, 9) - 5) * Math.max(windowDays, 0.5);
}

/** Impulsive Δv (m/s) consistent with the net element changes. */
function estimateDvMs(
	semiMajorAxisKm: number,
	deltaAKm: number,
	deltaIDeg: number,
): number {
	const speedKmS = Math.sqrt(MU_EARTH_KM3_S2 / semiMajorAxisKm);
	const inPlane = 0.5 * speedKmS * (Math.abs(deltaAKm) / semiMajorAxisKm);
	const outOfPlane = (speedKmS * (Math.abs(deltaIDeg) * Math.PI)) / 180;
	return round(Math.sqrt(inPlane ** 2 + outOfPlane ** 2) * 1000);
}

const MIN_ELSETS_FOR_TREND = 10;
const MIN_TREND_SPAN_DAYS = 10;
/** Baseline decay below this rate (km/day) is too slow to call a trend on. */
const MIN_BASELINE_DECAY_KM_PER_DAY = 0.005;

function decayTrend(
	samples: Sample[],
	pairs: Pair[],
	medianRate: number,
	dragSensitive: boolean,
	kpSamples: KpSample[] | undefined,
): { recentRate: number | undefined; event: OrbitalEvent | undefined } {
	if (!dragSensitive) {
		return { recentRate: undefined, event: undefined };
	}
	// Flagged pairs are maneuvers/storm hits, not the secular trend.
	const quiet = pairs.filter((p) => !p.jump && !p.residualTrigger);
	if (quiet.length < 4) {
		return {
			recentRate: quiet.length > 0 ? round(medianRate) : undefined,
			event: undefined,
		};
	}

	const firstMs = (samples[0] as Sample).epochMs;
	const lastMs = (samples[samples.length - 1] as Sample).epochMs;
	const midMs = (firstMs + lastMs) / 2;
	const rateOf = (p: Pair): number => p.deltaAKm / p.gapDays;
	const early = quiet.filter(
		(p) => (samples[p.index] as Sample).epochMs <= midMs,
	);
	const recent = quiet.filter(
		(p) => (samples[p.index] as Sample).epochMs > midMs,
	);
	const recentRate =
		recent.length > 0 ? median(recent.map(rateOf)) : medianRate;

	const spanDays = (lastMs - firstMs) / 86_400_000;
	if (
		samples.length < MIN_ELSETS_FOR_TREND ||
		spanDays < MIN_TREND_SPAN_DAYS ||
		early.length < 3 ||
		recent.length < 3
	) {
		return { recentRate: round(recentRate), event: undefined };
	}

	const baselineRate = median(early.map(rateOf));
	const accelerated =
		baselineRate <= -MIN_BASELINE_DECAY_KM_PER_DAY &&
		recentRate <= 2 * baselineRate;
	if (!accelerated) {
		return { recentRate: round(recentRate), event: undefined };
	}

	const midSample = samples.reduce((best, s) =>
		Math.abs(s.epochMs - midMs) < Math.abs(best.epochMs - midMs) ? s : best,
	);
	const maxKp =
		kpSamples === undefined
			? undefined
			: maxKpInWindow(kpSamples, midMs, lastMs);
	if (maxKp !== undefined && maxKp >= 5) {
		// The faster decay coincides with a storm: expected physics, not an
		// anomaly of the object. The jump detector reports the storm windows.
		return { recentRate: round(recentRate), event: undefined };
	}

	return {
		recentRate: round(recentRate),
		event: {
			type: "decay-anomaly",
			subtype: "accelerated-decay",
			confidence: maxKp === undefined ? "low" : "medium",
			window: {
				from: midSample.elset.epoch,
				to: (samples[samples.length - 1] as Sample).elset.epoch,
			},
			evidence: {
				baselineDecayKmPerDay: round(baselineRate),
				recentDecayKmPerDay: round(recentRate),
				gapDays: round(Math.max(...recent.map((p) => p.gapDays), 0)),
				maxKp,
			},
		},
	};
}

function median(values: number[]): number {
	if (values.length === 0) {
		return 0;
	}
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? (sorted[mid] as number)
		: ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function medianAbsoluteDeviation(values: number[], center: number): number {
	return median(values.map((value) => Math.abs(value - center)));
}
