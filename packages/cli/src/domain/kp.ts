import { parseEpoch } from "./propagation";
import { round } from "./round";
import { kpToGScale } from "./space-weather";

/** One 3-hour planetary Kp bin, timestamped at the bin start (UTC). */
export interface KpSample {
	time: string;
	kp: number;
	/** Definitive value from GFZ, as opposed to a preliminary nowcast. */
	definitive: boolean;
}

/** A 3-hour Kp bin covers [start, start + 3h). */
const KP_BIN_MS = 3 * 3_600_000;

/**
 * Highest Kp among the bins overlapping [fromMs, toMs], or undefined when no
 * bin does — the geomagnetic context of an orbital-event window.
 */
export function maxKpInWindow(
	samples: KpSample[],
	fromMs: number,
	toMs: number,
): number | undefined {
	let max: number | undefined;
	for (const sample of samples) {
		const startMs = parseEpoch(sample.time)?.getTime();
		if (startMs === undefined) {
			continue;
		}
		if (startMs + KP_BIN_MS <= fromMs || startMs > toMs) {
			continue;
		}
		if (max === undefined || sample.kp > max) {
			max = sample.kp;
		}
	}
	return max;
}

export interface GeomagneticStorm {
	start: string;
	end: string;
	maxKp: number;
	noaaScale: string;
}

export interface GeomagneticSummary {
	maxKp: number;
	maxKpTime: string;
	/** Runs of consecutive bins at storm level (Kp >= 5, NOAA G1+). */
	storms: GeomagneticStorm[];
}

const STORM_KP_THRESHOLD = 5;

/** Storm-level runs and overall maximum of a Kp series (empty → undefined). */
export function summarizeKp(
	samples: KpSample[],
): GeomagneticSummary | undefined {
	const usable = samples
		.map((sample) => ({ sample, ms: parseEpoch(sample.time)?.getTime() }))
		.filter((entry): entry is { sample: KpSample; ms: number } =>
			Number.isFinite(entry.ms),
		)
		.sort((a, b) => a.ms - b.ms);
	if (usable.length === 0) {
		return undefined;
	}

	let max = usable[0] as { sample: KpSample; ms: number };
	for (const entry of usable) {
		if (entry.sample.kp > max.sample.kp) {
			max = entry;
		}
	}

	const storms: GeomagneticStorm[] = [];
	let run: { startMs: number; endMs: number; maxKp: number } | undefined;
	for (const { sample, ms } of usable) {
		if (sample.kp >= STORM_KP_THRESHOLD) {
			if (run === undefined) {
				run = { startMs: ms, endMs: ms + KP_BIN_MS, maxKp: sample.kp };
			} else {
				run.endMs = ms + KP_BIN_MS;
				run.maxKp = Math.max(run.maxKp, sample.kp);
			}
		} else if (run !== undefined) {
			storms.push(toStorm(run));
			run = undefined;
		}
	}
	if (run !== undefined) {
		storms.push(toStorm(run));
	}

	return {
		maxKp: round(max.sample.kp),
		maxKpTime: new Date(max.ms).toISOString(),
		storms,
	};
}

function toStorm(run: {
	startMs: number;
	endMs: number;
	maxKp: number;
}): GeomagneticStorm {
	return {
		start: new Date(run.startMs).toISOString(),
		end: new Date(run.endMs).toISOString(),
		maxKp: round(run.maxKp),
		noaaScale: kpToGScale(run.maxKp),
	};
}
