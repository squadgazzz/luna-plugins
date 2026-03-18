import type { LunaUnload } from "@luna/core";

export const unloads = new Set<LunaUnload>();

const STORAGE_PREFIX = "spotifySync:";

export let clientId = localStorage.getItem(`${STORAGE_PREFIX}clientId`) ?? "";
export let accessToken = localStorage.getItem(`${STORAGE_PREFIX}accessToken`) ?? "";
export let refreshToken = localStorage.getItem(`${STORAGE_PREFIX}refreshToken`) ?? "";
export let tokenExpiry = Number(localStorage.getItem(`${STORAGE_PREFIX}tokenExpiry`)) || 0;
export let codeVerifier = localStorage.getItem(`${STORAGE_PREFIX}codeVerifier`) ?? "";
export let syncFavorites = localStorage.getItem(`${STORAGE_PREFIX}syncFavorites`) === "true";
export let syncMode: "auto" | "manual" = (localStorage.getItem(`${STORAGE_PREFIX}syncMode`) as "auto" | "manual") || "auto";
export let skipSimilar = localStorage.getItem(`${STORAGE_PREFIX}skipSimilar`) !== "false";
export let preserveFavOrder = localStorage.getItem(`${STORAGE_PREFIX}preserveFavOrder`) !== "false";
export let syncArtists = localStorage.getItem(`${STORAGE_PREFIX}syncArtists`) === "true";
export let syncAlbums = localStorage.getItem(`${STORAGE_PREFIX}syncAlbums`) === "true";

export function setClientId(id: string): void {
	clientId = id;
	localStorage.setItem(`${STORAGE_PREFIX}clientId`, id);
}

export function setAccessToken(token: string): void {
	accessToken = token;
	localStorage.setItem(`${STORAGE_PREFIX}accessToken`, token);
}

export function setRefreshToken(token: string): void {
	refreshToken = token;
	localStorage.setItem(`${STORAGE_PREFIX}refreshToken`, token);
}

export function setTokenExpiry(expiry: number): void {
	tokenExpiry = expiry;
	localStorage.setItem(`${STORAGE_PREFIX}tokenExpiry`, String(expiry));
}

export function setCodeVerifier(verifier: string): void {
	codeVerifier = verifier;
	localStorage.setItem(`${STORAGE_PREFIX}codeVerifier`, verifier);
}

export function setSyncFavorites(enabled: boolean): void {
	syncFavorites = enabled;
	localStorage.setItem(`${STORAGE_PREFIX}syncFavorites`, String(enabled));
}

export function setSkipSimilar(skip: boolean): void {
	skipSimilar = skip;
	localStorage.setItem(`${STORAGE_PREFIX}skipSimilar`, String(skip));
}

export function setPreserveFavOrder(preserve: boolean): void {
	preserveFavOrder = preserve;
	localStorage.setItem(`${STORAGE_PREFIX}preserveFavOrder`, String(preserve));
}

export function setSyncMode(mode: "auto" | "manual"): void {
	syncMode = mode;
	localStorage.setItem(`${STORAGE_PREFIX}syncMode`, mode);
}

export function setSyncArtists(enabled: boolean): void {
	syncArtists = enabled;
	localStorage.setItem(`${STORAGE_PREFIX}syncArtists`, String(enabled));
}

export function setSyncAlbums(enabled: boolean): void {
	syncAlbums = enabled;
	localStorage.setItem(`${STORAGE_PREFIX}syncAlbums`, String(enabled));
}

export function clearAuth(): void {
	setAccessToken("");
	setRefreshToken("");
	setTokenExpiry(0);
	setCodeVerifier("");
}

// --- Sync memory ---

export type SimilarDecision = "keep-existing" | "add-new";

export function getMatchCache(playlistKey: string): Record<string, number> {
	try {
		return JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}matched:${playlistKey}`) ?? "{}");
	} catch {
		return {};
	}
}

export function saveMatchCache(playlistKey: string, cache: Record<string, number>): void {
	localStorage.setItem(`${STORAGE_PREFIX}matched:${playlistKey}`, JSON.stringify(cache));
}

export function getSimilarDecisions(playlistKey: string): Record<string, SimilarDecision> {
	try {
		return JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}decisions:${playlistKey}`) ?? "{}");
	} catch {
		return {};
	}
}

export function saveSimilarDecisions(playlistKey: string, decisions: Record<string, SimilarDecision>): void {
	localStorage.setItem(`${STORAGE_PREFIX}decisions:${playlistKey}`, JSON.stringify(decisions));
}

export function hasSyncMemory(playlistKey: string): boolean {
	const matched = localStorage.getItem(`${STORAGE_PREFIX}matched:${playlistKey}`);
	const decisions = localStorage.getItem(`${STORAGE_PREFIX}decisions:${playlistKey}`);
	return (matched !== null && matched !== "{}") || (decisions !== null && decisions !== "{}");
}

export function clearSyncMemoryFor(playlistKey: string): void {
	localStorage.removeItem(`${STORAGE_PREFIX}matched:${playlistKey}`);
	localStorage.removeItem(`${STORAGE_PREFIX}decisions:${playlistKey}`);
}

// --- Artist sync memory ---

export function getArtistMatchCache(): Record<string, number> {
	try {
		return JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}artistMatched`) ?? "{}");
	} catch {
		return {};
	}
}

export function saveArtistMatchCache(cache: Record<string, number>): void {
	localStorage.setItem(`${STORAGE_PREFIX}artistMatched`, JSON.stringify(cache));
}

export function getArtistSkipCache(): Record<string, true> {
	try {
		return JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}artistSkipped`) ?? "{}");
	} catch {
		return {};
	}
}

export function saveArtistSkipCache(skipped: Record<string, true>): void {
	localStorage.setItem(`${STORAGE_PREFIX}artistSkipped`, JSON.stringify(skipped));
}

export function hasArtistCache(): boolean {
	const matched = localStorage.getItem(`${STORAGE_PREFIX}artistMatched`);
	const skipped = localStorage.getItem(`${STORAGE_PREFIX}artistSkipped`);
	return (matched !== null && matched !== "{}") || (skipped !== null && skipped !== "{}");
}

export function clearArtistCache(): void {
	localStorage.removeItem(`${STORAGE_PREFIX}artistMatched`);
	localStorage.removeItem(`${STORAGE_PREFIX}artistSkipped`);
}

// --- Album sync memory ---

export function getAlbumMatchCache(): Record<string, number> {
	try {
		return JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}albumMatched`) ?? "{}");
	} catch {
		return {};
	}
}

export function saveAlbumMatchCache(cache: Record<string, number>): void {
	localStorage.setItem(`${STORAGE_PREFIX}albumMatched`, JSON.stringify(cache));
}

export function getAlbumSkipCache(): Record<string, true> {
	try {
		return JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}albumSkipped`) ?? "{}");
	} catch {
		return {};
	}
}

export function saveAlbumSkipCache(skipped: Record<string, true>): void {
	localStorage.setItem(`${STORAGE_PREFIX}albumSkipped`, JSON.stringify(skipped));
}

export function hasAlbumCache(): boolean {
	const matched = localStorage.getItem(`${STORAGE_PREFIX}albumMatched`);
	const skipped = localStorage.getItem(`${STORAGE_PREFIX}albumSkipped`);
	return (matched !== null && matched !== "{}") || (skipped !== null && skipped !== "{}");
}

export function clearAlbumCache(): void {
	localStorage.removeItem(`${STORAGE_PREFIX}albumMatched`);
	localStorage.removeItem(`${STORAGE_PREFIX}albumSkipped`);
}

export function isLoggedIn(): boolean {
	return accessToken !== "" && Date.now() < tokenExpiry;
}
