import { err, ok, type Result } from "neverthrow";
import type { FileCache } from "../core/file-cache";
import { type SourceResult, sourceFetch } from "../core/source-fetch";
import { type DerivedOrbit, deriveOrbit } from "../domain/derive";
import { type Omm, ommArraySchema } from "../domain/omm.schema";
import {
	type CelestrakSatcat,
	celestrakSatcatArraySchema,
} from "../domain/satcat.schema";
import {
	NotFoundError,
	type SpaceDataError,
	UpstreamSchemaError,
} from "../errors/spacedata-error";

const SOURCE = "celestrak";
const GP_URL = "https://celestrak.org/NORAD/elements/gp.php";
const SATCAT_URL = "https://celestrak.org/satcat/records.php";
// CelesTrak updates GP data once every 2 hours and asks clients to download
// each dataset at most once per update cycle; on errors, to stop querying.
const GP_TTL_SECONDS = 2 * 60 * 60;
// The SATCAT changes at most a few times per day; a day of cache is honest.
const SATCAT_TTL_SECONDS = 24 * 60 * 60;
const BREAKER_COOLDOWN_SECONDS = 2 * 60 * 60;

/** SATCAT OBJECT_TYPE codes → readable labels. */
const OBJECT_TYPE_LABELS: Record<string, string> = {
	PAY: "PAYLOAD",
	"R/B": "ROCKET BODY",
	DEB: "DEBRIS",
	UNK: "UNKNOWN",
};

/** SATCAT OPS_STATUS_CODE → readable labels (subset; unknown codes pass through). */
const OPS_STATUS_LABELS: Record<string, string> = {
	"+": "OPERATIONAL",
	"-": "NONOPERATIONAL",
	P: "PARTIALLY OPERATIONAL",
	B: "BACKUP",
	S: "SPARE",
	X: "EXTENDED MISSION",
	D: "DECAYED",
	"?": "UNKNOWN",
};

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

export interface CatalogRecord {
	noradId: number;
	name: string;
	internationalDesignator: string;
	objectType: string;
	operationalStatus: string;
	owner: string;
	launchDate: string;
	launchSite: string;
	decayDate: string | undefined;
	periodMinutes: number | undefined;
	inclinationDeg: number | undefined;
	apogeeKm: number | undefined;
	perigeeKm: number | undefined;
	rcsM2: number | undefined;
	orbitCenter: string;
	onOrbit: boolean;
}

export interface CelestrakOptions {
	cache: FileCache;
	fresh: boolean;
	baseUrl?: string;
}

export function fetchByCatalogNumber(
	noradId: number,
	options: CelestrakOptions,
): Promise<Result<SourceResult<SatelliteRecord[]>, SpaceDataError>> {
	return fetchGp({ CATNR: String(noradId) }, options);
}

export function searchByName(
	query: string,
	options: CelestrakOptions,
): Promise<Result<SourceResult<SatelliteRecord[]>, SpaceDataError>> {
	return fetchGp({ NAME: query }, options);
}

/**
 * Every GP record of one CelesTrak group (e.g. "visual", "stations",
 * "starlink", "active"). Groups are curated CelesTrak dataset names.
 */
export function fetchGroup(
	group: string,
	options: CelestrakOptions,
): Promise<Result<SourceResult<SatelliteRecord[]>, SpaceDataError>> {
	return fetchGp({ GROUP: group }, options);
}

export function fetchCatalogRecord(
	noradId: number,
	options: CelestrakOptions,
): Promise<Result<SourceResult<CatalogRecord>, SpaceDataError>> {
	const url = new URL(options.baseUrl ?? SATCAT_URL);
	url.searchParams.set("CATNR", String(noradId));
	url.searchParams.set("FORMAT", "json");

	return sourceFetch<CatalogRecord>({
		source: SOURCE,
		url: url.toString(),
		cache: options.cache,
		ttlSeconds: SATCAT_TTL_SECONDS,
		breakerCooldownSeconds: BREAKER_COOLDOWN_SECONDS,
		fresh: options.fresh,
		notFoundMessage: `no object with NORAD id ${noradId} in the CelesTrak SATCAT`,
		parseBody: (body) => parseSatcatBody(body, noradId),
	});
}

async function fetchGp(
	params: Record<string, string>,
	options: CelestrakOptions,
): Promise<Result<SourceResult<SatelliteRecord[]>, SpaceDataError>> {
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
		parseBody: (body) => parseGpBody(body, params.GROUP),
	});
}

function parseGpBody(
	body: string,
	group: string | undefined,
): Result<SatelliteRecord[], SpaceDataError> {
	// CelesTrak answers HTTP 200 with a plain-text sentinel when the query
	// matches no object, instead of an empty JSON array.
	if (body.startsWith("No GP data found")) {
		return err(
			new NotFoundError(
				"no object in the CelesTrak GP catalog matches the query",
			),
		);
	}
	// An unknown GROUP gets a different sentinel: "Invalid query: ...
	// (GROUP=x not found)". Only mapped for group queries — for CATNR/NAME an
	// "Invalid query" body would signal a broken request and must surface as
	// an upstream schema error below, not read as a benign no-match.
	if (group !== undefined && body.startsWith("Invalid query")) {
		return err(new NotFoundError(`no CelesTrak group named "${group}"`));
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

function parseSatcatBody(
	body: string,
	noradId: number,
): Result<CatalogRecord, SpaceDataError> {
	// Like the GP endpoint, a no-match answer is HTTP 200 with a sentinel.
	if (body.startsWith("No SATCAT records found")) {
		return err(
			new NotFoundError(
				`no object with NORAD id ${noradId} in the CelesTrak SATCAT`,
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

	const parsed = celestrakSatcatArraySchema.safeParse(json);
	if (!parsed.success) {
		return err(
			new UpstreamSchemaError(
				SOURCE,
				parsed.error.issues[0]?.message ?? "unknown issue",
			),
		);
	}
	const record = parsed.data[0];
	if (record === undefined) {
		return err(
			new NotFoundError(
				`no object with NORAD id ${noradId} in the CelesTrak SATCAT`,
			),
		);
	}
	return ok(toCatalogRecord(record));
}

function toCatalogRecord(entry: CelestrakSatcat): CatalogRecord {
	return {
		noradId: entry.NORAD_CAT_ID,
		name: entry.OBJECT_NAME,
		internationalDesignator: entry.OBJECT_ID,
		objectType: OBJECT_TYPE_LABELS[entry.OBJECT_TYPE] ?? entry.OBJECT_TYPE,
		operationalStatus:
			OPS_STATUS_LABELS[entry.OPS_STATUS_CODE] ?? entry.OPS_STATUS_CODE,
		owner: entry.OWNER,
		launchDate: entry.LAUNCH_DATE,
		launchSite: entry.LAUNCH_SITE,
		decayDate: entry.DECAY_DATE === "" ? undefined : entry.DECAY_DATE,
		periodMinutes: entry.PERIOD ?? undefined,
		inclinationDeg: entry.INCLINATION ?? undefined,
		apogeeKm: entry.APOGEE ?? undefined,
		perigeeKm: entry.PERIGEE ?? undefined,
		rcsM2: entry.RCS ?? undefined,
		orbitCenter: entry.ORBIT_CENTER,
		onOrbit: entry.DECAY_DATE === "",
	};
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
