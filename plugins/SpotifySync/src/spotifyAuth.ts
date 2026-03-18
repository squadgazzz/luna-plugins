import {
	clientId,
	codeVerifier,
	accessToken,
	refreshToken,
	tokenExpiry,
	setAccessToken,
	setRefreshToken,
	setTokenExpiry,
	setCodeVerifier,
	clearAuth,
} from "./state";
import type { LunaUnloads } from "@luna/core";

const SPOTIFY_AUTH_URL = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const REDIRECT_URI = "tidaLuna://spotify-callback";
const SCOPES = "playlist-read-private user-library-read user-follow-read";

const VERIFIER_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

function generateCodeVerifier(): string {
	const bytes = new Uint8Array(96);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => VERIFIER_CHARS[byte % 66]).join("");
}

async function generateCodeChallenge(verifier: string): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	const base64 = btoa(String.fromCharCode(...new Uint8Array(hash)));
	return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function buildAuthUrl(): Promise<string> {
	const verifier = generateCodeVerifier();
	setCodeVerifier(verifier);
	const challenge = await generateCodeChallenge(verifier);

	const params = new URLSearchParams({
		client_id: clientId,
		response_type: "code",
		redirect_uri: REDIRECT_URI,
		scope: SCOPES,
		code_challenge_method: "S256",
		code_challenge: challenge,
	});

	return `${SPOTIFY_AUTH_URL}?${params.toString()}`;
}

/** Starts the full OAuth flow: opens browser, listens for protocol callback, exchanges code. */
export function startAuthFlow(unloads: LunaUnloads): { promise: Promise<void>; cancel: () => void } {
	let unloadListener: (() => void) | undefined;
	let rejectPromise: ((err: Error) => void) | undefined;

	const promise = new Promise<void>((resolve, reject) => {
		rejectPromise = reject;

		buildAuthUrl()
			.then((authUrl) => {
				unloadListener = __ipcRenderer.on("__Luna.openUrl", (url: string) => {
					if (!url.toLowerCase().startsWith("tidaluna://spotify-callback")) return;

					unloadListener?.();
					unloadListener = undefined;

					try {
						const parsed = new URL(url);
						const error = parsed.searchParams.get("error");
						if (error) {
							reject(new Error(`Spotify authorization denied: ${error}`));
							return;
						}
						const code = parsed.searchParams.get("code");
						if (!code) {
							reject(new Error("No authorization code in callback URL"));
							return;
						}
						exchangeCode(code).then(resolve).catch(reject);
					} catch (err) {
						reject(err);
					}
				});

				unloads.add(unloadListener);
				window.open(authUrl, "_blank");
			})
			.catch((err) => {
				unloadListener?.();
				unloadListener = undefined;
				reject(err);
			});
	});

	return {
		promise,
		cancel: () => {
			unloadListener?.();
			unloadListener = undefined;
			rejectPromise?.(new Error("Auth flow cancelled"));
		},
	};
}

async function exchangeCode(code: string): Promise<void> {
	const body = new URLSearchParams({
		client_id: clientId,
		grant_type: "authorization_code",
		code,
		redirect_uri: REDIRECT_URI,
		code_verifier: codeVerifier,
	});

	const response = await fetch(SPOTIFY_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: body.toString(),
	});

	if (!response.ok) {
		throw new Error(`Token exchange failed: ${response.status}`);
	}
	const data = await response.json();
	setAccessToken(data.access_token);
	setRefreshToken(data.refresh_token);
	setTokenExpiry(Date.now() + data.expires_in * 1000);
}

export async function refreshAccessToken(): Promise<void> {
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: refreshToken,
		client_id: clientId,
	});

	let response: Response;
	try {
		response = await fetch(SPOTIFY_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: body.toString(),
		});
	} catch (err) {
		clearAuth();
		throw err;
	}

	if (!response.ok) {
		clearAuth();
		throw new Error(`Token refresh failed: ${response.status} ${response.statusText}`);
	}

	const data = await response.json();
	setAccessToken(data.access_token);
	setTokenExpiry(Date.now() + data.expires_in * 1000);
	if (data.refresh_token) {
		setRefreshToken(data.refresh_token);
	}
}

export async function ensureValidToken(): Promise<void> {
	if (!accessToken) {
		throw new Error("Not logged in");
	}
	if (Date.now() >= tokenExpiry - 60_000) {
		await refreshAccessToken();
	}
}
