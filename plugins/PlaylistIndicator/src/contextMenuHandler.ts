import type { LunaUnload } from "@luna/core";
import { observe, redux } from "@luna/lib";

import { addToPlaylistCache, getPlaylistTrackIds } from "./playlistCache";

let currentTrackId: redux.ItemId | null = null;

// Match both context menu rows (div) and "Show all playlists" modal rows (button)
const PLAYLIST_ROW_SELECTOR = '[data-track--playlist-uuid][data-tracktype--playlist-uuid="string"]';
const INDICATOR_CLASS = "playlist-indicator-check";

function injectIndicator(row: Element): void {
	if (row.querySelector(`.${INDICATOR_CLASS}`) !== null) return;

	const indicator = document.createElement("span");
	indicator.className = INDICATOR_CLASS;
	indicator.textContent = "✓";

	// Context menu layout: text is in span._actionTextInner
	const textSpan = row.querySelector<HTMLSpanElement>('span[class*="_actionTextInner"]');
	if (textSpan !== null) {
		textSpan.appendChild(indicator);
		return;
	}

	// "Show all playlists" modal layout: text is in div._lineHeader / div._cell-header
	const headerDiv = row.querySelector<HTMLDivElement>('div[class*="_lineHeader"], div[class*="_cell-header"]');
	if (headerDiv !== null) {
		headerDiv.appendChild(indicator);
		return;
	}
}

export function setupContextMenuHandler(unloads: Set<LunaUnload>): void {
	// Capture target track ID when "Add to playlist" menu opens (via "+" button)
	redux.intercept("contextMenu/OPEN", unloads, (payload) => {
		if (payload.type === "ADD_TO") {
			currentTrackId = payload.id;
		}
	});

	// Capture target track ID from the three-dots context menu
	redux.intercept("contextMenu/OPEN_MEDIA_ITEM", unloads, (payload) => {
		currentTrackId = payload.id;
	});

	// Don't clear track ID on contextMenu/CLOSE — the "Show all playlists" modal
	// opens after the context menu closes, and still needs the track ID.
	// It gets overwritten on the next OPEN/OPEN_MEDIA_ITEM instead.

	// Observe playlist rows as they appear in the DOM (context menu + modal)
	observe<HTMLElement>(unloads, PLAYLIST_ROW_SELECTOR, async (row) => {
		const trackId = currentTrackId;
		if (trackId === null) return;

		const uuid = row.getAttribute("data-track--playlist-uuid");
		if (uuid === null) return;

		const trackIds = await getPlaylistTrackIds(uuid);
		// Verify context hasn't changed while we were fetching
		if (currentTrackId !== trackId) return;
		if (trackIds.has(trackId)) {
			injectIndicator(row);
		}
	});

	// Optimistically update cache when a track is added to a playlist
	redux.intercept("content/ADD_MEDIA_ITEMS_TO_PLAYLIST_SUCCESS", unloads, (payload) => {
		addToPlaylistCache(String(payload.playlistUUID), payload.mediaItemIdsToAdd);
	});
}
