import type { LunaUnload } from "@luna/core";
import { redux } from "@luna/lib";

import { filterTrackIds } from "./filterMatch";
import { getCurrentFilterText, hasActiveFilter } from "./filterState";

// Re-entrancy guard: we dispatch ADD_ALREADY_LOADED_ITEMS_TO_QUEUE ourselves,
// so we must skip our own intercept to avoid infinite loops.
let isInternalDispatch = false;

export function setupQueueIntercepts(unloads: Set<LunaUnload>): void {
	// Intercept: playing from a playlist tracklist (most common path)
	redux.intercept("playQueue/ADD_TRACK_LIST_TO_PLAY_QUEUE", unloads, (payload) => {
		if (payload.position !== "now") return;
		if (!hasActiveFilter()) return;
		// Let through — the subsequent ADD_ALREADY_LOADED_ITEMS_TO_QUEUE handles filtering.
	});

	// Intercept: lazy-loaded lists fetching first page
	redux.intercept("playQueue/FETCH_FIRST_PAGE_AND_ADD_TO_QUEUE", unloads, (payload) => {
		if (payload.position !== "now") return;
		if (!hasActiveFilter()) return;
	});

	// Intercept: already-loaded items being added to queue.
	// Block Tidal's action and replace it with our filtered version in a single dispatch.
	// This avoids double queue updates that cause 412 errors with Tidal Connect.
	redux.intercept("playQueue/ADD_ALREADY_LOADED_ITEMS_TO_QUEUE", unloads, (payload) => {
		if (isInternalDispatch) return; // let our own dispatches through
		if (payload.position !== "now") return;
		if (!hasActiveFilter()) return;

		const filterText = getCurrentFilterText();
		const state = redux.store.getState();

		const filteredIds = filterTrackIds(payload.items, filterText, state);
		if (filteredIds.length === 0) return;

		// The clicked track is items[fromIndex] (Tidal resolves it before this action).
		const clickedTrackId = payload.items[payload.fromIndex ?? 0];

		// Find the clicked track in our filtered list and rotate so it plays first
		let startIdx = 0;
		if (clickedTrackId !== undefined) {
			for (let i = 0; i < filteredIds.length; i++) {
				if (filteredIds[i] == clickedTrackId) {
					startIdx = i;
					break;
				}
			}
		}
		const rotated = startIdx > 0
			? [...filteredIds.slice(startIdx), ...filteredIds.slice(0, startIdx)]
			: filteredIds;

		// Block Tidal's action and dispatch our filtered version instead
		isInternalDispatch = true;
		redux.actions["playQueue/ADD_ALREADY_LOADED_ITEMS_TO_QUEUE"]({
			context: payload.context,
			items: rotated,
			fromIndex: 0,
			position: "now",
			forceShuffle: payload.forceShuffle,
		});
		isInternalDispatch = false;

		return "block";
	});
}
