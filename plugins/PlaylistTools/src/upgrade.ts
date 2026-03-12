import { MediaItem } from "@luna/lib";

import type { IndexedTrack, TrackItem } from "./detection";
import { isRemastered, stripRemasterTags } from "./detection";
import type { DuplicateGroupResult, PlaylistScanResult, ProgressInfo, SelectedTarget, TrackChoice } from "./dedup";
import {
	fetchFavoriteTracks,
	fetchPlaylistItems,
	fetchStreamInfo,
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
	const query = `${simplify(track.title)} ${track.artists[0]?.name ?? ""}`;
	const searchResults = await searchTracks(query, signal);
	const candidates: TidalSearchResult[] = [];
	for (const r of searchResults) {
		if (!excludeIds.has(r.id) && isSameSong(track, r) && isBetter(track, r)) {
			candidates.push(r);
		}
	}
	// Same-tier bit depth/sample rate is handled by Luna's MediaItem.max() in the first pass
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
		const groups: DuplicateGroupResult[] = [];
		const sem = new Semaphore(10);
		let completed = 0;

		const scanOne = async (it: IndexedTrack) => {
			if (signal?.aborted) return;
			await sem.acquire();
			try {
				if (signal?.aborted) return;

				const allAlternatives: { track: TrackItem; isFromLuna: boolean }[] = [];
				const excludeIds = new Set<number>([it.track.item.id]);

				// First pass: Luna's MediaItem.max() (ISRC-based, accurate quality ranking)
				const lunaMax = await findMaxViaLuna(it.track.item.id);
				if (lunaMax !== undefined && lunaMax.item.id !== it.track.item.id) {
					allAlternatives.push({ track: lunaMax, isFromLuna: true });
					excludeIds.add(lunaMax.item.id);
				}

				// Second pass: title/artist search (finds remasters, reissues, different ISRCs)
				if (!signal?.aborted) {
					const searchResults = await findAlternativesViaSearch(it.track.item, excludeIds, signal);
					for (const r of searchResults) {
						allAlternatives.push({ track: toTrackItem(r), isFromLuna: false });
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
					onStatus(`Scanning "${target.title}": ${completed}/${indexed.length} tracks checked, ${groups.length} alternatives found...`, { current: completed, total: indexed.length });
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
			const infoSem = new Semaphore(10);
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
				const validChoices = g.choices.filter((c) => !c.isAlternative || hasVisibleImprovement(current, c));
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
