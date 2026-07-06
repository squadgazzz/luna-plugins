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

export interface SpotifySavedAlbum {
	id: string;
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
		if (res.status === 403) throw new Error("Spotify API error: 403 Forbidden. In Development Mode, Spotify only lets an app read playlists you own or collaborate on (not followed or editorial playlists), and requires Premium. If you own this playlist and have Premium, try disconnecting and re-logging in to refresh permissions.");
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
	return fetchAllPages<SpotifyPlaylist>(
		`${BASE}/me/playlists?limit=50`,
		// Spotify's /me/playlists returns null entries and items missing `tracks`/`owner`
		// (deleted or unavailable followed playlists). Drop the unusable ones and normalize
		// the rest so downstream render/sync can rely on the shape.
		// The Feb/Mar 2026 API migration renamed the playlist `tracks` field to `items`,
		// so read whichever is present or the count shows 0 for every playlist.
		(data) => {
			const items = (data.items ?? []) as ((Partial<SpotifyPlaylist> & { items?: { total?: number } }) | null)[];
			return items
				.filter((p): p is Partial<SpotifyPlaylist> & { items?: { total?: number } } => p != null && typeof p.id === "string")
				.map((p) => ({
					id: p.id!,
					name: p.name ?? "(untitled)",
					description: p.description ?? "",
					tracks: { total: p.tracks?.total ?? p.items?.total ?? 0 },
					owner: { id: p.owner?.id ?? "" },
				}));
		},
		undefined,
		signal,
	);
}

export async function getPlaylistTracks(
	playlistId: string,
	onProgress?: (loaded: number, total: number) => void,
	signal?: AbortSignal,
): Promise<SpotifyTrack[]> {
	// Spotify's Feb/Mar 2026 migration replaced GET /playlists/{id}/tracks (now 403 for
	// Development Mode apps) with /items, and renamed each entry's `track` field to `item`.
	// No `fields` projection: the old one named `track`, and the default response already
	// carries everything we read (id, name, artists, album, external_ids.isrc, type).
	// Read `item ?? track` so it works whichever field name the account's API version uses.
	const tracks = await fetchAllPages<SpotifyTrack>(
		`${BASE}/playlists/${playlistId}/items?limit=100`,
		(data) => {
			const items = (data.items ?? []) as { item?: SpotifyTrack | null; track?: SpotifyTrack | null }[];
			return items.map((i) => i.item ?? i.track).filter((t): t is SpotifyTrack => t != null);
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

export async function getSavedAlbums(onProgress?: (loaded: number, total: number) => void, signal?: AbortSignal): Promise<SpotifySavedAlbum[]> {
	return fetchAllPages<SpotifySavedAlbum>(
		`${BASE}/me/albums?limit=50`,
		(data) => {
			const items = data.items as { album: { id: string; name: string; artists: SpotifyArtist[] } | null }[];
			return items
				.filter((i) => i.album !== null)
				.map((i) => ({ id: i.album!.id, name: i.album!.name, artists: i.album!.artists }));
		},
		onProgress,
		signal,
	);
}
