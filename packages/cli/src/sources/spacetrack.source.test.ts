import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCache } from "../core/file-cache";
import {
	AuthenticationError,
	MissingCredentialsError,
	NotFoundError,
	UpstreamSchemaError,
} from "../errors/spacedata-error";
import {
	fetchConjunctions,
	fetchElsetHistory,
	fetchReentries,
} from "./spacetrack.source";

const cdmFixture = {
	CDM_ID: "1234567",
	CREATED: "2026-07-03 08:00:00",
	EMERGENCY_REPORTABLE: "Y",
	TCA: "2026-07-04T12:34:56.000000",
	MIN_RNG: "0.5",
	PC: "0.0001",
	SAT_1_ID: "25544",
	SAT_1_NAME: "ISS (ZARYA)",
	SAT1_OBJECT_TYPE: "PAYLOAD",
	SAT_2_ID: "99999",
	SAT_2_NAME: "COSMOS DEB",
	SAT2_OBJECT_TYPE: "DEBRIS",
};

const tipFixture = {
	NORAD_CAT_ID: "54321",
	MSG_EPOCH: "2026-07-03 06:00:00",
	DECAY_EPOCH: "2026-07-05 14:30:00",
	WINDOW: "4",
	LAT: "12.3",
	LON: "-45.6",
	INCL: "51.6",
	NEXT_REPORT: "6",
	HIGH_INTEREST: "N",
};

const gpHistoryFixture = {
	NORAD_CAT_ID: "25544",
	OBJECT_NAME: "ISS (ZARYA)",
	OBJECT_ID: "1998-067A",
	EPOCH: "2026-06-01T00:00:00.000000",
	MEAN_MOTION: "15.5",
	ECCENTRICITY: "0.0003",
	INCLINATION: "51.64",
	RA_OF_ASC_NODE: "100.1",
	ARG_OF_PERICENTER: "200.2",
	MEAN_ANOMALY: "300.3",
	BSTAR: "0.0001",
	REV_AT_EPOCH: "57000",
};

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

function makeCache(): FileCache {
	return new FileCache(mkdtempSync(join(tmpdir(), "spacedata-st-")));
}

function credentials(): { identity: string; password: string } {
	return { identity: "user@example.com", password: "hunter2secret" };
}

function mockFetch(
	handler: (url: string, init?: RequestInit) => Response,
): ReturnType<typeof mock> {
	const fetchMock = mock(
		async (input: string | URL | Request, init?: RequestInit) =>
			handler(String(input), init),
	);
	globalThis.fetch = fetchMock as unknown as typeof fetch;
	return fetchMock;
}

function loginOk(): Response {
	return new Response('""', {
		status: 200,
		headers: { "set-cookie": "chocolatechip=abc123; path=/; HttpOnly" },
	});
}

/** Routes the two-step flow: login POST → session cookie, query GET → data. */
function mockTwoStep(
	queryHandler: (url: string, init?: RequestInit) => Response,
): ReturnType<typeof mock> {
	return mockFetch((url, init) => {
		if (url.includes("/ajaxauth/login")) {
			return loginOk();
		}
		return queryHandler(url, init);
	});
}

describe("spacetrack source", () => {
	test("logs in for a session cookie, queries with it and parses element history", async () => {
		const fetchMock = mockFetch((url, init) => {
			if (url.includes("/ajaxauth/login")) {
				expect(init?.method).toBe("POST");
				const body = String(init?.body);
				expect(body).toContain("identity=user%40example.com");
				expect(body).toContain("password=hunter2secret");
				expect(body).not.toContain("query");
				return loginOk();
			}
			expect(url).toContain("/class/gp_history/NORAD_CAT_ID/25544");
			const headers = init?.headers as Record<string, string>;
			expect(headers.Cookie).toContain("chocolatechip=abc123");
			return new Response(JSON.stringify([gpHistoryFixture]), { status: 200 });
		});

		const result = await fetchElsetHistory(25544, 20, {
			cache: makeCache(),
			fresh: false,
			...credentials(),
		});

		const value = result._unsafeUnwrap();
		expect(value.source).toBe("spacetrack");
		const elset = value.data[0];
		expect(elset.epoch).toBe("2026-06-01T00:00:00.000000");
		expect(elset.meanMotionRevPerDay).toBe(15.5);
		expect(elset.derived.perigeeAltitudeKm).toBeGreaterThan(395);
		expect(elset.derived.perigeeAltitudeKm).toBeLessThan(415);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	test("fails fast with MissingCredentialsError when env/options lack credentials", async () => {
		const fetchMock = mockFetch(() => new Response("[]", { status: 200 }));
		delete process.env.SPACEDATA_SPACETRACK_IDENTITY;
		delete process.env.SPACEDATA_SPACETRACK_PASSWORD;

		const result = await fetchElsetHistory(25544, 20, {
			cache: makeCache(),
			fresh: false,
		});

		expect(result._unsafeUnwrapErr()).toBeInstanceOf(MissingCredentialsError);
		expect(fetchMock).toHaveBeenCalledTimes(0);
	});

	test("maps a Space-Track login failure payload to AuthenticationError", async () => {
		mockFetch(() => new Response('{"Login":"Failed"}', { status: 200 }));

		const result = await fetchElsetHistory(25544, 20, {
			cache: makeCache(),
			fresh: false,
			...credentials(),
		});

		expect(result._unsafeUnwrapErr()).toBeInstanceOf(AuthenticationError);
	});

	test("maps HTTP 401 to AuthenticationError without opening the breaker", async () => {
		const cache = makeCache();
		mockFetch(() => new Response("Unauthorized", { status: 401 }));

		const first = await fetchElsetHistory(25544, 20, {
			cache,
			fresh: false,
			...credentials(),
		});
		expect(first._unsafeUnwrapErr()).toBeInstanceOf(AuthenticationError);

		const fetchMock = mockTwoStep(
			() => new Response(JSON.stringify([gpHistoryFixture]), { status: 200 }),
		);
		const retry = await fetchElsetHistory(25544, 20, {
			cache,
			fresh: false,
			...credentials(),
		});
		expect(retry.isOk()).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	test("caches by query only: credentials never influence the cache key", async () => {
		const cache = makeCache();
		const fetchMock = mockTwoStep(
			() => new Response(JSON.stringify([gpHistoryFixture]), { status: 200 }),
		);

		const first = await fetchElsetHistory(25544, 20, {
			cache,
			fresh: false,
			...credentials(),
		});
		const second = await fetchElsetHistory(25544, 20, {
			cache,
			fresh: false,
			identity: "other@example.com",
			password: "different-password",
		});

		expect(first._unsafeUnwrap().cached).toBe(false);
		expect(second._unsafeUnwrap().cached).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	test("parses conjunctions and filters by NORAD id on either satellite", async () => {
		mockTwoStep(
			() => new Response(JSON.stringify([cdmFixture]), { status: 200 }),
		);

		const all = await fetchConjunctions(20, undefined, {
			cache: makeCache(),
			fresh: false,
			...credentials(),
		});
		const conjunction = all._unsafeUnwrap().data[0];
		expect(conjunction.cdmId).toBe("1234567");
		expect(conjunction.minRangeKm).toBe(0.5);
		expect(conjunction.collisionProbability).toBe(0.0001);
		expect(conjunction.emergencyReportable).toBe(true);
		expect(conjunction.sat1.noradId).toBe(25544);
		expect(conjunction.sat2.objectType).toBe("DEBRIS");

		const filteredIn = await fetchConjunctions(20, 99999, {
			cache: makeCache(),
			fresh: false,
			...credentials(),
		});
		expect(filteredIn._unsafeUnwrap().data).toHaveLength(1);

		const filteredOut = await fetchConjunctions(20, 11111, {
			cache: makeCache(),
			fresh: false,
			...credentials(),
		});
		expect(filteredOut._unsafeUnwrap().data).toHaveLength(0);
	});

	test("parses re-entry predictions (TIP)", async () => {
		mockTwoStep(
			() => new Response(JSON.stringify([tipFixture]), { status: 200 }),
		);

		const result = await fetchReentries(10, {
			cache: makeCache(),
			fresh: false,
			...credentials(),
		});

		const reentry = result._unsafeUnwrap().data[0];
		expect(reentry).toEqual({
			noradId: 54321,
			messageEpoch: "2026-07-03 06:00:00",
			predictedDecayEpoch: "2026-07-05 14:30:00",
			windowHours: 4,
			latDeg: 12.3,
			lonDeg: -45.6,
			inclinationDeg: 51.6,
			nextReport: "6",
			highInterest: false,
		});
	});

	test("returns NotFoundError when there is no element history", async () => {
		mockTwoStep(() => new Response("[]", { status: 200 }));

		const result = await fetchElsetHistory(999999, 20, {
			cache: makeCache(),
			fresh: false,
			...credentials(),
		});

		expect(result._unsafeUnwrapErr()).toBeInstanceOf(NotFoundError);
	});

	test("rejects non-numeric values in numeric fields", async () => {
		mockTwoStep(
			() =>
				new Response(
					JSON.stringify([
						{ ...gpHistoryFixture, MEAN_MOTION: "not-a-number" },
					]),
					{ status: 200 },
				),
		);

		const result = await fetchElsetHistory(25544, 20, {
			cache: makeCache(),
			fresh: false,
			...credentials(),
		});

		expect(result._unsafeUnwrapErr()).toBeInstanceOf(UpstreamSchemaError);
	});
});
