import { err, ok, type Result } from "neverthrow";
import {
	degreesLat,
	degreesLong,
	degreesToRadians,
	ecfToLookAngles,
	eciToEcf,
	eciToGeodetic,
	type GeodeticLocation,
	type GMSTime,
	gstime,
	jday,
	json2satrec,
	propagate,
	radiansToDegrees,
	type SatRec,
	SatRecError,
	shadowFraction,
	sunPos,
} from "satellite.js";
import { PropagationError } from "../errors/spacedata-error";
import { round } from "./round";

/**
 * Mean elements needed to initialize SGP4. Structurally satisfied by the
 * CelesTrak `SatelliteRecord` — field names match on purpose. The mean-motion
 * derivatives of the OMM are deliberately absent: SGP4 stores but never uses
 * them (atmospheric drag is modeled through BSTAR alone).
 */
export interface PropagatableElements {
	noradId: number;
	name: string;
	/** Element set epoch as served by CelesTrak (ISO 8601, no zone = UTC). */
	epoch: string;
	meanMotionRevPerDay: number;
	eccentricity: number;
	inclinationDeg: number;
	raOfAscNodeDeg: number;
	argOfPericenterDeg: number;
	meanAnomalyDeg: number;
	bstar: number;
}

/**
 * Ground observer. Altitude is in meters above the WGS-84 ellipsoid.
 * Callers must pass latitudeDeg in [-90, 90] and longitudeDeg in [-180, 180]
 * (both CLI parsers and MCP schemas enforce this); out-of-range values are
 * not rejected here and would silently wrap in the trigonometry.
 */
export interface Observer {
	latitudeDeg: number;
	longitudeDeg: number;
	altitudeM: number;
}

export interface SatellitePosition {
	latitudeDeg: number;
	longitudeDeg: number;
	altitudeKm: number;
	speedKmS: number;
	sunlit: boolean;
}

/** A satellite as seen from a ground observer at one instant. */
export interface ObserverView {
	elevationDeg: number;
	azimuthDeg: number;
	rangeKm: number;
	altitudeKm: number;
	sunlit: boolean;
}

export interface SatellitePass {
	aos: { time: string; azimuthDeg: number };
	tca: {
		time: string;
		azimuthDeg: number;
		elevationDeg: number;
		rangeKm: number;
	};
	los: { time: string; azimuthDeg: number };
	durationSeconds: number;
	/**
	 * Optically visible at some point of the pass: satellite in sunlight while
	 * the observer's sky is dark (sun below civil twilight).
	 */
	visible: boolean;
}

export interface PassSearch {
	passes: SatellitePass[];
	/** The object never drops below the elevation mask (e.g. GEO overhead). */
	alwaysAboveMinElevation: boolean;
	/**
	 * Scan samples where SGP4 failed to propagate (e.g. the orbit decayed
	 * partway through the window). When nonzero, passes may be truncated.
	 */
	failedSamples: number;
}

/** Matches satellite.js's own KM_PER_AU (shadow.js; not exported by the lib). */
const AU_KM = 149597870.69098932;
/** Observer's sky is considered dark below civil twilight. */
export const TWILIGHT_SUN_ELEVATION_DEG = -6;
/**
 * Coarse sampling step for the pass search; crossings are then bisected.
 * A pass whose above-mask segment is shorter than one step can be missed —
 * only relevant for very high elevation masks, where LEO passes spend mere
 * seconds above the threshold.
 */
const PASS_SCAN_STEP_MS = 30_000;
/** Sampling step for the optical-visibility check within one pass. */
const VISIBILITY_STEP_MS = 10_000;
/** Refinement tolerance for AOS/TCA/LOS times. */
const REFINE_TOLERANCE_MS = 500;

const SATREC_ERROR_DETAILS: Record<number, string> = {
	[SatRecError.MeanEccentricityOutOfRange]:
		"mean eccentricity is out of the 0 ≤ e < 1 range",
	[SatRecError.MeanMotionBelowZero]: "mean motion has fallen below zero",
	[SatRecError.PerturbedEccentricityOutOfRange]:
		"perturbed eccentricity is out of the 0 ≤ e < 1 range",
	[SatRecError.SemiLatusRectumBelowZero]:
		"the orbit's semi-latus rectum has fallen below zero",
	[SatRecError.Decayed]:
		"the orbit has decayed; the object is below the Earth's surface at the requested time",
};

/** Element epoch → Date. CelesTrak serves ISO 8601 without a zone (UTC). */
export function parseEpoch(epoch: string): Date | undefined {
	const date = new Date(epoch.endsWith("Z") ? epoch : `${epoch}Z`);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * User-supplied instant → Date. Unlike bare `new Date(...)`, a date-time
 * WITHOUT an explicit zone is interpreted as UTC (matching the element
 * epochs), never as host-local time — `position --at ...` must mean the same
 * instant on every machine.
 */
export function parseInstant(raw: string): Date | undefined {
	const trimmed = raw.trim();
	const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
	const hasTime = trimmed.includes("T");
	const date = new Date(hasTime && !hasZone ? `${trimmed}Z` : trimmed);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Hours between the element epoch and `at` (positive when `at` is later).
 * The invalid-epoch error is constructed here and in initSatrec only, so the
 * two layers can never drift apart.
 */
export function elementAgeHours(
	elements: Pick<PropagatableElements, "noradId" | "epoch">,
	at: Date,
): Result<number, PropagationError> {
	const epochDate = parseEpoch(elements.epoch);
	if (epochDate === undefined) {
		return err(invalidEpochError(elements.noradId, elements.epoch));
	}
	return ok(round((at.getTime() - epochDate.getTime()) / 3_600_000));
}

/**
 * Geodetic position, speed and illumination of the object at one instant.
 */
export function propagatePosition(
	elements: PropagatableElements,
	at: Date,
): Result<SatellitePosition, PropagationError> {
	return initSatrec(elements).andThen((satrec) => {
		const eci = propagateEci(satrec, elements.noradId, at);
		if (eci.isErr()) {
			return err(eci.error);
		}
		const { position, velocity } = eci.value;
		const geodetic = eciToGeodetic(position, gstime(at));
		return ok({
			latitudeDeg: round(degreesLat(geodetic.latitude)),
			longitudeDeg: round(degreesLong(geodetic.longitude)),
			altitudeKm: round(geodetic.height),
			speedKmS: round(
				Math.sqrt(velocity.x ** 2 + velocity.y ** 2 + velocity.z ** 2),
			),
			sunlit: isSunlit(position, at),
		});
	});
}

/**
 * Elevation, azimuth and range of the object as seen from a ground observer
 * at one instant — the building block of `overhead`.
 */
export function observerView(
	elements: PropagatableElements,
	observer: Observer,
	at: Date,
): Result<ObserverView, PropagationError> {
	return initSatrec(elements).andThen((satrec) => {
		const look = propagateLook(satrec, toGeodeticLocation(observer), at);
		if (look === undefined) {
			return err(
				new PropagationError(elements.noradId, satrecErrorDetail(satrec.error)),
			);
		}
		return ok({
			elevationDeg: round(radiansToDegrees(look.angles.elevation)),
			azimuthDeg: round(radiansToDegrees(look.angles.azimuth)),
			rangeKm: round(look.angles.rangeSat),
			altitudeKm: round(eciToGeodetic(look.position, look.gmst).height),
			sunlit: isSunlit(look.position, at),
		});
	});
}

/**
 * Every pass of the object over the observer within the window, with AOS/TCA/
 * LOS refined by bisection to sub-second precision and an optical-visibility
 * flag. A pass already in progress at the window edges is clipped to it.
 */
export function findPasses(
	elements: PropagatableElements,
	observer: Observer,
	start: Date,
	days: number,
	minElevationDeg: number,
): Result<PassSearch, PropagationError> {
	return initSatrec(elements).andThen((satrec) => {
		const observerGd = toGeodeticLocation(observer);
		const startMs = start.getTime();
		const endMs = startMs + days * 86_400_000;
		// NaN (invalid start date or days) would never satisfy the loop's exit
		// comparison and hang the scan forever.
		if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
			return err(
				new PropagationError(
					elements.noradId,
					"the search window start or length is not a valid finite time",
				),
			);
		}

		const elevationAt = (ms: number): number | undefined => {
			const look = propagateLook(satrec, observerGd, new Date(ms));
			return look === undefined
				? undefined
				: radiansToDegrees(look.angles.elevation);
		};
		const isAbove = (ms: number): boolean => {
			const elevation = elevationAt(ms);
			return elevation !== undefined && elevation >= minElevationDeg;
		};

		// Coarse scan: collect [rise, set] intervals at PASS_SCAN_STEP_MS.
		const intervals: { riseMs: number; setMs: number }[] = [];
		let propagated = 0;
		let failedSamples = 0;
		let riseMs: number | undefined;
		let previousMs = startMs;
		let previousAbove: boolean | undefined;
		for (let ms = startMs; ; ms += PASS_SCAN_STEP_MS) {
			const clampedMs = Math.min(ms, endMs);
			const elevation = elevationAt(clampedMs);
			if (elevation === undefined) {
				failedSamples += 1;
			} else {
				propagated += 1;
			}
			const above = elevation !== undefined && elevation >= minElevationDeg;

			if (above && previousAbove !== true) {
				riseMs =
					previousAbove === undefined
						? clampedMs // above at the window start: clip the pass to it
						: bisectCrossing(previousMs, clampedMs, isAbove);
			}
			if (!above && previousAbove === true && riseMs !== undefined) {
				intervals.push({
					riseMs,
					setMs: bisectCrossing(clampedMs, previousMs, isAbove),
				});
				riseMs = undefined;
			}

			previousMs = clampedMs;
			previousAbove = above;
			if (clampedMs >= endMs) {
				break;
			}
		}
		if (riseMs !== undefined) {
			intervals.push({ riseMs, setMs: endMs }); // still above at window end
		}

		if (propagated === 0) {
			return err(
				new PropagationError(elements.noradId, satrecErrorDetail(satrec.error)),
			);
		}

		const wholeWindow =
			intervals.length === 1 &&
			intervals[0]?.riseMs === startMs &&
			intervals[0]?.setMs === endMs;
		if (wholeWindow) {
			return ok({
				passes: [],
				alwaysAboveMinElevation: true,
				failedSamples,
			});
		}

		const passes: SatellitePass[] = [];
		for (const interval of intervals) {
			const pass = buildPass(satrec, observer, observerGd, interval);
			if (pass !== undefined) {
				passes.push(pass);
			}
		}
		return ok({ passes, alwaysAboveMinElevation: false, failedSamples });
	});
}

/**
 * Distance (km) between where element set `from` says the object is at the
 * epoch of element set `to`, and where `to` itself places it — the SGP4
 * propagation residual used by maneuver detection. Natural dynamics that SGP4
 * models (drag via BSTAR, J2 secular rates) cancel out of this comparison, so
 * a large residual over a short gap means the published orbit changed in a
 * way the previous elements could not predict. Returns undefined when either
 * set fails to initialize or propagate (e.g. decayed elements).
 */
export function propagationResidualKm(
	from: PropagatableElements,
	to: PropagatableElements,
): number | undefined {
	const at = parseEpoch(to.epoch);
	if (at === undefined) {
		return undefined;
	}
	const fromSatrec = initSatrec(from);
	const toSatrec = initSatrec(to);
	if (fromSatrec.isErr() || toSatrec.isErr()) {
		return undefined;
	}
	const fromEci = propagate(fromSatrec.value, at);
	const toEci = propagate(toSatrec.value, at);
	if (fromEci === null || toEci === null) {
		return undefined;
	}
	const dx = fromEci.position.x - toEci.position.x;
	const dy = fromEci.position.y - toEci.position.y;
	const dz = fromEci.position.z - toEci.position.z;
	return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Sun elevation over the observer's horizon, in degrees. */
export function sunElevationDeg(observer: Observer, at: Date): number {
	const sunEciKm = sunEciPositionKm(at);
	const look = ecfToLookAngles(
		toGeodeticLocation(observer),
		eciToEcf(sunEciKm, gstime(at)),
	);
	return radiansToDegrees(look.elevation);
}

function invalidEpochError(noradId: number, epoch: string): PropagationError {
	return new PropagationError(
		noradId,
		`element set epoch "${epoch}" is not a valid date`,
	);
}

function initSatrec(
	elements: PropagatableElements,
): Result<SatRec, PropagationError> {
	if (parseEpoch(elements.epoch) === undefined) {
		return err(invalidEpochError(elements.noradId, elements.epoch));
	}
	const satrec = json2satrec({
		OBJECT_NAME: elements.name,
		OBJECT_ID: "",
		NORAD_CAT_ID: elements.noradId,
		EPOCH: elements.epoch,
		MEAN_MOTION: elements.meanMotionRevPerDay,
		ECCENTRICITY: elements.eccentricity,
		INCLINATION: elements.inclinationDeg,
		RA_OF_ASC_NODE: elements.raOfAscNodeDeg,
		ARG_OF_PERICENTER: elements.argOfPericenterDeg,
		MEAN_ANOMALY: elements.meanAnomalyDeg,
		BSTAR: elements.bstar,
		// Unused by SGP4 (drag comes from BSTAR); see PropagatableElements.
		MEAN_MOTION_DOT: 0,
		MEAN_MOTION_DDOT: 0,
		EPHEMERIS_TYPE: 0,
		CLASSIFICATION_TYPE: "U",
		ELEMENT_SET_NO: 999,
		REV_AT_EPOCH: 0,
	});
	if (satrec.error !== SatRecError.None) {
		return err(
			new PropagationError(elements.noradId, satrecErrorDetail(satrec.error)),
		);
	}
	return ok(satrec);
}

function propagateEci(
	satrec: SatRec,
	noradId: number,
	at: Date,
): Result<NonNullable<ReturnType<typeof propagate>>, PropagationError> {
	const eci = propagate(satrec, at);
	if (eci === null) {
		return err(new PropagationError(noradId, satrecErrorDetail(satrec.error)));
	}
	return ok(eci);
}

/**
 * The shared propagate → ECF → look-angles pipeline of the observer-relative
 * queries. Returns undefined when SGP4 fails (inspect satrec.error).
 */
function propagateLook(
	satrec: SatRec,
	observerGd: GeodeticLocation,
	at: Date,
):
	| {
			position: { x: number; y: number; z: number };
			gmst: GMSTime;
			angles: ReturnType<typeof ecfToLookAngles>;
	  }
	| undefined {
	const eci = propagate(satrec, at);
	if (eci === null) {
		return undefined;
	}
	const gmst = gstime(at);
	return {
		position: eci.position,
		gmst,
		angles: ecfToLookAngles(observerGd, eciToEcf(eci.position, gmst)),
	};
}

function satrecErrorDetail(error: SatRecError): string {
	return SATREC_ERROR_DETAILS[error] ?? `SGP4 error code ${error}`;
}

function toGeodeticLocation(observer: Observer): GeodeticLocation {
	// degreesToRadians (not radiansLat/radiansLong): the latter throw on
	// out-of-range input, which would escape the Result contract. Bounds are
	// the caller's responsibility (see Observer).
	return {
		latitude: degreesToRadians(observer.latitudeDeg),
		longitude: degreesToRadians(observer.longitudeDeg),
		height: observer.altitudeM / 1000,
	};
}

function sunEciPositionKm(at: Date): { x: number; y: number; z: number } {
	const { rsun } = sunPos(jday(at));
	return { x: rsun.x * AU_KM, y: rsun.y * AU_KM, z: rsun.z * AU_KM };
}

function isSunlit(
	positionEciKm: { x: number; y: number; z: number },
	at: Date,
): boolean {
	return shadowFraction(sunPos(jday(at)).rsun, positionEciKm) < 1;
}

/**
 * Boundary between a false and a true sample of `isAbove`, to
 * REFINE_TOLERANCE_MS. The two input instants may come in either order.
 */
function bisectCrossing(
	falseMs: number,
	trueMs: number,
	isAbove: (ms: number) => boolean,
): number {
	let low = falseMs;
	let high = trueMs;
	while (Math.abs(high - low) > REFINE_TOLERANCE_MS) {
		const mid = (low + high) / 2;
		if (isAbove(mid)) {
			high = mid;
		} else {
			low = mid;
		}
	}
	return Math.round(high);
}

function buildPass(
	satrec: SatRec,
	observer: Observer,
	observerGd: GeodeticLocation,
	interval: { riseMs: number; setMs: number },
): SatellitePass | undefined {
	const viewAt = (
		ms: number,
	):
		| { elevationDeg: number; azimuthDeg: number; rangeKm: number }
		| undefined => {
		const look = propagateLook(satrec, observerGd, new Date(ms));
		if (look === undefined) {
			return undefined;
		}
		return {
			elevationDeg: radiansToDegrees(look.angles.elevation),
			azimuthDeg: radiansToDegrees(look.angles.azimuth),
			rangeKm: look.angles.rangeSat,
		};
	};

	// Culmination: coarse argmax, then golden-section around it.
	const coarseStepMs = Math.min(
		PASS_SCAN_STEP_MS,
		Math.max(1000, (interval.setMs - interval.riseMs) / 50),
	);
	let tcaMs = interval.riseMs;
	let tcaElevation = Number.NEGATIVE_INFINITY;
	for (let ms = interval.riseMs; ms <= interval.setMs; ms += coarseStepMs) {
		const elevation = viewAt(ms)?.elevationDeg;
		if (elevation !== undefined && elevation > tcaElevation) {
			tcaElevation = elevation;
			tcaMs = ms;
		}
	}
	tcaMs = refineMaximum(
		Math.max(interval.riseMs, tcaMs - coarseStepMs),
		Math.min(interval.setMs, tcaMs + coarseStepMs),
		(ms) => viewAt(ms)?.elevationDeg ?? Number.NEGATIVE_INFINITY,
	);

	const aos = viewAt(interval.riseMs);
	const tca = viewAt(tcaMs);
	const los = viewAt(interval.setMs);
	if (aos === undefined || tca === undefined || los === undefined) {
		return undefined;
	}

	return {
		aos: {
			time: new Date(interval.riseMs).toISOString(),
			azimuthDeg: round(aos.azimuthDeg),
		},
		tca: {
			time: new Date(tcaMs).toISOString(),
			azimuthDeg: round(tca.azimuthDeg),
			elevationDeg: round(tca.elevationDeg),
			rangeKm: round(tca.rangeKm),
		},
		los: {
			time: new Date(interval.setMs).toISOString(),
			azimuthDeg: round(los.azimuthDeg),
		},
		durationSeconds: Math.round((interval.setMs - interval.riseMs) / 1000),
		visible: isPassVisible(satrec, observer, interval),
	};
}

function isPassVisible(
	satrec: SatRec,
	observer: Observer,
	interval: { riseMs: number; setMs: number },
): boolean {
	for (
		let ms = interval.riseMs;
		ms <= interval.setMs;
		ms += VISIBILITY_STEP_MS
	) {
		const at = new Date(ms);
		if (sunElevationDeg(observer, at) > TWILIGHT_SUN_ELEVATION_DEG) {
			continue;
		}
		const eci = propagate(satrec, at);
		if (eci !== null && isSunlit(eci.position, at)) {
			return true;
		}
	}
	return false;
}

/** Golden-section maximum of `f` over [lowMs, highMs] to REFINE_TOLERANCE_MS. */
function refineMaximum(
	lowMs: number,
	highMs: number,
	f: (ms: number) => number,
): number {
	const phi = (Math.sqrt(5) - 1) / 2;
	let low = lowMs;
	let high = highMs;
	let left = high - phi * (high - low);
	let right = low + phi * (high - low);
	let fLeft = f(left);
	let fRight = f(right);
	while (high - low > REFINE_TOLERANCE_MS) {
		if (fLeft < fRight) {
			low = left;
			left = right;
			fLeft = fRight;
			right = low + phi * (high - low);
			fRight = f(right);
		} else {
			high = right;
			right = left;
			fRight = fLeft;
			left = high - phi * (high - low);
			fLeft = f(left);
		}
	}
	return Math.round((low + high) / 2);
}
