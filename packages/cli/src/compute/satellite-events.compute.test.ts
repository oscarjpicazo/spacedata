import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCache } from "../core/file-cache";
import { ISS_GP_HISTORY_RAW } from "../domain/iss-history.fixture";
import {
	MissingCredentialsError,
	NotFoundError,
} from "../errors/spacedata-error";
import { computeSatelliteEvents } from "./satellite-events.compute";

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

function makeCache(): FileCache {
	return new FileCache(mkdtempSync(join(tmpdir(), "spacedata-satev-")));
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
	};
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

function mockRouting(routes: {
	gpHistory?: () => Response;
	gfz?: () => Response;
}): ReturnType<typeof mock> {
	const fetchMock = mock(async (input: string | URL | Request) => {
		const url = String(input);
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

describe("computeSatelliteEvents", () => {
	test("detects the ISS reboost end to end with geomagnetic context", async () => {
		mockRouting({});

		const result = await computeSatelliteEvents(
			25544,
			30,
			options(makeCache()),
		);

		const value = result._unsafeUnwrap();
		expect(value.source).toBe("spacetrack+gfz+analysis");
		expect(value.data.noradId).toBe(25544);
		expect(value.data.name).toBe("ISS (ZARYA)");
		expect(value.data.regime).toBe("leo");
		expect(value.data.elsetCount).toBe(83);
		expect(value.data.events).toHaveLength(1);
		expect(value.data.events[0]?.subtype).toBe("orbit-raise");
		expect(value.data.events[0]?.evidence.maxKp).toBe(2);
		expect(value.data.warnings).toHaveLength(0);
	});

	test("a failing Kp source degrades to a warning, not an error", async () => {
		mockRouting({ gfz: () => new Response("boom", { status: 500 }) });

		const result = await computeSatelliteEvents(
			25544,
			30,
			options(makeCache()),
		);

		const value = result._unsafeUnwrap();
		expect(value.data.events).toHaveLength(1);
		expect(value.data.events[0]?.evidence.maxKp).toBeUndefined();
		expect(
			value.data.warnings.some((w) =>
				w.includes("storm discrimination is disabled"),
			),
		).toBe(true);
	});

	test("an unknown object fails with NotFoundError", async () => {
		mockRouting({ gpHistory: () => new Response("[]", { status: 200 }) });

		const result = await computeSatelliteEvents(
			999999,
			30,
			options(makeCache()),
		);

		expect(result._unsafeUnwrapErr()).toBeInstanceOf(NotFoundError);
	});

	test("missing credentials fail before any request", async () => {
		const fetchMock = mockRouting({});
		const previousIdentity = process.env.SPACEDATA_SPACETRACK_IDENTITY;
		const previousPassword = process.env.SPACEDATA_SPACETRACK_PASSWORD;
		delete process.env.SPACEDATA_SPACETRACK_IDENTITY;
		delete process.env.SPACEDATA_SPACETRACK_PASSWORD;
		try {
			const result = await computeSatelliteEvents(25544, 30, {
				cache: makeCache(),
				fresh: false,
				gfzBaseUrl: "https://gfz.test/json/",
			});
			expect(result._unsafeUnwrapErr()).toBeInstanceOf(MissingCredentialsError);
			// Only the (harmless) GFZ fetch may have fired.
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
});
