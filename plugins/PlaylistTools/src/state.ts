const STORAGE_PREFIX = "dedupPlaylist:";

export type KeepStrategy = "best-quality" | "oldest" | "newest";

export let byId = localStorage.getItem(`${STORAGE_PREFIX}byId`) === "true";
export let byIsrc = localStorage.getItem(`${STORAGE_PREFIX}byIsrc`) === "true";
export let byName = localStorage.getItem(`${STORAGE_PREFIX}byName`) !== "false";
export let byRemaster = localStorage.getItem(`${STORAGE_PREFIX}byRemaster`) === "true";
export let keepStrategy: KeepStrategy = (localStorage.getItem(`${STORAGE_PREFIX}keepStrategy`) as KeepStrategy) ?? "best-quality";

export function setById(enabled: boolean): void {
	byId = enabled;
	localStorage.setItem(`${STORAGE_PREFIX}byId`, String(enabled));
}

export function setByIsrc(enabled: boolean): void {
	byIsrc = enabled;
	localStorage.setItem(`${STORAGE_PREFIX}byIsrc`, String(enabled));
}

export function setByName(enabled: boolean): void {
	byName = enabled;
	localStorage.setItem(`${STORAGE_PREFIX}byName`, String(enabled));
}

export function setByRemaster(enabled: boolean): void {
	byRemaster = enabled;
	localStorage.setItem(`${STORAGE_PREFIX}byRemaster`, String(enabled));
}

export function setKeepStrategy(strategy: KeepStrategy): void {
	keepStrategy = strategy;
	localStorage.setItem(`${STORAGE_PREFIX}keepStrategy`, strategy);
}

export type ScanMode = "dedup" | "upgrade";

export let scanMode: ScanMode = (localStorage.getItem(`${STORAGE_PREFIX}scanMode`) as ScanMode) ?? "dedup";

export function setScanMode(mode: ScanMode): void {
	scanMode = mode;
	localStorage.setItem(`${STORAGE_PREFIX}scanMode`, mode);
}

export function getActiveStrategies(): string[] {
	const strategies: string[] = [];
	if (byId) strategies.push("id");
	if (byIsrc) strategies.push("isrc");
	if (byName) strategies.push("name");
	if (byRemaster) strategies.push("remaster");
	return strategies;
}

// --- Upgrade decisions cache (per playlist) ---
// Two states per alternative:
//   dismissed: user kept original, explicitly rejected this alternative → never suggest again
//   accepted:  user applied this replacement → skip while in playlist, re-suggest if removed

const CACHE_PREFIX = `${STORAGE_PREFIX}upgradeCache:`;

interface PlaylistCache {
	dismissed: Record<string, number[]>; // originalTrackId → [dismissed alt IDs]
	accepted: Record<string, number[]>;  // originalTrackId → [accepted alt IDs]
}

function loadCache(playlistUuid: string): PlaylistCache {
	try {
		const raw = localStorage.getItem(`${CACHE_PREFIX}${playlistUuid}`);
		if (!raw) return { dismissed: {}, accepted: {} };
		const obj = JSON.parse(raw) as Partial<PlaylistCache>;
		return { dismissed: obj.dismissed ?? {}, accepted: obj.accepted ?? {} };
	} catch {
		return { dismissed: {}, accepted: {} };
	}
}

function saveCache(playlistUuid: string, cache: PlaylistCache): void {
	const hasEntries = Object.keys(cache.dismissed).length > 0 || Object.keys(cache.accepted).length > 0;
	if (!hasEntries) {
		localStorage.removeItem(`${CACHE_PREFIX}${playlistUuid}`);
	} else {
		localStorage.setItem(`${CACHE_PREFIX}${playlistUuid}`, JSON.stringify(cache));
	}
}

/**
 * Check if an alternative should be skipped.
 * - dismissed → always skip
 * - accepted → skip only if the alternative is still in the playlist (existingIds)
 */
export function shouldSkipUpgrade(playlistUuid: string, originalId: number, alternativeId: number, existingIds: Set<number>): boolean {
	const cache = loadCache(playlistUuid);
	const key = String(originalId);

	if (cache.dismissed[key]?.includes(alternativeId)) return true;
	if (cache.accepted[key]?.includes(alternativeId) && existingIds.has(alternativeId)) return true;

	return false;
}

export function saveUpgradeDecisions(
	playlistUuid: string,
	dismissed: Map<number, number[]>,
	accepted: Map<number, number[]>,
): void {
	const cache = loadCache(playlistUuid);

	for (const [originalId, altIds] of dismissed) {
		const key = String(originalId);
		const existing = new Set(cache.dismissed[key] ?? []);
		for (const id of altIds) existing.add(id);
		cache.dismissed[key] = [...existing];
	}

	for (const [originalId, altIds] of accepted) {
		const key = String(originalId);
		const existing = new Set(cache.accepted[key] ?? []);
		for (const id of altIds) existing.add(id);
		cache.accepted[key] = [...existing];
	}

	saveCache(playlistUuid, cache);
}

export function clearCacheForPlaylist(playlistUuid: string): void {
	localStorage.removeItem(`${CACHE_PREFIX}${playlistUuid}`);
}

export function getCacheCountForPlaylist(playlistUuid: string): number {
	const cache = loadCache(playlistUuid);
	let count = 0;
	for (const v of Object.values(cache.dismissed)) count += v.length;
	for (const v of Object.values(cache.accepted)) count += v.length;
	return count;
}
