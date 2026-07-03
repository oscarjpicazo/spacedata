import { err, ok, type Result } from "neverthrow";
import {
	CircuitOpenError,
	NetworkError,
	NotFoundError,
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
	headers?: Record<string, string>;
	/**
	 * "The query matched nothing" is a valid answer, not an upstream failure:
	 * these statuses map to NotFoundError and must NOT open the breaker.
	 */
	notFoundMessage?: string;
	/** Parse and validate the raw HTTP body into T (or a domain error). */
	parseBody: (body: string) => Result<unknown, SpaceDataError>;
}

/**
 * Shared fetch pipeline for every upstream source: circuit breaker → cache →
 * HTTP → body validation → cache write. On any non-200 the breaker opens for
 * the source's cooldown, as required by CelesTrak's M2M usage policy.
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
		headers,
		notFoundMessage,
		parseBody,
	} = options;

	if (!fresh) {
		const hit = cache.get<T>(source, url);
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

	let response: Response;
	try {
		response = await fetch(url, { headers });
	} catch (cause) {
		return err(new NetworkError(source, cause));
	}

	if (response.status === 404 && notFoundMessage !== undefined) {
		return err(new NotFoundError(notFoundMessage));
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

	cache.set(source, url, parsed.value, ttlSeconds);
	return ok({
		source,
		cached: false,
		fetchedAt: new Date().toISOString(),
		data: parsed.value as T,
	});
}
