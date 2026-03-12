import { MediaItem } from "@luna/lib";

import type { IndexedTrack, TrackItem } from "./detection";
import { isRemastered, stripRemasterTags } from "./detection";
import type { DuplicateGroupResult, PlaylistScanResult, ProgressInfo, SelectedTarget, TrackChoice } from "./dedup";
import { shouldSkipUpgrade } from "./state";
import {
	fetchFavoriteTracks,
	fetchPlaylistItems,
	fetchStreamInfo,
	isrcLookupAll,
	searchTracks,
	type TidalSearchResult,
} from "./tidalApi";

const QUALITY_RANK: Record<string, number> = {
	LOW: 0,
	HIGH: 1,
	LOSSLESS: 2,
	HI_RES_LOSSLESS: 3,
};

function normalize(s: string): string {
	return s.normalize("NFC").toLowerCase().trim();
}

function simplify(s: string): string {
	return s.split("-")[0].trim().split("(")[0].trim().split("[")[0].trim();
}

function durationMatch(a: number, b: number, tolerance = 2): boolean {
	return Math.abs(a - b) < tolerance;
}

function artistOverlap(a: { name: string }[], b: { name: string }[]): boolean {
	const setA = new Set(a.map((x) => normalize(x.name)));
	for (const artist of b) {
		if (setA.has(normalize(artist.name))) return true;
	}
	return false;
}

function isSameSong(current: TrackItem["item"], candidate: TidalSearchResult): boolean {
	if (!artistOverlap(current.artists, candidate.artists)) return false;
	if (!durationMatch(current.duration, candidate.duration)) return false;

	const currentName = normalize(simplify(stripRemasterTags(current.title)));
	const candidateName = normalize(simplify(stripRemasterTags(candidate.title)));
	return currentName === candidateName || currentName.includes(candidateName) || candidateName.includes(currentName);
}

function isTrackRemastered(item: { title: string; version?: string; album?: { title: string } }): boolean {
	return isRemastered(item.title, item.version) || (item.album ? isRemastered(item.album.title) : false);
}

function isBetter(current: TrackItem["item"], candidate: TidalSearchResult): boolean {
	const currentQuality = QUALITY_RANK[current.audioQuality ?? ""] ?? -1;
	const candidateQuality = QUALITY_RANK[candidate.audioQuality ?? ""] ?? -1;

	if (candidateQuality > currentQuality) return true;

	if (isTrackRemastered(candidate) && !isTrackRemastered(current)) return true;

	return false;
}

function toTrackItem(result: TidalSearchResult): TrackItem {
	return {
		item: {
			id: result.id,
			title: result.title,
			version: result.version,
			duration: result.duration,
			isrc: result.isrc,
			artists: result.artists.map((a) => ({ id: a.id ?? 0, name: a.name })),
			album: result.album,
			audioQuality: result.audioQuality,
			streamStartDate: result.streamStartDate,
		},
	};
}

function mediaItemToTrackItem(mediaItem: MediaItem): TrackItem {
	const t = mediaItem.tidalItem;
	return {
		item: {
			id: t.id as number,
			title: t.title ?? "",
			version: t.version ?? undefined,
			duration: t.duration ?? 0,
			isrc: t.isrc ?? undefined,
			artists: (t.artists ?? []).map((a: any) => ({ id: a.id ?? 0, name: a.name ?? "" })),
			album: t.album ? { title: t.album.title ?? "", releaseDate: t.album.releaseDate ?? undefined } : undefined,
			audioQuality: t.audioQuality ?? undefined,
			streamStartDate: t.streamStartDate ?? undefined,
		},
	};
}

function rankAlternatives(alternatives: TidalSearchResult[]): TidalSearchResult[] {
	return [...alternatives].sort((a, b) => {
		const qualA = QUALITY_RANK[a.audioQuality ?? ""] ?? -1;
		const qualB = QUALITY_RANK[b.audioQuality ?? ""] ?? -1;
		if (qualB !== qualA) return qualB - qualA;

		const remA = isTrackRemastered(a) ? 1 : 0;
		const remB = isTrackRemastered(b) ? 1 : 0;
		if (remB !== remA) return remB - remA;

		const dateA = a.album?.releaseDate ?? "";
		const dateB = b.album?.releaseDate ?? "";
		if (dateB !== dateA) return dateB > dateA ? 1 : -1;

		return 0;
	});
}

/**
 * First pass: use Luna's MediaItem.max() for fast, accurate ISRC-based quality lookup.
 * Returns a TrackItem for the best version, or undefined if already at max.
 */
async function findMaxViaLuna(trackId: number): Promise<TrackItem | undefined> {
	try {
		const mediaItem = await MediaItem.fromId(trackId);
		if (mediaItem === undefined) return undefined;
		const maxItem = await mediaItem.max();
		if (maxItem === undefined) return undefined;
		return mediaItemToTrackItem(maxItem);
	} catch {
		return undefined;
	}
}

/**
 * Second pass: title/artist search to find remasters, reissues, and alternatives
 * that ISRC lookup might miss (different ISRCs, different albums, etc.)
 */
async function findAlternativesViaSearch(
	track: TrackItem["item"],
	excludeIds: Set<number>,
	signal?: AbortSignal,
): Promise<TidalSearchResult[]> {
	const artist = track.artists[0]?.name ?? "";
	const simplified = simplify(track.title);
	const query = `${simplified} ${artist}`;
	const dbg = `[search:${track.id} "${track.title}"]`;
	const searchResults = await searchTracks(query, signal);
	console.log(`${dbg} query="${query}" → ${searchResults.length} results`);
	const candidates: TidalSearchResult[] = [];
	const seenIds = new Set<number>();
	for (const r of searchResults) {
		if (excludeIds.has(r.id)) {
			console.log(`${dbg} skip ${r.id} "${r.title}" (already in playlist)`);
			continue;
		}
		if (seenIds.has(r.id)) continue;
		const same = isSameSong(track, r);
		const better = same && isBetter(track, r);
		if (same && better) {
			candidates.push(r);
			seenIds.add(r.id);
		} else {
			console.log(`${dbg} rejected ${r.id} "${r.title}" v="${r.version ?? ""}" q=${r.audioQuality} dur=${r.duration} curDur=${track.duration} (sameSong=${same}, better=${better})`);
		}
	}

	return candidates;
}

function hasVisibleImprovement(current: TrackChoice, alternative: TrackChoice): boolean {
	const curItem = current.track.track.item;
	const altItem = alternative.track.track.item;

	// Higher quality tier
	const curQual = QUALITY_RANK[curItem.audioQuality ?? ""] ?? -1;
	const altQual = QUALITY_RANK[altItem.audioQuality ?? ""] ?? -1;
	if (altQual > curQual) return true;

	// Higher bit depth or sample rate
	const curStream = current.streamInfo;
	const altStream = alternative.streamInfo;
	if (curStream && altStream && curStream.bitDepth > 0 && altStream.bitDepth > 0) {
		if (altStream.bitDepth > curStream.bitDepth) return true;
		if (altStream.sampleRate > curStream.sampleRate) return true;
	}

	// Remaster (track title, version, or album title)
	if (isTrackRemastered(altItem) && !isTrackRemastered(curItem)) return true;

	return false;
}

class Semaphore {
	private queue: (() => void)[] = [];
	private count: number;
	constructor(max: number) { this.count = max; }
	async acquire(): Promise<void> {
		if (this.count > 0) { this.count--; return; }
		return new Promise((resolve) => this.queue.push(() => { this.count--; resolve(); }));
	}
	release(): void {
		this.count++;
		const next = this.queue.shift();
		if (next) next();
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function scanForUpgrades(
	targets: SelectedTarget[],
	onStatus: (msg: string, progress?: ProgressInfo) => void,
	signal?: AbortSignal,
): Promise<PlaylistScanResult[]> {
	const results: PlaylistScanResult[] = [];

	for (const target of targets) {
		if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
		onStatus(`Fetching "${target.title}"...`);
		const items = target.type === "favorites"
			? await fetchFavoriteTracks(signal)
			: await fetchPlaylistItems(target.uuid, signal);

		if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
		onStatus(`Scanning ${items.length} tracks from "${target.title}" for alternatives...`);

		const indexed: IndexedTrack[] = items.map((item, index) => ({ index, track: item }));
		const existingIds = new Set(indexed.map((it) => it.track.item.id));
		const groups: DuplicateGroupResult[] = [];
		const sem = new Semaphore(3);
		let completed = 0;

		const scanOne = async (it: IndexedTrack) => {
			if (signal?.aborted) return;
			await sem.acquire();
			try {
				if (signal?.aborted) return;

				const allAlternatives: { track: TrackItem; isFromLuna: boolean }[] = [];
				const excludeIds = new Set<number>(existingIds);
				const originalId = it.track.item.id;
				const dbg = `[upgrade:${originalId} "${it.track.item.title}"]`;

				// First pass: Luna's MediaItem.max() (ISRC-based, accurate quality ranking)
				const lunaMax = await findMaxViaLuna(originalId);
				if (lunaMax !== undefined) {
					const dominated = lunaMax.item.id === originalId;
					const skipped = !dominated && shouldSkipUpgrade(target.uuid, originalId, lunaMax.item.id, existingIds);
					const inPlaylist = existingIds.has(lunaMax.item.id);
					console.log(`${dbg} Luna max → ${lunaMax.item.id} "${lunaMax.item.title}" v="${lunaMax.item.version ?? ""}" q=${lunaMax.item.audioQuality} (sameId=${dominated}, skipped=${skipped}, inPlaylist=${inPlaylist})`);
					if (!dominated && !skipped) {
						allAlternatives.push({ track: lunaMax, isFromLuna: true });
						excludeIds.add(lunaMax.item.id);
					}
				} else {
					console.log(`${dbg} Luna max → undefined`);
				}

				// Small pause between API calls to spread load
				if (!signal?.aborted) await delay(100);

				// Second pass: direct ISRC lookup — finds all versions of same recording on Tidal
				if (!signal?.aborted && it.track.item.isrc) {
					const isrcResults = await isrcLookupAll(it.track.item.isrc);
					console.log(`${dbg} ISRC "${it.track.item.isrc}" → ${isrcResults.length} version(s)`);
					// Log a few samples to diagnose filtering
					for (const r of isrcResults.slice(0, 3)) {
						console.log(`${dbg} ISRC sample: ${r.id} "${r.title}" v="${r.version ?? ""}" q=${r.audioQuality} album="${r.album?.title ?? "?"}" remastered=${isTrackRemastered(r)}`);
					}
					// Check specifically for the known remaster
					const known = isrcResults.find((r) => r.id === 68633325);
					if (known) {
						console.log(`${dbg} ISRC has 68633325: "${known.title}" v="${known.version ?? ""}" q=${known.audioQuality} album="${known.album?.title ?? "?"}" remastered=${isTrackRemastered(known)} isBetter=${isBetter(it.track.item, known)}`);
					}
					for (const r of isrcResults) {
						if (r.id === originalId || excludeIds.has(r.id)) continue;
						if (isBetter(it.track.item, r) && !shouldSkipUpgrade(target.uuid, originalId, r.id, existingIds)) {
							console.log(`${dbg} ISRC match: ${r.id} "${r.title}" v="${r.version ?? ""}" q=${r.audioQuality}`);
							allAlternatives.push({ track: toTrackItem(r), isFromLuna: false });
							excludeIds.add(r.id);
						}
					}
				}

				if (!signal?.aborted) await delay(100);

				// Third pass: title/artist search (finds different-ISRC alternatives, remasters from other albums)
				if (!signal?.aborted) {
					const searchResults = await findAlternativesViaSearch(it.track.item, excludeIds, signal);
					console.log(`${dbg} search → ${searchResults.length} candidate(s)`, searchResults.map((r) => `${r.id} "${r.title}" v="${r.version ?? ""}" q=${r.audioQuality}`));
					for (const r of searchResults) {
						if (!shouldSkipUpgrade(target.uuid, originalId, r.id, existingIds)) {
							allAlternatives.push({ track: toTrackItem(r), isFromLuna: false });
						} else {
							console.log(`${dbg} search candidate ${r.id} skipped by cache`);
						}
					}
				}

				if (allAlternatives.length > 0) {
					// Convert all to TidalSearchResult for consistent ranking
					const asSearchResults: TidalSearchResult[] = allAlternatives.map((a) => ({
						id: a.track.item.id,
						title: a.track.item.title,
						version: a.track.item.version,
						duration: a.track.item.duration,
						isrc: a.track.item.isrc,
						artists: a.track.item.artists,
						album: a.track.item.album,
						audioQuality: a.track.item.audioQuality,
						streamStartDate: a.track.item.streamStartDate,
					}));
					const ranked = rankAlternatives(asSearchResults);
					const choices: TrackChoice[] = [
						{ index: it.index, track: it, keep: false },
						...ranked.map((alt, i) => ({
							index: -1,
							track: { index: -1, track: toTrackItem(alt) } as IndexedTrack,
							keep: i === 0,
							isAlternative: true,
						})),
					];
					groups.push({ choices });
				}
			} finally {
				sem.release();
				completed++;
				if (completed % 10 === 0 || completed === indexed.length) {
					onStatus(`Scanning "${target.title}": ${completed}/${indexed.length} tracks checked...`, { current: completed, total: indexed.length });
				}
			}
		};

		await Promise.all(indexed.map((it) => scanOne(it)));

		if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");

		// Sort groups by original playlist position
		groups.sort((a, b) => a.choices[0].index - b.choices[0].index);

		if (groups.length > 0) {
			const allChoices: TrackChoice[] = [];
			for (const g of groups) {
				for (const c of g.choices) allChoices.push(c);
			}

			let infoDone = 0;
			const infoSem = new Semaphore(3);
			await Promise.all(allChoices.map(async (choice) => {
				await infoSem.acquire();
				try {
					if (signal?.aborted) return;
					const t = choice.track.track.item;
					choice.streamInfo = await fetchStreamInfo(t.id, t.audioQuality ?? "LOSSLESS");
				} catch {
					choice.streamInfo = null;
				} finally {
					infoSem.release();
					infoDone++;
					if (infoDone % 20 === 0 || infoDone === allChoices.length) {
						onStatus(`Fetching stream quality: ${infoDone}/${allChoices.length}...`, { current: infoDone, total: allChoices.length });
					}
				}
			}));

			// Filter out alternatives with no visible improvement (removes Luna false positives)
			const filteredGroups: DuplicateGroupResult[] = [];
			for (const g of groups) {
				const current = g.choices.find((c) => !c.isAlternative);
				if (!current) continue;
				const validChoices = g.choices.filter((c) => {
					if (!c.isAlternative) return true;
					const visible = hasVisibleImprovement(current, c);
					if (!visible) {
						const alt = c.track.track.item;
						console.log(`[upgrade:${current.track.track.item.id}] filtered out alt ${alt.id} "${alt.title}" v="${alt.version ?? ""}" — no visible improvement`);
					}
					return visible;
				});
				if (validChoices.some((c) => c.isAlternative)) {
					filteredGroups.push({ choices: validChoices });
				}
			}

			if (filteredGroups.length > 0) {
				onStatus(`Found ${filteredGroups.length} alternative(s) in "${target.title}"`);
				results.push({ target, groups: filteredGroups, indexed });
			} else {
				onStatus(`No alternatives found in "${target.title}"`);
			}
		} else {
			onStatus(`No alternatives found in "${target.title}"`);
		}
	}

	return results;
}
