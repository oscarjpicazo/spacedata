export abstract class SpaceDataError extends Error {
	abstract readonly code: string;
	abstract readonly exitCode: number;

	toJSON(): Record<string, unknown> {
		return {
			code: this.code,
			message: this.message,
		};
	}
}

export class NotFoundError extends SpaceDataError {
	readonly code = "NOT_FOUND";
	readonly exitCode = 2;
}

export class UpstreamHttpError extends SpaceDataError {
	readonly code = "UPSTREAM_HTTP";
	readonly exitCode = 3;

	constructor(
		readonly source: string,
		readonly status: number,
	) {
		super(`${source} responded with HTTP ${status}`);
	}

	override toJSON(): Record<string, unknown> {
		return { ...super.toJSON(), source: this.source, status: this.status };
	}
}

export class NetworkError extends SpaceDataError {
	readonly code = "NETWORK";
	readonly exitCode = 3;

	constructor(
		readonly source: string,
		cause: unknown,
	) {
		super(
			`network request to ${source} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
		);
	}

	override toJSON(): Record<string, unknown> {
		return { ...super.toJSON(), source: this.source };
	}
}

export class CircuitOpenError extends SpaceDataError {
	readonly code = "CIRCUIT_OPEN";
	readonly exitCode = 4;

	constructor(
		readonly source: string,
		readonly retryAt: string,
	) {
		super(
			`${source} recently returned an error; refusing to query it again until ${retryAt} to respect its usage policy`,
		);
	}

	override toJSON(): Record<string, unknown> {
		return { ...super.toJSON(), source: this.source, retryAt: this.retryAt };
	}
}

export class RateLimitedError extends SpaceDataError {
	readonly code = "RATE_LIMITED";
	readonly exitCode = 4;

	constructor(
		readonly source: string,
		readonly retryAt: string,
	) {
		super(
			`${source} rate limit reached; refusing to query it again until ${retryAt} to respect its usage policy`,
		);
	}

	override toJSON(): Record<string, unknown> {
		return { ...super.toJSON(), source: this.source, retryAt: this.retryAt };
	}
}

export class MissingCredentialsError extends SpaceDataError {
	readonly code = "MISSING_CREDENTIALS";
	readonly exitCode = 6;
}

export class AuthenticationError extends SpaceDataError {
	readonly code = "AUTH_FAILED";
	readonly exitCode = 6;

	constructor(readonly source: string) {
		super(`${source} rejected the provided credentials`);
	}

	override toJSON(): Record<string, unknown> {
		return { ...super.toJSON(), source: this.source };
	}
}

export class UpstreamSchemaError extends SpaceDataError {
	readonly code = "UPSTREAM_SCHEMA";
	readonly exitCode = 5;

	constructor(
		readonly source: string,
		detail: string,
	) {
		super(`${source} returned data with an unexpected shape: ${detail}`);
	}

	override toJSON(): Record<string, unknown> {
		return { ...super.toJSON(), source: this.source };
	}
}
