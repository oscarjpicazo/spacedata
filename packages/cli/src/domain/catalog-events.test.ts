import { describe, expect, test } from "bun:test";
import {
	classifyChanges,
	type DebutRecord,
	groupDebuts,
	parseUpstreamInstant,
} from "./catalog-events";

const NOW = new Date("2026-07-19T12:00:00Z");

function debut(
	noradId: number,
	internationalDesignator: string,
	overrides?: Partial<DebutRecord>,
): DebutRecord {
	return {
		noradId,
		internationalDesignator,
		name: `OBJECT ${noradId}`,
		objectType: "PAYLOAD",
		launchDate: "2026-07-18",
		...overrides,
	};
}

describe("groupDebuts", () => {
	test("groups pieces by launch and counts object types", () => {
		const groups = groupDebuts(
			[
				debut(100080, "2026-164A"),
				debut(100081, "2026-164B", { objectType: "ROCKET BODY" }),
				debut(100082, "2026-164C", { objectType: "UNKNOWN" }),
				debut(100090, "2026-165A"),
			],
			NOW,
		);
		expect(groups).toHaveLength(2);
		const first = groups[0];
		expect(first?.launchDesignator).toBe("2026-164");
		expect(first?.pieces).toBe(3);
		expect(first?.objectTypes.payloads).toBe(1);
		expect(first?.objectTypes.rocketBodies).toBe(1);
		expect(first?.objectTypes.unknown).toBe(1);
		expect(first?.noradIds).toEqual([100080, 100081, 100082]);
		expect(first?.fragmentationSignal).toBe(false);
	});

	test("multi-letter pieces of an old launch flag a fragmentation signal", () => {
		const pieces = Array.from({ length: 6 }, (_, k) =>
			debut(60000 + k, `2019-006${"ABCDEF"[k]}${k > 3 ? "B" : ""}`, {
				objectType: "DEBRIS",
				launchDate: "2019-01-15",
			}),
		);
		const groups = groupDebuts(pieces, NOW);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.launchDesignator).toBe("2019-006");
		expect(groups[0]?.fragmentationSignal).toBe(true);
		expect(groups[0]?.objectTypes.debris).toBe(6);
	});

	test("a fresh deployment of many pieces is not a fragmentation signal", () => {
		const pieces = Array.from({ length: 8 }, (_, k) =>
			debut(100100 + k, `2026-166${"ABCDEFGH"[k]}`),
		);
		expect(groupDebuts(pieces, NOW)[0]?.fragmentationSignal).toBe(false);
	});
});

describe("classifyChanges", () => {
	test("splits decay dates, renames and other changes", () => {
		const classified = classifyChanges([
			{
				noradId: 58902,
				changedAt: "2026-07-19 17:33:27",
				name: "LEMUR 2",
				previousName: "LEMUR 2",
				decayDate: "2026-06-14",
				previousDecayDate: undefined,
			},
			{
				noradId: 100080,
				changedAt: "2026-07-19 10:00:00",
				name: "NISAR",
				previousName: "OBJECT A",
				decayDate: undefined,
				previousDecayDate: undefined,
			},
			{
				noradId: 12345,
				changedAt: "2026-07-18 09:00:00",
				name: "SAME",
				previousName: "SAME",
				decayDate: undefined,
				previousDecayDate: undefined,
			},
		]);
		expect(classified.decayDatesSet).toHaveLength(1);
		expect(classified.decayDatesSet[0]?.noradId).toBe(58902);
		expect(classified.decayDatesSet[0]?.decayDate).toBe("2026-06-14");
		expect(classified.renamed).toHaveLength(1);
		expect(classified.renamed[0]?.from).toBe("OBJECT A");
		expect(classified.renamed[0]?.to).toBe("NISAR");
		expect(classified.otherCount).toBe(1);
	});

	test("a revised decay date counts as a decay-date change", () => {
		const classified = classifyChanges([
			{
				noradId: 1,
				changedAt: "2026-07-19 00:00:00",
				decayDate: "2026-07-20",
				previousDecayDate: "2026-07-25",
			},
		]);
		expect(classified.decayDatesSet).toHaveLength(1);
		expect(classified.decayDatesSet[0]?.previousDecayDate).toBe("2026-07-25");
	});
});

describe("parseUpstreamInstant", () => {
	test("parses the three upstream timestamp shapes as UTC", () => {
		expect(parseUpstreamInstant("2026-07-18")?.toISOString()).toBe(
			"2026-07-18T00:00:00.000Z",
		);
		expect(parseUpstreamInstant("2026-07-18 18:23:24")?.toISOString()).toBe(
			"2026-07-18T18:23:24.000Z",
		);
		expect(
			parseUpstreamInstant("2026-07-17T19:56:26.020608")?.toISOString(),
		).toBe("2026-07-17T19:56:26.020Z");
	});

	test("rejects garbage and undefined", () => {
		expect(parseUpstreamInstant("not a date")).toBeUndefined();
		expect(parseUpstreamInstant(undefined)).toBeUndefined();
	});
});
