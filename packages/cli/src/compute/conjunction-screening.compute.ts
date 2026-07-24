import { err, ok, type Result } from "neverthrow";
import { wrapAggregate } from "../core/aggregate";
import type { SourceResult } from "../core/source-fetch";
import {
	assessConjunction,
	type ConjunctionPartner,
	canManeuver,
	partnerOf,
	type ScreenedConjunction,
	type SubjectHistory,
} from "../domain/conjunction-assessment";
import { analyzeElsetSeries, type OrbitalEvent } from "../domain/events";
import type { SpaceDataError } from "../errors/spacedata-error";
import {
	type CatalogRecord,
	fetchCatalogRecord,
} from "../sources/celestrak.source";
import { fetchKpHistory } from "../sources/gfz.source";
import {
	fetchSocratesConjunctions,
	type SocratesConjunction,
} from "../sources/socrates.source";
import {
	fetchElsetWindow,
	type SpacetrackOptions,
} from "../sources/spacetrack.source";

/**
 * Inputs + computation: conjunctions, catalog records, element history and
 * geomagnetic context are fetched; maneuver detection and the avoidance
 * correlation run locally (domain/events.ts, domain/conjunction-assessment.ts).
 */
const SOURCE = "celestrak+spacetrack+gfz+analysis";

/**
 * Element history analyzed for avoidance maneuvers. SOCRATES predicts at most
 * 7 days ahead and avoidance burns come days before TCA at most; 14 days also
 * gives the detector a noise baseline of its own.
 */
const HISTORY_WINDOW_DAYS = 14;
/** SOCRATES rows involving the subject; one object rarely has more than a few. */
const CONJUNCTION_FETCH_LIMIT = 50;
/** Partner SATCAT lookups per run, to stay polite with CelesTrak. */
const MAX_PARTNER_LOOKUPS = 10;

export interface ConjunctionScreeningReport {
	noradId: number;
	name: string | undefined;
	objectType: string | undefined;
	operationalStatus: string | undefined;
	canManeuver: boolean | undefined;
	historyWindowDays: number;
	/** Element sets analyzed; undefined when history was unavailable. */
	elsetCount: number | undefined;
	/** Maneuver-type events detected in the subject's history window. */
	detectedManeuvers: OrbitalEvent[];
	conjunctionCount: number;
	conjunctions: ScreenedConjunction[];
	warnings: string[];
}

export interface ConjunctionScreeningOptions extends SpacetrackOptions {
	gfzBaseUrl?: string;
	socratesBaseUrl?: string;
	satcatBaseUrl?: string;
}

/**
 * Conjunction screening with an avoidance verdict for one object: SOCRATES
 * conjunctions are the core input — their failure fails the command. The
 * subject's SATCAT record, the partners' records and the element history
 * each degrade to unknown/unavailable with a warning, so the command answers
 * without any account and upgrades with Space-Track credentials.
 */
export async function computeConjunctionScreening(
	noradId: number,
	options: ConjunctionScreeningOptions,
	/** "Now" for upcoming/past TCA status; defaults to now. For tests. */
	now?: Date,
): Promise<Result<SourceResult<ConjunctionScreeningReport>, SpaceDataError>> {
	const nowMs = (now ?? new Date()).getTime();
	const celestrak = { cache: options.cache, fresh: options.fresh };

	const [socrates, subjectCatalog] = await Promise.all([
		fetchSocratesConjunctions({
			...celestrak,
			limit: CONJUNCTION_FETCH_LIMIT,
			noradId,
			baseUrl: options.socratesBaseUrl,
		}),
		fetchCatalogRecord(noradId, {
			...celestrak,
			baseUrl: options.satcatBaseUrl,
		}),
	]);
	if (socrates.isErr()) {
		return err(socrates.error);
	}
	const conjunctions = socrates.value.data;

	const warnings: string[] = [];
	if (subjectCatalog.isErr()) {
		warnings.push(
			`the subject's catalog record is unavailable (${subjectCatalog.error.message}); maneuverability is unknown`,
		);
	}
	const subject = subjectCatalog.isOk() ? subjectCatalog.value.data : undefined;
	const subjectCanManeuver = canManeuver(
		subject?.objectType,
		subject?.operationalStatus,
	);

	// An empty screening is a complete answer: no history or partner lookups.
	if (conjunctions.length === 0) {
		return ok(
			wrapAggregate(
				SOURCE,
				socrates.value,
				[subjectCatalog.isOk() ? subjectCatalog.value : undefined],
				report(noradId, subject, subjectCanManeuver, undefined, [], warnings),
			),
		);
	}

	const partnerIds = [
		...new Set(conjunctions.map((c) => partnerOf(c, noradId).noradId)),
	];
	const lookedUpIds = partnerIds.slice(0, MAX_PARTNER_LOOKUPS);
	if (partnerIds.length > lookedUpIds.length) {
		warnings.push(
			`partner catalog lookups were capped at ${MAX_PARTNER_LOOKUPS} of ${partnerIds.length}; the rest screen with unknown maneuverability`,
		);
	}

	const [elsets, kp, partnerLookups] = await Promise.all([
		fetchElsetWindow(noradId, HISTORY_WINDOW_DAYS, options),
		fetchKpHistory(HISTORY_WINDOW_DAYS, {
			...celestrak,
			baseUrl: options.gfzBaseUrl,
		}),
		Promise.all(
			lookedUpIds.map(async (id) => ({
				id,
				result: await fetchCatalogRecord(id, {
					...celestrak,
					baseUrl: options.satcatBaseUrl,
				}),
			})),
		),
	]);

	const partnerRecords = new Map<number, CatalogRecord>();
	for (const lookup of partnerLookups) {
		if (lookup.result.isErr()) {
			warnings.push(
				`the catalog record of NORAD id ${lookup.id} is unavailable (${lookup.result.error.message}); its maneuverability is unknown`,
			);
		} else {
			partnerRecords.set(lookup.id, lookup.result.value.data);
		}
	}

	let history: SubjectHistory | undefined;
	if (elsets.isErr()) {
		warnings.push(
			`avoidance detection is unavailable (${elsets.error.message}); verdicts degrade to history-unavailable`,
		);
	} else {
		if (kp.isErr()) {
			warnings.push(
				`the geomagnetic context is unavailable (${kp.error.message}); storm discrimination is disabled and decays during storms may be reported as maneuvers`,
			);
		}
		const analysis = analyzeElsetSeries(
			elsets.value.data,
			kp.isOk() ? kp.value.data.samples : undefined,
		);
		history = { elsetCount: analysis.elsetCount, events: analysis.events };
		warnings.push(...analysis.warnings);
	}

	const screened = conjunctions.map((conjunction) => {
		const partnerSat = partnerOf(conjunction, noradId);
		const record = partnerRecords.get(partnerSat.noradId);
		const partner: ConjunctionPartner = {
			noradId: partnerSat.noradId,
			name: record?.name ?? partnerSat.name,
			objectType: record?.objectType,
			operationalStatus: record?.operationalStatus,
			canManeuver: canManeuver(record?.objectType, record?.operationalStatus),
		};
		return assessConjunction(
			conjunction,
			subjectCanManeuver,
			partner,
			history,
			nowMs,
		);
	});

	return ok(
		wrapAggregate(
			SOURCE,
			socrates.value,
			[
				subjectCatalog.isOk() ? subjectCatalog.value : undefined,
				elsets.isOk() ? elsets.value : undefined,
				kp.isOk() ? kp.value : undefined,
				...partnerLookups.map((lookup) =>
					lookup.result.isOk() ? lookup.result.value : undefined,
				),
			],
			report(
				noradId,
				subject ?? subjectFromConjunctions(noradId, conjunctions),
				subjectCanManeuver,
				history,
				screened,
				warnings,
			),
		),
	);
}

function report(
	noradId: number,
	subject:
		| { name?: string; objectType?: string; operationalStatus?: string }
		| undefined,
	subjectCanManeuver: boolean | undefined,
	history: SubjectHistory | undefined,
	conjunctions: ScreenedConjunction[],
	warnings: string[],
): ConjunctionScreeningReport {
	return {
		noradId,
		name: subject?.name,
		objectType: subject?.objectType,
		operationalStatus: subject?.operationalStatus,
		canManeuver: subjectCanManeuver,
		historyWindowDays: HISTORY_WINDOW_DAYS,
		elsetCount: history?.elsetCount,
		detectedManeuvers:
			history?.events.filter((event) => event.type === "maneuver") ?? [],
		conjunctionCount: conjunctions.length,
		conjunctions,
		warnings,
	};
}

/** SOCRATES still names the subject when its SATCAT record is unavailable. */
function subjectFromConjunctions(
	noradId: number,
	conjunctions: SocratesConjunction[],
): { name: string } | undefined {
	for (const conjunction of conjunctions) {
		const sat = [conjunction.sat1, conjunction.sat2].find(
			(s) => s.noradId === noradId,
		);
		if (sat !== undefined) {
			return { name: sat.name };
		}
	}
	return undefined;
}
