import { err, ok, type Result } from "neverthrow";
import type { FileCache } from "../core/file-cache";
import { type SourceResult, sourceFetch } from "../core/source-fetch";
import { type DerivedOrbit, deriveOrbit } from "../domain/derive";
import { type Omm, ommArraySchema } from "../domain/omm.schema";
import {
	NotFoundError,
	type SpaceCliError,
	UpstreamSchemaError,
} from "../errors/space-cli-error";

const SOURCE = "celestrak";
const GP_URL = "https://celestrak.org/NORAD/elements/gp.php";
// CelesTrak updates GP data once every 2 hours and asks clients to download
// each dataset at most once per update cycle; on errors, to stop querying.
const GP_TTL_SECONDS = 2 * 60 * 60;
const BREAKER_COOLDOWN_SECONDS = 2 * 60 * 60;

export interface SatelliteRecord {
	noradId: number;
	name: string;
	internationalDesignator: string;
	epoch: string;
	meanMotionRevPerDay: number;
	eccentricity: number;
	inclinationDeg: number;
	raOfAscNodeDeg: number;
	argOfPericenterDeg: number;
	meanAnomalyDeg: number;
	bstar: number;
	revAtEpoch: number | undefined;
	derived: DerivedOrbit;
}

export interface CelestrakOptions {
	cache: FileCache;
	fresh: boolean;
	baseUrl?: string;
}

export function fetchByCatalogNumber(
	noradId: number,
	options: CelestrakOptions,
): Promise<Result<SourceResult<SatelliteRecord[]>, SpaceCliError>> {
	return fetchGp({ CATNR: String(noradId) }, options);
}

export function searchByName(
	query: string,
	options: CelestrakOptions,
): Promise<Result<SourceResult<SatelliteRecord[]>, SpaceCliError>> {
	return fetchGp({ NAME: query }, options);
}

async function fetchGp(
	params: Record<string, string>,
	options: CelestrakOptions,
): Promise<Result<SourceResult<SatelliteRecord[]>, SpaceCliError>> {
	const url = new URL(options.baseUrl ?? GP_URL);
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value);
	}
	url.searchParams.set("FORMAT", "json");

	return sourceFetch<SatelliteRecord[]>({
		source: SOURCE,
		url: url.toString(),
		cache: options.cache,
		ttlSeconds: GP_TTL_SECONDS,
		breakerCooldownSeconds: BREAKER_COOLDOWN_SECONDS,
		fresh: options.fresh,
		notFoundMessage: "no object in the CelesTrak GP catalog matches the query",
		parseBody: parseGpBody,
	});
}

function parseGpBody(body: string): Result<SatelliteRecord[], SpaceCliError> {
	// CelesTrak answers HTTP 200 with a plain-text sentinel when the query
	// matches no object, instead of an empty JSON array.
	if (body.startsWith("No GP data found")) {
		return err(
			new NotFoundError(
				"no object in the CelesTrak GP catalog matches the query",
			),
		);
	}

	let json: unknown;
	try {
		json = JSON.parse(body);
	} catch {
		return err(
			new UpstreamSchemaError(
				SOURCE,
				"response is neither JSON nor a known sentinel",
			),
		);
	}

	const parsed = ommArraySchema.safeParse(json);
	if (!parsed.success) {
		return err(
			new UpstreamSchemaError(
				SOURCE,
				parsed.error.issues[0]?.message ?? "unknown issue",
			),
		);
	}

	return ok(parsed.data.map(toSatelliteRecord));
}

function toSatelliteRecord(omm: Omm): SatelliteRecord {
	return {
		noradId: omm.NORAD_CAT_ID,
		name: omm.OBJECT_NAME,
		internationalDesignator: omm.OBJECT_ID,
		epoch: omm.EPOCH,
		meanMotionRevPerDay: omm.MEAN_MOTION,
		eccentricity: omm.ECCENTRICITY,
		inclinationDeg: omm.INCLINATION,
		raOfAscNodeDeg: omm.RA_OF_ASC_NODE,
		argOfPericenterDeg: omm.ARG_OF_PERICENTER,
		meanAnomalyDeg: omm.MEAN_ANOMALY,
		bstar: omm.BSTAR,
		revAtEpoch: omm.REV_AT_EPOCH,
		derived: deriveOrbit(omm.MEAN_MOTION, omm.ECCENTRICITY),
	};
}
