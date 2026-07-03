import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface CacheEnvelope {
	storedAt: string;
	ttlSeconds: number;
	value: unknown;
}

interface BreakerState {
	openedAt: string;
	cooldownSeconds: number;
}

export interface CacheHit<T> {
	value: T;
	storedAt: string;
}

export function defaultCacheDir(): string {
	const xdgCacheHome = process.env.XDG_CACHE_HOME;
	const base =
		xdgCacheHome !== undefined && xdgCacheHome !== ""
			? xdgCacheHome
			: join(homedir(), ".cache");
	return join(base, "spacedata");
}

/**
 * File-backed cache with per-entry TTL, plus a per-source circuit breaker.
 *
 * Both exist to honor upstream usage policies (CelesTrak: one download per
 * update cycle, stop querying on non-200; LL2: 15 calls/hour per IP), so they
 * are first-class citizens of every source, not an optimization.
 */
export class FileCache {
	constructor(private readonly dir: string) {
		mkdirSync(this.dir, { recursive: true });
	}

	get<T>(namespace: string, key: string): CacheHit<T> | undefined {
		const path = this.entryPath(namespace, key);
		if (!existsSync(path)) {
			return undefined;
		}
		const envelope = this.readEnvelope(path);
		if (envelope === undefined) {
			return undefined;
		}
		const expiresAt =
			Date.parse(envelope.storedAt) + envelope.ttlSeconds * 1000;
		if (Number.isNaN(expiresAt) || Date.now() >= expiresAt) {
			rmSync(path, { force: true });
			return undefined;
		}
		return { value: envelope.value as T, storedAt: envelope.storedAt };
	}

	set(
		namespace: string,
		key: string,
		value: unknown,
		ttlSeconds: number,
	): void {
		const envelope: CacheEnvelope = {
			storedAt: new Date().toISOString(),
			ttlSeconds,
			value,
		};
		writeFileSync(this.entryPath(namespace, key), JSON.stringify(envelope));
	}

	breakerRetryAt(source: string): string | undefined {
		const path = this.breakerPath(source);
		if (!existsSync(path)) {
			return undefined;
		}
		const state = this.readBreaker(path);
		if (state === undefined) {
			return undefined;
		}
		const retryAtMs = Date.parse(state.openedAt) + state.cooldownSeconds * 1000;
		if (Number.isNaN(retryAtMs) || Date.now() >= retryAtMs) {
			rmSync(path, { force: true });
			return undefined;
		}
		return new Date(retryAtMs).toISOString();
	}

	openBreaker(source: string, cooldownSeconds: number): void {
		const state: BreakerState = {
			openedAt: new Date().toISOString(),
			cooldownSeconds,
		};
		writeFileSync(this.breakerPath(source), JSON.stringify(state));
	}

	clearBreaker(source: string): void {
		rmSync(this.breakerPath(source), { force: true });
	}

	/**
	 * Sliding-window rate limiter persisted across CLI invocations. Returns
	 * the ISO instant when the next request becomes allowed, or undefined if
	 * a request may be sent now.
	 */
	rateLimitRetryAt(
		source: string,
		perMinute: number,
		perHour: number,
	): string | undefined {
		const now = Date.now();
		const stamps = this.readRequestLog(source).filter(
			(t) => now - t < 60 * 60 * 1000,
		);
		const lastMinute = stamps.filter((t) => now - t < 60 * 1000);
		if (lastMinute.length >= perMinute) {
			const oldest = Math.min(...lastMinute);
			return new Date(oldest + 60 * 1000).toISOString();
		}
		if (stamps.length >= perHour) {
			const oldest = Math.min(...stamps);
			return new Date(oldest + 60 * 60 * 1000).toISOString();
		}
		return undefined;
	}

	recordRequest(source: string): void {
		const now = Date.now();
		const stamps = this.readRequestLog(source).filter(
			(t) => now - t < 60 * 60 * 1000,
		);
		stamps.push(now);
		writeFileSync(this.requestLogPath(source), JSON.stringify(stamps));
	}

	private entryPath(namespace: string, key: string): string {
		const hash = createHash("sha256").update(key).digest("hex").slice(0, 32);
		return join(this.dir, `${namespace}-${hash}.json`);
	}

	private breakerPath(source: string): string {
		return join(this.dir, `breaker-${source}.json`);
	}

	private requestLogPath(source: string): string {
		return join(this.dir, `requests-${source}.json`);
	}

	private readRequestLog(source: string): number[] {
		const path = this.requestLogPath(source);
		if (!existsSync(path)) {
			return [];
		}
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
			return Array.isArray(parsed)
				? parsed.filter((t): t is number => typeof t === "number")
				: [];
		} catch {
			rmSync(path, { force: true });
			return [];
		}
	}

	private readEnvelope(path: string): CacheEnvelope | undefined {
		try {
			return JSON.parse(readFileSync(path, "utf8")) as CacheEnvelope;
		} catch {
			rmSync(path, { force: true });
			return undefined;
		}
	}

	private readBreaker(path: string): BreakerState | undefined {
		try {
			return JSON.parse(readFileSync(path, "utf8")) as BreakerState;
		} catch {
			rmSync(path, { force: true });
			return undefined;
		}
	}
}
