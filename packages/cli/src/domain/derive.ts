import { round } from "./round";

const MU_EARTH_KM3_S2 = 398600.4418;
const EARTH_EQUATORIAL_RADIUS_KM = 6378.137;
const SECONDS_PER_DAY = 86400;

export interface DerivedOrbit {
	semiMajorAxisKm: number;
	perigeeAltitudeKm: number;
	apogeeAltitudeKm: number;
	periodMinutes: number;
}

/**
 * Derive geometry from the mean elements of a GP/OMM record. Altitudes are
 * relative to the equatorial radius — the usual convention for the perigee
 * and apogee figures published in catalogs.
 */
export function deriveOrbit(
	meanMotionRevPerDay: number,
	eccentricity: number,
): DerivedOrbit {
	const meanMotionRadPerSec =
		(meanMotionRevPerDay * 2 * Math.PI) / SECONDS_PER_DAY;
	const semiMajorAxisKm =
		(MU_EARTH_KM3_S2 / meanMotionRadPerSec ** 2) ** (1 / 3);
	return {
		semiMajorAxisKm: round(semiMajorAxisKm),
		perigeeAltitudeKm: round(
			semiMajorAxisKm * (1 - eccentricity) - EARTH_EQUATORIAL_RADIUS_KM,
		),
		apogeeAltitudeKm: round(
			semiMajorAxisKm * (1 + eccentricity) - EARTH_EQUATORIAL_RADIUS_KM,
		),
		periodMinutes: round((24 * 60) / meanMotionRevPerDay),
	};
}
