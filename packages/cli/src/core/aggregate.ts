import type { SourceResult } from "./source-fetch";

/**
 * Aggregate envelope for reports built from several fetches: `cached` only
 * when every contributing fetch came from cache; `fetchedAt` is the most
 * recent of them. The core fetch is required, so the aggregate is never
 * empty; extras are the sections that may have degraded to undefined.
 */
export function wrapAggregate<T>(
	source: string,
	core: SourceResult<unknown>,
	extras: (SourceResult<unknown> | undefined)[],
	data: T,
): SourceResult<T> {
	const sources = [core, ...extras.filter((entry) => entry !== undefined)];
	return {
		source,
		cached: sources.every((entry) => entry.cached),
		// ISO-8601 strings compare chronologically.
		fetchedAt: sources.reduce(
			(latest, entry) => (entry.fetchedAt > latest ? entry.fetchedAt : latest),
			core.fetchedAt,
		),
		data,
	};
}
