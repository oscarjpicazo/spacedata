import { err, ok, type Result } from "neverthrow";
import { wrapAggregate } from "../core/aggregate";
import type { SourceResult } from "../core/source-fetch";
import {
	analyzeElsetSeries,
	type OrbitalEvent,
	type OrbitRegime,
} from "../domain/events";
import type { SpaceDataError } from "../errors/spacedata-error";
import { fetchKpHistory } from "../sources/gfz.source";
import {
	fetchElsetWindow,
	type SpacetrackOptions,
} from "../sources/spacetrack.source";

/**
 * Inputs + computation: element history and geomagnetic context are fetched,
 * the event detection itself runs locally (see domain/events.ts).
 */
const SOURCE = "spacetrack+gfz+analysis";

export interface SatelliteEventsReport {
	noradId: number;
	name: string | undefined;
	windowDays: number;
	/** Element sets analyzed (deduplicated, parsable epochs). */
	elsetCount: number;
	span: { from: string; to: string } | undefined;
	regime: OrbitRegime;
	dragSensitive: boolean;
	noiseFloor: { semiMajorAxisKm: number; inclinationDeg: number } | undefined;
	decayRateKmPerDay?: number;
	events: OrbitalEvent[];
	warnings: string[];
}

export interface SatelliteEventsOptions extends SpacetrackOptions {
	gfzBaseUrl?: string;
}

/**
 * Orbital events of one object over the last `days` days: maneuvers, storm
 * responses and decay anomalies inferred from its Space-Track element
 * history, with planetary Kp (GFZ) as geomagnetic context. The element
 * history is the core input — its failure fails the command; a missing Kp
 * series only disables storm discrimination, with a warning.
 */
export async function computeSatelliteEvents(
	noradId: number,
	days: number,
	options: SatelliteEventsOptions,
): Promise<Result<SourceResult<SatelliteEventsReport>, SpaceDataError>> {
	const [elsets, kp] = await Promise.all([
		fetchElsetWindow(noradId, days, options),
		fetchKpHistory(days, {
			cache: options.cache,
			fresh: options.fresh,
			baseUrl: options.gfzBaseUrl,
		}),
	]);
	if (elsets.isErr()) {
		return err(elsets.error);
	}

	const warnings: string[] = [];
	if (kp.isErr()) {
		warnings.push(
			`the geomagnetic context is unavailable (${kp.error.message}); storm discrimination is disabled and decays during storms may be reported as maneuvers`,
		);
	}

	const analysis = analyzeElsetSeries(
		elsets.value.data,
		kp.isOk() ? kp.value.data.samples : undefined,
	);

	const lastElset = elsets.value.data[elsets.value.data.length - 1];

	return ok(
		wrapAggregate(SOURCE, elsets.value, [kp.isOk() ? kp.value : undefined], {
			noradId,
			name: lastElset?.name,
			windowDays: days,
			elsetCount: analysis.elsetCount,
			span: analysis.span,
			regime: analysis.regime,
			dragSensitive: analysis.dragSensitive,
			noiseFloor: analysis.noiseFloor,
			decayRateKmPerDay: analysis.decayRateKmPerDay,
			events: analysis.events,
			warnings: [...analysis.warnings, ...warnings],
		}),
	);
}
