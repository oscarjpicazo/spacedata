import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCache } from "./file-cache";

function makeCache(): FileCache {
	return new FileCache(mkdtempSync(join(tmpdir(), "spacecli-cache-")));
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
});
