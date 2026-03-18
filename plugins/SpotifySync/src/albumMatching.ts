import { Semaphore } from "../../../lib/retry";
import { normalize, simple } from "./matching";
import { searchAlbum } from "./tidalApi";
import type { TidalAlbum } from "./tidalApi";
import type { SpotifySavedAlbum } from "./spotifyApi";

export interface AlbumToAdd {
	spotifyAlbum: SpotifySavedAlbum;
	tidalAlbum: TidalAlbum;
}

export interface AmbiguousAlbumMatch {
	spotifyAlbum: SpotifySavedAlbum;
	candidates: TidalAlbum[];
	selectedTidalId: number | null; // null = skip
}

export interface AlbumMatchResult {
	toAdd: AlbumToAdd[];
	ambiguous: AmbiguousAlbumMatch[];
	alreadyFavorited: number;
	unmatched: string[];
}

function albumNameMatch(tidalTitle: string, spotifyName: string): boolean {
	const tidalSimple = simple(tidalTitle.toLowerCase());
	const spotifySimple = simple(spotifyName.toLowerCase());
	return tidalSimple === spotifySimple || normalize(tidalSimple) === normalize(spotifySimple);
}

function artistOverlap(tidalArtists: { name: string }[], spotifyArtists: { name: string }[]): boolean {
	const tidalSet = new Set(tidalArtists.map((a) => normalize(a.name)));
	for (const a of spotifyArtists) {
		if (tidalSet.has(normalize(a.name))) return true;
	}
	return false;
}

function formatAlbumDesc(album: SpotifySavedAlbum): string {
	return `${album.artists.map((a) => a.name).join(", ")} - ${album.name}`;
}

export async function matchAllAlbums(
	spotifyAlbums: SpotifySavedAlbum[],
	existingTidalIds: Set<number>,
	matchCache: Record<string, number>,
	skipCache: Record<string, true>,
	onProgress?: (done: number, total: number, matched: number) => void,
	signal?: AbortSignal,
): Promise<AlbumMatchResult> {
	const sem = new Semaphore(5);
	const toAdd: AlbumToAdd[] = [];
	const ambiguous: AmbiguousAlbumMatch[] = [];
	const unmatched: string[] = [];
	let alreadyFavorited = 0;
	let done = 0;
	let matched = 0;

	const matchOne = async (album: SpotifySavedAlbum) => {
		if (signal?.aborted) return;

		// Check skip cache
		if (album.id in skipCache) {
			done++;
			onProgress?.(done, spotifyAlbums.length, matched);
			return;
		}

		// Check match cache
		if (album.id in matchCache) {
			const tidalId = matchCache[album.id];
			if (existingTidalIds.has(tidalId)) {
				alreadyFavorited++;
			} else {
				toAdd.push({ spotifyAlbum: album, tidalAlbum: { id: tidalId, title: album.name, artists: album.artists.map((a) => ({ name: a.name })) } });
				matched++;
			}
			done++;
			onProgress?.(done, spotifyAlbums.length, matched);
			return;
		}

		// Search Tidal
		await sem.acquire();
		try {
			if (signal?.aborted) return;
			await new Promise((r) => setTimeout(r, 50)); // stagger

			const query = `${simple(album.name)} ${simple(album.artists[0]?.name ?? "")}`;
			const results = await searchAlbum(query, signal);
			if (results.length === 0) {
				unmatched.push(formatAlbumDesc(album));
			} else {
				// Find exact match: album name matches AND at least one artist overlaps
				const exactMatch = results.find(
					(r) => albumNameMatch(r.title, album.name) && artistOverlap(r.artists, album.artists),
				);
				if (exactMatch) {
					if (existingTidalIds.has(exactMatch.id)) {
						alreadyFavorited++;
						matchCache[album.id] = exactMatch.id;
					} else {
						toAdd.push({ spotifyAlbum: album, tidalAlbum: exactMatch });
						matchCache[album.id] = exactMatch.id;
						matched++;
					}
				} else {
					// Filter candidates to those with at least artist overlap
					const relevant = results.filter((r) => artistOverlap(r.artists, album.artists));
					if (relevant.length > 0) {
						ambiguous.push({ spotifyAlbum: album, candidates: relevant, selectedTidalId: null });
					} else {
						unmatched.push(formatAlbumDesc(album));
					}
				}
			}
		} finally {
			sem.release();
			done++;
			onProgress?.(done, spotifyAlbums.length, matched);
		}
	};

	await Promise.all(spotifyAlbums.map((a) => matchOne(a)));

	if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");

	return { toAdd, ambiguous, alreadyFavorited, unmatched };
}
