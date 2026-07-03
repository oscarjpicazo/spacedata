import { z } from "zod";

/** OMM (Orbit Mean-Elements Message) record as served by CelesTrak's GP API in FORMAT=json. */
export const ommSchema = z.object({
	OBJECT_NAME: z.string(),
	OBJECT_ID: z.string(),
	EPOCH: z.string(),
	MEAN_MOTION: z.number(),
	ECCENTRICITY: z.number(),
	INCLINATION: z.number(),
	RA_OF_ASC_NODE: z.number(),
	ARG_OF_PERICENTER: z.number(),
	MEAN_ANOMALY: z.number(),
	NORAD_CAT_ID: z.number(),
	BSTAR: z.number(),
	MEAN_MOTION_DOT: z.number(),
	MEAN_MOTION_DDOT: z.number(),
	CLASSIFICATION_TYPE: z.string().optional(),
	ELEMENT_SET_NO: z.number().optional(),
	REV_AT_EPOCH: z.number().optional(),
	EPHEMERIS_TYPE: z.number().optional(),
});

export const ommArraySchema = z.array(ommSchema);

export type Omm = z.infer<typeof ommSchema>;
