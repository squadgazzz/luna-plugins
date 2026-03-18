import { accessToken } from "./state";
import { ensureValidToken } from "./spotifyAuth";

const BASE = "https://api.spotify.com/v1";

// --- Types ---

export interface SpotifyArtist {
	name: string;
}

export interface SpotifyFollowedArtist {
	id: string;
	name: string;
}

export interface SpotifyAlbum {
	name: string;
	artists: SpotifyArtist[];
}

export interface SpotifyTrack {
	id: string | null;
	name: string;
	artists: SpotifyArtist[];
	album: SpotifyAlbum;
	track_number: number;
	duration_ms: number;
	type: string;
	external_ids?: { isrc?: string };
}

export interface SpotifyPlaylist {
	id: string;
	name: string;
	description: string;
	tracks: { total: number };
	owner: { id: string };
}

// --- Internal helpers ---

async function spotifyFetch(url: string, signal?: AbortSignal, maxRetries = 5): Promise<Response> {
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		await ensureValidToken();
		let res: Response;
		try {
			res = await fetch(url, {
				headers: { Authorization: "Bearer " + accessToken },
				signal,
			});
		} catch (err) {
			if (err instanceof DOMException && err.name === "AbortError") throw err;
			if (attempt === maxRetries) throw err;
			const jitter = Math.random() * 500;
			const delay = 1000 * Math.pow(2, attempt) + jitter;
			console.log(`[SpotifySync][Spotify] Network error, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})`);
			await new Promise((r) => setTimeout(r, delay));
			if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
			continue;
		}
		if (res.status === 429) {
			if (attempt === maxRetries) throw new Error("Spotify rate limit exceeded after all retries");
			const retryAfter = Number(res.headers.get("Retry-After") ?? "1");
			const jitter = Math.random() * 500;
			const delay = retryAfter * 1000 + jitter;
			console.log(`[SpotifySync][Spotify][429] Rate limited, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})`);
			await new Promise((r) => setTimeout(r, delay));
			if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
			continue;
		}
		if (res.status >= 500) {
			if (attempt === maxRetries) throw new Error(`Spotify API error: ${res.status} ${res.statusText}`);
			const jitter = Math.random() * 500;
			const delay = 1000 * Math.pow(2, attempt) + jitter;
			console.log(`[SpotifySync][Spotify][${res.status}] Server error, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})`);
			await new Promise((r) => setTimeout(r, delay));
			if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
			continue;
		}
		if (!res.ok) throw new Error(`Spotify API error: ${res.status} ${res.statusText}`);
		return res;
	}
	throw new Error("Unreachable");
}

async function fetchAllPages<T>(
	initialUrl: string,
	extractItems: (data: Record<string, unknown>) => T[],
	onProgress?: (loaded: number, total: number) => void,
	signal?: AbortSignal,
): Promise<T[]> {
	const items: T[] = [];
	let url: string | null = initialUrl;

	while (url) {
		if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
		const response = await spotifyFetch(url, signal);
		const data = await response.json();

		const pageItems = extractItems(data);
		items.push(...pageItems);

		if (onProgress) {
			onProgress(items.length, data.total as number);
		}

		url = (data.next as string | null) ?? null;
	}

	return items;
}

// --- Exported functions ---

export async function getMe(signal?: AbortSignal): Promise<{ id: string; display_name: string }> {
	const response = await spotifyFetch(`${BASE}/me`, signal);
	const data = await response.json();
	return { id: data.id, display_name: data.display_name };
}

export async function getPlaylists(signal?: AbortSignal): Promise<SpotifyPlaylist[]> {
	const me = await getMe(signal);
	const playlists = await fetchAllPages<SpotifyPlaylist>(
		`${BASE}/me/playlists?limit=50`,
		(data) => data.items as SpotifyPlaylist[],
		undefined,
		signal,
	);
	return playlists.filter((p) => p.owner.id === me.id);
}

export async function getPlaylistTracks(
	playlistId: string,
	onProgress?: (loaded: number, total: number) => void,
	signal?: AbortSignal,
): Promise<SpotifyTrack[]> {
	const fields = "next,total,limit,items(track(name,album(name,artists),artists,track_number,duration_ms,id,external_ids(isrc),type))";
	const tracks = await fetchAllPages<SpotifyTrack>(
		`${BASE}/playlists/${playlistId}/tracks?limit=100&fields=${encodeURIComponent(fields)}`,
		(data) => {
			const items = data.items as { track: SpotifyTrack | null }[];
			return items.map((i) => i.track).filter((t): t is SpotifyTrack => t !== null);
		},
		onProgress,
		signal,
	);
	return tracks.filter(
		(t) => t.type === "track" && t.album && t.album.name && t.album.artists && t.album.artists.length > 0,
	);
}

export async function getLikedTracks(onProgress?: (loaded: number, total: number) => void, signal?: AbortSignal): Promise<SpotifyTrack[]> {
	return fetchAllPages<SpotifyTrack>(
		`${BASE}/me/tracks?limit=50`,
		(data) => {
			const items = data.items as { track: SpotifyTrack | null }[];
			return items.map((i) => i.track).filter((t): t is SpotifyTrack => t !== null);
		},
		onProgress,
		signal,
	);
}

export async function getFollowedArtists(onProgress?: (loaded: number) => void, signal?: AbortSignal): Promise<SpotifyFollowedArtist[]> {
	const artists: SpotifyFollowedArtist[] = [];
	let after: string | null = null;

	for (;;) {
		if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
		const params = new URLSearchParams({ type: "artist", limit: "50" });
		if (after) params.set("after", after);
		const response = await spotifyFetch(`${BASE}/me/following?${params}`, signal);
		const data = await response.json();
		const page = data.artists;
		const items = (page.items ?? []) as SpotifyFollowedArtist[];
		artists.push(...items);
		onProgress?.(artists.length);
		after = page.cursors?.after ?? null;
		if (!after) break;
	}

	return artists;
}
