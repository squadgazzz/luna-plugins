import { redux, TidalApi } from "@luna/lib";
import { Semaphore, RateLimitTracker, fetchWithRetry } from "../../../lib/retry";

import type { TrackItem } from "./detection";

interface PlaylistItemsResponse {
	items: TrackItem[];
	totalNumberOfItems: number;
}

export interface PlaylistInfo {
	uuid: string;
	title: string;
	numberOfTracks: number;
}

function getUserId(): number | null {
	const state = redux.store.getState();
	return state.session?.userId ?? null;
}

export async function fetchFavoritesCount(): Promise<number> {
	const userId = getUserId();
	if (userId === null) return 0;

	const headers = await TidalApi.getAuthHeaders();
	const queryArgs = TidalApi.queryArgs();
	const res = await fetchWithRetry(`https://api.tidal.com/v1/users/${userId}/favorites/tracks?${queryArgs}&limit=1`, { headers }, rateLimit.retryOptionsLimited);
	if (!res.ok) return 0;
	const data = (await res.json()) as { totalNumberOfItems: number; items: unknown[] };
	// Tidal's totalNumberOfItems can be stale after bulk deletion — if no items returned, count is 0
	if ((data.items ?? []).length === 0) return 0;
	return data.totalNumberOfItems ?? 0;
}

export async function fetchUserPlaylists(): Promise<PlaylistInfo[]> {
	const userId = getUserId();
	if (userId === null) throw new Error("Not logged in");

	const headers = await TidalApi.getAuthHeaders();
	const queryArgs = TidalApi.queryArgs();
	const res = await fetchWithRetry(`https://api.tidal.com/v1/users/${userId}/playlists?${queryArgs}&limit=999`, { headers }, rateLimit.retryOptionsLimited);
	if (!res.ok) throw new Error(`Failed to fetch playlists: ${res.status}`);

	const data = (await res.json()) as { items: { uuid: string; title: string; numberOfTracks: number }[] };
	return data.items.map((p) => ({ uuid: p.uuid, title: p.title, numberOfTracks: p.numberOfTracks }));
}

export async function fetchPlaylistItems(playlistUUID: string, signal?: AbortSignal): Promise<TrackItem[]> {
	// Use raw fetch instead of TidalApi.playlistItems() to bypass memoization
	const headers = await TidalApi.getAuthHeaders();
	const queryArgs = TidalApi.queryArgs();
	const res = await fetchWithRetry(`https://api.tidal.com/v1/playlists/${playlistUUID}/items?${queryArgs}&limit=-1`, { headers, signal }, rateLimit.retryOptions);
	if (!res.ok) throw new Error(`Failed to fetch playlist items: ${res.status}`);
	const data = (await res.json()) as PlaylistItemsResponse;
	return data.items;
}

export async function fetchFavoriteTracks(signal?: AbortSignal): Promise<TrackItem[]> {
	const userId = getUserId();
	if (userId === null) throw new Error("Not logged in");

	const headers = await TidalApi.getAuthHeaders();
	const queryArgs = TidalApi.queryArgs();
	const items: TrackItem[] = [];
	const seenIds = new Set<number>();
	let offset = 0;
	const limit = 9999;
	let total = Infinity;

	while (offset < total) {
		if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
		const res = await fetchWithRetry(
			`https://api.tidal.com/v1/users/${userId}/favorites/tracks?${queryArgs}&limit=${limit}&offset=${offset}&order=DATE&orderDirection=ASC`,
			{ headers, signal },
			rateLimit.retryOptions,
		);
		if (!res.ok) throw new Error(`Failed to fetch favorites: ${res.status}`);
		const data = (await res.json()) as PlaylistItemsResponse & { totalNumberOfItems?: number };
		if (data.totalNumberOfItems !== undefined) total = data.totalNumberOfItems;
		const page = data.items ?? [];
		if (page.length === 0) break;
		for (const item of page) {
			if (!seenIds.has(item.item.id)) {
				seenIds.add(item.item.id);
				items.push(item);
			}
		}
		offset += page.length;
	}

	return items;
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

export async function removeFromFavorites(trackIds: number[], onProgress?: (removed: number, total: number) => void, signal?: AbortSignal): Promise<boolean> {
	const userId = getUserId();
	if (userId === null) return false;

	const headers = await TidalApi.getAuthHeaders();
	const queryArgs = TidalApi.queryArgs();
	const sem = new Semaphore(5);
	let done = 0;
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
			done++;
			onProgress?.(done, trackIds.length);
		}
	};

	await Promise.all(trackIds.map((id) => deleteOne(id)));

	return !failed;
}

export interface StreamInfo {
	bitDepth: number;
	sampleRate: number;
}

export async function fetchStreamInfo(trackId: number, audioQuality: string): Promise<StreamInfo | null> {
	try {
		const info = await TidalApi.playbackInfo(trackId as unknown as redux.ItemId, audioQuality as redux.AudioQuality);
		if (info === undefined) return null;
		return { bitDepth: info.bitDepth ?? 0, sampleRate: info.sampleRate ?? 0 };
	} catch {
		return null;
	}
}

export function updateReduxAfterRemoval(playlistUUID: string, removeIndices: number[]): void {
	redux.actions["content/REMOVE_MEDIA_ITEMS_FROM_PLAYLIST_SUCCESS"]({
		currentDirection: "ASC",
		currentOrder: "INDEX",
		playlistUUID,
		removeIndices,
	});
}

export interface TidalSearchResult {
	id: number;
	title: string;
	version?: string;
	duration: number;
	isrc?: string;
	artists: { id: number; name: string }[];
	album?: { title: string; releaseDate?: string };
	audioQuality?: string;
	streamStartDate?: string;
}

export async function isrcLookupAll(isrc: string): Promise<TidalSearchResult[]> {
	const results: TidalSearchResult[] = [];
	try {
		for await (const track of TidalApi.isrc(isrc)) {
			const t = track as any;
			results.push({
				id: t.id,
				title: t.title,
				version: t.version ?? undefined,
				duration: t.duration,
				isrc: t.isrc ?? undefined,
				artists: t.artists ?? [],
				album: t.album ?? undefined,
				audioQuality: t.audioQuality ?? undefined,
				streamStartDate: t.streamStartDate ?? undefined,
			});
		}
	} catch {
		/* no matches */
	}
	return results;
}

export const rateLimit = new RateLimitTracker("PlaylistTools");

export async function searchTracks(query: string, signal?: AbortSignal): Promise<TidalSearchResult[]> {
	const headers = await TidalApi.getAuthHeaders();
	const queryArgs = TidalApi.queryArgs();
	const res = await fetchWithRetry(
		`https://api.tidal.com/v1/search/tracks?${queryArgs}&query=${encodeURIComponent(query)}&limit=20`,
		{ headers, signal },
		rateLimit.retryOptions,
	);
	if (!res.ok) {
		console.debug(`[searchTracks] FAILED query="${query}" status=${res.status}`);
		return [];
	}
	const data = await res.json();
	const items = ((data.items ?? []) as any[]).map((t) => ({
		id: t.id,
		title: t.title,
		version: t.version ?? undefined,
		duration: t.duration,
		isrc: t.isrc ?? undefined,
		artists: t.artists ?? [],
		album: t.album ?? undefined,
		audioQuality: t.audioQuality ?? undefined,
		streamStartDate: t.streamStartDate ?? undefined,
	}));
	console.debug(`[searchTracks] query="${query}" → ${items.length} results`);
	return items;
}

export async function addToPlaylist(playlistUUID: string, trackIds: number[], signal?: AbortSignal): Promise<boolean> {
	const headers = await TidalApi.getAuthHeaders();
	const queryArgs = TidalApi.queryArgs();

	const playlistRes = await fetchWithRetry(`https://api.tidal.com/v1/playlists/${playlistUUID}?${queryArgs}`, { headers, signal }, rateLimit.retryOptions);
	if (!playlistRes.ok) return false;

	const etag = playlistRes.headers.get("etag");
	if (etag === null) return false;

	const addRes = await fetchWithRetry(`https://api.tidal.com/v1/playlists/${playlistUUID}/items?${queryArgs}`, {
		method: "POST",
		headers: {
			...headers,
			"Content-Type": "application/x-www-form-urlencoded",
			"If-None-Match": etag,
		},
		body: `trackIds=${trackIds.join(",")}&onDupes=SKIP`,
		signal,
	}, rateLimit.retryOptions);

	return addRes.ok;
}

export async function addToFavorites(trackIds: number[], signal?: AbortSignal): Promise<boolean> {
	const userId = getUserId();
	if (userId === null) return false;

	const headers = await TidalApi.getAuthHeaders();
	const queryArgs = TidalApi.queryArgs();

	const res = await fetchWithRetry(`https://api.tidal.com/v1/users/${userId}/favorites/tracks?${queryArgs}`, {
		method: "POST",
		headers: {
			...headers,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: `trackId=${trackIds.join(",")}`,
		signal,
	}, rateLimit.retryOptions);

	return res.ok;
}
