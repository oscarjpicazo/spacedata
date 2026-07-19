import { z } from "zod";

/**
 * GFZ Potsdam Kp index web service (https://kp.gfz.de/app/json/): parallel
 * arrays of 3-hour bins. `Kp` entries are null for bins not yet issued;
 * `status` marks each bin "def" (definitive) or "pre"/"now" (preliminary).
 */
export const gfzKpSchema = z
	.object({
		datetime: z.array(z.string()),
		Kp: z.array(z.number().nullable()),
		status: z.array(z.string()).optional(),
	})
	.refine((value) => value.Kp.length === value.datetime.length, {
		message: "Kp and datetime arrays have different lengths",
	});

export type GfzKp = z.infer<typeof gfzKpSchema>;
