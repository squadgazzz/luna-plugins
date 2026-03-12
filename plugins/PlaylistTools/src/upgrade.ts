import type { IndexedTrack, TrackItem } from "./detection";
import { isRemastered, stripRemasterTags } from "./detection";
import type { DuplicateGroupResult, PlaylistScanResult, ProgressInfo, SelectedTarget, TrackChoice } from "./dedup";
import { shouldSkipUpgrade } from "./state";
import {
	fetchFavoriteTracks,
	fetchPlaylistItems,
	fetchStreamInfo,
	getRateLimitHits,
	resetRateLimitHits,
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

	const currentName = normalize(simplify(stripRemasterTags(current.title)));
	const candidateName = normalize(simplify(stripRemasterTags(candidate.title)));
	const nameMatch = currentName === candidateName || currentName.includes(candidateName) || candidateName.includes(currentName);
	if (!nameMatch) return false;

	// Remasters can differ by up to ~15s due to mastering changes; use relaxed tolerance
	const eitherRemaster = isTrackRemastered(candidate) || isTrackRemastered(current);
	const tolerance = eitherRemaster ? 15 : 2;
	if (!durationMatch(current.duration, candidate.duration, tolerance)) return false;

	return true;
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

/** Search by title/artist for remasters, higher quality versions, and alternatives. */
async function findAlternativesViaSearch(
	track: TrackItem["item"],
	excludeIds: Set<number>,
	signal?: AbortSignal,
): Promise<TidalSearchResult[]> {
	const artist = track.artists[0]?.name ?? "";
	const simplified = simplify(track.title);

	const filterCandidates = (results: TidalSearchResult[], seenIds: Set<number>): TidalSearchResult[] => {
		const candidates: TidalSearchResult[] = [];
		for (const r of results) {
			if (excludeIds.has(r.id)) continue;
			if (seenIds.has(r.id)) continue;
			const same = isSameSong(track, r);
			const better = same && isBetter(track, r);
			if (same && better) {
				candidates.push(r);
				seenIds.add(r.id);
			}
		}
		return candidates;
	};

	const seenIds = new Set<number>();

	// Regular search
	const query = `${simplified} ${artist}`;
	const searchResults = await searchTracks(query, signal);
	const candidates = filterCandidates(searchResults, seenIds);

	// If no candidates, try a remaster-specific search
	if (candidates.length === 0 && !signal?.aborted) {
		const remasterQuery = `${simplified} remaster ${artist}`;
		const remasterResults = await searchTracks(remasterQuery, signal);
		const remasterCandidates = filterCandidates(remasterResults, seenIds);
		for (const c of remasterCandidates) candidates.push(c);
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


export async function scanForUpgrades(
	targets: SelectedTarget[],
	onStatus: (msg: string, progress?: ProgressInfo) => void,
	signal?: AbortSignal,
): Promise<PlaylistScanResult[]> {
	const results: PlaylistScanResult[] = [];
	resetRateLimitHits();

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
				// Stagger requests to avoid bursts
				await new Promise((r) => setTimeout(r, 100));

				const excludeIds = new Set<number>(existingIds);
				const originalId = it.track.item.id;

				// Search by title/artist to find remasters, higher quality, and alternatives
				const searchResults = await findAlternativesViaSearch(it.track.item, excludeIds, signal);
				const alternatives: TidalSearchResult[] = [];
				for (const r of searchResults) {
					if (!shouldSkipUpgrade(target.uuid, originalId, r.id, existingIds)) {
						alternatives.push(r);
					}
				}

				if (alternatives.length > 0) {
					const ranked = rankAlternatives(alternatives);
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
						console.debug(`[upgrade:${current.track.track.item.id}] filtered out alt ${alt.id} "${alt.title}" v="${alt.version ?? ""}" — no visible improvement`);
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

	const hits = getRateLimitHits();
	if (hits > 0) console.log(`[upgrade] Scan complete. Rate limited ${hits} time(s).`);
	else console.log(`[upgrade] Scan complete. No rate limiting encountered.`);

	return results;
}
