import { err, ok, type Result } from "neverthrow";
import { wrapAggregate } from "../core/aggregate";
import type { SourceResult } from "../core/source-fetch";
import {
	type ClassifiedChanges,
	classifyChanges,
	groupDebuts,
	type LaunchGroup,
	parseUpstreamInstant,
} from "../domain/catalog-events";
import { type GeomagneticSummary, summarizeKp } from "../domain/kp";
import type { SpaceDataError } from "../errors/spacedata-error";
import { fetchKpHistory } from "../sources/gfz.source";
import {
	fetchPreviousLaunches,
	type LaunchSummary,
} from "../sources/launch-library.source";
import {
	fetchReentries,
	fetchSatcatChanges,
	fetchSatcatDebuts,
	type Reentry,
	type SpacetrackOptions,
} from "../sources/spacetrack.source";

const SOURCE = "spacetrack+launch-library+gfz";

/** Upstream fetch caps; hitting one adds a truncation warning. */
const DEBUT_LIMIT = 500;
const CHANGE_LIMIT = 500;
const REENTRY_FETCH_LIMIT = 60;
const LAUNCH_LIMIT = 60;

export interface OrbitalEventsReport {
	windowDays: number;
	/** Instant the window was evaluated at. */
	at: string;
	/** Newly cataloged objects, grouped by launch. */
	newObjects: { count: number; launches: LaunchGroup[] };
	/** Debut bursts for old launches — possible fragmentations. */
	fragmentationSignals: LaunchGroup[];
	catalogChanges: ClassifiedChanges | undefined;
	/** Re-entry predictions whose message or decay epoch touches the window. */
	reentries: Reentry[] | undefined;
	pastLaunches: { count: number; launches: LaunchSummary[] } | undefined;
	geomagnetic: GeomagneticSummary | undefined;
	warnings: string[];
}

export interface OrbitalEventsOptions extends SpacetrackOptions {
	gfzBaseUrl?: string;
	launchLibraryBaseUrl?: string;
}

/**
 * "What happened in orbit in the last `days` days": an aggregated digest of
 * catalog events — none of them inferred, unlike `sat events`. Newly
 * cataloged objects (satcat_debut) are the core section — their failure
 * fails the command; every other section degrades to undefined with a
 * warning, following the spaceweather pattern.
 */
export async function computeOrbitalEvents(
	days: number,
	options: OrbitalEventsOptions,
	/** "Now" for the window; defaults to now. For tests. */
	now?: Date,
): Promise<Result<SourceResult<OrbitalEventsReport>, SpaceDataError>> {
	const reference = now ?? new Date();
	// Floored to the hour so the URL — and the cache key — stays stable.
	const sinceMs =
		Math.floor((reference.getTime() - days * 86_400_000) / 3_600_000) *
		3_600_000;

	const [debuts, changes, reentries, launches, kp] = await Promise.all([
		fetchSatcatDebuts(days, DEBUT_LIMIT, options),
		fetchSatcatChanges(days, CHANGE_LIMIT, options),
		fetchReentries(REENTRY_FETCH_LIMIT, options),
		fetchPreviousLaunches({
			cache: options.cache,
			fresh: options.fresh,
			limit: LAUNCH_LIMIT,
			sinceIso: new Date(sinceMs).toISOString(),
			baseUrl: options.launchLibraryBaseUrl,
		}),
		fetchKpHistory(days, {
			cache: options.cache,
			fresh: options.fresh,
			baseUrl: options.gfzBaseUrl,
		}),
	]);
	if (debuts.isErr()) {
		return err(debuts.error);
	}

	const warnings: string[] = [];
	const section = <T>(
		name: string,
		result: Result<SourceResult<T>, SpaceDataError>,
	): SourceResult<T> | undefined => {
		if (result.isErr()) {
			warnings.push(
				`the ${name} section is unavailable: ${result.error.message}`,
			);
			return undefined;
		}
		return result.value;
	};

	const changesValue = section("catalog changes", changes);
	const reentriesValue = section("re-entries", reentries);
	const launchesValue = section("past launches", launches);
	const kpValue = section("geomagnetic", kp);

	if (debuts.value.data.length >= DEBUT_LIMIT) {
		warnings.push(
			`newly cataloged objects were truncated at ${DEBUT_LIMIT}; narrow --days for the full set`,
		);
	}
	if (changesValue !== undefined && changesValue.data.length >= CHANGE_LIMIT) {
		warnings.push(
			`catalog changes were truncated at ${CHANGE_LIMIT}; narrow --days for the full set`,
		);
	}

	const launchGroups = groupDebuts(debuts.value.data, reference);

	const windowStartMs = reference.getTime() - days * 86_400_000;
	const windowEndMs = reference.getTime() + days * 86_400_000;
	// TIP issues successive messages per object; the fetch is newest-first, so
	// keeping the first occurrence keeps the latest prediction.
	const seenReentries = new Set<number>();
	const reentriesInWindow = reentriesValue?.data.filter((reentry) => {
		if (seenReentries.has(reentry.noradId)) {
			return false;
		}
		const messageMs = parseUpstreamInstant(reentry.messageEpoch)?.getTime();
		const decayMs = parseUpstreamInstant(
			reentry.predictedDecayEpoch,
		)?.getTime();
		const inWindow =
			(messageMs !== undefined && messageMs >= windowStartMs) ||
			(decayMs !== undefined &&
				decayMs >= windowStartMs &&
				decayMs <= windowEndMs);
		if (inWindow) {
			seenReentries.add(reentry.noradId);
		}
		return inWindow;
	});
	if (
		reentriesValue !== undefined &&
		reentriesValue.data.length >= REENTRY_FETCH_LIMIT
	) {
		warnings.push(
			`re-entry predictions were fetched newest-${REENTRY_FETCH_LIMIT} only; a busy window may be incomplete`,
		);
	}

	return ok(
		wrapAggregate(
			SOURCE,
			debuts.value,
			[changesValue, reentriesValue, launchesValue, kpValue],
			{
				windowDays: days,
				at: reference.toISOString(),
				newObjects: {
					count: debuts.value.data.length,
					launches: launchGroups,
				},
				fragmentationSignals: launchGroups.filter(
					(group) => group.fragmentationSignal,
				),
				catalogChanges:
					changesValue === undefined
						? undefined
						: classifyChanges(changesValue.data),
				reentries: reentriesInWindow,
				pastLaunches:
					launchesValue === undefined
						? undefined
						: {
								count: launchesValue.data.count,
								launches: launchesValue.data.launches,
							},
				geomagnetic:
					kpValue === undefined ? undefined : summarizeKp(kpValue.data.samples),
				warnings,
			},
		),
	);
}
