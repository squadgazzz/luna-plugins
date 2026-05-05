import anyAscii from "any-ascii";
import { redux } from "@luna/lib";
import type { SpotifyPlaylist } from "./spotifyApi";
import { getPlaylistTracks, getLikedTracks, getFollowedArtists, getSavedAlbums } from "./spotifyApi";
import { matchAllTracks } from "./matching";
import { fetchUserPlaylists, fetchPlaylistTracks, fetchFavoriteTracks, addTracksToPlaylist, createPlaylist, addToFavorites, removeFromPlaylist, removeFromFavorites, fetchFollowedArtists, followArtists, fetchFavoriteAlbums, favoriteAlbums } from "./tidalApi";
import type { TidalPlaylist, TidalTrackInfo } from "./tidalApi";
import { getMatchCache, saveMatchCache, getSimilarDecisions, preserveFavOrder, getArtistMatchCache, saveArtistMatchCache, getArtistSkipCache, saveArtistSkipCache, getAlbumMatchCache, saveAlbumMatchCache, getAlbumSkipCache, saveAlbumSkipCache } from "./state";
import { matchAllArtists } from "./artistMatching";
import type { ArtistToFollow, AmbiguousArtistMatch } from "./artistMatching";
import { matchAllAlbums } from "./albumMatching";
import type { AlbumToAdd, AmbiguousAlbumMatch } from "./albumMatching";

// --- Types ---

export interface SimilarVersion {
	tidalId: number;
	playlistIndex: number; // position in playlist (-1 for favorites)
	description: string;
	duration: number; // seconds
}

export interface TrackToAdd {
	tidalId: number;
	spotifyTrackId: string;
	description: string;
	duration: number; // seconds
	similarExisting?: SimilarVersion[];
}

export interface TrackToRemove {
	tidalId: number;
	playlistIndex: number;
	description: string;
}

export interface SyncPrepResult {
	playlistName: string;
	spotifyPlaylistId: string;
	playlistDescription: string;
	existingUUID: string; // empty if playlist needs to be created
	isFavorites: boolean;
	matched: number;
	unmatched: number;
	alreadyPresent: number;
	tracksToAdd: TrackToAdd[];
	tracksToRemove: TrackToRemove[];
	unmatchedTracks: string[];
}

export interface SyncPlaylistResult {
	playlistName: string;
	matched: number;
	unmatched: number;
	added: number;
	removed: number;
	alreadyPresent: number;
	addedTracks: string[];
	removedTracks: string[];
	unmatchedTracks: string[];
}

export interface ProgressInfo {
	current: number;
	total: number;
}

export type ProgressCallback = (message: string, progress?: ProgressInfo) => void;

// --- Artist sync types ---

export interface ArtistSyncPrepResult {
	alreadyFollowed: number;
	toFollow: ArtistToFollow[];
	ambiguous: AmbiguousArtistMatch[];
	unmatched: string[];
}

export interface ArtistSyncResult {
	followed: number;
	alreadyFollowed: number;
	skipped: number;
	unmatched: number;
	followedNames: string[];
	unmatchedNames: string[];
}

// --- Album sync types ---

export interface AlbumSyncPrepResult {
	alreadyFavorited: number;
	toAdd: AlbumToAdd[];
	ambiguous: AmbiguousAlbumMatch[];
	unmatched: string[];
}

export interface AlbumSyncResult {
	added: number;
	alreadyFavorited: number;
	skipped: number;
	unmatched: number;
	addedNames: string[];
	unmatchedNames: string[];
}

// --- ISRC helpers ---

/** Check if either Spotify or matched Tidal ISRC exists in the existing tracks' ISRC set */
function hasMatchingIsrc(existingIsrcs: Set<string>, spotifyIsrc?: string | null, tidalIsrc?: string | null): boolean {
	if (spotifyIsrc && existingIsrcs.has(spotifyIsrc.toUpperCase())) return true;
	if (tidalIsrc && existingIsrcs.has(tidalIsrc.toUpperCase())) return true;
	return false;
}

// --- Similarity helpers ---

const VERSION_MARKERS = ["remix", "instrumental", "acoustic", "live", "radio edit", "acapella", "demo", "unplugged"];

/** Extracts version markers (remix, live, etc.) from a track name */
function extractVersionMarker(name: string): string {
	const lower = name.toLowerCase();
	const markers = VERSION_MARKERS.filter((m) => lower.includes(m));
	return markers.sort().join("+");
}

/** Normalizes a string to a comparable key: transliterate, normalize abbreviations, strip suffixes */
function normalizeForKey(s: string, separators: string[]): string {
	let result = anyAscii(s);
	for (const sep of separators) {
		result = result.split(sep)[0];
	}
	result = result.trim().toLowerCase();
	// Normalize common abbreviations
	result = result
		.replace(/\bpt\b\.?\s*/g, "part ")
		.replace(/\bft\b\.?\s*/g, "feat ")
		.replace(/\bvol\b\.?\s*/g, "volume ");
	// Normalize roman numerals to arabic (longest first to avoid partial matches)
	result = result
		.replace(/\bviii\b/g, "8")
		.replace(/\bvii\b/g, "7")
		.replace(/\bvi\b/g, "6")
		.replace(/\biv\b/g, "4")
		.replace(/\bix\b/g, "9")
		.replace(/\biii\b/g, "3")
		.replace(/\bii\b/g, "2")
		.replace(/\bv\b/g, "5")
		.replace(/\bx\b/g, "10")
		.replace(/\bi\b/g, "1");
	return result.replace(/[^a-z0-9]/g, "");
}

/** Builds a key for fuzzy track comparison */
function trackSimilarityKey(name: string, artist: string): string {
	const n = normalizeForKey(name, [" - ", "(", "["]);
	const a = normalizeForKey(artist, ["&", ",", " - ", "(", "["]);
	const marker = extractVersionMarker(name);
	return marker ? `${n}|${a}|${marker}` : `${n}|${a}`;
}

interface SimilarTrackEntry {
	tidalId: number;
	playlistIndex: number;
	description: string;
	duration: number; // seconds
}

/** Combines Tidal title and version fields into a full track name */
function fullTrackName(title: string, version: string | null): string {
	return version ? `${title} (${version})` : title;
}

interface TitlePrefixEntry {
	titleNorm: string;
	artistNorm: string;
	entries: SimilarTrackEntry[];
}

interface SimilarityIndex {
	byKey: Map<string, SimilarTrackEntry[]>;
	prefixes: TitlePrefixEntry[]; // title-only entries for prefix matching
}

/** Builds a similarity index from existing Tidal tracks */
function buildSimilarityIndex(existingTracks: TidalTrackInfo[]): SimilarityIndex {
	const byKey = new Map<string, SimilarTrackEntry[]>();
	const prefixMap = new Map<string, SimilarTrackEntry[]>();

	for (let i = 0; i < existingTracks.length; i++) {
		const track = existingTracks[i];
		const displayName = fullTrackName(track.title, track.version);
		const artist = track.artists[0]?.name ?? "";
		// Primary key uses fullTrackName (parens format) — version markers like
		// "Remix" get stripped by the "(" separator, matching Spotify's "(Remix)" format
		const key = trackSimilarityKey(displayName, artist);
		const entry: SimilarTrackEntry = {
			tidalId: track.id,
			playlistIndex: i,
			description: `${track.artists.map((a) => a.name).join(", ")} - ${displayName}`,
			duration: track.duration,
		};

		const list = byKey.get(key);
		if (list) list.push(entry);
		else byKey.set(key, [entry]);

		if (track.version) {
			// Flat key: title + version WITHOUT parens — preserves non-marker version
			// text like "Part 1" that would otherwise be stripped by "(" splitting.
			// Handles "Poney Pt. I" (Spotify) matching "Poney" + version "Part 1" (Tidal)
			const flatKey = trackSimilarityKey(`${track.title} ${track.version}`, artist);
			if (flatKey !== key) {
				const fList = byKey.get(flatKey);
				if (fList) fList.push(entry);
				else byKey.set(flatKey, [entry]);
			}

			// Title-only prefix entry for prefix fallback matching
			const titleKey = trackSimilarityKey(track.title, artist);
			const pList = prefixMap.get(titleKey);
			if (pList) pList.push(entry);
			else prefixMap.set(titleKey, [entry]);
		}
	}

	const prefixes: TitlePrefixEntry[] = [];
	for (const [titleKey, entries] of prefixMap) {
		const [titleNorm, artistNorm] = titleKey.split("|");
		if (titleNorm.length >= 4) {
			prefixes.push({ titleNorm, artistNorm, entries });
		}
	}

	return { byKey, prefixes };
}

/**
 * Check if a Spotify track has similar existing versions.
 * Returns "exact" if name+artist+duration match (same recording).
 * Returns SimilarVersion[] if name+artist match but duration differs.
 * Returns undefined if no similar track.
 */
function checkSimilarity(
	similarityIndex: SimilarityIndex,
	spotifyName: string,
	spotifyArtist: string,
	spotifyDurationMs: number,
): "exact" | SimilarVersion[] | undefined {
	const key = trackSimilarityKey(spotifyName, spotifyArtist);
	let entries = similarityIndex.byKey.get(key);

	// Prefix fallback: check if the Spotify name extends a Tidal title
	if (!entries && similarityIndex.prefixes.length > 0) {
		const spotifyNameNorm = normalizeForKey(spotifyName, []);
		const spotifyArtistNorm = normalizeForKey(spotifyArtist, ["&", ",", " - ", "(", "["]);
		for (const pe of similarityIndex.prefixes) {
			if (pe.artistNorm === spotifyArtistNorm && spotifyNameNorm.startsWith(pe.titleNorm)) {
				entries = pe.entries;
				break;
			}
		}
	}

	if (!entries) return undefined;

	const spotifyDurationSec = spotifyDurationMs / 1000;
	// Check if any existing track has a matching duration (same recording, different ID)
	for (const entry of entries) {
		if (Math.abs(entry.duration - spotifyDurationSec) < 2) return "exact";
	}
	// Deduplicate by tidalId (same track at multiple playlist positions)
	const seen = new Set<number>();
	const unique = entries.filter((e) => {
		if (seen.has(e.tidalId)) return false;
		seen.add(e.tidalId);
		return true;
	});
	// Duration differs — return unique similar versions
	return unique.map((entry) => ({
		tidalId: entry.tidalId,
		playlistIndex: entry.playlistIndex,
		description: entry.description,
		duration: entry.duration,
	}));
}

// --- Prepare functions ---

async function preparePlaylistSync(
	spotifyPlaylist: SpotifyPlaylist,
	tidalPlaylists: TidalPlaylist[],
	onProgress: ProgressCallback,
	signal?: AbortSignal,
): Promise<SyncPrepResult> {
	const name = spotifyPlaylist.name;
	const playlistKey = spotifyPlaylist.id;
	const matchCache = getMatchCache(playlistKey);
	const decisions = getSimilarDecisions(playlistKey);

	// 1. Fetch Spotify tracks
	onProgress(`Fetching Spotify tracks for "${name}"...`);
	const spotifyTracks = await getPlaylistTracks(spotifyPlaylist.id, (loaded, total) => {
		onProgress(`Fetching Spotify tracks for "${name}": ${loaded}/${total}`, { current: loaded, total });
	}, signal);
	if (signal?.aborted) throw new DOMException("Sync cancelled", "AbortError");

	// 2. Check existing Tidal playlist — fetch full track metadata
	let existingTracks: TidalTrackInfo[] = [];
	let existingTrackIds = new Set<number>();
	let existingUUID = "";
	const existingPlaylist = tidalPlaylists.find((p) => p.title === name);

	if (existingPlaylist) {
		onProgress(`Found existing Tidal playlist "${name}", fetching tracks...`);
		existingTracks = await fetchPlaylistTracks(existingPlaylist.uuid, signal);
		existingTrackIds = new Set(existingTracks.map((t) => t.id));
		existingUUID = existingPlaylist.uuid;
		onProgress(`Tidal playlist "${name}" has ${existingTrackIds.size} existing tracks`);
	}
	if (signal?.aborted) throw new DOMException("Sync cancelled", "AbortError");

	// Build similarity index for fuzzy comparison
	const similarityIndex = buildSimilarityIndex(existingTracks);

	// Build ISRC set from existing tracks for cross-release matching
	// (same recording may have different Tidal IDs across regional releases)
	const existingIsrcs = new Set<string>();
	for (const t of existingTracks) {
		if (t.isrc) existingIsrcs.add(t.isrc.toUpperCase());
	}

	// 3. Match all tracks
	onProgress(`Matching tracks for "${name}"...`);
	const matchResults = await matchAllTracks(spotifyTracks, (matched, total, unmatchedList) => {
		onProgress(`Matching "${name}": ${matched}/${total} matched, ${unmatchedList.length} unmatched`, { current: matched, total });
	}, signal, matchCache);

	// Save updated match cache
	saveMatchCache(playlistKey, matchCache);

	// 4. Compute results with similarity detection
	let matched = 0;
	let unmatched = 0;
	let alreadyPresent = 0;
	const unmatchedTracks: string[] = [];
	const tracksToAdd: TrackToAdd[] = [];
	const seenIds = new Set<number>();

	for (const result of matchResults) {
		if (result === undefined) continue;
		const trackDesc = `${result.spotifyTrack.artists.map((a) => a.name).join(", ")} - ${result.spotifyTrack.name}`;
		const tidalId = result.tidalMatch?.id ?? null;
		const isrcAlreadyExists = hasMatchingIsrc(existingIsrcs, result.spotifyTrack.external_ids?.isrc, result.tidalMatch?.isrc);

		if (tidalId !== null) {
			matched++;
			if (existingTrackIds.has(tidalId) || isrcAlreadyExists) {
				alreadyPresent++;
			} else if (!seenIds.has(tidalId)) {
				const sim = checkSimilarity(
					similarityIndex,
					result.spotifyTrack.name,
					result.spotifyTrack.artists[0]?.name ?? "",
					result.spotifyTrack.duration_ms,
				);
				if (sim === "exact") {
					// Same name+artist+duration — silently skip
					alreadyPresent++;
				} else {
					const spotifyId = result.spotifyTrack.id;
					if (spotifyId && spotifyId in decisions) {
						if (decisions[spotifyId] === "keep-existing") {
							alreadyPresent++;
						} else {
							tracksToAdd.push({
								tidalId,
								spotifyTrackId: spotifyId,
								description: trackDesc,
								duration: result.spotifyTrack.duration_ms / 1000,
							});
							seenIds.add(tidalId);
						}
					} else {
						tracksToAdd.push({
							tidalId,
							spotifyTrackId: spotifyId ?? "",
							description: trackDesc,
							duration: result.spotifyTrack.duration_ms / 1000,
							similarExisting: sim === undefined ? undefined : sim,
						});
						seenIds.add(tidalId);
					}
				}
			}
		} else {
			// ISRC check for unmatched tracks too — may exist under different metadata
			if (isrcAlreadyExists) {
				alreadyPresent++;
			} else {
				const sim = checkSimilarity(
					similarityIndex,
					result.spotifyTrack.name,
					result.spotifyTrack.artists[0]?.name ?? "",
					result.spotifyTrack.duration_ms,
				);
				if (sim !== undefined) {
					alreadyPresent++;
				} else {
					unmatched++;
					unmatchedTracks.push(trackDesc);
				}
			}
		}
	}

	return {
		playlistName: name,
		spotifyPlaylistId: playlistKey,
		playlistDescription: spotifyPlaylist.description ?? "",
		existingUUID,
		isFavorites: false,
		matched,
		unmatched,
		alreadyPresent,
		tracksToAdd,
		tracksToRemove: [],
		unmatchedTracks: unmatchedTracks.sort((a, b) => a.localeCompare(b)),
	};
}

async function prepareFavoritesSync(
	onProgress: ProgressCallback,
	signal?: AbortSignal,
): Promise<SyncPrepResult> {
	// 1. Fetch liked tracks
	onProgress("Fetching Spotify liked tracks...");
	const playlistKey = "favorites";
	const matchCache = getMatchCache(playlistKey);
	const decisions = getSimilarDecisions(playlistKey);
	const spotifyTracks = await getLikedTracks((loaded, total) => {
		onProgress(`Fetching liked tracks: ${loaded}/${total}`, { current: loaded, total });
	}, signal);
	// Spotify returns newest-first; reverse so oldest-first to preserve chronological order when adding to Tidal
	spotifyTracks.reverse();
	if (signal?.aborted) throw new DOMException("Sync cancelled", "AbortError");

	// 2. Fetch existing Tidal favorites with metadata
	onProgress("Fetching existing Tidal favorites...");
	const existingTracks = await fetchFavoriteTracks(onProgress, signal);
	const existingTrackIds = new Set(existingTracks.map((t) => t.id));
	onProgress(`Found ${existingTrackIds.size} existing Tidal favorites`);
	if (signal?.aborted) throw new DOMException("Sync cancelled", "AbortError");

	// Build similarity index
	const similarityIndex = buildSimilarityIndex(existingTracks);

	// Build ISRC set from existing tracks for cross-release matching
	const existingIsrcs = new Set<string>();
	for (const t of existingTracks) {
		if (t.isrc) existingIsrcs.add(t.isrc.toUpperCase());
	}

	// 3. Match tracks
	onProgress("Matching liked tracks...");
	const matchResults = await matchAllTracks(spotifyTracks, (matched, total, unmatchedList) => {
		onProgress(`Matching favorites: ${matched}/${total} matched, ${unmatchedList.length} unmatched`, { current: matched, total });
	}, signal, matchCache);

	saveMatchCache(playlistKey, matchCache);

	// 4. Collect results with similarity detection
	let matched = 0;
	let unmatched = 0;
	let alreadyPresent = 0;
	const unmatchedTracks: string[] = [];
	const tracksToAdd: TrackToAdd[] = [];
	const seenIds = new Set<number>();

	for (const result of matchResults) {
		if (result === undefined) continue;
		const trackDesc = `${result.spotifyTrack.artists.map((a) => a.name).join(", ")} - ${result.spotifyTrack.name}`;
		const tidalId = result.tidalMatch?.id ?? null;
		const isrcAlreadyExists = hasMatchingIsrc(existingIsrcs, result.spotifyTrack.external_ids?.isrc, result.tidalMatch?.isrc);

		if (tidalId !== null) {
			matched++;
			if (existingTrackIds.has(tidalId) || isrcAlreadyExists) {
				alreadyPresent++;
			} else if (!seenIds.has(tidalId)) {
				const sim = checkSimilarity(
					similarityIndex,
					result.spotifyTrack.name,
					result.spotifyTrack.artists[0]?.name ?? "",
					result.spotifyTrack.duration_ms,
				);
				if (sim === "exact") {
					alreadyPresent++;
				} else {
					const spotifyId = result.spotifyTrack.id;
					if (spotifyId && spotifyId in decisions) {
						if (decisions[spotifyId] === "keep-existing") {
							alreadyPresent++;
						} else {
							tracksToAdd.push({
								tidalId,
								spotifyTrackId: spotifyId,
								description: trackDesc,
								duration: result.spotifyTrack.duration_ms / 1000,
							});
							seenIds.add(tidalId);
						}
					} else {
						tracksToAdd.push({
							tidalId,
							spotifyTrackId: spotifyId ?? "",
							description: trackDesc,
							duration: result.spotifyTrack.duration_ms / 1000,
							similarExisting: sim === undefined ? undefined : sim,
						});
						seenIds.add(tidalId);
					}
				}
			}
		} else {
			// ISRC check for unmatched tracks too — may exist under different metadata
			if (isrcAlreadyExists) {
				alreadyPresent++;
			} else {
				const sim = checkSimilarity(
					similarityIndex,
					result.spotifyTrack.name,
					result.spotifyTrack.artists[0]?.name ?? "",
					result.spotifyTrack.duration_ms,
				);
				if (sim !== undefined) {
					alreadyPresent++;
				} else {
					unmatched++;
					unmatchedTracks.push(trackDesc);
				}
			}
		}
	}

	return {
		playlistName: "Favorites",
		spotifyPlaylistId: "favorites",
		playlistDescription: "",
		existingUUID: "",
		isFavorites: true,
		matched,
		unmatched,
		alreadyPresent,
		tracksToAdd,
		tracksToRemove: [],
		unmatchedTracks: unmatchedTracks.sort((a, b) => a.localeCompare(b)),
	};
}

async function prepareArtistSync(
	onProgress: ProgressCallback,
	signal?: AbortSignal,
): Promise<ArtistSyncPrepResult> {
	onProgress("Fetching Spotify followed artists...");
	const spotifyArtists = await getFollowedArtists((loaded) => {
		onProgress(`Fetching Spotify artists: ${loaded} loaded...`);
	}, signal);

	if (spotifyArtists.length === 0) {
		return { alreadyFollowed: 0, toFollow: [], ambiguous: [], unmatched: [] };
	}

	onProgress("Fetching Tidal followed artists...");
	const tidalFollowed = await fetchFollowedArtists(signal);
	const existingIds = new Set(tidalFollowed.map((a) => a.id));

	const matchCache = getArtistMatchCache();
	const skipCache = getArtistSkipCache();

	const result = await matchAllArtists(spotifyArtists, existingIds, matchCache, skipCache, (done, total, matched) => {
		onProgress(`Matching artists: ${matched}/${total} matched`, { current: done, total });
	}, signal);

	saveArtistMatchCache(matchCache);

	return result;
}

export async function executeArtistSync(
	prep: ArtistSyncPrepResult,
	onProgress: ProgressCallback,
	signal?: AbortSignal,
): Promise<ArtistSyncResult> {
	const artistIds = prep.toFollow.map((a) => a.tidalArtist.id);

	const matchCache = getArtistMatchCache();
	const skipCache = getArtistSkipCache();
	for (const amb of prep.ambiguous) {
		if (amb.selectedTidalId !== null) {
			artistIds.push(amb.selectedTidalId);
			matchCache[amb.spotifyArtist.id] = amb.selectedTidalId;
		} else {
			skipCache[amb.spotifyArtist.id] = true;
		}
	}
	saveArtistMatchCache(matchCache);
	saveArtistSkipCache(skipCache);

	const skipped = prep.ambiguous.filter((a) => a.selectedTidalId === null).length;

	if (artistIds.length > 0) {
		onProgress(`Following ${artistIds.length} artists on Tidal...`);
		await followArtists(artistIds, (done, total) => {
			onProgress(`Following artists: ${done}/${total}`, { current: done, total });
		}, signal);
		redux.actions["content/LOAD_ALL_FAVORITES"]();
	}

	const followedNames = [
		...prep.toFollow.map((a) => a.spotifyArtist.name),
		...prep.ambiguous.filter((a) => a.selectedTidalId !== null).map((a) => a.spotifyArtist.name),
	];

	return {
		followed: artistIds.length,
		alreadyFollowed: prep.alreadyFollowed,
		skipped,
		unmatched: prep.unmatched.length,
		followedNames,
		unmatchedNames: prep.unmatched,
	};
}

async function prepareAlbumSync(
	onProgress: ProgressCallback,
	signal?: AbortSignal,
): Promise<AlbumSyncPrepResult> {
	onProgress("Fetching Spotify saved albums...");
	const spotifyAlbums = await getSavedAlbums((loaded, total) => {
		onProgress(`Fetching Spotify albums: ${loaded}/${total}...`, { current: loaded, total });
	}, signal);

	if (spotifyAlbums.length === 0) {
		return { alreadyFavorited: 0, toAdd: [], ambiguous: [], unmatched: [] };
	}

	onProgress("Fetching Tidal favorite albums...");
	const tidalAlbums = await fetchFavoriteAlbums(signal);
	const existingIds = new Set(tidalAlbums.map((a) => a.id));

	const matchCache = getAlbumMatchCache();
	const skipCache = getAlbumSkipCache();

	const result = await matchAllAlbums(spotifyAlbums, existingIds, matchCache, skipCache, (done, total, matched) => {
		onProgress(`Matching albums: ${matched}/${total} matched`, { current: done, total });
	}, signal);

	saveAlbumMatchCache(matchCache);

	return result;
}

export async function executeAlbumSync(
	prep: AlbumSyncPrepResult,
	onProgress: ProgressCallback,
	signal?: AbortSignal,
): Promise<AlbumSyncResult> {
	const albumIds = prep.toAdd.map((a) => a.tidalAlbum.id);

	const matchCache = getAlbumMatchCache();
	const skipCache = getAlbumSkipCache();
	for (const amb of prep.ambiguous) {
		if (amb.selectedTidalId !== null) {
			albumIds.push(amb.selectedTidalId);
			matchCache[amb.spotifyAlbum.id] = amb.selectedTidalId;
		} else {
			skipCache[amb.spotifyAlbum.id] = true;
		}
	}
	saveAlbumMatchCache(matchCache);
	saveAlbumSkipCache(skipCache);

	const skipped = prep.ambiguous.filter((a) => a.selectedTidalId === null).length;

	if (albumIds.length > 0) {
		onProgress(`Adding ${albumIds.length} albums to Tidal favorites...`);
		await favoriteAlbums(albumIds, (done, total) => {
			onProgress(`Adding albums: ${done}/${total}`, { current: done, total });
		}, signal);
		redux.actions["content/LOAD_ALL_FAVORITES"]();
	}

	const addedNames = [
		...prep.toAdd.map((a) => `${a.spotifyAlbum.artists.map((ar) => ar.name).join(", ")} - ${a.spotifyAlbum.name}`),
		...prep.ambiguous.filter((a) => a.selectedTidalId !== null).map((a) => `${a.spotifyAlbum.artists.map((ar) => ar.name).join(", ")} - ${a.spotifyAlbum.name}`),
	];

	return {
		added: albumIds.length,
		alreadyFavorited: prep.alreadyFavorited,
		skipped,
		unmatched: prep.unmatched.length,
		addedNames,
		unmatchedNames: prep.unmatched,
	};
}

export async function prepareAll(
	selectedPlaylists: SpotifyPlaylist[],
	doSyncFavorites: boolean,
	doSyncArtists: boolean,
	doSyncAlbums: boolean,
	onProgress: ProgressCallback,
	onPrepared: (result: SyncPrepResult) => void,
	signal?: AbortSignal,
): Promise<{ playlists: SyncPrepResult[]; artists?: ArtistSyncPrepResult; albums?: AlbumSyncPrepResult }> {
	const playlists: SyncPrepResult[] = [];

	onProgress("Fetching Tidal playlists...");
	const tidalPlaylists = await fetchUserPlaylists(signal);

	for (const playlist of selectedPlaylists) {
		if (signal?.aborted) break;
		try {
			const result = await preparePlaylistSync(playlist, tidalPlaylists, onProgress, signal);
			playlists.push(result);
			onPrepared(result);
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError") break;
			playlists.push({
				playlistName: playlist.name,
				spotifyPlaylistId: playlist.id,
				playlistDescription: "",
				existingUUID: "",
				isFavorites: false,
				matched: 0,
				unmatched: 0,
				alreadyPresent: 0,
				tracksToAdd: [],
				tracksToRemove: [],
				unmatchedTracks: [`Error: ${error instanceof Error ? error.message : String(error)}`],
			});
		}
	}

	if (doSyncFavorites && !signal?.aborted) {
		try {
			const result = await prepareFavoritesSync(onProgress, signal);
			playlists.push(result);
			onPrepared(result);
		} catch (error) {
			if (!(error instanceof DOMException && error.name === "AbortError")) {
				playlists.push({
					playlistName: "Favorites",
					spotifyPlaylistId: "favorites",
					playlistDescription: "",
					existingUUID: "",
					isFavorites: true,
					matched: 0,
					unmatched: 0,
					alreadyPresent: 0,
					tracksToAdd: [],
					tracksToRemove: [],
					unmatchedTracks: [`Error: ${error instanceof Error ? error.message : String(error)}`],
				});
			}
		}
	}

	let artists: ArtistSyncPrepResult | undefined;
	if (doSyncArtists && !signal?.aborted) {
		try {
			artists = await prepareArtistSync(onProgress, signal);
		} catch (error) {
			if (!(error instanceof DOMException && error.name === "AbortError")) {
				onProgress(`Error preparing artist sync: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	let albums: AlbumSyncPrepResult | undefined;
	if (doSyncAlbums && !signal?.aborted) {
		try {
			albums = await prepareAlbumSync(onProgress, signal);
		} catch (error) {
			if (!(error instanceof DOMException && error.name === "AbortError")) {
				onProgress(`Error preparing album sync: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	return { playlists, artists, albums };
}

// --- Execute functions ---

export async function executeAll(
	prepResults: SyncPrepResult[],
	onProgress: ProgressCallback,
	onDone: (result: SyncPlaylistResult) => void,
	signal?: AbortSignal,
): Promise<SyncPlaylistResult[]> {
	const results: SyncPlaylistResult[] = [];

	for (const prep of prepResults) {
		if (signal?.aborted) break;

		const trackIds = prep.tracksToAdd.map((t) => t.tidalId);
		const addedDescriptions = prep.tracksToAdd.map((t) => t.description);
		const removeDescriptions = prep.tracksToRemove.map((t) => t.description);
		let removedCount = 0;
		let addedCount = 0;

		try {
			// Phase 1: Remove tracks first (before adding)
			if (prep.tracksToRemove.length > 0) {
				if (prep.isFavorites) {
					onProgress(`Removing ${prep.tracksToRemove.length} tracks from favorites...`);
					const removeIds = prep.tracksToRemove.map((t) => t.tidalId);
					const ok = await removeFromFavorites(removeIds, signal);
					if (ok) removedCount = prep.tracksToRemove.length;
				} else if (prep.existingUUID) {
					onProgress(`Removing ${prep.tracksToRemove.length} tracks from "${prep.playlistName}"...`);
					const removeIndices = prep.tracksToRemove.map((t) => t.playlistIndex);
					const ok = await removeFromPlaylist(prep.existingUUID, removeIndices, signal);
					if (ok) removedCount = prep.tracksToRemove.length;
				}
			}

			// Phase 2: Add tracks
			if (trackIds.length > 0) {
				if (prep.isFavorites) {
					const parallel = !preserveFavOrder;
					onProgress(`Adding ${trackIds.length} tracks to favorites${parallel ? " (parallel)" : ""}...`);
					await addToFavorites(trackIds, (added, total) => {
						addedCount = added;
						onProgress(`Adding to favorites: ${added}/${total}`, { current: added, total });
					}, parallel, signal);
					addedCount = trackIds.length;
					onProgress(`Added ${trackIds.length} tracks to favorites`);
				} else {
					let targetUUID = prep.existingUUID;
					if (!targetUUID) {
						onProgress(`Creating Tidal playlist "${prep.playlistName}"...`);
						targetUUID = await createPlaylist(prep.playlistName, prep.playlistDescription);
						if (!targetUUID) {
							const refreshed = await fetchUserPlaylists();
							const created = refreshed.find((p) => p.title === prep.playlistName);
							if (!created) throw new Error(`Could not find newly created playlist "${prep.playlistName}"`);
							targetUUID = created.uuid;
						}
					}
					onProgress(`Adding ${trackIds.length} tracks to "${prep.playlistName}"...`);
					await addTracksToPlaylist(targetUUID, trackIds, (added, total) => {
						addedCount = added;
						onProgress(`Adding tracks to "${prep.playlistName}": ${added}/${total}`, { current: added, total });
					}, signal);
					addedCount = trackIds.length;
					onProgress(`Added ${trackIds.length} tracks to "${prep.playlistName}"`);
				}
			} else if (removedCount === 0) {
				onProgress(`No new tracks to add to "${prep.playlistName}"`);
			}

			// Refresh Tidal's internal cache so the UI reflects changes without a restart
			if (prep.isFavorites && (trackIds.length > 0 || removedCount > 0)) {
				redux.actions["content/LOAD_FAVORITE_TRACKS"]({ reset: true });
				redux.actions["content/LOAD_ALL_FAVORITES"]();
			}
			if (!prep.isFavorites && (trackIds.length > 0 || removedCount > 0)) {
				redux.actions["folders/LOAD_FOLDER_ITEMS"]({ context: "sidebar", reset: true, loadAll: true });
				redux.actions["content/LOAD_CREATED_PLAYLISTS"]({ reset: true, getAll: true });
			}
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError") break;
			onProgress(`Error syncing "${prep.playlistName}": ${error instanceof Error ? error.message : String(error)}`);
		}

		const result: SyncPlaylistResult = {
			playlistName: prep.playlistName,
			matched: prep.matched,
			unmatched: prep.unmatched,
			added: addedCount,
			removed: removedCount,
			alreadyPresent: prep.alreadyPresent,
			addedTracks: addedDescriptions.slice(0, addedCount),
			removedTracks: removeDescriptions,
			unmatchedTracks: prep.unmatchedTracks,
		};
		results.push(result);
		onDone(result);
	}

	return results;
}
