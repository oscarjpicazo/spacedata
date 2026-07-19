import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCache } from "../core/file-cache";
import { MissingCredentialsError } from "../errors/spacedata-error";
import { computeOrbitalEvents } from "./orbital-events.compute";

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

function makeCache(): FileCache {
	return new FileCache(mkdtempSync(join(tmpdir(), "spacedata-orbev-")));
}

const NOW = new Date("2026-07-19T12:00:00Z");

function options(cache: FileCache) {
	return {
		cache,
		fresh: false,
		identity: "user@example.com",
		password: "hunter2secret",
		baseUrl: "https://st.test/query",
		loginUrl: "https://st.test/login",
		gfzBaseUrl: "https://gfz.test/json/",
		launchLibraryBaseUrl: "https://ll.test/2.3.0",
	};
}

function debutRow(
	noradId: number,
	intlDes: string,
	overrides?: Record<string, string | null>,
): Record<string, string | null> {
	return {
		INTLDES: intlDes,
		NORAD_CAT_ID: String(noradId),
		OBJECT_TYPE: "PAYLOAD",
		SATNAME: `OBJECT ${noradId}`,
		DEBUT: "2026-07-18 18:23:24",
		COUNTRY: "IND",
		LAUNCH: "2026-07-18",
		SITE: "SRI",
		RCS_SIZE: null,
		...overrides,
	};
}

const debutsBody = JSON.stringify([
	debutRow(100080, "2026-164A"),
	debutRow(100081, "2026-164B", { OBJECT_TYPE: "ROCKET BODY" }),
	// An old launch shedding 5 pieces at once: fragmentation signal.
	...Array.from({ length: 5 }, (_, k) =>
		debutRow(100200 + k, `2019-006${"CDEFG"[k]}`, {
			OBJECT_TYPE: "DEBRIS",
			LAUNCH: "2019-01-15",
		}),
	),
]);

const changesBody = JSON.stringify([
	{
		NORAD_CAT_ID: "58902",
		CURRENT_NAME: "LEMUR 2",
		PREVIOUS_NAME: "LEMUR 2",
		CURRENT_INTLDES: "2024-022D",
		PREVIOUS_INTLDES: "2024-022D",
		CURRENT_DECAY: "2026-07-14",
		PREVIOUS_DECAY: null,
		CHANGE_MADE: "2026-07-19 10:00:00",
	},
]);

const tipBody = JSON.stringify([
	{
		NORAD_CAT_ID: "54321",
		MSG_EPOCH: "2026-07-18 06:00:00",
		DECAY_EPOCH: "2026-07-20 14:30:00",
		WINDOW: "4",
		LAT: "12.3",
		LON: "-45.6",
		INCL: "51.6",
		NEXT_REPORT: "6",
		HIGH_INTEREST: "N",
	},
	{
		// An older TIP message for the same object: deduplicated away.
		NORAD_CAT_ID: "54321",
		MSG_EPOCH: "2026-07-17 06:00:00",
		DECAY_EPOCH: "2026-07-20 16:00:00",
		WINDOW: "8",
		LAT: null,
		LON: null,
		INCL: "51.6",
		NEXT_REPORT: "6",
		HIGH_INTEREST: "N",
	},
	{
		// Far outside the window in both epochs: filtered out.
		NORAD_CAT_ID: "11111",
		MSG_EPOCH: "2026-05-01 06:00:00",
		DECAY_EPOCH: "2026-05-02 14:30:00",
		WINDOW: "4",
		LAT: null,
		LON: null,
		INCL: "51.6",
		NEXT_REPORT: null,
		HIGH_INTEREST: "N",
	},
]);

const launchesBody = JSON.stringify({
	count: 1,
	results: [
		{
			id: "abc",
			name: "Falcon 9 | Starlink",
			net: "2026-07-16T04:00:00Z",
			status: { name: "Launch Successful" },
			launch_service_provider: { name: "SpaceX" },
		},
	],
});

function gfzBody(): string {
	const datetime: string[] = [];
	const kp: number[] = [];
	for (
		let ms = Date.UTC(2026, 6, 12);
		ms < Date.UTC(2026, 6, 19, 12);
		ms += 3 * 3_600_000
	) {
		datetime.push(new Date(ms).toISOString().replace(".000Z", "Z"));
		kp.push(ms === Date.UTC(2026, 6, 15) ? 6.333 : 2);
	}
	return JSON.stringify({ Kp: kp, datetime });
}

function mockRouting(
	overrides?: Partial<Record<string, () => Response>>,
): ReturnType<typeof mock> {
	const fetchMock = mock(async (input: string | URL | Request) => {
		const url = String(input);
		if (url.includes("st.test/login")) {
			return new Response('""', {
				status: 200,
				headers: { "set-cookie": "session=abc; path=/" },
			});
		}
		if (url.includes("satcat_debut")) {
			return overrides?.debuts?.() ?? new Response(debutsBody, { status: 200 });
		}
		if (url.includes("satcat_change")) {
			return (
				overrides?.changes?.() ?? new Response(changesBody, { status: 200 })
			);
		}
		if (url.includes("/class/tip/")) {
			return overrides?.tip?.() ?? new Response(tipBody, { status: 200 });
		}
		if (url.includes("ll.test")) {
			return (
				overrides?.launches?.() ?? new Response(launchesBody, { status: 200 })
			);
		}
		if (url.includes("gfz.test")) {
			return overrides?.gfz?.() ?? new Response(gfzBody(), { status: 200 });
		}
		throw new Error(`unexpected url: ${url}`);
	});
	globalThis.fetch = fetchMock as unknown as typeof fetch;
	return fetchMock;
}

describe("computeOrbitalEvents", () => {
	test("aggregates every section of a busy week", async () => {
		mockRouting();

		const result = await computeOrbitalEvents(7, options(makeCache()), NOW);

		const value = result._unsafeUnwrap();
		expect(value.source).toBe("spacetrack+launch-library+gfz");
		const data = value.data;

		expect(data.newObjects.count).toBe(7);
		expect(data.newObjects.launches[0]?.launchDesignator).toBe("2019-006");
		expect(data.fragmentationSignals).toHaveLength(1);
		expect(data.fragmentationSignals[0]?.launchDesignator).toBe("2019-006");

		expect(data.catalogChanges?.decayDatesSet).toHaveLength(1);
		expect(data.catalogChanges?.decayDatesSet[0]?.noradId).toBe(58902);

		// The stale TIP message is filtered out; the duplicate per-object
		// message is deduplicated keeping the newest prediction.
		expect(data.reentries).toHaveLength(1);
		expect(data.reentries?.[0]?.noradId).toBe(54321);
		expect(data.reentries?.[0]?.predictedDecayEpoch).toBe(
			"2026-07-20 14:30:00",
		);

		expect(data.pastLaunches?.count).toBe(1);
		expect(data.geomagnetic?.maxKp).toBe(6.333);
		expect(data.geomagnetic?.storms).toHaveLength(1);
		expect(data.warnings).toHaveLength(0);
	});

	test("auxiliary section failures degrade with warnings", async () => {
		mockRouting({
			changes: () => new Response("boom", { status: 500 }),
			launches: () => new Response("boom", { status: 500 }),
			gfz: () => new Response("boom", { status: 500 }),
		});

		const result = await computeOrbitalEvents(7, options(makeCache()), NOW);

		const value = result._unsafeUnwrap();
		expect(value.data.newObjects.count).toBe(7);
		expect(value.data.catalogChanges).toBeUndefined();
		expect(value.data.pastLaunches).toBeUndefined();
		expect(value.data.geomagnetic).toBeUndefined();
		expect(value.data.warnings.length).toBeGreaterThanOrEqual(3);
	});

	test("a failing core section fails the command", async () => {
		mockRouting({ debuts: () => new Response("boom", { status: 500 }) });

		const result = await computeOrbitalEvents(7, options(makeCache()), NOW);

		expect(result.isErr()).toBe(true);
	});

	test("missing credentials fail the command", async () => {
		mockRouting();
		const previousIdentity = process.env.SPACEDATA_SPACETRACK_IDENTITY;
		const previousPassword = process.env.SPACEDATA_SPACETRACK_PASSWORD;
		delete process.env.SPACEDATA_SPACETRACK_IDENTITY;
		delete process.env.SPACEDATA_SPACETRACK_PASSWORD;
		try {
			const result = await computeOrbitalEvents(
				7,
				{
					cache: makeCache(),
					fresh: false,
					gfzBaseUrl: "https://gfz.test/json/",
					launchLibraryBaseUrl: "https://ll.test/2.3.0",
				},
				NOW,
			);
			expect(result._unsafeUnwrapErr()).toBeInstanceOf(MissingCredentialsError);
		} finally {
			if (previousIdentity !== undefined) {
				process.env.SPACEDATA_SPACETRACK_IDENTITY = previousIdentity;
			}
			if (previousPassword !== undefined) {
				process.env.SPACEDATA_SPACETRACK_PASSWORD = previousPassword;
			}
		}
	});

	test("hitting the debut cap adds a truncation warning", async () => {
		mockRouting({
			debuts: () =>
				new Response(
					JSON.stringify(
						Array.from({ length: 500 }, (_, k) =>
							debutRow(
								200000 + k,
								`2026-170${String.fromCharCode(65 + (k % 26))}`,
							),
						),
					),
					{ status: 200 },
				),
		});

		const result = await computeOrbitalEvents(7, options(makeCache()), NOW);

		const value = result._unsafeUnwrap();
		expect(
			value.data.warnings.some((w) => w.includes("truncated at 500")),
		).toBe(true);
	});
});
