import { err, ok, type Result } from "neverthrow";
import type { FileCache } from "../core/file-cache";
import { type SourceResult, sourceFetch } from "../core/source-fetch";
import { gfzKpSchema } from "../domain/gfz.schema";
import type { KpSample } from "../domain/kp";
import {
	type SpaceDataError,
	UpstreamSchemaError,
} from "../errors/spacedata-error";

const SOURCE = "gfz-kp";
const BASE_URL = "https://kp.gfz.de/app/json/";
// GFZ Potsdam is the official producer of the planetary Kp index. Its JSON
// service is free, CC BY 4.0-licensed and has no published rate limit
// (https://kp.gfz.de/en/data). Kp is issued in 3-hour bins, so one bin is the
// natural refresh cadence; request windows are aligned to bin boundaries so
// the cache key stays stable for a whole TTL.
const TTL_SECONDS = 3 * 60 * 60;
const BREAKER_COOLDOWN_SECONDS = 30 * 60;

export interface KpHistory {
	samples: KpSample[];
}

export interface GfzOptions {
	cache: FileCache;
	fresh: boolean;
	baseUrl?: string;
}

/**
 * Planetary Kp history for the last `days` days (3-hour bins, UTC), from the
 * start of the first UTC day through the current bin.
 */
export function fetchKpHistory(
	days: number,
	options: GfzOptions,
	/** "Now" for the window end; defaults to now. For tests. */
	now?: Date,
): Promise<Result<SourceResult<KpHistory>, SpaceDataError>> {
	const reference = now ?? new Date();
	const endMs = ceilToKpBin(reference.getTime());
	const startMs = floorToUtcMidnight(endMs - days * 86_400_000);

	const url = new URL(options.baseUrl ?? BASE_URL);
	url.searchParams.set("start", toGfzInstant(startMs));
	url.searchParams.set("end", toGfzInstant(endMs));
	url.searchParams.set("index", "Kp");

	return sourceFetch<KpHistory>({
		source: SOURCE,
		url: url.toString(),
		cache: options.cache,
		ttlSeconds: TTL_SECONDS,
		breakerCooldownSeconds: BREAKER_COOLDOWN_SECONDS,
		fresh: options.fresh,
		parseBody: parseKpBody,
	});
}

function parseKpBody(body: string): Result<KpHistory, SpaceDataError> {
	let json: unknown;
	try {
		json = JSON.parse(body);
	} catch {
		return err(new UpstreamSchemaError(SOURCE, "response is not valid JSON"));
	}

	const parsed = gfzKpSchema.safeParse(json);
	if (!parsed.success) {
		return err(
			new UpstreamSchemaError(
				SOURCE,
				parsed.error.issues[0]?.message ?? "unknown issue",
			),
		);
	}

	const samples: KpSample[] = [];
	for (let index = 0; index < parsed.data.datetime.length; index += 1) {
		const kp = parsed.data.Kp[index];
		const time = parsed.data.datetime[index];
		if (kp === null || kp === undefined || time === undefined) {
			continue; // bins not yet issued come back as null
		}
		samples.push({
			time,
			kp,
			definitive: parsed.data.status?.[index] === "def",
		});
	}
	return ok({ samples });
}

const KP_BIN_MS = 3 * 3_600_000;

function ceilToKpBin(ms: number): number {
	return Math.ceil(ms / KP_BIN_MS) * KP_BIN_MS;
}

function floorToUtcMidnight(ms: number): number {
	return Math.floor(ms / 86_400_000) * 86_400_000;
}

/** GFZ expects second-precision ISO instants (no milliseconds). */
function toGfzInstant(ms: number): string {
	return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}
