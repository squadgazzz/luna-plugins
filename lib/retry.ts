export class Semaphore {
	private queue: (() => void)[] = [];
	private count: number;
	constructor(max: number) { this.count = max; }
	async acquire(): Promise<void> {
		if (this.count > 0) { this.count--; return; }
		return new Promise((resolve) => this.queue.push(() => { this.count--; resolve(); }));
	}
	release(): void {
		this.count++;
		const next = this.queue.shift();
		if (next) next();
	}
}

export interface FetchRetryOptions {
	maxRetries?: number;
	/** Max retries specifically for 429 responses. Defaults to maxRetries. Set to Infinity for unlimited. */
	maxRateLimitRetries?: number;
	tag?: string;
	onRateLimit?: () => void;
	/** Called before each fetch attempt (including retries). Use for shared pause across concurrent requests. */
	beforeFetch?: () => Promise<void>;
}

/**
 * Shared rate-limit tracker for coordinating backoff across concurrent requests.
 * When any request gets 429'd, all concurrent requests pause for the shared duration.
 */
export class RateLimitTracker {
	private _hits = 0;
	private _sharedPauseUntil = 0;
	private readonly _pauseDuration: number;
	readonly tag: string;

	constructor(tag: string, pauseDuration = 3000) {
		this.tag = tag;
		this._pauseDuration = pauseDuration;
	}

	get hits(): number { return this._hits; }

	reset(): void {
		this._hits = 0;
		this._sharedPauseUntil = 0;
	}

	/** Returns the hits count and resets state. */
	resetAndGetHits(): number {
		const hits = this._hits;
		this.reset();
		return hits;
	}

	/** FetchRetryOptions with unlimited 429 retries and shared backoff. */
	get retryOptions(): FetchRetryOptions {
		return {
			tag: this.tag,
			maxRateLimitRetries: Infinity,
			onRateLimit: () => {
				this._hits++;
				this._sharedPauseUntil = Math.max(this._sharedPauseUntil, Date.now() + this._pauseDuration);
			},
			beforeFetch: async () => {
				const delay = this._sharedPauseUntil - Date.now();
				if (delay > 0) await new Promise((r) => setTimeout(r, delay));
			},
		};
	}
}

async function backoff(attempt: number, signal: AbortSignal | null | undefined, prefix: string, reason: string, retryAfter?: string | null): Promise<void> {
	const jitter = Math.random() * 500;
	const base = retryAfter ? parseInt(retryAfter, 10) * 1000 : 1000 * Math.pow(2, attempt);
	const delay = base + jitter;
	console.log(`${prefix} ${reason}, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1})`);
	await new Promise((r) => setTimeout(r, delay));
	if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
}

export async function fetchWithRetry(url: string, init: RequestInit, options?: FetchRetryOptions): Promise<Response> {
	const maxRetries = options?.maxRetries ?? 3;
	const maxRateLimitRetries = options?.maxRateLimitRetries ?? maxRetries;
	const tag = options?.tag ?? "";
	const prefix = tag ? `[${tag}]` : "";

	let attempt = 0;
	let rateLimitAttempt = 0;

	for (;;) {
		if (options?.beforeFetch) await options.beforeFetch();
		let res: Response;
		try {
			res = await fetch(url, init);
		} catch (err) {
			if (err instanceof DOMException && err.name === "AbortError") throw err;
			if (attempt >= maxRetries) throw err;
			await backoff(attempt, init.signal, prefix, "Network error");
			attempt++;
			continue;
		}
		if (res.status === 429) {
			options?.onRateLimit?.();
			if (rateLimitAttempt >= maxRateLimitRetries) return res;
			await backoff(rateLimitAttempt, init.signal, prefix, "[429] Rate limited", res.headers.get("Retry-After"));
			rateLimitAttempt++;
			continue;
		}
		if (res.status >= 500) {
			if (attempt >= maxRetries) return res;
			await backoff(attempt, init.signal, prefix, `[${res.status}] Server error`);
			attempt++;
			continue;
		}
		return res;
	}
}
