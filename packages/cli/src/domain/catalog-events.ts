import { parseEpoch } from "./propagation";

/**
 * A newly cataloged object, as needed by the launch grouping. Structurally
 * satisfied by the Space-Track `CatalogDebut` — field names match on purpose.
 */
export interface DebutRecord {
	noradId: number;
	internationalDesignator: string;
	name?: string | undefined;
	objectType?: string | undefined;
	launchDate?: string | undefined;
}

/** A catalog change record; structurally satisfied by `CatalogChange`. */
export interface ChangeRecord {
	noradId: number;
	changedAt: string;
	name?: string | undefined;
	previousName?: string | undefined;
	decayDate?: string | undefined;
	previousDecayDate?: string | undefined;
}

export interface LaunchGroup {
	/** International designator prefix shared by the pieces (e.g. 2026-164). */
	launchDesignator: string;
	launchDate: string | undefined;
	pieces: number;
	objectTypes: {
		payloads: number;
		rocketBodies: number;
		debris: number;
		unknown: number;
	};
	/** Up to 10 NORAD ids of the group, ascending. */
	noradIds: number[];
	/** Up to 5 object names of the group. */
	sampleNames: string[];
	/**
	 * Several pieces debuting for a launch that happened long ago: the classic
	 * public signature of a fragmentation (or of delayed debris cataloging —
	 * hence "signal", not "event").
	 */
	fragmentationSignal: boolean;
}

/** Pieces needed before an old launch's debut burst counts as a signal. */
const FRAGMENTATION_MIN_PIECES = 5;
/** A launch this much older than "now" is not a fresh deployment. */
const FRAGMENTATION_MIN_AGE_DAYS = 60;
const NORAD_ID_SAMPLE = 10;
const NAME_SAMPLE = 5;

/**
 * Group newly cataloged objects by launch. Fresh launches produce groups of
 * deploying pieces; old launches producing many new pieces at once are
 * flagged as possible fragmentations.
 */
export function groupDebuts(debuts: DebutRecord[], now: Date): LaunchGroup[] {
	const byLaunch = new Map<string, DebutRecord[]>();
	for (const debut of debuts) {
		const designator =
			/^(\d{4}-\d{3})/.exec(debut.internationalDesignator)?.[1] ??
			debut.internationalDesignator;
		const group = byLaunch.get(designator);
		if (group === undefined) {
			byLaunch.set(designator, [debut]);
		} else {
			group.push(debut);
		}
	}

	const groups: LaunchGroup[] = [];
	for (const [designator, members] of byLaunch) {
		const launchDate = members.find(
			(member) => member.launchDate !== undefined,
		)?.launchDate;
		const launchMs = parseUpstreamInstant(launchDate)?.getTime();
		const oldLaunch =
			launchMs !== undefined &&
			now.getTime() - launchMs > FRAGMENTATION_MIN_AGE_DAYS * 86_400_000;

		const objectTypes = {
			payloads: 0,
			rocketBodies: 0,
			debris: 0,
			unknown: 0,
		};
		for (const member of members) {
			switch (member.objectType) {
				case "PAYLOAD":
					objectTypes.payloads += 1;
					break;
				case "ROCKET BODY":
					objectTypes.rocketBodies += 1;
					break;
				case "DEBRIS":
					objectTypes.debris += 1;
					break;
				default:
					objectTypes.unknown += 1;
			}
		}

		groups.push({
			launchDesignator: designator,
			launchDate,
			pieces: members.length,
			objectTypes,
			noradIds: members
				.map((member) => member.noradId)
				.sort((a, b) => a - b)
				.slice(0, NORAD_ID_SAMPLE),
			sampleNames: members
				.map((member) => member.name)
				.filter((name): name is string => name !== undefined)
				.slice(0, NAME_SAMPLE),
			fragmentationSignal:
				oldLaunch && members.length >= FRAGMENTATION_MIN_PIECES,
		});
	}

	return groups.sort(
		(a, b) =>
			b.pieces - a.pieces ||
			a.launchDesignator.localeCompare(b.launchDesignator),
	);
}

export interface DecayDateSet {
	noradId: number;
	name: string | undefined;
	decayDate: string;
	previousDecayDate: string | undefined;
	changedAt: string;
}

export interface Renamed {
	noradId: number;
	from: string;
	to: string;
	changedAt: string;
}

export interface ClassifiedChanges {
	/** Objects whose decay date was set or revised — confirmed decays. */
	decayDatesSet: DecayDateSet[];
	renamed: Renamed[];
	/** Changes that were neither of the above (owner, designator, …). */
	otherCount: number;
}

/** Split raw catalog changes into the kinds worth reporting as events. */
export function classifyChanges(changes: ChangeRecord[]): ClassifiedChanges {
	const decayDatesSet: DecayDateSet[] = [];
	const renamed: Renamed[] = [];
	let otherCount = 0;
	for (const change of changes) {
		let classified = false;
		if (
			change.decayDate !== undefined &&
			change.decayDate !== change.previousDecayDate
		) {
			decayDatesSet.push({
				noradId: change.noradId,
				name: change.name,
				decayDate: change.decayDate,
				previousDecayDate: change.previousDecayDate,
				changedAt: change.changedAt,
			});
			classified = true;
		}
		if (
			change.name !== undefined &&
			change.previousName !== undefined &&
			change.name !== change.previousName
		) {
			renamed.push({
				noradId: change.noradId,
				from: change.previousName,
				to: change.name,
				changedAt: change.changedAt,
			});
			classified = true;
		}
		if (!classified) {
			otherCount += 1;
		}
	}
	return { decayDatesSet, renamed, otherCount };
}

/**
 * Space-Track timestamps come as "YYYY-MM-DD HH:MM:SS" or bare "YYYY-MM-DD"
 * (both UTC); element epochs as zone-less ISO 8601. Normalize all three.
 */
export function parseUpstreamInstant(
	value: string | undefined,
): Date | undefined {
	if (value === undefined) {
		return undefined;
	}
	const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value)
		? `${value}T00:00:00`
		: value.replace(" ", "T");
	return parseEpoch(normalized);
}
