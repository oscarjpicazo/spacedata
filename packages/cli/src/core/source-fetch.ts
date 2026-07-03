import { err, ok, type Result } from "neverthrow";
import {
	AuthenticationError,
	CircuitOpenError,
	NetworkError,
	NotFoundError,
	RateLimitedError,
	type SpaceDataError,
	UpstreamHttpError,
} from "../errors/spacedata-error";
import type { FileCache } from "./file-cache";

export interface SourceResult<T> {
	source: string;
	cached: boolean;
	fetchedAt: string;
	data: T;
}

export interface SourceFetchOptions {
	source: string;
	url: string;
	cache: FileCache;
	ttlSeconds: number;
	breakerCooldownSeconds: number;
	fresh: boolean;
	method?: "GET" | "POST";
	body?: string;
	headers?: Record<string, string>;
	/**
	 * Cache key override. MANDATORY when the request body carries credentials:
	 * the key must identify the query only — secrets must never reach the
	 * cache, not even hashed.
	 */
	cacheKey?: string;
	/**
	 * Persistent sliding-window rate limit for the source (e.g. Space-Track's
	 * <30/min and 300/h). Checked before the request; when exceeded the call
	 * fails fast with RateLimitedError instead of hitting the API.
	 */
	rateLimit?: { perMinute: number; perHour: number };
	/**
	 * "The query matched nothing" is a valid answer, not an upstream failure:
	 * these statuses map to NotFoundError and must NOT open the breaker.
	 */
	notFoundMessage?: string;
	/**
	 * When set, 401/403 responses map to AuthenticationError (bad user
	 * credentials) without opening the breaker: the upstream is healthy.
	 */
	authenticated?: boolean;
	/** Parse and validate the raw HTTP body into T (or a domain error). */
	parseBody: (body: string) => Result<unknown, SpaceDataError>;
}

/**
 * Shared fetch pipeline for every upstream source: cache → circuit breaker →
 * rate limit → HTTP → body validation → cache write. On any non-200 the
 * breaker opens for the source's cooldown, as required by CelesTrak's M2M
 * usage policy.
 */
export async function sourceFetch<T>(
	options: SourceFetchOptions,
): Promise<Result<SourceResult<T>, SpaceDataError>> {
	const {
		source,
		url,
		cache,
		ttlSeconds,
		breakerCooldownSeconds,
		fresh,
		method,
		body: requestBody,
		headers,
		cacheKey,
		rateLimit,
		notFoundMessage,
		authenticated,
		parseBody,
	} = options;

	const key = cacheKey ?? url;

	if (!fresh) {
		const hit = cache.get<T>(source, key);
		if (hit !== undefined) {
			return ok({
				source,
				cached: true,
				fetchedAt: hit.storedAt,
				data: hit.value,
			});
		}
	}

	const retryAt = cache.breakerRetryAt(source);
	if (retryAt !== undefined) {
		return err(new CircuitOpenError(source, retryAt));
	}

	if (rateLimit !== undefined) {
		const rateRetryAt = cache.rateLimitRetryAt(
			source,
			rateLimit.perMinute,
			rateLimit.perHour,
		);
		if (rateRetryAt !== undefined) {
			return err(new RateLimitedError(source, rateRetryAt));
		}
		cache.recordRequest(source);
	}

	let response: Response;
	try {
		response = await fetch(url, {
			method: method ?? "GET",
			headers,
			body: requestBody,
		});
	} catch (cause) {
		return err(new NetworkError(source, cause));
	}

	if (response.status === 404 && notFoundMessage !== undefined) {
		return err(new NotFoundError(notFoundMessage));
	}

	if (
		authenticated === true &&
		(response.status === 401 || response.status === 403)
	) {
		return err(new AuthenticationError(source));
	}

	if (response.status !== 200) {
		cache.openBreaker(source, breakerCooldownSeconds);
		return err(new UpstreamHttpError(source, response.status));
	}
	cache.clearBreaker(source);

	const body = await response.text();
	const parsed = parseBody(body);
	if (parsed.isErr()) {
		return err(parsed.error);
	}

	cache.set(source, key, parsed.value, ttlSeconds);
	return ok({
		source,
		cached: false,
		fetchedAt: new Date().toISOString(),
		data: parsed.value as T,
	});
}
