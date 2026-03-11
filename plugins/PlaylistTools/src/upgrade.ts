import type { IndexedTrack, TrackItem } from "./detection";
import { isRemastered, stripRemasterTags } from "./detection";
import type { DuplicateGroupResult, PlaylistScanResult, ProgressInfo, SelectedTarget, TrackChoice } from "./dedup";
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

function isBetter(current: TrackItem["item"], candidate: TidalSearchResult): boolean {
	const currentQuality = QUALITY_RANK[current.audioQuality ?? ""] ?? -1;
	const candidateQuality = QUALITY_RANK[candidate.audioQuality ?? ""] ?? -1;

	if (candidateQuality > currentQuality) return true;

	const currentRemastered = isRemastered(current.title, current.version);
	const candidateRemastered = isRemastered(candidate.title, candidate.version);
	if (candidateRemastered && !currentRemastered) return true;

	if (candidateQuality === currentQuality) {
		const currentDate = current.album?.releaseDate;
		const candidateDate = candidate.album?.releaseDate;
		if (currentDate && candidateDate && candidateDate > currentDate) return true;
	}

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
		},
	};
}

function rankAlternatives(alternatives: TidalSearchResult[]): TidalSearchResult[] {
	return [...alternatives].sort((a, b) => {
		const qualA = QUALITY_RANK[a.audioQuality ?? ""] ?? -1;
		const qualB = QUALITY_RANK[b.audioQuality ?? ""] ?? -1;
		if (qualB !== qualA) return qualB - qualA;

		const remA = isRemastered(a.title, a.version) ? 1 : 0;
		const remB = isRemastered(b.title, b.version) ? 1 : 0;
		if (remB !== remA) return remB - remA;

		const dateA = a.album?.releaseDate ?? "";
		const dateB = b.album?.releaseDate ?? "";
		if (dateB !== dateA) return dateB > dateA ? 1 : -1;

		return 0;
	});
}

async function findAlternatives(
	track: TrackItem["item"],
	signal?: AbortSignal,
): Promise<TidalSearchResult[]> {
	const candidates: TidalSearchResult[] = [];
	const seenIds = new Set<number>();
	seenIds.add(track.id);

	if (track.isrc) {
		const isrcResults = await isrcLookupAll(track.isrc);
		for (const r of isrcResults) {
			if (!seenIds.has(r.id)) {
				seenIds.add(r.id);
				candidates.push(r);
			}
		}
	}

	if (signal?.aborted) return [];

	const query = `${simplify(track.title)} ${track.artists[0]?.name ?? ""}`;
	const searchResults = await searchTracks(query, signal);
	for (const r of searchResults) {
		if (!seenIds.has(r.id) && isSameSong(track, r)) {
			seenIds.add(r.id);
			candidates.push(r);
		}
	}

	// First pass: candidates clearly better by quality tier, remaster, or release date
	const better = candidates.filter((c) => isBetter(track, c));
	const betterIds = new Set(better.map((c) => c.id));

	// Second pass: same quality tier — compare stream info (bit depth, sample rate)
	const currentQuality = QUALITY_RANK[track.audioQuality ?? ""] ?? -1;
	const sameTier = candidates.filter((c) => {
		if (betterIds.has(c.id)) return false;
		const q = QUALITY_RANK[c.audioQuality ?? ""] ?? -1;
		return q === currentQuality && q >= 0;
	});

	if (sameTier.length > 0) {
		const currentStream = await fetchStreamInfo(track.id, track.audioQuality ?? "LOSSLESS");
		if (currentStream && currentStream.bitDepth > 0) {
			for (const c of sameTier) {
				if (signal?.aborted) return [];
				const cStream = await fetchStreamInfo(c.id, c.audioQuality ?? "LOSSLESS");
				if (cStream && (
					cStream.bitDepth > currentStream.bitDepth ||
					(cStream.bitDepth === currentStream.bitDepth && cStream.sampleRate > currentStream.sampleRate)
				)) {
					better.push(c);
				}
			}
		}
	}

	return better;
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
				const alternatives = await findAlternatives(it.track.item, signal);
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

			onStatus(`Found ${groups.length} alternative(s) in "${target.title}"`);
			results.push({ target, groups, indexed });
		} else {
			onStatus(`No alternatives found in "${target.title}"`);
		}
	}

	return results;
}
