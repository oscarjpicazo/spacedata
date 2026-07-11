import { round } from "./round";

const FLARE_CLASSES: [string, number][] = [
	["A", 1e-8],
	["B", 1e-7],
	["C", 1e-6],
	["M", 1e-5],
	["X", 1e-4],
];

/**
 * GOES X-ray flux (0.1-0.8nm, W/m²) → solar flare class. Each class is a
 * decade: A ≥ 1e-8, B ≥ 1e-7, C ≥ 1e-6, M ≥ 1e-5, X ≥ 1e-4. A magnitude
 * that rounds up to 10.0 promotes to the next class (9.97e-5 is X1.0, not
 * the impossible "M10.0"); X itself is open-ended (X28.0 is real).
 */
export function flareClass(fluxWm2: number): string {
	let index = 0;
	for (let i = FLARE_CLASSES.length - 1; i >= 0; i -= 1) {
		const threshold = FLARE_CLASSES[i]?.[1] ?? 0;
		if (fluxWm2 >= threshold) {
			index = i;
			break;
		}
	}
	let magnitude =
		Math.round((fluxWm2 / (FLARE_CLASSES[index]?.[1] ?? 1)) * 10) / 10;
	if (magnitude >= 10 && index < FLARE_CLASSES.length - 1) {
		index += 1;
		magnitude = 1;
	}
	return `${FLARE_CLASSES[index]?.[0]}${magnitude.toFixed(1)}`;
}

/**
 * Kp → NOAA geomagnetic storm scale: G1 at Kp 5 up to G5 at Kp 9.
 * Below storm level returns "G0" (NOAA reports "none").
 */
export function kpToGScale(kp: number): string {
	const level = Math.min(5, Math.max(0, Math.floor(kp) - 4));
	return `G${level}`;
}

/**
 * Aurora probability (0-100) at the OVATION grid cell containing the
 * observer. The grid is 1°×1° with longitudes 0-359 and latitudes -90..90;
 * undefined when the (schema-valid but malformed) grid lacks the cell.
 */
export function auroraProbabilityAt(
	coordinates: [number, number, number][],
	latitudeDeg: number,
	longitudeDeg: number,
): number | undefined {
	const lon = (((Math.round(longitudeDeg) % 360) + 360) % 360) % 360;
	const lat = Math.max(-90, Math.min(90, Math.round(latitudeDeg)));
	for (const [gridLon, gridLat, probability] of coordinates) {
		if (gridLon === lon && gridLat === lat) {
			return round(probability);
		}
	}
	return undefined;
}
