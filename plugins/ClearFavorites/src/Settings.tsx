import React, { useRef, useState } from "react";
import { redux, TidalApi } from "@luna/lib";
import { Semaphore, fetchWithRetry } from "../../../lib/retry";

const CONFIRM_TEXT = "DELETE ALL";

let rateLimitHits = 0;
const retryOptions = { tag: "ClearFavorites", onRateLimit: () => { rateLimitHits++; } };

function getUserId(): number | null {
	const state = redux.store.getState();
	return state.session?.userId ?? null;
}

async function fetchFavoriteTrackIds(signal: AbortSignal): Promise<number[]> {
	const userId = getUserId();
	if (userId === null) throw new Error("Not logged in");

	const headers = await TidalApi.getAuthHeaders();
	const queryArgs = TidalApi.queryArgs();
	const ids: number[] = [];
	let offset = 0;
	const limit = 9999;
	let total = Infinity;

	while (offset < total) {
		if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
		const res = await fetchWithRetry(
			`https://api.tidal.com/v1/users/${userId}/favorites/tracks?${queryArgs}&limit=${limit}&offset=${offset}&order=DATE&orderDirection=ASC`,
			{ headers, signal },
			retryOptions,
		);
		if (!res.ok) throw new Error(`Failed to fetch favorites: ${res.status}`);
		const data = (await res.json()) as { totalNumberOfItems?: number; items: { item: { id: number } }[] };
		if (data.totalNumberOfItems !== undefined) total = data.totalNumberOfItems;
		const page = data.items ?? [];
		if (page.length === 0) break;
		for (const entry of page) {
			ids.push(entry.item.id);
		}
		offset += page.length;
	}

	return ids;
}

async function deleteAllFavorites(onProgress: (done: number, total: number) => void, signal: AbortSignal): Promise<number> {
	const userId = getUserId();
	if (userId === null) throw new Error("Not logged in");

	const trackIds = await fetchFavoriteTrackIds(signal);
	if (trackIds.length === 0) return 0;

	const headers = await TidalApi.getAuthHeaders();
	const queryArgs = TidalApi.queryArgs();
	const sem = new Semaphore(3);
	let done = 0;
	rateLimitHits = 0;

	const deleteOne = async (trackId: number) => {
		if (signal.aborted) return;
		await sem.acquire();
		try {
			if (signal.aborted) return;
			const res = await fetchWithRetry(
				`https://api.tidal.com/v1/users/${userId}/favorites/tracks/${trackId}?${queryArgs}`,
				{ method: "DELETE", headers, signal },
				retryOptions,
			);
			if (!res.ok) console.warn(`[ClearFavorites] Failed to delete track ${trackId}: ${res.status}`);
		} finally {
			sem.release();
			done++;
			onProgress(done, trackIds.length);
		}
	};

	await Promise.all(trackIds.map((id) => deleteOne(id)));

	if (rateLimitHits > 0) console.log(`[ClearFavorites] Done. Rate limited ${rateLimitHits} time(s).`);

	return done;
}

export const Settings = () => {
	const [input, setInput] = useState("");
	const [running, setRunning] = useState(false);
	const [status, setStatus] = useState("");
	const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
	const abortRef = useRef<AbortController | null>(null);

	const confirmed = input === CONFIRM_TEXT;

	const handleClear = async () => {
		const controller = new AbortController();
		abortRef.current = controller;
		setRunning(true);
		setStatus("Fetching favorites...");
		setProgress(null);
		try {
			const removed = await deleteAllFavorites((done, total) => {
				setStatus(`Deleting: ${done}/${total}`);
				setProgress({ current: done, total });
			}, controller.signal);
			if (removed > 0) {
				redux.actions["content/LOAD_FAVORITE_TRACKS"]({ reset: true });
				redux.actions["content/LOAD_ALL_FAVORITES"]();
			}
			setStatus(removed > 0 ? `Done. Removed ${removed} tracks. Restart the app to see changes in the UI.` : "No favorites to remove.");
		} catch (err) {
			if (err instanceof DOMException && err.name === "AbortError") {
				setStatus("Cancelled.");
			} else {
				setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
			}
		} finally {
			setRunning(false);
			setProgress(null);
			setInput("");
			abortRef.current = null;
		}
	};

	const handleCancel = () => {
		abortRef.current?.abort();
	};

	return (
		<div style={{ padding: "16px", color: "#fff" }}>
			<div style={{ fontSize: "14px", marginBottom: "12px", color: "rgba(255,255,255,0.7)" }}>
				This will permanently delete <strong>all</strong> tracks from your Tidal favorites. This action cannot be undone.
			</div>
			<div style={{ marginBottom: "12px" }}>
				<label style={{ fontSize: "13px", color: "rgba(255,255,255,0.5)", display: "block", marginBottom: "4px" }}>
					Type <strong>{CONFIRM_TEXT}</strong> to confirm:
				</label>
				<input
					type="text"
					value={input}
					onChange={(e) => setInput(e.target.value)}
					disabled={running}
					placeholder={CONFIRM_TEXT}
					style={{
						width: "200px",
						padding: "6px 10px",
						borderRadius: "4px",
						border: "1px solid rgba(255,255,255,0.2)",
						background: "rgba(255,255,255,0.05)",
						color: "#fff",
						fontSize: "13px",
						outline: "none",
					}}
				/>
			</div>
			<div style={{ display: "flex", gap: "8px" }}>
				<button
					onClick={handleClear}
					disabled={!confirmed || running}
					style={{
						padding: "8px 20px",
						borderRadius: "4px",
						border: "none",
						background: confirmed && !running ? "rgba(255,60,60,0.7)" : "rgba(255,255,255,0.1)",
						color: "#fff",
						cursor: confirmed && !running ? "pointer" : "not-allowed",
						fontSize: "13px",
						fontWeight: 500,
					}}
				>
					{running ? status || "Starting..." : "Clear All Favorites"}
				</button>
				{running && (
					<button
						onClick={handleCancel}
						style={{
							padding: "8px 20px",
							borderRadius: "4px",
							border: "1px solid rgba(255,100,100,0.4)",
							background: "transparent",
							color: "rgba(255,100,100,0.8)",
							cursor: "pointer",
							fontSize: "13px",
							fontWeight: 500,
						}}
					>
						Cancel
					</button>
				)}
			</div>
			{running && progress && (
				<div style={{ marginTop: "10px" }}>
					<div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", color: "rgba(255,255,255,0.5)", marginBottom: "4px" }}>
						<span>{progress.current}/{progress.total}</span>
						<span>{Math.round((progress.current / progress.total) * 100)}%</span>
					</div>
					<div style={{ height: "4px", borderRadius: "2px", background: "rgba(255,255,255,0.1)", overflow: "hidden" }}>
						<div style={{
							height: "100%",
							borderRadius: "2px",
							background: "rgba(255,60,60,0.7)",
							width: `${(progress.current / progress.total) * 100}%`,
							transition: "width 0.2s ease",
						}} />
					</div>
				</div>
			)}
			{!running && status && (
				<div style={{ marginTop: "10px", fontSize: "13px", color: "rgba(255,255,255,0.6)" }}>
					{status}
				</div>
			)}
		</div>
	);
};
