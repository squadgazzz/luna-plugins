import { redux, TidalApi } from "@luna/lib";
import { Semaphore, RateLimitTracker, fetchWithRetry } from "../../../lib/retry";

export interface TidalPlaylist {
	uuid: string;
	title: string;
	numberOfTracks: number;
	type: string;
}

export interface TidalTrackInfo {
	id: number;
	title: string;
	version: string | null;
	duration: number; // seconds
	isrc: string | null;
	artists: { name: string }[];
}

const rateLimit = new RateLimitTracker("SpotifySync");

function getUserId(): number | null {
	const state = redux.store.getState();
	return state.session?.userId ?? null;
}

export async function fetchUserPlaylists(signal?: AbortSignal): Promise<TidalPlaylist[]> {
	const userId = getUserId();
	if (userId === null) throw new Error("Not logged in");

	const headers = await TidalApi.getAuthHeaders();
	const queryArgs = TidalApi.queryArgs();
	const res = await fetchWithRetry(`https://api.tidal.com/v1/users/${userId}/playlists?${queryArgs}&limit=999`, { headers, signal }, rateLimit.retryOptions);
	if (!res.ok) throw new Error(`Failed to fetch playlists: ${res.status}`);

	const data = (await res.json()) as { items: TidalPlaylist[] };
	return data.items;
}

export async function fetchPlaylistTracks(playlistUUID: string, signal?: AbortSignal): Promise<TidalTrackInfo[]> {
	const headers = await TidalApi.getAuthHeaders();
	const queryArgs = TidalApi.queryArgs();
	const res = await fetchWithRetry(
		`https://api.tidal.com/v1/playlists/${playlistUUID}/items?${queryArgs}&limit=-1`,
		{ headers, signal },
		rateLimit.retryOptions,
	);
	if (!res.ok) throw new Error(`Failed to fetch playlist items: ${res.status}`);
	const data = (await res.json()) as { items: { item: TidalTrackInfo | null }[] };
	const tracks: TidalTrackInfo[] = [];
	for (const entry of (data.items ?? [])) {
		if (entry.item) {
			tracks.push({ id: entry.item.id, title: entry.item.title, version: entry.item.version ?? null, duration: entry.item.duration, isrc: (entry.item as any).isrc ?? null, artists: entry.item.artists });
		}
	}
	return tracks;
}

export async function addTracksToPlaylist(playlistUUID: string, trackIds: number[], onProgress?: (added: number, total: number) => void, signal?: AbortSignal): Promise<void> {
	const chunkSize = 20;
	const total = trackIds.length;
	let added = 0;
	rateLimit.reset();

	for (let i = 0; i < total; i += chunkSize) {
		if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
		const batch = trackIds.slice(i, i + chunkSize);

		const headers = await TidalApi.getAuthHeaders();
		const queryArgs = TidalApi.queryArgs();

		// Get ETag
		const playlistRes = await fetchWithRetry(`https://api.tidal.com/v1/playlists/${playlistUUID}?${queryArgs}`, { headers, signal }, rateLimit.retryOptions);
		if (!playlistRes.ok) throw new Error(`Failed to fetch playlist for ETag: ${playlistRes.status}`);

		const etag = playlistRes.headers.get("etag");
		if (etag === null) throw new Error("Failed to get ETag from playlist response");

		// Add tracks
		const addRes = await fetchWithRetry(`https://api.tidal.com/v1/playlists/${playlistUUID}/items?${queryArgs}`, {
			method: "POST",
			headers: {
				...headers,
				"Content-Type": "application/x-www-form-urlencoded",
				"If-None-Match": etag,
			},
			body: `trackIds=${batch.join(",")}&onDupes=SKIP`,
			signal,
		}, rateLimit.retryOptions);
		if (!addRes.ok) throw new Error(`Failed to add tracks to playlist: ${addRes.status}`);

		added += batch.length;
		onProgress?.(added, total);
	}

	const hits = rateLimit.resetAndGetHits();
	if (hits > 0) console.log(`[SpotifySync] Adding to playlist complete. Total 429 rate limit hits: ${hits}`);
}

export async function createPlaylist(title: string, description?: string): Promise<string> {
	const headers = await TidalApi.getAuthHeaders();
	const params = new URLSearchParams({
		name: title,
		description: description ?? "",
		folderId: "root",
	});

	const res = await fetchWithRetry(`https://api.tidal.com/v2/my-collection/playlists/folders/create-playlist?${params}`, {
		method: "PUT",
		headers,
	}, rateLimit.retryOptions);

	if (!res.ok) throw new Error(`Failed to create playlist: ${res.status}`);

	const json = await res.json();
	const data = json.data ?? json;
	const uuid = data.uuid ?? "";
	if (!uuid) throw new Error(`Playlist created but UUID not found in response`);

	return uuid;
}

export async function fetchFavoriteTracks(onProgress?: (message: string) => void, signal?: AbortSignal): Promise<TidalTrackInfo[]> {
	const userId = getUserId();
	if (userId === null) throw new Error("Not logged in");

	const headers = await TidalApi.getAuthHeaders();
	const queryArgs = TidalApi.queryArgs();
	const tracks: TidalTrackInfo[] = [];
	let offset = 0;
	const limit = 9999;
	let total = Infinity;

	while (offset < total) {
		if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
		onProgress?.(`Fetching Tidal favorites${tracks.length > 0 ? `: ${tracks.length} loaded...` : "..."}`);
		const res = await fetchWithRetry(
			`https://api.tidal.com/v1/users/${userId}/favorites/tracks?${queryArgs}&limit=${limit}&offset=${offset}&order=DATE&orderDirection=ASC`,
			{ headers, signal },
			rateLimit.retryOptions,
		);
		if (!res.ok) throw new Error(`Failed to fetch favorites: ${res.status}`);
		const data = (await res.json()) as { totalNumberOfItems?: number; items: { item: TidalTrackInfo | null }[] };
		if (data.totalNumberOfItems !== undefined) total = data.totalNumberOfItems;
		const items = data.items ?? [];
		if (items.length === 0) break;
		for (const entry of items) {
			if (entry.item) {
				tracks.push({ id: entry.item.id, title: entry.item.title, version: entry.item.version ?? null, duration: entry.item.duration, isrc: (entry.item as any).isrc ?? null, artists: entry.item.artists });
			}
		}
		offset += items.length;
	}

	onProgress?.(`Fetched ${tracks.length} Tidal favorites`);
	return tracks;
}

export async function addToFavorites(trackIds: number[], onProgress?: (added: number, total: number) => void, parallel?: boolean, signal?: AbortSignal): Promise<void> {
	const userId = getUserId();
	if (userId === null) throw new Error("Not logged in");

	const headers = await TidalApi.getAuthHeaders();
	const queryArgs = TidalApi.queryArgs();
	const url = `https://api.tidal.com/v1/users/${userId}/favorites/tracks?${queryArgs}`;
	const postInit = (body: string): RequestInit => ({
		method: "POST",
		headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
		body,
		signal,
	});

	rateLimit.reset();

	if (parallel) {
		const chunkSize = 20;
		const sem = new Semaphore(3);
		let added = 0;

		const chunks: number[][] = [];
		for (let i = 0; i < trackIds.length; i += chunkSize) {
			chunks.push(trackIds.slice(i, i + chunkSize));
		}

		await Promise.all(chunks.map(async (batch) => {
			if (signal?.aborted) return;
			await sem.acquire();
			try {
				if (signal?.aborted) return;
				const res = await fetchWithRetry(url, postInit(`trackId=${batch.join(",")}`), rateLimit.retryOptions);
				if (!res.ok) throw new Error(`Failed to add tracks to favorites: ${res.status}`);
				added += batch.length;
				onProgress?.(added, trackIds.length);
			} finally {
				sem.release();
			}
		}));
	} else {
		for (let i = 0; i < trackIds.length; i++) {
			if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
			const res = await fetchWithRetry(url, postInit(`trackId=${trackIds[i]}`), rateLimit.retryOptions);
			if (!res.ok) throw new Error(`Failed to add track to favorites: ${res.status}`);
			onProgress?.(i + 1, trackIds.length);
		}
	}

	const hits = rateLimit.resetAndGetHits();
	if (hits > 0) console.log(`[SpotifySync] Adding favorites complete. Total 429 rate limit hits: ${hits}`);
}

export async function removeFromPlaylist(playlistUUID: string, removeIndices: number[], signal?: AbortSignal): Promise<boolean> {
	const headers = await TidalApi.getAuthHeaders();
	const queryArgs = TidalApi.queryArgs();

	const playlistRes = await fetchWithRetry(`https://api.tidal.com/v1/playlists/${playlistUUID}?${queryArgs}`, { headers, signal }, rateLimit.retryOptions);
	if (!playlistRes.ok) return false;

	const etag = playlistRes.headers.get("etag");
	if (etag === null) return false;

	const indices = removeIndices.join(",");
	const deleteRes = await fetchWithRetry(`https://api.tidal.com/v1/playlists/${playlistUUID}/items/${indices}?${queryArgs}`, {
		method: "DELETE",
		headers: {
			...headers,
			"If-None-Match": etag,
		},
		signal,
	}, rateLimit.retryOptions);

	return deleteRes.ok;
}

export async function removeFromFavorites(trackIds: number[], signal?: AbortSignal): Promise<boolean> {
	const userId = getUserId();
	if (userId === null) return false;

	const headers = await TidalApi.getAuthHeaders();
	const queryArgs = TidalApi.queryArgs();
	const sem = new Semaphore(5);
	let failed = false;

	const deleteOne = async (trackId: number) => {
		if (signal?.aborted || failed) return;
		await sem.acquire();
		try {
			if (signal?.aborted || failed) return;
			const res = await fetchWithRetry(
				`https://api.tidal.com/v1/users/${userId}/favorites/tracks/${trackId}?${queryArgs}`,
				{ method: "DELETE", headers, signal },
				rateLimit.retryOptions,
			);
			if (!res.ok) failed = true;
		} catch (err) {
			if (err instanceof DOMException && err.name === "AbortError") throw err;
			failed = true;
		} finally {
			sem.release();
		}
	};

	await Promise.all(trackIds.map((id) => deleteOne(id)));

	return !failed;
}
