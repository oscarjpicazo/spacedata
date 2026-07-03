import type { SpaceDataError } from "../errors/spacedata-error";
import type { SourceResult } from "./source-fetch";

/**
 * Output contract (stable, agents depend on it):
 * - stdout: single JSON document `{ok: true, source, cached, fetchedAt, data}`
 * - stderr: single JSON document `{ok: false, error: {code, message, ...}}`
 * - exit codes: 0 ok · 1 usage · 2 not found · 3 upstream/network ·
 *   4 circuit open or rate limited · 5 unexpected upstream schema ·
 *   6 missing or rejected credentials
 */
export function emit<T>(result: SourceResult<T>, pretty: boolean): void {
	const payload = { ok: true, ...result };
	process.stdout.write(`${JSON.stringify(payload, null, pretty ? 2 : 0)}\n`);
}

export function fail(error: SpaceDataError, pretty: boolean): never {
	const payload = { ok: false, error: error.toJSON() };
	process.stderr.write(`${JSON.stringify(payload, null, pretty ? 2 : 0)}\n`);
	process.exit(error.exitCode);
}
