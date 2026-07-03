import { z } from "zod";

/** Subset of a Launch Library 2 (v2.3.0) launch that spacedata exposes. */
export const launchSchema = z.object({
	id: z.string(),
	name: z.string(),
	net: z.string().nullable(),
	status: z
		.object({
			name: z.string(),
			abbrev: z.string().optional(),
		})
		.nullable(),
	launch_service_provider: z
		.object({
			name: z.string(),
		})
		.nullable()
		.optional(),
	rocket: z
		.object({
			configuration: z
				.object({
					name: z.string(),
					full_name: z.string().nullable().optional(),
				})
				.nullable(),
		})
		.nullable()
		.optional(),
	pad: z
		.object({
			name: z.string(),
			location: z
				.object({
					name: z.string(),
				})
				.nullable()
				.optional(),
		})
		.nullable()
		.optional(),
	mission: z
		.object({
			name: z.string(),
			type: z.string().nullable().optional(),
			orbit: z
				.object({
					name: z.string(),
					abbrev: z.string().optional(),
				})
				.nullable()
				.optional(),
		})
		.nullable()
		.optional(),
});

export const launchListSchema = z.object({
	count: z.number(),
	results: z.array(launchSchema),
});

export type Launch = z.infer<typeof launchSchema>;
