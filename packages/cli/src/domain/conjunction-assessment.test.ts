import { describe, expect, test } from "bun:test";
import {
	assessConjunction,
	canManeuver,
	expectedMover,
	parseTca,
	partnerOf,
	type ScreenableConjunction,
} from "./conjunction-assessment";
import type { EventConfidence, OrbitalEvent } from "./events";

const TCA = "2026-07-03 12:00:00.000";
const TCA_MS = Date.UTC(2026, 6, 3, 12);
/** A "now" after TCA, so the default status is past unless stated otherwise. */
const NOW_MS = Date.UTC(2026, 6, 10);

const conjunction: ScreenableConjunction = {
	tca: TCA,
	minRangeKm: 0.12,
	relativeSpeedKmS: 14.2,
	maxProbability: 0.0015,
	sat1: { noradId: 25544, name: "ISS (ZARYA)" },
	sat2: { noradId: 39000, name: "COSMOS 2251 DEB" },
};

const debrisPartner = {
	noradId: 39000,
	name: "COSMOS 2251 DEB",
	objectType: "DEBRIS",
	operationalStatus: "UNKNOWN",
	canManeuver: false,
};

function maneuver(
	from: string,
	to: string,
	confidence: EventConfidence = "high",
): OrbitalEvent {
	return {
		type: "maneuver",
		subtype: "orbit-raise",
		confidence,
		window: { from, to },
		evidence: { gapDays: 0.4 },
		estimatedDvMs: 1.1,
	};
}

describe("canManeuver", () => {
	test("only an alive payload can maneuver", () => {
		expect(canManeuver("PAYLOAD", "OPERATIONAL")).toBe(true);
		expect(canManeuver("PAYLOAD", "PARTIALLY OPERATIONAL")).toBe(true);
		expect(canManeuver("PAYLOAD", "NONOPERATIONAL")).toBe(false);
		expect(canManeuver("PAYLOAD", "DECAYED")).toBe(false);
		expect(canManeuver("DEBRIS", "UNKNOWN")).toBe(false);
		expect(canManeuver("ROCKET BODY", "OPERATIONAL")).toBe(false);
	});

	test("unknown type or status stays unknown, never a guess", () => {
		expect(canManeuver(undefined, "OPERATIONAL")).toBeUndefined();
		expect(canManeuver("UNKNOWN", "OPERATIONAL")).toBeUndefined();
		expect(canManeuver("PAYLOAD", undefined)).toBeUndefined();
		expect(canManeuver("PAYLOAD", "UNKNOWN")).toBeUndefined();
	});
});

describe("expectedMover", () => {
	test("covers the known matrix and degrades to unknown", () => {
		expect(expectedMover(true, true)).toBe("either");
		expect(expectedMover(true, false)).toBe("subject");
		expect(expectedMover(false, true)).toBe("partner");
		expect(expectedMover(false, false)).toBe("neither");
		expect(expectedMover(undefined, false)).toBe("unknown");
		expect(expectedMover(true, undefined)).toBe("unknown");
	});
});

describe("partnerOf / parseTca", () => {
	test("partnerOf picks the side that is not the subject", () => {
		expect(partnerOf(conjunction, 25544).noradId).toBe(39000);
		expect(partnerOf(conjunction, 39000).noradId).toBe(25544);
	});

	test("parseTca reads SOCRATES space-separated timestamps as UTC", () => {
		expect(parseTca("2026-07-08 05:14:25.836")).toBe(
			Date.UTC(2026, 6, 8, 5, 14, 25, 836),
		);
	});
});

describe("assessConjunction", () => {
	test("a maneuver ending shortly before TCA is likely-avoidance", () => {
		const history = {
			elsetCount: 40,
			events: [maneuver("2026-07-02T04:00:00", "2026-07-02T12:00:00")],
		};

		const screened = assessConjunction(
			conjunction,
			true,
			debrisPartner,
			history,
			NOW_MS,
		);

		expect(screened.verdict).toBe("likely-avoidance");
		expect(screened.confidence).toBe("high");
		expect(screened.evidence?.maneuver.subtype).toBe("orbit-raise");
		expect(screened.evidence?.leadTimeDays).toBe(1);
		expect(screened.expectedMover).toBe("subject");
		expect(screened.tcaStatus).toBe("past");
	});

	test("a maneuver outside the lookback window does not correlate", () => {
		const history = {
			elsetCount: 40,
			// Ends more than AVOIDANCE_LOOKBACK_DAYS before TCA.
			events: [maneuver("2026-06-25T00:00:00", "2026-06-26T00:00:00")],
		};

		const screened = assessConjunction(
			conjunction,
			true,
			debrisPartner,
			history,
			NOW_MS,
		);

		expect(screened.verdict).toBe("no-maneuver-detected");
		expect(screened.evidence).toBeUndefined();
	});

	test("a maneuver starting after TCA does not correlate", () => {
		const history = {
			elsetCount: 40,
			events: [maneuver("2026-07-03T18:00:00", "2026-07-04T06:00:00")],
		};

		expect(
			assessConjunction(conjunction, true, debrisPartner, history, NOW_MS)
				.verdict,
		).toBe("no-maneuver-detected");
	});

	test("drag and decay events never count as avoidance", () => {
		const storm: OrbitalEvent = {
			type: "drag-anomaly",
			subtype: "storm-response",
			confidence: "medium",
			window: { from: "2026-07-02T04:00:00", to: "2026-07-02T12:00:00" },
			evidence: { gapDays: 0.4 },
		};

		expect(
			assessConjunction(
				conjunction,
				true,
				debrisPartner,
				{ elsetCount: 40, events: [storm] },
				NOW_MS,
			).verdict,
		).toBe("no-maneuver-detected");
	});

	test("the highest-confidence overlapping maneuver wins", () => {
		const history = {
			elsetCount: 40,
			events: [
				maneuver("2026-07-01T00:00:00", "2026-07-01T12:00:00", "medium"),
				maneuver("2026-07-02T04:00:00", "2026-07-02T12:00:00", "high"),
			],
		};

		const screened = assessConjunction(
			conjunction,
			true,
			debrisPartner,
			history,
			NOW_MS,
		);

		expect(screened.confidence).toBe("high");
		expect(screened.evidence?.maneuver.window.to).toBe("2026-07-02T12:00:00");
	});

	test("a subject the catalog rules out is not-maneuverable", () => {
		expect(
			assessConjunction(
				conjunction,
				false,
				debrisPartner,
				{ elsetCount: 40, events: [] },
				NOW_MS,
			).verdict,
		).toBe("not-maneuverable");
	});

	test("a correlated maneuver beats the catalog's word", () => {
		const history = {
			elsetCount: 40,
			events: [maneuver("2026-07-02T04:00:00", "2026-07-02T12:00:00")],
		};

		expect(
			assessConjunction(conjunction, false, debrisPartner, history, NOW_MS)
				.verdict,
		).toBe("likely-avoidance");
	});

	test("missing history degrades to history-unavailable", () => {
		expect(
			assessConjunction(conjunction, true, debrisPartner, undefined, NOW_MS)
				.verdict,
		).toBe("history-unavailable");
	});

	test("a series too short for detection is insufficient-history", () => {
		expect(
			assessConjunction(
				conjunction,
				true,
				debrisPartner,
				{ elsetCount: 5, events: [] },
				NOW_MS,
			).verdict,
		).toBe("insufficient-history");
	});

	test("a TCA after now is upcoming", () => {
		const screened = assessConjunction(
			conjunction,
			true,
			debrisPartner,
			{ elsetCount: 40, events: [] },
			TCA_MS - 86_400_000,
		);

		expect(screened.tcaStatus).toBe("upcoming");
	});
});
