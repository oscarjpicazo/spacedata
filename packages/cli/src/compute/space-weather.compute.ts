import { err, ok, type Result } from "neverthrow";
import { wrapAggregate } from "../core/aggregate";
import type { SourceResult } from "../core/source-fetch";
import {
	type Observer,
	parseEpoch,
	sunElevationDeg,
	TWILIGHT_SUN_ELEVATION_DEG,
} from "../domain/propagation";
import { round } from "../domain/round";
import {
	auroraProbabilityAt,
	flareClass,
	kpToGScale,
} from "../domain/space-weather";
import {
	type SpaceDataError,
	UpstreamSchemaError,
} from "../errors/spacedata-error";
import {
	fetchAuroraGrid,
	fetchEstimatedKp,
	fetchKpForecast,
	fetchScales,
	fetchSolarWindMag,
	fetchSolarWindSpeed,
	fetchXrayFlux,
	type KpForecastEntry,
	type NoaaScales,
	type SwpcOptions,
} from "../sources/swpc.source";

const SOURCE = "noaa-swpc";

/**
 * Sections other than Kp are optional on purpose: each comes from its own
 * SWPC product, and a single unavailable product must degrade the report
 * (with a warning) instead of failing it.
 */
export interface SpaceWeatherReport {
	/** Instant the report (and its 24h forecast window) was evaluated at. */
	at: string;
	kp: { estimated: number; time: string; noaaScale: string };
	forecastMax24h: { kp: number; time: string; noaaScale: string } | undefined;
	scales: NoaaScales | undefined;
	solarWind: { speedKmS: number; time: string } | undefined;
	magneticField: { btNt: number; bzNt: number; time: string } | undefined;
	xray: { fluxWm2: number; flareClass: string; time: string } | undefined;
	warnings: string[];
}

export interface AuroraReport {
	observer: Observer;
	/** Instant the sun elevation and darkSky flag were evaluated at. */
	at: string;
	probabilityPct: number;
	observationTime: string;
	forecastTime: string;
	kpNow: number | undefined;
	sunElevationDeg: number;
	/** Sun below civil twilight: dark enough to possibly see an aurora. */
	darkSky: boolean;
	warnings: string[];
}

/**
 * Aggregated space-weather snapshot from six SWPC products fetched in
 * parallel. The estimated Kp is the core of the report — its failure fails
 * the command; every other section degrades to undefined with a warning.
 */
export async function computeSpaceWeather(
	options: SwpcOptions,
	/** "Now" for the 24h forecast window; defaults to now. For tests. */
	now?: Date,
): Promise<Result<SourceResult<SpaceWeatherReport>, SpaceDataError>> {
	const [kp, forecast, scales, wind, mag, xray] = await Promise.all([
		fetchEstimatedKp(options),
		fetchKpForecast(options),
		fetchScales(options),
		fetchSolarWindSpeed(options),
		fetchSolarWindMag(options),
		fetchXrayFlux(options),
	]);
	if (kp.isErr()) {
		return err(kp.error);
	}

	const warnings: string[] = [];
	const section = <T>(
		name: string,
		result: Result<SourceResult<T>, SpaceDataError>,
	): SourceResult<T> | undefined => {
		if (result.isErr()) {
			warnings.push(sectionUnavailable(name, result.error));
			return undefined;
		}
		return result.value;
	};

	const forecastValue = section("Kp forecast", forecast);
	const scalesValue = section("NOAA scales", scales);
	const windValue = section("solar wind", wind);
	const magValue = section("magnetic field", mag);
	const xrayValue = section("X-ray flux", xray);

	const reference = now ?? new Date();
	const max24h = maxForecastWithin24h(forecastValue?.data.entries, reference);

	const extras = [forecastValue, scalesValue, windValue, magValue, xrayValue];

	return ok(
		wrapAggregate(SOURCE, kp.value, extras, {
			at: reference.toISOString(),
			kp: {
				estimated: kp.value.data.estimatedKp,
				time: kp.value.data.time,
				noaaScale: kpToGScale(kp.value.data.estimatedKp),
			},
			forecastMax24h: max24h,
			scales: scalesValue?.data,
			solarWind: windValue?.data,
			magneticField: magValue?.data,
			xray:
				xrayValue === undefined
					? undefined
					: {
							fluxWm2: xrayValue.data.fluxWm2,
							flareClass: flareClass(xrayValue.data.fluxWm2),
							time: xrayValue.data.time,
						},
			warnings,
		}),
	);
}

/**
 * Aurora visibility outlook at a ground location: OVATION probability for
 * the observer's grid cell, current Kp, and whether the sky is dark enough.
 */
export async function computeAurora(
	observer: Observer,
	options: SwpcOptions,
	/** Instant for the sun-elevation check; defaults to now. For tests. */
	at?: Date,
): Promise<Result<SourceResult<AuroraReport>, SpaceDataError>> {
	const [grid, kp] = await Promise.all([
		fetchAuroraGrid(options),
		fetchEstimatedKp(options),
	]);
	if (grid.isErr()) {
		return err(grid.error);
	}

	const probability = auroraProbabilityAt(
		grid.value.data.coordinates,
		observer.latitudeDeg,
		observer.longitudeDeg,
	);
	if (probability === undefined) {
		return err(
			new UpstreamSchemaError(
				SOURCE,
				"the aurora grid is missing the observer's cell",
			),
		);
	}

	const warnings: string[] = [];
	if (kp.isErr()) {
		warnings.push(sectionUnavailable("Kp", kp.error));
	}

	const when = at ?? new Date();
	// Rounded once, then reused for the flag: the emitted elevation and the
	// darkSky boolean must never contradict each other at the threshold.
	const sunElevation = round(sunElevationDeg(observer, when));

	return ok(
		wrapAggregate(SOURCE, grid.value, [kp.isOk() ? kp.value : undefined], {
			observer,
			at: when.toISOString(),
			probabilityPct: probability,
			observationTime: grid.value.data.observationTime,
			forecastTime: grid.value.data.forecastTime,
			kpNow: kp.isOk() ? kp.value.data.estimatedKp : undefined,
			sunElevationDeg: sunElevation,
			darkSky: sunElevation <= TWILIGHT_SUN_ELEVATION_DEG,
			warnings,
		}),
	);
}

function sectionUnavailable(name: string, error: SpaceDataError): string {
	return `the ${name} section is unavailable: ${error.message}`;
}

function maxForecastWithin24h(
	entries: KpForecastEntry[] | undefined,
	now: Date,
): { kp: number; time: string; noaaScale: string } | undefined {
	if (entries === undefined) {
		return undefined;
	}
	const horizonMs = now.getTime() + 24 * 3_600_000;
	let best: { kp: number; time: string; noaaScale: string } | undefined;
	for (const entry of entries) {
		if (entry.kind === "observed") {
			continue;
		}
		const time = parseEpoch(entry.time);
		if (time === undefined) {
			continue;
		}
		const ms = time.getTime();
		// A bin timestamped exactly "now" starts now: part of the window.
		if (ms < now.getTime() || ms > horizonMs) {
			continue;
		}
		if (best === undefined || entry.kp > best.kp) {
			best = {
				kp: entry.kp,
				time: time.toISOString(),
				noaaScale: entry.noaaScale ?? kpToGScale(entry.kp),
			};
		}
	}
	return best;
}
