import { z } from "zod";

/**
 * Space-Track serializes every JSON value as a string (or null). These
 * helpers make the string→number conversion explicit at the boundary and
 * fail validation on non-numeric content instead of coercing silently.
 */
const numericString = z.string().transform((value, ctx) => {
	const parsed = Number(value);
	if (value.trim() === "" || Number.isNaN(parsed)) {
		ctx.addIssue({
			code: "custom",
			message: `expected a number, got "${value}"`,
		});
		return z.NEVER;
	}
	return parsed;
});

const nullableNumericString = z
	.string()
	.nullable()
	.transform((value, ctx) => {
		if (value === null || value.trim() === "") {
			return undefined;
		}
		const parsed = Number(value);
		if (Number.isNaN(parsed)) {
			ctx.addIssue({
				code: "custom",
				message: `expected a number, got "${value}"`,
			});
			return z.NEVER;
		}
		return parsed;
	});

const nullableString = z
	.string()
	.nullable()
	.transform((value) => value ?? undefined);

/** cdm_public: public conjunction data messages (close approaches). */
export const cdmSchema = z.object({
	CDM_ID: z.string(),
	CREATED: nullableString,
	EMERGENCY_REPORTABLE: nullableString,
	TCA: z.string(),
	MIN_RNG: nullableNumericString,
	PC: nullableNumericString,
	SAT_1_ID: numericString,
	SAT_1_NAME: nullableString,
	SAT1_OBJECT_TYPE: nullableString,
	SAT_2_ID: numericString,
	SAT_2_NAME: nullableString,
	SAT2_OBJECT_TYPE: nullableString,
});

export const cdmArraySchema = z.array(cdmSchema);
export type Cdm = z.infer<typeof cdmSchema>;

/** tip: Tracking and Impact Prediction messages (predicted re-entries). */
export const tipSchema = z.object({
	NORAD_CAT_ID: numericString,
	MSG_EPOCH: nullableString,
	DECAY_EPOCH: nullableString,
	WINDOW: nullableNumericString,
	LAT: nullableNumericString,
	LON: nullableNumericString,
	INCL: nullableNumericString,
	NEXT_REPORT: nullableString,
	HIGH_INTEREST: nullableString,
});

export const tipArraySchema = z.array(tipSchema);
export type Tip = z.infer<typeof tipSchema>;

/** gp_history: historical orbital element sets (OMM) for one object. */
export const gpHistorySchema = z.object({
	NORAD_CAT_ID: numericString,
	OBJECT_NAME: nullableString,
	OBJECT_ID: nullableString,
	EPOCH: z.string(),
	MEAN_MOTION: numericString,
	ECCENTRICITY: numericString,
	INCLINATION: numericString,
	RA_OF_ASC_NODE: numericString,
	ARG_OF_PERICENTER: numericString,
	MEAN_ANOMALY: numericString,
	BSTAR: nullableNumericString,
	REV_AT_EPOCH: nullableNumericString,
});

export const gpHistoryArraySchema = z.array(gpHistorySchema);
export type GpHistory = z.infer<typeof gpHistorySchema>;
