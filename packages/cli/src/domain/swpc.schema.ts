import { z } from "zod";

/**
 * One entry of SWPC's 1-minute estimated planetary K index series. Only the
 * fields this feature consumes are required — demanding unused keys would
 * needlessly couple the core Kp product to upstream drift.
 */
export const swpcEstimatedKpSchema = z.object({
	time_tag: z.string(),
	estimated_kp: z.number(),
});

export const swpcEstimatedKpArraySchema = z.array(swpcEstimatedKpSchema);

/**
 * One entry of SWPC's Kp forecast product: observed history plus estimated
 * and predicted 3-hour bins, each with its NOAA G scale when storm-level.
 */
export const swpcKpForecastEntrySchema = z.object({
	time_tag: z.string(),
	kp: z.number(),
	observed: z.enum(["observed", "estimated", "predicted"]),
	noaa_scale: z.string().nullable(),
});

export const swpcKpForecastArraySchema = z.array(swpcKpForecastEntrySchema);

/**
 * One R/S/G block of SWPC's noaa-scales product. Numeric fields are served
 * as strings ("30") or null — converted explicitly at the source boundary.
 */
const swpcScaleBlockSchema = z.object({
	Scale: z.string().nullable(),
	Text: z.string().nullable(),
});

const swpcScalesEntrySchema = z.object({
	DateStamp: z.string(),
	TimeStamp: z.string(),
	R: swpcScaleBlockSchema.extend({
		MinorProb: z.string().nullable().optional(),
		MajorProb: z.string().nullable().optional(),
	}),
	S: swpcScaleBlockSchema.extend({
		Prob: z.string().nullable().optional(),
	}),
	G: swpcScaleBlockSchema,
});

/**
 * The noaa-scales product is an object keyed by day offset: "-1" yesterday,
 * "0" current conditions, "1" today's probabilities, "2"/"3" the outlook.
 */
export const swpcScalesSchema = z.record(z.string(), swpcScalesEntrySchema);

/** Solar wind speed summary (single-element series). */
export const swpcSolarWindSpeedSchema = z.array(
	z.object({ proton_speed: z.number(), time_tag: z.string() }),
);

/** Interplanetary magnetic field summary (single-element series). */
export const swpcSolarWindMagSchema = z.array(
	z.object({ bt: z.number(), bz_gsm: z.number(), time_tag: z.string() }),
);

/** One GOES X-ray flux sample; the 0.1-0.8nm band defines flare classes. */
export const swpcXrayEntrySchema = z.object({
	time_tag: z.string(),
	flux: z.number(),
	energy: z.string(),
});

export const swpcXrayArraySchema = z.array(swpcXrayEntrySchema);

/**
 * OVATION aurora model: a 1°×1° global grid of [longitude 0-359,
 * latitude -90..90, probability 0-100] tuples.
 */
export const swpcOvationSchema = z.object({
	"Observation Time": z.string(),
	"Forecast Time": z.string(),
	coordinates: z.array(z.tuple([z.number(), z.number(), z.number()])),
});

export type SwpcKpForecastEntry = z.infer<typeof swpcKpForecastEntrySchema>;
export type SwpcScales = z.infer<typeof swpcScalesSchema>;
