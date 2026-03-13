import { TidalApi } from "@luna/lib";
import { Semaphore, RateLimitTracker, fetchWithRetry } from "../../../lib/retry";
import type { SpotifyTrack } from "./spotifyApi";

// --- Internal types ---

interface TidalTrackResult {
	id: number;
	title: string;
	version?: string;
	duration: number;
	isrc?: string;
	artists: { name: string }[];
	album?: { title: string };
	audioQuality?: string;
}

// --- String helpers (ported from sync.py) ---

function normalize(s: string): string {
	// NFD normalize, strip combining marks (accents), lowercase, trim
	return s
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.trim();
}

function simple(input: string): string {
	// Take text before first hyphen, parenthesis, or bracket
	return input.split("-")[0].trim().split("(")[0].trim().split("[")[0].trim();
}

function splitArtists(name: string): string[] {
	if (name.includes("&")) return name.split("&").map((s) => s.trim());
	if (name.includes(",")) return name.split(",").map((s) => s.trim());
	return [name];
}

// --- Quality ranking ---

const QUALITY_RANK: Record<string, number> = {
	HI_RES_LOSSLESS: 5,
	HI_RES: 4,
	LOSSLESS: 3,
	HIGH: 2,
	LOW: 1,
};

function qualityRank(quality?: string): number {
	return QUALITY_RANK[quality ?? ""] ?? 0;
}

// --- Album matching ---

function albumMatch(tidalAlbumTitle: string | undefined, spotifyAlbumName: string): boolean {
	if (!tidalAlbumTitle) return false;
	const tidalSimple = simple(tidalAlbumTitle.toLowerCase());
	const spotifySimple = simple(spotifyAlbumName.toLowerCase());
	return tidalSimple === spotifySimple || normalize(tidalSimple) === normalize(spotifySimple);
}

/** Select best track from candidates: prefer album match, then highest quality */
function selectBestTrack(candidates: TidalTrackResult[], spotifyTrack: SpotifyTrack): TidalTrackResult | null {
	if (candidates.length === 0) return null;
	if (candidates.length === 1) return candidates[0];

	const albumMatches = candidates.filter((t) => albumMatch(t.album?.title, spotifyTrack.album.name));
	const pool = albumMatches.length > 0 ? albumMatches : candidates;
	return pool.reduce((best, t) => (qualityRank(t.audioQuality) > qualityRank(best.audioQuality) ? t : best));
}

// --- Match functions ---

function isrcMatch(tidalIsrc: string | undefined, spotifyTrack: SpotifyTrack): boolean {
	const spotifyIsrc = spotifyTrack.external_ids?.isrc;
	if (!spotifyIsrc || !tidalIsrc) return false;
	return tidalIsrc.toUpperCase() === spotifyIsrc.toUpperCase();
}

function durationMatch(tidalDurationSec: number, spotifyTrack: SpotifyTrack, tolerance = 2): boolean {
	return Math.abs(tidalDurationSec - spotifyTrack.duration_ms / 1000) < tolerance;
}

function nameMatch(tidalName: string, tidalVersion: string | undefined, spotifyTrack: SpotifyTrack): boolean {
	const tidalLower = tidalName.toLowerCase();
	const tidalVersionLower = tidalVersion?.toLowerCase() ?? "";

	// Exclusion rules: if one side has the pattern and the other doesn't, reject
	for (const pattern of ["instrumental", "acapella", "remix"]) {
		const spotifyHas = spotifyTrack.name.toLowerCase().includes(pattern);
		const tidalHas = tidalLower.includes(pattern) || tidalVersionLower.includes(pattern);
		if (spotifyHas !== tidalHas) return false;
	}

	// The simplified Spotify track name must be a substring of the Tidal track name
	// Try both un-normalized and normalized
	const simpleSpotify = simple(spotifyTrack.name.toLowerCase()).split("feat.")[0].trim();
	return tidalLower.includes(simpleSpotify) || normalize(tidalLower).includes(normalize(simpleSpotify));
}

function artistMatch(tidalArtists: string[], spotifyTrack: SpotifyTrack): boolean {
	const getTidal = (doNorm: boolean): Set<string> => {
		const names: string[] = [];
		for (const a of tidalArtists) names.push(...splitArtists(doNorm ? normalize(a) : a));
		return new Set(names.map((n) => simple(n.trim().toLowerCase())));
	};
	const getSpotify = (doNorm: boolean): Set<string> => {
		const names: string[] = [];
		for (const a of spotifyTrack.artists) names.push(...splitArtists(doNorm ? normalize(a.name) : a.name));
		return new Set(names.map((n) => simple(n.trim().toLowerCase())));
	};

	// Check overlap with and without normalization
	for (const doNorm of [false, true]) {
		const tidal = getTidal(doNorm);
		const spotify = getSpotify(doNorm);
		for (const name of tidal) {
			if (spotify.has(name)) return true;
		}
	}
	return false;
}

function matchTrack(tidal: TidalTrackResult, spotify: SpotifyTrack): boolean {
	return (
		isrcMatch(tidal.isrc, spotify) ||
		(durationMatch(tidal.duration, spotify) && nameMatch(tidal.title, tidal.version, spotify) && artistMatch(tidal.artists.map((a) => a.name), spotify))
	);
}

// --- Search via Tidal search API ---

const rateLimit = new RateLimitTracker("SpotifySync");

async function searchTidal(query: string, signal?: AbortSignal): Promise<TidalTrackResult[]> {
	const headers = await TidalApi.getAuthHeaders();
	const queryArgs = TidalApi.queryArgs();
	const res = await fetchWithRetry(
		`https://api.tidal.com/v1/search/tracks?${queryArgs}&query=${encodeURIComponent(query)}&limit=20`,
		{ headers, signal },
		rateLimit.retryOptions,
	);
	if (!res.ok) return [];
	const data = await res.json();
	return (data.items ?? []) as TidalTrackResult[];
}

export interface TidalMatch {
	id: number;
	isrc: string | null;
}

export interface MatchResult {
	spotifyTrack: SpotifyTrack;
	tidalMatch: TidalMatch | null;
}

// --- Main matching functions ---

export async function matchSpotifyTrack(spotifyTrack: SpotifyTrack, sem: Semaphore, signal?: AbortSignal): Promise<TidalMatch | null> {
	if (!spotifyTrack.id) return null;

	await sem.acquire();
	try {
		if (signal?.aborted) return null;

		// Stagger requests to avoid bursts
		await new Promise((r) => setTimeout(r, 50));

		// Search by title/artist, then pick best match (album match > quality)
		const query = `${simple(spotifyTrack.name)} ${simple(spotifyTrack.artists[0].name)}`;
		const results = await searchTidal(query, signal);
		const candidates = results.filter((track) => matchTrack(track, spotifyTrack));
		const best = selectBestTrack(candidates, spotifyTrack);
		if (best) return { id: best.id, isrc: best.isrc ?? null };
	} finally {
		sem.release();
	}

	return null;
}

export async function matchAllTracks(
	spotifyTracks: SpotifyTrack[],
	onProgress?: (matched: number, total: number, unmatched: string[]) => void,
	signal?: AbortSignal,
	matchCache?: Record<string, number>,
): Promise<MatchResult[]> {
	rateLimit.reset();
	const sem = new Semaphore(5);
	const results: MatchResult[] = new Array(spotifyTracks.length);
	const unmatched: string[] = [];
	let matched = 0;
	let completed = 0;

	const matchOne = async (i: number) => {
		if (signal?.aborted) return;
		const st = spotifyTracks[i];

		// Check match cache first — skip API search if we already know the Tidal ID
		if (st.id && matchCache && st.id in matchCache) {
			const cachedId = matchCache[st.id];
			results[i] = { spotifyTrack: st, tidalMatch: { id: cachedId, isrc: null } };
			matched++;
			completed++;
			if (completed % 10 === 0 || completed === spotifyTracks.length) {
				onProgress?.(matched, spotifyTracks.length, unmatched);
			}
			return;
		}

		const tidalMatch = await matchSpotifyTrack(st, sem, signal);
		if (signal?.aborted) return;
		results[i] = { spotifyTrack: st, tidalMatch };
		if (tidalMatch !== null) {
			matched++;
			// Write successful match to cache
			if (st.id && matchCache) {
				matchCache[st.id] = tidalMatch.id;
			}
		} else {
			unmatched.push(`${st.artists.map((a) => a.name).join(", ")} - ${st.name}`);
		}
		completed++;
		if (completed % 10 === 0 || completed === spotifyTracks.length) {
			onProgress?.(matched, spotifyTracks.length, unmatched);
		}
	};

	// Run all lookups concurrently, throttled by the semaphore
	await Promise.all(spotifyTracks.map((_, i) => matchOne(i)));

	if (signal?.aborted) throw new DOMException("Sync cancelled", "AbortError");

	const totalHits = rateLimit.hits;
	if (totalHits > 0) {
		console.log(`[SpotifySync] Matching complete. Total 429 rate limit hits: ${totalHits}`);
	}

	return results;
}
