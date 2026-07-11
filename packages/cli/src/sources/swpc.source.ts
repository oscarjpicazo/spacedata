import { err, ok, type Result } from "neverthrow";
import type { FileCache } from "../core/file-cache";
import { type SourceResult, sourceFetch } from "../core/source-fetch";
import { parseEpoch } from "../domain/propagation";
import {
	type SwpcKpForecastEntry,
	type SwpcScales,
	swpcEstimatedKpArraySchema,
	swpcKpForecastArraySchema,
	swpcOvationSchema,
	swpcScalesSchema,
	swpcSolarWindMagSchema,
	swpcSolarWindSpeedSchema,
	swpcXrayArraySchema,
} from "../domain/swpc.schema";
import {
	type SpaceDataError,
	UpstreamSchemaError,
} from "../errors/spacedata-error";

const SOURCE = "noaa-swpc";
const BASE_URL = "https://services.swpc.noaa.gov";
// SWPC is a free public service with no documented rate limit; near-real-time
// products refresh every 1-5 minutes, forecasts a few times per day. Caching
// one refresh cycle keeps agent loops from hammering it. With no published
// policy to cite, the breaker cooldown (~2 refresh cycles) simply stops
// re-querying a failing product for a sensible while.
const REALTIME_TTL_SECONDS = 5 * 60;
const FORECAST_TTL_SECONDS = 30 * 60;
const BREAKER_COOLDOWN_SECONDS = 10 * 60;

export interface EstimatedKp {
	time: string;
	estimatedKp: number;
}

export interface KpForecastEntry {
	time: string;
	kp: number;
	kind: string;
	noaaScale: string | undefined;
}

export interface KpForecast {
	entries: KpForecastEntry[];
}

export interface NoaaScaleNow {
	scale: string;
	text: string;
}

export interface NoaaScales {
	observedAt: string;
	radioBlackouts: NoaaScaleNow;
	solarRadiation: NoaaScaleNow;
	geomagneticStorm: NoaaScaleNow;
	todayProbabilities: {
		radioBlackoutMinorPct: number | undefined;
		radioBlackoutMajorPct: number | undefined;
		solarRadiationPct: number | undefined;
	};
	geomagneticOutlook: { date: string; scale: string; text: string }[];
}

export interface SolarWindSpeed {
	speedKmS: number;
	time: string;
}

export interface SolarWindMag {
	btNt: number;
	bzNt: number;
	time: string;
}

export interface XrayFlux {
	fluxWm2: number;
	time: string;
}

export interface AuroraGrid {
	observationTime: string;
	forecastTime: string;
	coordinates: [number, number, number][];
}

export interface SwpcOptions {
	cache: FileCache;
	fresh: boolean;
	baseUrl?: string;
}

/** Latest 1-minute estimated planetary Kp. */
export function fetchEstimatedKp(
	options: SwpcOptions,
): Promise<Result<SourceResult<EstimatedKp>, SpaceDataError>> {
	return fetchProduct(
		options,
		"kp-1m",
		"/json/planetary_k_index_1m.json",
		REALTIME_TTL_SECONDS,
		(json) => {
			const parsed = swpcEstimatedKpArraySchema.safeParse(json);
			if (!parsed.success) {
				return schemaError(parsed.error.issues[0]?.message);
			}
			const latest = latestByTime(parsed.data);
			if (latest === undefined) {
				return schemaError("the estimated Kp series is empty");
			}
			// This product's time_tag carries no zone (UTC implied): normalize
			// so every timestamp in the reports is an explicit-UTC ISO string.
			return ok({
				time: parseEpoch(latest.time_tag)?.toISOString() ?? latest.time_tag,
				estimatedKp: latest.estimated_kp,
			});
		},
	);
}

/** Observed + predicted 3-hour Kp bins with NOAA G scales. */
export function fetchKpForecast(
	options: SwpcOptions,
): Promise<Result<SourceResult<KpForecast>, SpaceDataError>> {
	return fetchProduct(
		options,
		"kp-forecast",
		"/products/noaa-planetary-k-index-forecast.json",
		FORECAST_TTL_SECONDS,
		(json) => {
			const parsed = swpcKpForecastArraySchema.safeParse(json);
			if (!parsed.success) {
				return schemaError(parsed.error.issues[0]?.message);
			}
			return ok({ entries: parsed.data.map(toForecastEntry) });
		},
	);
}

/** Current NOAA R/S/G scales, today's probabilities and the 2-day outlook. */
export function fetchScales(
	options: SwpcOptions,
): Promise<Result<SourceResult<NoaaScales>, SpaceDataError>> {
	return fetchProduct(
		options,
		"scales",
		"/products/noaa-scales.json",
		// The "0" block is CURRENT conditions, not a forecast: real-time TTL.
		REALTIME_TTL_SECONDS,
		(json) => {
			const parsed = swpcScalesSchema.safeParse(json);
			return parsed.success
				? toNoaaScales(parsed.data)
				: schemaError(parsed.error.issues[0]?.message);
		},
	);
}

export function fetchSolarWindSpeed(
	options: SwpcOptions,
): Promise<Result<SourceResult<SolarWindSpeed>, SpaceDataError>> {
	return fetchProduct(
		options,
		"solar-wind-speed",
		"/products/summary/solar-wind-speed.json",
		REALTIME_TTL_SECONDS,
		(json) => {
			const parsed = swpcSolarWindSpeedSchema.safeParse(json);
			if (!parsed.success) {
				return schemaError(parsed.error.issues[0]?.message);
			}
			const latest = latestByTime(parsed.data);
			if (latest === undefined) {
				return schemaError("the solar wind speed series is empty");
			}
			return ok({ speedKmS: latest.proton_speed, time: latest.time_tag });
		},
	);
}

export function fetchSolarWindMag(
	options: SwpcOptions,
): Promise<Result<SourceResult<SolarWindMag>, SpaceDataError>> {
	return fetchProduct(
		options,
		"solar-wind-mag",
		"/products/summary/solar-wind-mag-field.json",
		REALTIME_TTL_SECONDS,
		(json) => {
			const parsed = swpcSolarWindMagSchema.safeParse(json);
			if (!parsed.success) {
				return schemaError(parsed.error.issues[0]?.message);
			}
			const latest = latestByTime(parsed.data);
			if (latest === undefined) {
				return schemaError("the magnetic field series is empty");
			}
			return ok({
				btNt: latest.bt,
				bzNt: latest.bz_gsm,
				time: latest.time_tag,
			});
		},
	);
}

/** Latest GOES X-ray flux in the flare-defining 0.1-0.8nm band. */
export function fetchXrayFlux(
	options: SwpcOptions,
): Promise<Result<SourceResult<XrayFlux>, SpaceDataError>> {
	return fetchProduct(
		options,
		"xray",
		"/json/goes/primary/xrays-6-hour.json",
		REALTIME_TTL_SECONDS,
		(json) => {
			const parsed = swpcXrayArraySchema.safeParse(json);
			if (!parsed.success) {
				return schemaError(parsed.error.issues[0]?.message);
			}
			const latest = latestByTime(
				parsed.data.filter((entry) => entry.energy === "0.1-0.8nm"),
			);
			if (latest === undefined) {
				return schemaError("no 0.1-0.8nm X-ray flux sample");
			}
			return ok({ fluxWm2: latest.flux, time: latest.time_tag });
		},
	);
}

/** OVATION aurora probability grid (1°×1°, global). */
export function fetchAuroraGrid(
	options: SwpcOptions,
): Promise<Result<SourceResult<AuroraGrid>, SpaceDataError>> {
	return fetchProduct(
		options,
		"ovation",
		"/json/ovation_aurora_latest.json",
		REALTIME_TTL_SECONDS,
		(json) => {
			const parsed = swpcOvationSchema.safeParse(json);
			if (!parsed.success) {
				return schemaError(parsed.error.issues[0]?.message);
			}
			return ok({
				observationTime: parsed.data["Observation Time"],
				forecastTime: parsed.data["Forecast Time"],
				coordinates: parsed.data.coordinates,
			});
		},
	);
}

function fetchProduct<T>(
	options: SwpcOptions,
	product: string,
	path: string,
	ttlSeconds: number,
	parse: (json: unknown) => Result<T, SpaceDataError>,
): Promise<Result<SourceResult<T>, SpaceDataError>> {
	return sourceFetch<T>({
		// One source key PER PRODUCT (flat — FileCache derives file names from
		// it), so the circuit breaker isolates each endpoint: the aggregate
		// commands fetch several products in parallel, and with a shared key a
		// failing product would lock out its healthy siblings while their 200s
		// simultaneously cleared its breaker. The aggregate envelope still
		// reports plain "noaa-swpc" (see compute/space-weather.compute.ts).
		source: `${SOURCE}-${product}`,
		url: `${options.baseUrl ?? BASE_URL}${path}`,
		cache: options.cache,
		ttlSeconds,
		breakerCooldownSeconds: BREAKER_COOLDOWN_SECONDS,
		fresh: options.fresh,
		parseBody: (body) => {
			let json: unknown;
			try {
				json = JSON.parse(body);
			} catch {
				return schemaError("response is not JSON");
			}
			return parse(json);
		},
	});
}

function schemaError(
	detail: string | undefined,
): Result<never, SpaceDataError> {
	return err(new UpstreamSchemaError(SOURCE, detail ?? "unknown issue"));
}

/** Latest sample by time_tag — never trusts upstream array ordering. */
function latestByTime<T extends { time_tag: string }>(
	entries: T[],
): T | undefined {
	let latest: T | undefined;
	for (const entry of entries) {
		// SWPC time_tags are uniform ISO-8601 per product: lexicographic
		// comparison is chronological.
		if (latest === undefined || entry.time_tag > latest.time_tag) {
			latest = entry;
		}
	}
	return latest;
}

function toForecastEntry(entry: SwpcKpForecastEntry): KpForecastEntry {
	return {
		time: entry.time_tag,
		kp: entry.kp,
		kind: entry.observed,
		// SWPC uses null for storm-free bins; guard "" defensively too.
		noaaScale:
			entry.noaa_scale === null || entry.noaa_scale === ""
				? undefined
				: entry.noaa_scale,
	};
}

function toNoaaScales(data: SwpcScales): Result<NoaaScales, SpaceDataError> {
	const current = data["0"];
	if (current === undefined) {
		return schemaError("noaa-scales is missing the current-conditions entry");
	}

	const outlook: { date: string; scale: string; text: string }[] = [];
	for (const key of ["2", "3"]) {
		const day = data[key];
		if (day?.G.Scale != null && day.G.Text != null) {
			outlook.push({
				date: day.DateStamp,
				scale: `G${day.G.Scale}`,
				text: day.G.Text,
			});
		}
	}

	const probabilities = data["1"];
	return ok({
		// SWPC publishes every product timestamp in UTC; the noaa-scales
		// DateStamp/TimeStamp pair carries no zone, so we pin it explicitly.
		observedAt: `${current.DateStamp}T${current.TimeStamp}Z`,
		radioBlackouts: toScaleNow("R", current.R),
		solarRadiation: toScaleNow("S", current.S),
		geomagneticStorm: toScaleNow("G", current.G),
		todayProbabilities: {
			radioBlackoutMinorPct: toPercent(probabilities?.R.MinorProb),
			radioBlackoutMajorPct: toPercent(probabilities?.R.MajorProb),
			solarRadiationPct: toPercent(probabilities?.S.Prob),
		},
		geomagneticOutlook: outlook,
	});
}

function toScaleNow(
	letter: string,
	block: { Scale: string | null; Text: string | null },
): NoaaScaleNow {
	return {
		scale: block.Scale === null ? `${letter}?` : `${letter}${block.Scale}`,
		text: block.Text ?? "unknown",
	};
}

/** SWPC serializes probabilities as strings ("30") or null. */
function toPercent(raw: string | null | undefined): number | undefined {
	if (raw == null) {
		return undefined;
	}
	const value = Number.parseInt(raw, 10);
	return Number.isNaN(value) ? undefined : value;
}
