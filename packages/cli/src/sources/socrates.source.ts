import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import type { FileCache } from "../core/file-cache";
import { type SourceResult, sourceFetch } from "../core/source-fetch";
import {
	type SpaceDataError,
	UpstreamSchemaError,
} from "../errors/spacedata-error";

// SOCRATES (Satellite Orbital Conjunction Reports Assessing Threatening
// Encounters in Space) is CelesTrak's public conjunction service — no
// account needed. It shares CelesTrak's usage policy, so it shares the
// "celestrak" breaker; runs are produced three times per day (~8h cycle).
const SOURCE = "celestrak";
const SOCRATES_URL = "https://celestrak.org/SOCRATES/sort-maxProb.csv";
const SOCRATES_TTL_SECONDS = 8 * 60 * 60;
const BREAKER_COOLDOWN_SECONDS = 2 * 60 * 60;

const EXPECTED_HEADER = [
	"NORAD_CAT_ID_1",
	"OBJECT_NAME_1",
	"DSE_1",
	"NORAD_CAT_ID_2",
	"OBJECT_NAME_2",
	"DSE_2",
	"TCA",
	"TCA_RANGE",
	"TCA_RELATIVE_SPEED",
	"MAX_PROB",
	"DILUTION",
];

const socratesRowSchema = z.object({
	NORAD_CAT_ID_1: z.coerce.number(),
	OBJECT_NAME_1: z.string(),
	NORAD_CAT_ID_2: z.coerce.number(),
	OBJECT_NAME_2: z.string(),
	TCA: z.string(),
	TCA_RANGE: z.coerce.number(),
	TCA_RELATIVE_SPEED: z.coerce.number(),
	MAX_PROB: z.coerce.number(),
});

export interface SocratesConjunction {
	tca: string;
	minRangeKm: number;
	relativeSpeedKmS: number;
	maxProbability: number;
	sat1: SocratesSatellite;
	sat2: SocratesSatellite;
}

interface SocratesSatellite {
	noradId: number;
	name: string;
}

export interface SocratesOptions {
	cache: FileCache;
	fresh: boolean;
	limit: number;
	noradId?: number;
	baseUrl?: string;
}

export function fetchSocratesConjunctions(
	options: SocratesOptions,
): Promise<Result<SourceResult<SocratesConjunction[]>, SpaceDataError>> {
	return sourceFetch<SocratesConjunction[]>({
		source: SOURCE,
		url: options.baseUrl ?? SOCRATES_URL,
		cache: options.cache,
		ttlSeconds: SOCRATES_TTL_SECONDS,
		breakerCooldownSeconds: BREAKER_COOLDOWN_SECONDS,
		fresh: options.fresh,
		parseBody: parseSocratesCsv,
	}).then((result) =>
		result.map((value) => ({
			...value,
			data: value.data
				.filter(
					(c) =>
						options.noradId === undefined ||
						c.sat1.noradId === options.noradId ||
						c.sat2.noradId === options.noradId,
				)
				.slice(0, options.limit),
		})),
	);
}

function parseSocratesCsv(
	body: string,
): Result<SocratesConjunction[], SpaceDataError> {
	const lines = body.trim().split("\n");
	const header = lines[0]?.trim().split(",");
	if (header === undefined || header.join(",") !== EXPECTED_HEADER.join(",")) {
		return err(
			new UpstreamSchemaError(SOURCE, "unexpected SOCRATES CSV header"),
		);
	}

	const conjunctions: SocratesConjunction[] = [];
	for (const line of lines.slice(1)) {
		if (line.trim() === "") {
			continue;
		}
		const cells = line.split(",");
		if (cells.length !== EXPECTED_HEADER.length) {
			return err(new UpstreamSchemaError(SOURCE, "malformed SOCRATES CSV row"));
		}
		const row = Object.fromEntries(
			EXPECTED_HEADER.map((column, index) => [column, cells[index]?.trim()]),
		);
		const parsed = socratesRowSchema.safeParse(row);
		if (!parsed.success) {
			return err(
				new UpstreamSchemaError(
					SOURCE,
					parsed.error.issues[0]?.message ?? "unknown issue",
				),
			);
		}
		conjunctions.push({
			tca: parsed.data.TCA,
			minRangeKm: parsed.data.TCA_RANGE,
			relativeSpeedKmS: parsed.data.TCA_RELATIVE_SPEED,
			maxProbability: parsed.data.MAX_PROB,
			sat1: {
				noradId: parsed.data.NORAD_CAT_ID_1,
				name: cleanObjectName(parsed.data.OBJECT_NAME_1),
			},
			sat2: {
				noradId: parsed.data.NORAD_CAT_ID_2,
				name: cleanObjectName(parsed.data.OBJECT_NAME_2),
			},
		});
	}
	return ok(conjunctions);
}

/** SOCRATES appends the ops-status code to names: "STARLINK-3278 [+]". */
function cleanObjectName(name: string): string {
	return name.replace(/\s*\[.\]$/, "");
}
