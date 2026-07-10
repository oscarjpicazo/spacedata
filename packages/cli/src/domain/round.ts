/**
 * 3-decimal rounding — the numeric precision of the JSON output contract.
 * Every derived/computed figure (km, degrees, minutes, hours) goes through
 * this single definition so the precision cannot drift between commands.
 */
export function round(value: number): number {
	return Math.round(value * 1000) / 1000;
}
