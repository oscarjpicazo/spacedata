import {
	type EventConfidence,
	MIN_ELSETS_FOR_DETECTION,
	type OrbitalEvent,
} from "./events";
import { parseEpoch } from "./propagation";
import { round } from "./round";

/**
 * One conjunction as needed by the screening verdict. Structurally satisfied
 * by the SOCRATES `SocratesConjunction` — field names match on purpose.
 */
export interface ScreenableConjunction {
	/** Time of closest approach as served by SOCRATES (UTC, space-separated). */
	tca: string;
	minRangeKm: number;
	relativeSpeedKmS: number;
	maxProbability: number;
	sat1: ScreenableSatellite;
	sat2: ScreenableSatellite;
}

export interface ScreenableSatellite {
	noradId: number;
	name: string;
}

/** The side of a conjunction that is not the screened object. */
export interface ConjunctionPartner {
	noradId: number;
	name: string;
	/** SATCAT object type (PAYLOAD, ROCKET BODY, DEBRIS, …), when known. */
	objectType?: string | undefined;
	operationalStatus?: string | undefined;
	canManeuver: boolean | undefined;
}

export type ScreeningVerdict =
	/** A detected maneuver of the subject overlaps the days before TCA. */
	| "likely-avoidance"
	/** History was analyzed and no maneuver correlates with this TCA. */
	| "no-maneuver-detected"
	/** The subject (debris, rocket body, dead payload) cannot dodge. */
	| "not-maneuverable"
	/** Element history could not be fetched (credentials, upstream). */
	| "history-unavailable"
	/** Too few element sets for maneuver detection to be meaningful. */
	| "insufficient-history";

export type ExpectedMover =
	| "subject"
	| "partner"
	| "either"
	| "neither"
	| "unknown";

/** The numbers behind a likely-avoidance verdict — an inference, never bare. */
export interface AvoidanceEvidence {
	maneuver: OrbitalEvent;
	/**
	 * Days between the maneuver window's end and TCA; negative when the first
	 * element set bounding the maneuver was released after closest approach.
	 */
	leadTimeDays: number;
}

export interface ScreenedConjunction {
	tca: string;
	tcaStatus: "upcoming" | "past";
	minRangeKm: number;
	relativeSpeedKmS: number;
	maxProbability: number;
	partner: ConjunctionPartner;
	/** Who of the pair would be expected to move, from SATCAT type/status. */
	expectedMover: ExpectedMover;
	verdict: ScreeningVerdict;
	/** Inherited from the correlated maneuver; likely-avoidance only. */
	confidence?: EventConfidence | undefined;
	evidence?: AvoidanceEvidence | undefined;
}

/** The subject's element-history analysis, when it could be fetched. */
export interface SubjectHistory {
	elsetCount: number;
	events: OrbitalEvent[];
}

/**
 * A maneuver counts as avoidance-correlated when its epoch window overlaps
 * the last days before TCA: operators typically execute collision-avoidance
 * burns between half a day and two days ahead of the encounter.
 */
export const AVOIDANCE_LOOKBACK_DAYS = 3;

const DAY_MS = 86_400_000;

/** SATCAT object types that can carry propulsion and take commands. */
const MANEUVERABLE_TYPES = new Set(["PAYLOAD"]);
/** Operational statuses that rule maneuvering out even for a payload. */
const INERT_STATUSES = new Set(["NONOPERATIONAL", "DECAYED"]);

/**
 * Whether an object can maneuver, from its SATCAT type and operational
 * status. `undefined` means the catalog cannot tell (unknown type, or a
 * payload with unknown status) — never assumed either way.
 */
export function canManeuver(
	objectType: string | undefined,
	operationalStatus: string | undefined,
): boolean | undefined {
	if (objectType === undefined || objectType === "UNKNOWN") {
		return undefined;
	}
	if (!MANEUVERABLE_TYPES.has(objectType)) {
		return false;
	}
	if (operationalStatus === undefined || operationalStatus === "UNKNOWN") {
		return undefined;
	}
	return !INERT_STATUSES.has(operationalStatus);
}

/**
 * Who of the pair would be expected to move. Conservative: any unknown side
 * makes the answer unknown rather than a guess.
 */
export function expectedMover(
	subjectCanManeuver: boolean | undefined,
	partnerCanManeuver: boolean | undefined,
): ExpectedMover {
	if (subjectCanManeuver === undefined || partnerCanManeuver === undefined) {
		return "unknown";
	}
	if (subjectCanManeuver && partnerCanManeuver) {
		return "either";
	}
	if (subjectCanManeuver) {
		return "subject";
	}
	if (partnerCanManeuver) {
		return "partner";
	}
	return "neither";
}

/** The side of a conjunction that is not the screened object. */
export function partnerOf(
	conjunction: ScreenableConjunction,
	subjectNoradId: number,
): ScreenableSatellite {
	return conjunction.sat1.noradId === subjectNoradId
		? conjunction.sat2
		: conjunction.sat1;
}

/** SOCRATES TCAs are space-separated UTC; normalize before parsing. */
export function parseTca(tca: string): number | undefined {
	return parseEpoch(tca.trim().replace(" ", "T"))?.getTime();
}

/**
 * Screening verdict for one conjunction. A correlated maneuver wins over the
 * catalog's word (a detected burn proves maneuverability); otherwise the
 * verdict degrades honestly through what is actually known: catalog says the
 * subject cannot move → not-maneuverable; no history → history-unavailable;
 * a series too short to detect on → insufficient-history.
 */
export function assessConjunction(
	conjunction: ScreenableConjunction,
	subjectCanManeuver: boolean | undefined,
	partner: ConjunctionPartner,
	history: SubjectHistory | undefined,
	nowMs: number,
): ScreenedConjunction {
	const tcaMs = parseTca(conjunction.tca);
	const correlated =
		history === undefined || tcaMs === undefined
			? undefined
			: bestCorrelatedManeuver(history.events, tcaMs);

	let verdict: ScreeningVerdict;
	if (correlated !== undefined) {
		verdict = "likely-avoidance";
	} else if (subjectCanManeuver === false) {
		verdict = "not-maneuverable";
	} else if (history === undefined) {
		verdict = "history-unavailable";
	} else if (history.elsetCount < MIN_ELSETS_FOR_DETECTION) {
		verdict = "insufficient-history";
	} else {
		verdict = "no-maneuver-detected";
	}

	return {
		tca: conjunction.tca,
		tcaStatus: tcaMs !== undefined && tcaMs < nowMs ? "past" : "upcoming",
		minRangeKm: conjunction.minRangeKm,
		relativeSpeedKmS: conjunction.relativeSpeedKmS,
		maxProbability: conjunction.maxProbability,
		partner,
		expectedMover: expectedMover(subjectCanManeuver, partner.canManeuver),
		verdict,
		confidence: correlated?.maneuver.confidence,
		evidence: correlated,
	};
}

const CONFIDENCE_RANK: Record<EventConfidence, number> = {
	low: 0,
	medium: 1,
	high: 2,
};

/**
 * The maneuver most plausibly tied to this TCA: window overlapping
 * [TCA - AVOIDANCE_LOOKBACK_DAYS, TCA], highest confidence first, then the
 * one whose window ends closest to TCA. Drag and decay events never count —
 * only type "maneuver" is a deliberate act.
 */
function bestCorrelatedManeuver(
	events: OrbitalEvent[],
	tcaMs: number,
): AvoidanceEvidence | undefined {
	const windowStartMs = tcaMs - AVOIDANCE_LOOKBACK_DAYS * DAY_MS;
	let best: { maneuver: OrbitalEvent; toMs: number } | undefined;
	for (const event of events) {
		if (event.type !== "maneuver") {
			continue;
		}
		const fromMs = parseEpoch(event.window.from)?.getTime();
		const toMs = parseEpoch(event.window.to)?.getTime();
		if (fromMs === undefined || toMs === undefined) {
			continue;
		}
		if (fromMs > tcaMs || toMs < windowStartMs) {
			continue;
		}
		if (
			best === undefined ||
			CONFIDENCE_RANK[event.confidence] >
				CONFIDENCE_RANK[best.maneuver.confidence] ||
			(CONFIDENCE_RANK[event.confidence] ===
				CONFIDENCE_RANK[best.maneuver.confidence] &&
				toMs > best.toMs)
		) {
			best = { maneuver: event, toMs };
		}
	}
	if (best === undefined) {
		return undefined;
	}
	return {
		maneuver: best.maneuver,
		leadTimeDays: round((tcaMs - best.toMs) / DAY_MS),
	};
}
