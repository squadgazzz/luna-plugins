import { Semaphore } from "../../../lib/retry";
import { normalize } from "./matching";
import { searchArtist } from "./tidalApi";
import type { TidalArtist } from "./tidalApi";
import type { SpotifyFollowedArtist } from "./spotifyApi";

export interface ArtistToFollow {
	spotifyArtist: SpotifyFollowedArtist;
	tidalArtist: TidalArtist;
}

export interface AmbiguousArtistMatch {
	spotifyArtist: SpotifyFollowedArtist;
	candidates: TidalArtist[];
	selectedTidalId: number | null; // null = skip
}

export interface ArtistMatchResult {
	toFollow: ArtistToFollow[];
	ambiguous: AmbiguousArtistMatch[];
	alreadyFollowed: number;
	unmatched: string[];
}

export async function matchAllArtists(
	spotifyArtists: SpotifyFollowedArtist[],
	existingTidalIds: Set<number>,
	matchCache: Record<string, number>,
	skipCache: Record<string, true>,
	onProgress?: (done: number, total: number, matched: number) => void,
	signal?: AbortSignal,
): Promise<ArtistMatchResult> {
	const sem = new Semaphore(5);
	const toFollow: ArtistToFollow[] = [];
	const ambiguous: AmbiguousArtistMatch[] = [];
	const unmatched: string[] = [];
	let alreadyFollowed = 0;
	let done = 0;
	let matched = 0;

	const matchOne = async (artist: SpotifyFollowedArtist) => {
		if (signal?.aborted) return;

		// Check skip cache
		if (artist.id in skipCache) {
			done++;
			onProgress?.(done, spotifyArtists.length, matched);
			return;
		}

		// Check match cache
		if (artist.id in matchCache) {
			const tidalId = matchCache[artist.id];
			if (existingTidalIds.has(tidalId)) {
				alreadyFollowed++;
			} else {
				toFollow.push({ spotifyArtist: artist, tidalArtist: { id: tidalId, name: artist.name } });
				matched++;
			}
			done++;
			onProgress?.(done, spotifyArtists.length, matched);
			return;
		}

		// Search Tidal
		await sem.acquire();
		try {
			if (signal?.aborted) return;
			await new Promise((r) => setTimeout(r, 50)); // stagger

			const results = await searchArtist(artist.name, signal);
			if (results.length === 0) {
				unmatched.push(artist.name);
			} else {
				const normalizedSpotify = normalize(artist.name);
				const exactMatch = results.find((r) => normalize(r.name) === normalizedSpotify);
				if (exactMatch) {
					if (existingTidalIds.has(exactMatch.id)) {
						alreadyFollowed++;
						matchCache[artist.id] = exactMatch.id;
					} else {
						toFollow.push({ spotifyArtist: artist, tidalArtist: exactMatch });
						matchCache[artist.id] = exactMatch.id;
						matched++;
					}
				} else {
					ambiguous.push({ spotifyArtist: artist, candidates: results, selectedTidalId: null });
				}
			}
		} finally {
			sem.release();
			done++;
			onProgress?.(done, spotifyArtists.length, matched);
		}
	};

	await Promise.all(spotifyArtists.map((a) => matchOne(a)));

	if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");

	return { toFollow, ambiguous, alreadyFollowed, unmatched: unmatched.sort((a, b) => a.localeCompare(b)) };
}
