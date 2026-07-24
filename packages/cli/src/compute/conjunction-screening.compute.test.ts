import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCache } from "../core/file-cache";
import { ISS_GP_HISTORY_RAW } from "../domain/iss-history.fixture";
import { UpstreamHttpError } from "../errors/spacedata-error";
import { computeConjunctionScreening } from "./conjunction-screening.compute";

const SOCRATES_HEADER =
	"NORAD_CAT_ID_1,OBJECT_NAME_1,DSE_1,NORAD_CAT_ID_2,OBJECT_NAME_2,DSE_2,TCA,TCA_RANGE,TCA_RELATIVE_SPEED,MAX_PROB,DILUTION";

/** One conjunction: the ISS vs a debris piece, TCA the day after the real
 * 2026-07-02 reboost in the fixture — the avoidance-correlated case. */
const SOCRATES_CSV = [
	SOCRATES_HEADER,
	"25544,ISS (ZARYA) [+],1.2,39000,COSMOS 2251 DEB [-],3.4,2026-07-03 12:00:00.000,0.120,14.200,1.500E-03,0.010",
].join("\n");

function satcatBody(
	noradId: number,
	name: string,
	objectType: string,
	opsStatus: string,
): string {
	return JSON.stringify([
		{
			OBJECT_NAME: name,
			OBJECT_ID: "1998-067A",
			NORAD_CAT_ID: noradId,
			OBJECT_TYPE: objectType,
			OPS_STATUS_CODE: opsStatus,
			OWNER: "ISS",
			LAUNCH_DATE: "1998-11-20",
			LAUNCH_SITE: "TYMSC",
			DECAY_DATE: "",
			PERIOD: 92.9,
			INCLINATION: 51.64,
			APOGEE: 420,
			PERIGEE: 415,
			RCS: 399.1,
			ORBIT_CENTER: "EA",
			ORBIT_TYPE: "ORB",
		},
	]);
}

/** Quiet Kp bins covering the whole ISS fixture window. */
function gfzBody(): string {
	const datetime: string[] = [];
	const kp: number[] = [];
	for (
		let ms = Date.UTC(2026, 5, 19);
		ms < Date.UTC(2026, 6, 20);
		ms += 3 * 3_600_000
	) {
		datetime.push(new Date(ms).toISOString().replace(".000Z", "Z"));
		kp.push(2);
	}
	return JSON.stringify({ Kp: kp, datetime });
}

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

function makeCache(): FileCache {
	return new FileCache(mkdtempSync(join(tmpdir(), "spacedata-screen-")));
}

function options(cache: FileCache) {
	return {
		cache,
		fresh: false,
		identity: "user@example.com",
		password: "hunter2secret",
		baseUrl: "https://st.test/query",
		loginUrl: "https://st.test/login",
		gfzBaseUrl: "https://gfz.test/json/",
		socratesBaseUrl: "https://ct.test/socrates.csv",
		satcatBaseUrl: "https://ct.test/satcat",
	};
}

function mockRouting(routes: {
	socrates?: () => Response;
	satcat?: (noradId: string | null) => Response;
	gpHistory?: () => Response;
	gfz?: () => Response;
}): ReturnType<typeof mock> {
	const fetchMock = mock(async (input: string | URL | Request) => {
		const url = String(input);
		if (url.includes("socrates.csv")) {
			return routes.socrates?.() ?? new Response(SOCRATES_CSV, { status: 200 });
		}
		if (url.includes("ct.test/satcat")) {
			const catnr = new URL(url).searchParams.get("CATNR");
			if (routes.satcat !== undefined) {
				return routes.satcat(catnr);
			}
			return catnr === "25544"
				? new Response(satcatBody(25544, "ISS (ZARYA)", "PAY", "+"), {
						status: 200,
					})
				: new Response(satcatBody(39000, "COSMOS 2251 DEB", "DEB", "?"), {
						status: 200,
					});
		}
		if (url.includes("st.test/login")) {
			return new Response('""', {
				status: 200,
				headers: { "set-cookie": "session=abc; path=/" },
			});
		}
		if (url.includes("gp_history")) {
			return (
				routes.gpHistory?.() ??
				new Response(JSON.stringify(ISS_GP_HISTORY_RAW), { status: 200 })
			);
		}
		if (url.includes("gfz.test")) {
			return routes.gfz?.() ?? new Response(gfzBody(), { status: 200 });
		}
		throw new Error(`unexpected url: ${url}`);
	});
	globalThis.fetch = fetchMock as unknown as typeof fetch;
	return fetchMock;
}

describe("computeConjunctionScreening", () => {
	test("correlates the ISS reboost with a post-burn TCA into likely-avoidance", async () => {
		mockRouting({});

		const result = await computeConjunctionScreening(
			25544,
			options(makeCache()),
		);

		const value = result._unsafeUnwrap();
		expect(value.source).toBe("celestrak+spacetrack+gfz+analysis");
		expect(value.data.noradId).toBe(25544);
		expect(value.data.name).toBe("ISS (ZARYA)");
		expect(value.data.objectType).toBe("PAYLOAD");
		expect(value.data.canManeuver).toBe(true);
		expect(value.data.detectedManeuvers).toHaveLength(1);
		expect(value.data.conjunctionCount).toBe(1);

		const screened = value.data.conjunctions[0];
		expect(screened?.verdict).toBe("likely-avoidance");
		expect(screened?.confidence).toBeDefined();
		expect(screened?.evidence?.maneuver.subtype).toBe("orbit-raise");
		// The elset bounding the reboost postdates this TCA, so the lead time
		// is slightly negative — documented behavior, not an error.
		expect(Number.isFinite(screened?.evidence?.leadTimeDays)).toBe(true);
		expect(screened?.evidence?.leadTimeDays).toBeGreaterThan(-3);
		expect(screened?.partner.noradId).toBe(39000);
		expect(screened?.partner.objectType).toBe("DEBRIS");
		expect(screened?.partner.canManeuver).toBe(false);
		expect(screened?.expectedMover).toBe("subject");
		expect(screened?.tcaStatus).toBe("past");
	});

	test("missing Space-Track credentials degrade to history-unavailable", async () => {
		const fetchMock = mockRouting({});
		const previousIdentity = process.env.SPACEDATA_SPACETRACK_IDENTITY;
		const previousPassword = process.env.SPACEDATA_SPACETRACK_PASSWORD;
		delete process.env.SPACEDATA_SPACETRACK_IDENTITY;
		delete process.env.SPACEDATA_SPACETRACK_PASSWORD;
		try {
			const { identity: _i, password: _p, ...anonymous } = options(makeCache());
			const result = await computeConjunctionScreening(25544, anonymous);

			const value = result._unsafeUnwrap();
			expect(value.data.canManeuver).toBe(true);
			expect(value.data.elsetCount).toBeUndefined();
			expect(value.data.conjunctions[0]?.verdict).toBe("history-unavailable");
			expect(value.data.conjunctions[0]?.expectedMover).toBe("subject");
			expect(
				value.data.warnings.some((w) =>
					w.includes("avoidance detection is unavailable"),
				),
			).toBe(true);
			for (const call of fetchMock.mock.calls) {
				expect(String(call[0])).not.toContain("st.test");
			}
		} finally {
			if (previousIdentity !== undefined) {
				process.env.SPACEDATA_SPACETRACK_IDENTITY = previousIdentity;
			}
			if (previousPassword !== undefined) {
				process.env.SPACEDATA_SPACETRACK_PASSWORD = previousPassword;
			}
		}
	});

	test("no conjunctions is a complete answer without history fetches", async () => {
		const fetchMock = mockRouting({
			satcat: () =>
				new Response(satcatBody(11111, "SOME SAT", "PAY", "+"), {
					status: 200,
				}),
		});

		const result = await computeConjunctionScreening(
			11111,
			options(makeCache()),
		);

		const value = result._unsafeUnwrap();
		expect(value.data.conjunctionCount).toBe(0);
		expect(value.data.conjunctions).toHaveLength(0);
		expect(value.data.elsetCount).toBeUndefined();
		expect(value.data.warnings).toHaveLength(0);
		for (const call of fetchMock.mock.calls) {
			expect(String(call[0])).not.toContain("gp_history");
			expect(String(call[0])).not.toContain("gfz.test");
		}
	});

	test("a SOCRATES failure fails the command", async () => {
		mockRouting({ socrates: () => new Response("boom", { status: 500 }) });

		const result = await computeConjunctionScreening(
			25544,
			options(makeCache()),
		);

		expect(result._unsafeUnwrapErr()).toBeInstanceOf(UpstreamHttpError);
	});

	test("a failing partner catalog record degrades to unknown maneuverability", async () => {
		mockRouting({
			satcat: (catnr) =>
				catnr === "25544"
					? new Response(satcatBody(25544, "ISS (ZARYA)", "PAY", "+"), {
							status: 200,
						})
					: new Response("No SATCAT records found", { status: 200 }),
		});

		const result = await computeConjunctionScreening(
			25544,
			options(makeCache()),
		);

		const value = result._unsafeUnwrap();
		const screened = value.data.conjunctions[0];
		expect(screened?.verdict).toBe("likely-avoidance");
		expect(screened?.partner.objectType).toBeUndefined();
		expect(screened?.partner.name).toBe("COSMOS 2251 DEB");
		expect(screened?.expectedMover).toBe("unknown");
		expect(value.data.warnings.some((w) => w.includes("39000"))).toBe(true);
	});
});
