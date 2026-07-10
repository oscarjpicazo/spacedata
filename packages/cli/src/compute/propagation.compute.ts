import { err, ok, type Result } from "neverthrow";
import type { SourceResult } from "../core/source-fetch";
import {
	elementAgeHours,
	findPasses,
	type Observer,
	observerView,
	propagatePosition,
	type SatellitePass,
} from "../domain/propagation";
import { NotFoundError, type SpaceDataError } from "../errors/spacedata-error";
import {
	type CelestrakOptions,
	fetchByCatalogNumber,
	fetchGroup,
	type SatelliteRecord,
} from "../sources/celestrak.source";

/**
 * SGP4 results computed locally from CelesTrak elements: the envelope's
 * `cached`/`fetchedAt` describe the underlying element fetch.
 */
const SOURCE = "celestrak+sgp4";

/** SGP4 accuracy degrades noticeably beyond ~7 days from the element epoch. */
const STALE_ELEMENTS_DAYS = 7;
const STALE_ELEMENTS_HOURS = STALE_ELEMENTS_DAYS * 24;

export interface PositionReport {
	noradId: number;
	name: string;
	at: string;
	latitudeDeg: number;
	longitudeDeg: number;
	altitudeKm: number;
	speedKmS: number;
	sunlit: boolean;
	tleEpoch: string;
	tleAgeHours: number;
	warnings: string[];
}

export interface PassesReport {
	noradId: number;
	name: string;
	observer: Observer;
	windowStart: string;
	windowEnd: string;
	minElevationDeg: number;
	tleEpoch: string;
	tleAgeHours: number;
	alwaysAboveMinElevation: boolean;
	passes: SatellitePass[];
	warnings: string[];
}

export interface OverheadSatellite {
	noradId: number;
	name: string;
	elevationDeg: number;
	azimuthDeg: number;
	rangeKm: number;
	altitudeKm: number;
	sunlit: boolean;
	tleAgeHours: number;
}

export interface OverheadReport {
	group: string;
	at: string;
	observer: Observer;
	minElevationDeg: number;
	totalAboveMinElevation: number;
	satellites: OverheadSatellite[];
	/** Objects in the group whose elements failed to propagate. */
	skippedObjects: number;
	warnings: string[];
}

export interface PassesQuery {
	days: number;
	minElevationDeg: number;
	visibleOnly: boolean;
	/** Window start; defaults to now. Injectable for tests. */
	start?: Date;
}

export interface OverheadQuery {
	group: string;
	minElevationDeg: number;
	limit: number;
	/** Instant to evaluate; defaults to now. Injectable for tests. */
	at?: Date;
}

/** Geodetic position, speed and illumination of one object at one instant. */
export async function computePosition(
	noradId: number,
	at: Date | undefined,
	options: CelestrakOptions,
): Promise<Result<SourceResult<PositionReport>, SpaceDataError>> {
	const fetched = await fetchElements(noradId, options);
	if (fetched.isErr()) {
		return err(fetched.error);
	}
	const { envelope, record } = fetched.value;
	const when = at ?? new Date();

	const age = elementAgeHours(record, when);
	if (age.isErr()) {
		return err(age.error);
	}

	return propagatePosition(record, when).map((position) =>
		wrap(envelope, {
			noradId: record.noradId,
			name: record.name,
			at: when.toISOString(),
			...position,
			tleEpoch: record.epoch,
			tleAgeHours: age.value,
			warnings: stalenessWarnings(age.value),
		}),
	);
}

/** Upcoming passes of one object over a ground observer. */
export async function computePasses(
	noradId: number,
	observer: Observer,
	query: PassesQuery,
	options: CelestrakOptions,
): Promise<Result<SourceResult<PassesReport>, SpaceDataError>> {
	const fetched = await fetchElements(noradId, options);
	if (fetched.isErr()) {
		return err(fetched.error);
	}
	const { envelope, record } = fetched.value;
	const start = query.start ?? new Date();

	const age = elementAgeHours(record, start);
	if (age.isErr()) {
		return err(age.error);
	}
	// The whole window must be trustworthy: warn from the age at whichever
	// window edge is farther from the element epoch.
	const endAgeHours = age.value + query.days * 24;
	const worstAgeHours =
		Math.abs(endAgeHours) > Math.abs(age.value) ? endAgeHours : age.value;

	return findPasses(
		record,
		observer,
		start,
		query.days,
		query.minElevationDeg,
	).map((search) => {
		const warnings = stalenessWarnings(worstAgeHours);
		if (search.failedSamples > 0) {
			warnings.push(
				`SGP4 failed to propagate ${search.failedSamples} sampled instants of ` +
					"the window (the orbit may have decayed); passes may be truncated",
			);
		}
		return wrap(envelope, {
			noradId: record.noradId,
			name: record.name,
			observer,
			windowStart: start.toISOString(),
			windowEnd: new Date(
				start.getTime() + query.days * 86_400_000,
			).toISOString(),
			minElevationDeg: query.minElevationDeg,
			tleEpoch: record.epoch,
			tleAgeHours: age.value,
			alwaysAboveMinElevation: search.alwaysAboveMinElevation,
			passes: query.visibleOnly
				? search.passes.filter((pass) => pass.visible)
				: search.passes,
			warnings,
		});
	});
}

/** Every object of a CelesTrak group above the observer's horizon right now. */
export async function computeOverhead(
	observer: Observer,
	query: OverheadQuery,
	options: CelestrakOptions,
): Promise<Result<SourceResult<OverheadReport>, SpaceDataError>> {
	const fetched = await fetchGroup(query.group, options);
	if (fetched.isErr()) {
		return err(fetched.error);
	}
	const at = query.at ?? new Date();

	let skippedObjects = 0;
	const above: OverheadSatellite[] = [];
	for (const record of fetched.value.data) {
		const view = observerView(record, observer, at);
		const age = elementAgeHours(record, at);
		if (view.isErr() || age.isErr()) {
			skippedObjects += 1;
			continue;
		}
		if (view.value.elevationDeg >= query.minElevationDeg) {
			above.push({
				noradId: record.noradId,
				name: record.name,
				...view.value,
				tleAgeHours: age.value,
			});
		}
	}
	above.sort((a, b) => b.elevationDeg - a.elevationDeg);

	const satellites = above.slice(0, query.limit);
	const warnings: string[] = [];
	const staleCount = above.filter(
		(satellite) => Math.abs(satellite.tleAgeHours) > STALE_ELEMENTS_HOURS,
	).length;
	if (staleCount > 0) {
		warnings.push(
			`${staleCount} of the ${above.length} objects above ${query.minElevationDeg}° ` +
				`have element sets older than ~${STALE_ELEMENTS_DAYS} days; their SGP4 ` +
				"positions are degraded",
		);
	}
	if (satellites.length < above.length) {
		warnings.push(
			`showing the ${satellites.length} highest of ${above.length} objects above ` +
				`${query.minElevationDeg}° elevation; raise the limit to see the rest`,
		);
	}

	return ok(
		wrap(fetched.value, {
			group: query.group,
			at: at.toISOString(),
			observer,
			minElevationDeg: query.minElevationDeg,
			totalAboveMinElevation: above.length,
			satellites,
			skippedObjects,
			warnings,
		}),
	);
}

async function fetchElements(
	noradId: number,
	options: CelestrakOptions,
): Promise<
	Result<
		{ envelope: SourceResult<SatelliteRecord[]>; record: SatelliteRecord },
		SpaceDataError
	>
> {
	const fetched = await fetchByCatalogNumber(noradId, options);
	if (fetched.isErr()) {
		return err(fetched.error);
	}
	const record = fetched.value.data[0];
	if (record === undefined) {
		return err(
			new NotFoundError(
				`no object with NORAD id ${noradId} in the CelesTrak GP catalog`,
			),
		);
	}
	return ok({ envelope: fetched.value, record });
}

function wrap<T>(underlying: SourceResult<unknown>, data: T): SourceResult<T> {
	return {
		source: SOURCE,
		cached: underlying.cached,
		fetchedAt: underlying.fetchedAt,
		data,
	};
}

function stalenessWarnings(tleAgeHours: number): string[] {
	if (Math.abs(tleAgeHours) <= STALE_ELEMENTS_HOURS) {
		return [];
	}
	const days = Math.round(Math.abs(tleAgeHours) / 24);
	return [
		`the requested time is ~${days} days from the element set epoch; ` +
			`SGP4 accuracy degrades beyond ~${STALE_ELEMENTS_DAYS} days`,
	];
}
