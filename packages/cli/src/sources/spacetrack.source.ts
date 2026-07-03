import { err, ok, type Result } from "neverthrow";
import type { ZodType } from "zod";
import type { FileCache } from "../core/file-cache";
import { type SourceResult, sourceFetch } from "../core/source-fetch";
import { type DerivedOrbit, deriveOrbit } from "../domain/derive";
import {
	type Cdm,
	cdmArraySchema,
	type GpHistory,
	gpHistoryArraySchema,
	type Tip,
	tipArraySchema,
} from "../domain/spacetrack.schema";
import {
	AuthenticationError,
	MissingCredentialsError,
	NetworkError,
	NotFoundError,
	type SpaceDataError,
	UpstreamHttpError,
	UpstreamSchemaError,
} from "../errors/spacedata-error";

const SOURCE = "spacetrack";
const LOGIN_URL = "https://www.space-track.org/ajaxauth/login";
const QUERY_BASE = "https://www.space-track.org/basicspacedata/query";

// Space-Track's user agreement: fewer than 30 requests/minute and 300/hour,
// violations can suspend the account. We stay under with a safety margin,
// enforced across CLI invocations via the persistent request log.
const RATE_LIMIT = { perMinute: 25, perHour: 250 };
// Recommended query cadence for GP-class data is at most hourly.
const TTL_HOUR_SECONDS = 60 * 60;
const BREAKER_COOLDOWN_SECONDS = 60 * 60;

export interface SpacetrackOptions {
	cache: FileCache;
	fresh: boolean;
	identity?: string;
	password?: string;
	baseUrl?: string;
	loginUrl?: string;
}

export interface Conjunction {
	cdmId: string;
	created: string | undefined;
	tca: string;
	minRangeKm: number | undefined;
	collisionProbability: number | undefined;
	emergencyReportable: boolean;
	sat1: ConjunctionSatellite;
	sat2: ConjunctionSatellite;
}

interface ConjunctionSatellite {
	noradId: number;
	name: string | undefined;
	objectType: string | undefined;
}

export interface Reentry {
	noradId: number;
	messageEpoch: string | undefined;
	predictedDecayEpoch: string | undefined;
	windowHours: number | undefined;
	latDeg: number | undefined;
	lonDeg: number | undefined;
	inclinationDeg: number | undefined;
	nextReport: string | undefined;
	highInterest: boolean;
}

export interface HistoricalElset {
	noradId: number;
	name: string | undefined;
	internationalDesignator: string | undefined;
	epoch: string;
	meanMotionRevPerDay: number;
	eccentricity: number;
	inclinationDeg: number;
	raOfAscNodeDeg: number;
	argOfPericenterDeg: number;
	meanAnomalyDeg: number;
	derived: DerivedOrbit;
}

export function fetchConjunctions(
	limit: number,
	noradId: number | undefined,
	options: SpacetrackOptions,
): Promise<Result<SourceResult<Conjunction[]>, SpaceDataError>> {
	return spacetrackQuery<Conjunction[]>(
		`/class/cdm_public/TCA/>now/orderby/TCA asc/limit/${limit}/format/json`,
		options,
		TTL_HOUR_SECONDS,
		(body) =>
			parseWith(cdmArraySchema, body).map((cdms) => {
				const conjunctions = cdms.map(toConjunction);
				if (noradId === undefined) {
					return conjunctions;
				}
				return conjunctions.filter(
					(c) => c.sat1.noradId === noradId || c.sat2.noradId === noradId,
				);
			}),
	);
}

export function fetchReentries(
	limit: number,
	options: SpacetrackOptions,
): Promise<Result<SourceResult<Reentry[]>, SpaceDataError>> {
	return spacetrackQuery<Reentry[]>(
		`/class/tip/orderby/MSG_EPOCH desc/limit/${limit}/format/json`,
		options,
		TTL_HOUR_SECONDS,
		(body) =>
			parseWith(tipArraySchema, body).map((tips) => tips.map(toReentry)),
	);
}

export function fetchElsetHistory(
	noradId: number,
	limit: number,
	options: SpacetrackOptions,
): Promise<Result<SourceResult<HistoricalElset[]>, SpaceDataError>> {
	return spacetrackQuery<HistoricalElset[]>(
		`/class/gp_history/NORAD_CAT_ID/${noradId}/orderby/EPOCH desc/limit/${limit}/format/json`,
		options,
		TTL_HOUR_SECONDS,
		(body) =>
			parseWith(gpHistoryArraySchema, body).andThen((elsets) => {
				if (elsets.length === 0) {
					return err(
						new NotFoundError(
							`no element history for NORAD id ${noradId} on Space-Track`,
						),
					);
				}
				return ok(elsets.map(toHistoricalElset));
			}),
	);
}

function spacetrackQuery<T>(
	queryPath: string,
	options: SpacetrackOptions,
	ttlSeconds: number,
	parse: (body: string) => Result<T, SpaceDataError>,
): Promise<Result<SourceResult<T>, SpaceDataError>> {
	const identity =
		options.identity ?? process.env.SPACEDATA_SPACETRACK_IDENTITY;
	const password =
		options.password ?? process.env.SPACEDATA_SPACETRACK_PASSWORD;
	if (
		identity === undefined ||
		identity === "" ||
		password === undefined ||
		password === ""
	) {
		return Promise.resolve(
			err(
				new MissingCredentialsError(
					"Space-Track requires a free personal account: set SPACEDATA_SPACETRACK_IDENTITY and SPACEDATA_SPACETRACK_PASSWORD (register at https://www.space-track.org)",
				),
			),
		);
	}

	const queryUrl = `${options.baseUrl ?? QUERY_BASE}${queryPath}`;
	const loginUrl = options.loginUrl ?? LOGIN_URL;

	// Space-Track requires a two-step flow: POST the credentials to the login
	// endpoint (grants a session cookie), then GET the query with that cookie.
	// Bundling the query into the login request is rejected with HTTP 400.
	return sourceFetch<T>({
		source: SOURCE,
		url: queryUrl,
		cache: options.cache,
		ttlSeconds,
		breakerCooldownSeconds: BREAKER_COOLDOWN_SECONDS,
		fresh: options.fresh,
		rateLimit: RATE_LIMIT,
		authenticated: true,
		prepare: () => login(loginUrl, identity, password, options.cache),
		parseBody: parse,
	});
}

async function login(
	loginUrl: string,
	identity: string,
	password: string,
	cache: FileCache,
): Promise<Result<Record<string, string>, SpaceDataError>> {
	// The login request also counts against the account's rate limit.
	cache.recordRequest(SOURCE);

	let response: Response;
	try {
		response = await fetch(loginUrl, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ identity, password }).toString(),
		});
	} catch (cause) {
		return err(new NetworkError(SOURCE, cause));
	}

	if (response.status === 401 || response.status === 403) {
		return err(new AuthenticationError(SOURCE));
	}
	if (response.status !== 200) {
		cache.openBreaker(SOURCE, BREAKER_COOLDOWN_SECONDS);
		return err(new UpstreamHttpError(SOURCE, response.status));
	}

	const body = await response.text();
	if (body.includes('"Login"') && body.includes("Failed")) {
		return err(new AuthenticationError(SOURCE));
	}

	const cookies = response.headers.getSetCookie();
	if (cookies.length === 0) {
		return err(new AuthenticationError(SOURCE));
	}
	const cookieHeader = cookies.map((cookie) => cookie.split(";")[0]).join("; ");
	return ok({ Cookie: cookieHeader });
}

function parseWith<T>(
	schema: ZodType<T>,
	body: string,
): Result<T, SpaceDataError> {
	let json: unknown;
	try {
		json = JSON.parse(body);
	} catch {
		return err(new UpstreamSchemaError(SOURCE, "response is not valid JSON"));
	}
	const parsed = schema.safeParse(json);
	if (!parsed.success) {
		return err(
			new UpstreamSchemaError(
				SOURCE,
				parsed.error.issues[0]?.message ?? "unknown issue",
			),
		);
	}
	return ok(parsed.data);
}

function toConjunction(cdm: Cdm): Conjunction {
	return {
		cdmId: cdm.CDM_ID,
		created: cdm.CREATED,
		tca: cdm.TCA,
		minRangeKm: cdm.MIN_RNG,
		collisionProbability: cdm.PC,
		emergencyReportable: cdm.EMERGENCY_REPORTABLE === "Y",
		sat1: {
			noradId: cdm.SAT_1_ID,
			name: cdm.SAT_1_NAME,
			objectType: cdm.SAT1_OBJECT_TYPE,
		},
		sat2: {
			noradId: cdm.SAT_2_ID,
			name: cdm.SAT_2_NAME,
			objectType: cdm.SAT2_OBJECT_TYPE,
		},
	};
}

function toReentry(tip: Tip): Reentry {
	return {
		noradId: tip.NORAD_CAT_ID,
		messageEpoch: tip.MSG_EPOCH,
		predictedDecayEpoch: tip.DECAY_EPOCH,
		windowHours: tip.WINDOW,
		latDeg: tip.LAT,
		lonDeg: tip.LON,
		inclinationDeg: tip.INCL,
		nextReport: tip.NEXT_REPORT,
		highInterest: tip.HIGH_INTEREST === "Y" || tip.HIGH_INTEREST === "true",
	};
}

function toHistoricalElset(elset: GpHistory): HistoricalElset {
	return {
		noradId: elset.NORAD_CAT_ID,
		name: elset.OBJECT_NAME,
		internationalDesignator: elset.OBJECT_ID,
		epoch: elset.EPOCH,
		meanMotionRevPerDay: elset.MEAN_MOTION,
		eccentricity: elset.ECCENTRICITY,
		inclinationDeg: elset.INCLINATION,
		raOfAscNodeDeg: elset.RA_OF_ASC_NODE,
		argOfPericenterDeg: elset.ARG_OF_PERICENTER,
		meanAnomalyDeg: elset.MEAN_ANOMALY,
		derived: deriveOrbit(elset.MEAN_MOTION, elset.ECCENTRICITY),
	};
}
