import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCache } from "./file-cache";

function makeCache(): FileCache {
	return new FileCache(mkdtempSync(join(tmpdir(), "spacedata-cache-")));
}

describe("FileCache", () => {
	test("returns stored values before their TTL expires", () => {
		const cache = makeCache();
		cache.set("celestrak", "some-url", { hello: "world" }, 3600);

		const hit = cache.get<{ hello: string }>("celestrak", "some-url");
		expect(hit?.value).toEqual({ hello: "world" });
		expect(typeof hit?.storedAt).toBe("string");
	});

	test("misses on unknown keys and separates namespaces", () => {
		const cache = makeCache();
		cache.set("celestrak", "url", 1, 3600);

		expect(cache.get("celestrak", "other-url")).toBeUndefined();
		expect(cache.get("launch-library", "url")).toBeUndefined();
	});

	test("expires entries whose TTL has passed", () => {
		const cache = makeCache();
		cache.set("celestrak", "url", 1, 0);

		expect(cache.get("celestrak", "url")).toBeUndefined();
	});

	test("circuit breaker reports a retryAt while open and clears after cooldown", () => {
		const cache = makeCache();
		expect(cache.breakerRetryAt("celestrak")).toBeUndefined();

		cache.openBreaker("celestrak", 3600);
		const retryAt = cache.breakerRetryAt("celestrak");
		expect(retryAt).toBeDefined();
		expect(Date.parse(retryAt as string)).toBeGreaterThan(Date.now());

		cache.clearBreaker("celestrak");
		expect(cache.breakerRetryAt("celestrak")).toBeUndefined();
	});

	test("circuit breaker with elapsed cooldown is treated as closed", () => {
		const cache = makeCache();
		cache.openBreaker("celestrak", 0);

		expect(cache.breakerRetryAt("celestrak")).toBeUndefined();
	});

	test("rate limiter allows requests under both windows", () => {
		const cache = makeCache();
		cache.recordRequest("spacetrack");
		cache.recordRequest("spacetrack");

		expect(cache.rateLimitRetryAt("spacetrack", 25, 250)).toBeUndefined();
	});

	test("rate limiter blocks when the per-minute window is exhausted", () => {
		const cache = makeCache();
		for (let i = 0; i < 3; i++) {
			cache.recordRequest("spacetrack");
		}

		const retryAt = cache.rateLimitRetryAt("spacetrack", 3, 250);
		expect(retryAt).toBeDefined();
		expect(Date.parse(retryAt as string)).toBeGreaterThan(Date.now());
		// The window is per source: another source is unaffected.
		expect(cache.rateLimitRetryAt("celestrak", 3, 250)).toBeUndefined();
	});

	test("rate limiter blocks when the per-hour window is exhausted", () => {
		const cache = makeCache();
		for (let i = 0; i < 5; i++) {
			cache.recordRequest("spacetrack");
		}

		const retryAt = cache.rateLimitRetryAt("spacetrack", 100, 5);
		expect(retryAt).toBeDefined();
		expect(Date.parse(retryAt as string)).toBeGreaterThan(Date.now());
	});
});
