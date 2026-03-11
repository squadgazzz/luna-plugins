import type { LunaUnload } from "@luna/core";
import { redux } from "@luna/lib";

import { filterTrackIds } from "./filterMatch";
import { getCurrentFilterText, hasActiveFilter } from "./filterState";

let isInternalDispatch = false;

/**
 * Get all items from a trackList, trying the specific sort order first,
 * then falling back to defaultSort.
 */
function getTrackListItems(
	trackList: any,
	order?: string,
	orderDirection?: string,
): (string | number)[] {
	if (order && orderDirection) {
		const sortKey = `${order}_${orderDirection}`;
		const sorted = trackList.sorted?.[sortKey];
		if (sorted?.items?.length > 0) return sorted.items;
	}
	return trackList.sorted?.defaultSort?.items ?? [];
}

/**
 * Filter items, rotate so clicked track is first, and dispatch.
 * Returns true if handled (caller should block).
 */
function dispatchFilteredPlayNow(
	allItems: (string | number)[],
	fromIndex: number | undefined,
	context: unknown,
	forceShuffle: boolean | undefined,
): boolean {
	const filterText = getCurrentFilterText();
	const state = redux.store.getState();

	const filteredIds = filterTrackIds(allItems, filterText, state);
	if (filteredIds.length === 0) return false;

	const clickedId = fromIndex !== undefined ? allItems[fromIndex] : undefined;
	let startIdx = 0;
	if (clickedId !== undefined) {
		for (let i = 0; i < filteredIds.length; i++) {
			if (filteredIds[i] == clickedId) {
				startIdx = i;
				break;
			}
		}
	}

	const rotated = startIdx > 0
		? [...filteredIds.slice(startIdx), ...filteredIds.slice(0, startIdx)]
		: filteredIds;

	isInternalDispatch = true;
	redux.actions["playQueue/ADD_ALREADY_LOADED_ITEMS_TO_QUEUE"]({
		context,
		items: rotated,
		fromIndex: 0,
		position: "now",
		forceShuffle,
	});
	isInternalDispatch = false;
	return true;
}

export function setupQueueIntercepts(unloads: Set<LunaUnload>): void {
	// Intercept: playing from a tracklist.
	// Looks up the full item list from Redux using the correct sort key.
	redux.intercept("playQueue/ADD_TRACK_LIST_TO_PLAY_QUEUE", unloads, (payload) => {
		if (payload.position !== "now") return;
		if (!hasActiveFilter()) return;

		const state = redux.store.getState();
		const trackList = state.content.trackLists[payload.trackListName];
		if (trackList === undefined) return;

		const allItems = getTrackListItems(trackList, payload.order, payload.orderDirection);
		if (allItems.length === 0) return;

		if (!dispatchFilteredPlayNow(allItems, payload.fromIndex, payload.context, payload.forceShuffle)) return;

		// Preserve "Playing from" UI label
		if (payload.entityType !== undefined || payload.sourceTitle !== undefined) {
			redux.actions["playQueue/SET_SOURCE_PROPERTIES"]({
				name: payload.sourceTitle ?? "",
				trackListName: payload.trackListName,
				dataApiPath: payload.dataApiPath,
				entityId: payload.entityId,
				entityItemsType: payload.entityItemsType,
				entityType: payload.entityType,
			});
		}

		return true;
	});

	// Intercept: lazy-loaded lists fetching first page
	redux.intercept("playQueue/FETCH_FIRST_PAGE_AND_ADD_TO_QUEUE", unloads, (payload) => {
		if (payload.position !== "now") return;
		if (!hasActiveFilter()) return;

		const state = redux.store.getState();
		const trackList = state.content.trackLists[payload.trackListName];
		if (trackList === undefined) return;

		const allItems = getTrackListItems(trackList, payload.order, payload.orderDirection);
		if (allItems.length === 0) return;

		if (!dispatchFilteredPlayNow(allItems, payload.fromIndex, payload.context, payload.forceShuffle)) return;

		return true;
	});

	// Intercept: already-loaded items being added to queue.
	// Fallback for cases where the trackList isn't in Redux, and
	// filters lazy-loaded pages (scroll) that arrive after initial play.
	redux.intercept("playQueue/ADD_ALREADY_LOADED_ITEMS_TO_QUEUE", unloads, (payload) => {
		if (isInternalDispatch) return;
		if (!hasActiveFilter()) return;

		const filterText = getCurrentFilterText();
		const state = redux.store.getState();
		const filteredIds = filterTrackIds(payload.items, filterText, state);
		if (filteredIds.length === 0) {
			if (payload.position !== "now") return true; // block empty lazy-load pages
			return;
		}

		if (payload.position === "now") {
			// Fallback path: rotate so clicked track is first
			const clickedTrackId = payload.items[payload.fromIndex ?? 0];
			let startIdx = 0;
			if (clickedTrackId !== undefined) {
				for (let i = 0; i < filteredIds.length; i++) {
					if (filteredIds[i] == clickedTrackId) { startIdx = i; break; }
				}
			}
			const rotated = startIdx > 0
				? [...filteredIds.slice(startIdx), ...filteredIds.slice(0, startIdx)]
				: filteredIds;

			isInternalDispatch = true;
			redux.actions["playQueue/ADD_ALREADY_LOADED_ITEMS_TO_QUEUE"]({
				context: payload.context,
				items: rotated,
				fromIndex: 0,
				position: "now",
				forceShuffle: payload.forceShuffle,
			});
			isInternalDispatch = false;
		} else {
			// Lazy-loaded page: filter items, keep same position
			isInternalDispatch = true;
			redux.actions["playQueue/ADD_ALREADY_LOADED_ITEMS_TO_QUEUE"]({
				...payload,
				items: filteredIds,
			});
			isInternalDispatch = false;
		}

		return true;
	});
}
