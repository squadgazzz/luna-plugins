import type { LunaUnload } from "@luna/core";
import { observePromise, redux, TidalApi } from "@luna/lib";
import { RateLimitTracker, fetchWithRetry } from "../../../lib/retry";
import { tidalQueryArgs } from "../../../lib/tidalQuery";

import { removeFromPlaylistCache } from "./playlistCache";

const CONFIRM_MODAL_SELECTOR = '[data-test="confirm-modal"]';
const BUTTON_WRAPPER_SELECTOR = 'div[class*="_modalButtonWrapper"]';
const REMOVE_BUTTON_CLASS = "playlist-indicator-remove-btn";

const rateLimit = new RateLimitTracker("PlaylistIndicator");

async function fetchPlaylistItemsFresh(playlistUUID: redux.ItemId) {
	const headers = await TidalApi.getAuthHeaders();
	const queryArgs = tidalQueryArgs();
	const res = await fetchWithRetry(`https://desktop.tidal.com/v1/playlists/${playlistUUID}/items?${queryArgs}&limit=-1`, { headers }, rateLimit.retryOptionsLimited);
	if (!res.ok) return undefined;
	return res.json() as Promise<{ items: redux.MediaItem[]; totalNumberOfItems: number }>;
}

async function removeTracksFromPlaylist(playlistUUID: redux.ItemId, removeIndices: number[]): Promise<boolean> {
	const headers = await TidalApi.getAuthHeaders();
	const queryArgs = tidalQueryArgs();

	// Fetch playlist to get its ETag (required for write operations)
	const playlistRes = await fetchWithRetry(`https://desktop.tidal.com/v1/playlists/${playlistUUID}?${queryArgs}`, { headers }, rateLimit.retryOptionsLimited);
	if (!playlistRes.ok) return false;

	const etag = playlistRes.headers.get("etag");
	if (etag === null) return false;

	// Delete items by index via the Tidal API
	const indices = removeIndices.join(",");
	const deleteRes = await fetchWithRetry(`https://desktop.tidal.com/v1/playlists/${playlistUUID}/items/${indices}?${queryArgs}`, {
		method: "DELETE",
		headers: {
			...headers,
			"If-None-Match": etag,
		},
	}, rateLimit.retryOptionsLimited);

	return deleteRes.ok;
}

export function setupDuplicateModalHandler(unloads: Set<LunaUnload>): void {
	redux.intercept("modal/SHOW_CONFIRM", unloads, async (payload) => {
		if (payload.mode !== "addMediaItemsToPlaylist") return;

		const playlistUUID = payload.value;
		const trackIds = payload.additionalValues?.mediaItemIdsToAdd;
		if (trackIds === undefined || trackIds.length === 0) return;

		const modal = await observePromise<HTMLElement>(unloads, CONFIRM_MODAL_SELECTOR, 2000);
		if (modal === null) return;

		const buttonWrapper = modal.querySelector<HTMLElement>(BUTTON_WRAPPER_SELECTOR);
		if (buttonWrapper === null) return;

		// Get CSS classes from existing button for consistent styling
		const templateButton = buttonWrapper.querySelector<HTMLButtonElement>("button:last-of-type");
		if (templateButton === null) return;
		const baseClasses = templateButton.className;

		// Create button from scratch to avoid React event delegation leaking from cloneNode
		const removeButton = document.createElement("button");
		removeButton.textContent = "Remove from Playlist";
		removeButton.className = baseClasses + " " + REMOVE_BUTTON_CLASS;
		removeButton.type = "button";

		removeButton.addEventListener("click", async (e) => {
			e.stopPropagation();
			e.stopImmediatePropagation();
			e.preventDefault();

			removeButton.disabled = true;
			removeButton.textContent = "Removing…";

			try {
				// Fetch playlist items fresh (bypass TidalApi memoization) to find ALL occurrences
				const result = await fetchPlaylistItemsFresh(playlistUUID);
				if (result === undefined) return;

				const removeIndices: number[] = [];
				const trackIdSet = new Set(trackIds.map(String));
				for (let i = 0; i < result.items.length; i++) {
					if (trackIdSet.has(String(result.items[i].item.id))) {
						removeIndices.push(i);
					}
				}

				if (removeIndices.length === 0) return;

				const success = await removeTracksFromPlaylist(playlistUUID, removeIndices);
				if (success) {
					removeFromPlaylistCache(String(playlistUUID), trackIds);

					// Update Redux store so the UI reflects the removal without a reload
					redux.actions["content/REMOVE_MEDIA_ITEMS_FROM_PLAYLIST_SUCCESS"]({
						currentDirection: "ASC",
						currentOrder: "INDEX",
						playlistUUID,
						removeIndices,
					});
				}
			} finally {
				redux.actions["modal/CLOSE"]();
			}
		});

		buttonWrapper.appendChild(removeButton);
	});
}
