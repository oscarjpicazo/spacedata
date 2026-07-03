import { z } from "zod";

/** SATCAT record as served by CelesTrak's public records.php in FORMAT=json. */
export const celestrakSatcatSchema = z.object({
	OBJECT_NAME: z.string(),
	OBJECT_ID: z.string(),
	NORAD_CAT_ID: z.number(),
	OBJECT_TYPE: z.string(),
	OPS_STATUS_CODE: z.string(),
	OWNER: z.string(),
	LAUNCH_DATE: z.string(),
	LAUNCH_SITE: z.string(),
	DECAY_DATE: z.string(),
	PERIOD: z.number().nullable(),
	INCLINATION: z.number().nullable(),
	APOGEE: z.number().nullable(),
	PERIGEE: z.number().nullable(),
	RCS: z.number().nullable(),
	ORBIT_CENTER: z.string(),
	ORBIT_TYPE: z.string(),
});

export const celestrakSatcatArraySchema = z.array(celestrakSatcatSchema);
export type CelestrakSatcat = z.infer<typeof celestrakSatcatSchema>;
