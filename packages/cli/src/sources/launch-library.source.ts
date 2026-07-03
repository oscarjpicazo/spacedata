import { err, ok, type Result } from "neverthrow";
import type { FileCache } from "../core/file-cache";
import { type SourceResult, sourceFetch } from "../core/source-fetch";
import { type Launch, launchListSchema } from "../domain/launch.schema";
import {
	type SpaceCliError,
	UpstreamSchemaError,
} from "../errors/space-cli-error";

const SOURCE = "launch-library";
const BASE_URL = "https://ll.thespacedevs.com/2.3.0";
// Free tier allows 15 calls/hour per IP, so cache aggressively and back off
// for a full hour when the API starts refusing us (429 included).
const TTL_SECONDS = 60 * 60;
const BREAKER_COOLDOWN_SECONDS = 60 * 60;

export interface LaunchSummary {
	id: string;
	name: string;
	net: string | undefined;
	status: string | undefined;
	provider: string | undefined;
	rocket: string | undefined;
	pad: string | undefined;
	location: string | undefined;
	mission: string | undefined;
	orbit: string | undefined;
}

export interface LaunchListResult {
	count: number;
	launches: LaunchSummary[];
}

export interface LaunchLibraryOptions {
	cache: FileCache;
	fresh: boolean;
	limit: number;
	search?: string;
	baseUrl?: string;
	token?: string;
}

export function fetchUpcomingLaunches(
	options: LaunchLibraryOptions,
): Promise<Result<SourceResult<LaunchListResult>, SpaceCliError>> {
	const baseUrl =
		options.baseUrl ?? process.env.SPACECLI_LL2_BASE_URL ?? BASE_URL;
	const url = new URL(`${baseUrl}/launches/upcoming/`);
	url.searchParams.set("limit", String(options.limit));
	if (options.search !== undefined) {
		url.searchParams.set("search", options.search);
	}

	const token = options.token ?? process.env.SPACECLI_LL2_TOKEN;

	return sourceFetch<LaunchListResult>({
		source: SOURCE,
		url: url.toString(),
		cache: options.cache,
		ttlSeconds: TTL_SECONDS,
		breakerCooldownSeconds: BREAKER_COOLDOWN_SECONDS,
		fresh: options.fresh,
		headers:
			token !== undefined ? { Authorization: `Token ${token}` } : undefined,
		parseBody: parseLaunchListBody,
	});
}

function parseLaunchListBody(
	body: string,
): Result<LaunchListResult, SpaceCliError> {
	let json: unknown;
	try {
		json = JSON.parse(body);
	} catch {
		return err(new UpstreamSchemaError(SOURCE, "response is not valid JSON"));
	}

	const parsed = launchListSchema.safeParse(json);
	if (!parsed.success) {
		return err(
			new UpstreamSchemaError(
				SOURCE,
				parsed.error.issues[0]?.message ?? "unknown issue",
			),
		);
	}

	return ok({
		count: parsed.data.count,
		launches: parsed.data.results.map(toLaunchSummary),
	});
}

function toLaunchSummary(launch: Launch): LaunchSummary {
	return {
		id: launch.id,
		name: launch.name,
		net: launch.net ?? undefined,
		status: launch.status?.name,
		provider: launch.launch_service_provider?.name,
		rocket:
			launch.rocket?.configuration?.full_name ??
			launch.rocket?.configuration?.name,
		pad: launch.pad?.name,
		location: launch.pad?.location?.name,
		mission: launch.mission?.name,
		orbit: launch.mission?.orbit?.name,
	};
}
