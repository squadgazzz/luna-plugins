import React, { useEffect, useRef, useState } from "react";
import { LunaSettings, LunaSwitchSetting } from "@luna/ui";

import {
	clientId as initClientId,
	setClientId,
	syncFavorites as initSyncFavorites,
	setSyncFavorites,
	syncMode as initSyncMode,
	setSyncMode,
	skipSimilar as initSkipSimilar,
	setSkipSimilar,
	preserveFavOrder as initPreserveFavOrder,
	setPreserveFavOrder,
	isLoggedIn,
	clearAuth,
	hasSyncMemory,
	clearSyncMemoryFor,
	saveSimilarDecisions,
	getSimilarDecisions,
} from "./state";
import type { SimilarDecision } from "./state";
import { startAuthFlow } from "./spotifyAuth";
import { unloads as pluginUnloads } from "./state";
import { getPlaylists, getMe, type SpotifyPlaylist } from "./spotifyApi";
import { fetchUserPlaylists, type TidalPlaylist } from "./tidalApi";
import { prepareAll, executeAll, type SyncPrepResult, type SyncPlaylistResult, type ProgressInfo } from "./sync";
import { SyncModal, type ModalPhase } from "./SyncModal";

export const Settings = () => {
	const [loggedIn, setLoggedIn] = useState(isLoggedIn());
	const [userName, setUserName] = useState("");
	const [clientIdInput, setClientIdInput] = useState(initClientId);
	const [playlists, setPlaylists] = useState<SpotifyPlaylist[]>([]);
	const [tidalPlaylists, setTidalPlaylists] = useState<TidalPlaylist[]>([]);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const [doSyncFavorites, setDoSyncFavorites] = useState(initSyncFavorites);
	const [mode, setMode] = useState<"auto" | "manual">(initSyncMode);
	const [doSkipSimilar, setDoSkipSimilar] = useState(initSkipSimilar);
	const [memoryVersion, setMemoryVersion] = useState(0);
	const bumpMemory = () => setMemoryVersion((v) => v + 1);

	// Auth flow state
	const [awaitingCallback, setAwaitingCallback] = useState(false);
	const authCancelRef = useRef<(() => void) | null>(null);

	// Sync state
	const [syncing, setSyncing] = useState(false);
	const [showModal, setShowModal] = useState(false);
	const [modalPhase, setModalPhase] = useState<ModalPhase>("progress");
	const [progressMessage, setProgressMessage] = useState("");
	const [progressInfo, setProgressInfo] = useState<ProgressInfo | undefined>(undefined);
	const [prepResults, setPrepResults] = useState<SyncPrepResult[]>([]);
	const [results, setResults] = useState<SyncPlaylistResult[]>([]);
	const [uriCopied, setUriCopied] = useState(false);
	const abortRef = useRef<AbortController | null>(null);

	useEffect(() => {
		if (!loggedIn) return;
		setLoading(true);
		Promise.all([getMe(), getPlaylists(), fetchUserPlaylists()])
			.then(([me, spotifyPl, tidalPl]) => {
				setUserName(me.display_name);
				setPlaylists(spotifyPl);
				setTidalPlaylists(tidalPl);
				setLoading(false);
			})
			.catch((err) => {
				setError(err instanceof Error ? err.message : String(err));
				setLoading(false);
			});
	}, [loggedIn]);

	const handleLogin = async () => {
		if (!clientIdInput.trim()) {
			setError("Please enter a Spotify Client ID");
			return;
		}
		setError("");
		setClientId(clientIdInput.trim());
		setAwaitingCallback(true);
		try {
			const { promise, cancel } = startAuthFlow(pluginUnloads);
			authCancelRef.current = cancel;
			await promise;
			setAwaitingCallback(false);
			setLoggedIn(true);
		} catch (err) {
			setAwaitingCallback(false);
			if (err instanceof Error && err.message === "Auth flow cancelled") return;
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			authCancelRef.current = null;
		}
	};

	const handleDisconnect = () => {
		authCancelRef.current?.();
		clearAuth();
		setLoggedIn(false);
		setUserName("");
		setPlaylists([]);
		setTidalPlaylists([]);
		setSelected(new Set());
		setError("");
		setAwaitingCallback(false);
	};

	const togglePlaylist = (id: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const selectAll = () => {
		if (selected.size === playlists.length) {
			setSelected(new Set());
		} else {
			setSelected(new Set(playlists.map((p) => p.id)));
		}
	};

	const updateProgress = (message: string, progress?: ProgressInfo) => {
		setProgressMessage(message);
		setProgressInfo(progress);
	};

	const handleSync = async () => {
		const selectedPlaylists = playlists.filter((p) => selected.has(p.id));
		const abort = new AbortController();
		abortRef.current = abort;
		setSyncing(true);
		setShowModal(true);
		setModalPhase("progress");
		setProgressMessage("");
		setProgressInfo(undefined);
		setPrepResults([]);
		setResults([]);

		try {
			// Phase 1: Prepare (match all tracks)
			const preps = await prepareAll(
				selectedPlaylists,
				doSyncFavorites,
				updateProgress,
				() => {},
				abort.signal,
			);
			setPrepResults(preps);

			if (abort.signal.aborted) return;

			if (mode === "manual") {
				// Show confirmation UI
				setModalPhase("confirm");
				setSyncing(false);
				return;
			}

			// Auto mode: optionally filter out tracks with similar existing versions
			const filteredPreps = doSkipSimilar
				? preps.map((prep) => ({
						...prep,
						tracksToAdd: prep.tracksToAdd.filter((t) => !t.similarExisting || t.similarExisting.length === 0),
					}))
				: preps;
			updateProgress("Adding tracks...");
			await executeAll(
				filteredPreps,
				updateProgress,
				(r) => setResults((prev) => [...prev, r]),
				abort.signal,
			);
			saveDecisionsFromPreps(preps, filteredPreps);
			setModalPhase("complete");
		} catch (err) {
			if (!(err instanceof DOMException && err.name === "AbortError")) {
				updateProgress(`Error: ${err instanceof Error ? err.message : String(err)}`);
			}
		} finally {
			setSyncing(false);
			abortRef.current = null;
		}
	};

	const handleConfirm = async (filteredPreps: SyncPrepResult[]) => {
		const abort = new AbortController();
		abortRef.current = abort;
		setSyncing(true);
		setModalPhase("progress");
		updateProgress("Adding tracks...");
		setResults([]);

		try {
			await executeAll(
				filteredPreps,
				updateProgress,
				(r) => setResults((prev) => [...prev, r]),
				abort.signal,
			);
			saveDecisionsFromPreps(prepResults, filteredPreps);
			setModalPhase("complete");
		} catch (err) {
			if (!(err instanceof DOMException && err.name === "AbortError")) {
				updateProgress(`Error: ${err instanceof Error ? err.message : String(err)}`);
			}
		} finally {
			setSyncing(false);
			abortRef.current = null;
		}
	};

	const handleCancel = () => {
		abortRef.current?.abort();
		setShowModal(false);
		setSyncing(false);
	};

	const saveDecisionsFromPreps = (originalPreps: SyncPrepResult[], executedPreps: SyncPrepResult[]) => {
		for (const original of originalPreps) {
			const executed = executedPreps.find((p) => p.spotifyPlaylistId === original.spotifyPlaylistId);
			const executedIds = new Set(executed?.tracksToAdd.map((t) => t.tidalId) ?? []);
			const decisions = getSimilarDecisions(original.spotifyPlaylistId);
			let changed = false;

			for (const track of original.tracksToAdd) {
				if (!track.similarExisting || track.similarExisting.length === 0) continue;
				if (!track.spotifyTrackId) continue;
				const decision: SimilarDecision = executedIds.has(track.tidalId) ? "add-new" : "keep-existing";
				decisions[track.spotifyTrackId] = decision;
				changed = true;
			}

			if (changed) {
				saveSimilarDecisions(original.spotifyPlaylistId, decisions);
			}
		}
	};

	const tidalNames = new Set(tidalPlaylists.map((p) => p.title));

	const inputStyle = {
		width: "100%",
		padding: "8px 12px",
		borderRadius: "4px",
		border: "1px solid rgba(255,255,255,0.2)",
		background: "rgba(0,0,0,0.3)",
		color: "#fff",
		fontSize: "13px",
		boxSizing: "border-box" as const,
	};

	return (
		<>
			<LunaSettings>
				{/* Spotify Connection section */}
				<div style={{ padding: "12px 0" }}>
					<h3 style={{ margin: "0 0 8px", color: "rgba(255,255,255,0.9)", fontSize: "14px" }}>Spotify Connection</h3>

					{!loggedIn ? (
						<>
							{!awaitingCallback ? (
								<>
									<div style={{ marginBottom: "8px" }}>
										<label style={{ color: "rgba(255,255,255,0.6)", fontSize: "13px", display: "block", marginBottom: "4px" }}>
											Client ID (from{" "}
											<a
												href="https://developer.spotify.com/dashboard"
												target="_blank"
												rel="noopener noreferrer"
												style={{ color: "#1db954", textDecoration: "underline" }}
											>
												Spotify Developer Dashboard
											</a>
											)
										</label>
										<div style={{ color: "rgba(255,255,255,0.4)", fontSize: "12px", marginBottom: "6px" }}>
											Add{" "}
											<code style={{ background: "rgba(255,255,255,0.1)", padding: "1px 4px", borderRadius: "2px" }}>
												tidaLuna://spotify-callback
											</code>
											<button
												onClick={() => {
													const ta = document.createElement("textarea");
													ta.value = "tidaLuna://spotify-callback";
													ta.style.position = "fixed";
													ta.style.opacity = "0";
													document.body.appendChild(ta);
													ta.select();
													document.execCommand("copy");
													document.body.removeChild(ta);
													setUriCopied(true);
													setTimeout(() => setUriCopied(false), 1500);
												}}
												title="Copy to clipboard"
												style={{
													marginLeft: "4px",
													padding: "1px 4px",
													background: "none",
													border: "none",
													color: uriCopied ? "rgba(29,185,84,0.8)" : "rgba(255,255,255,0.5)",
													cursor: "pointer",
													verticalAlign: "middle",
												}}
											>
												{uriCopied ? (
													<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
														<path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
													</svg>
												) : (
													<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
														<path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25z" />
														<path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25z" />
													</svg>
												)}
											</button>{" "}
											as a Redirect URI in your app settings
										</div>
										<input
											type="text"
											value={clientIdInput}
											onChange={(e) => setClientIdInput(e.target.value)}
											placeholder="Enter your Spotify Client ID"
											style={inputStyle}
										/>
									</div>
									<button
										onClick={handleLogin}
										style={{
											padding: "8px 20px",
											borderRadius: "4px",
											border: "none",
											background: "#1db954",
											color: "#fff",
											cursor: "pointer",
											fontSize: "14px",
										}}
									>
										Login to Spotify
									</button>
								</>
							) : (
								<div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
									<span style={{ color: "rgba(255,255,255,0.6)", fontSize: "13px" }}>
										Waiting for Spotify authorization...
									</span>
									<button
										onClick={() => {
											authCancelRef.current?.();
											setAwaitingCallback(false);
											setError("");
										}}
										style={{
											padding: "4px 12px",
											borderRadius: "4px",
											border: "1px solid rgba(255,255,255,0.2)",
											background: "transparent",
											color: "rgba(255,255,255,0.6)",
											cursor: "pointer",
											fontSize: "12px",
										}}
									>
										Cancel
									</button>
								</div>
							)}
						</>
					) : (
						<div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
							<span style={{ color: "rgba(255,255,255,0.7)", fontSize: "13px" }}>
								Connected as <strong style={{ color: "#1db954" }}>{userName}</strong>
							</span>
							<button
								onClick={handleDisconnect}
								style={{
									padding: "4px 12px",
									borderRadius: "4px",
									border: "1px solid rgba(255,255,255,0.2)",
									background: "transparent",
									color: "rgba(255,255,255,0.6)",
									cursor: "pointer",
									fontSize: "12px",
								}}
							>
								Disconnect
							</button>
						</div>
					)}

					{error && <p style={{ color: "#ff6b6b", fontSize: "13px", margin: "8px 0 0" }}>{error}</p>}
				</div>

				{/* After login: settings and playlist list */}
				{loggedIn && !loading && (
					<>
						<LunaSwitchSetting
							title="Sync favorites"
							desc="Sync Spotify liked songs to Tidal favorites"
							defaultChecked={initSyncFavorites}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
								setSyncFavorites(e.target.checked);
								setDoSyncFavorites(e.target.checked);
							}}
						/>
						{hasSyncMemory("favorites") && (
							<div style={{ padding: "0 0 4px 0" }}>
								<button
									onClick={() => {
										clearSyncMemoryFor("favorites");
										bumpMemory();
									}}
									style={{
										padding: "2px 8px",
										borderRadius: "3px",
										border: "1px solid rgba(255,255,255,0.15)",
										background: "transparent",
										color: "rgba(255,255,255,0.5)",
										cursor: "pointer",
										fontSize: "11px",
									}}
								>
									Clear favorites memory
								</button>
							</div>
						)}

						<LunaSwitchSetting
							title="Manual mode"
							desc="Review and confirm tracks before adding"
							defaultChecked={initSyncMode === "manual"}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
								const newMode = e.target.checked ? "manual" : "auto";
								setSyncMode(newMode);
								setMode(newMode);
							}}
						/>

						<LunaSwitchSetting
							title="Skip similar versions"
							desc="Skip tracks when a similar version (e.g. remaster) already exists"
							defaultChecked={initSkipSimilar}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
								setSkipSimilar(e.target.checked);
								setDoSkipSimilar(e.target.checked);
							}}
						/>

						<LunaSwitchSetting
							title="Preserve favorites order"
							desc="Add favorites sequentially to preserve Spotify's order (slower)"
							defaultChecked={initPreserveFavOrder}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
								setPreserveFavOrder(e.target.checked);
							}}
						/>

						{/* Playlist list with checkboxes */}
						<div style={{ padding: "12px 0" }}>
							<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
								<h3 style={{ margin: 0, color: "rgba(255,255,255,0.9)", fontSize: "14px" }}>Playlists</h3>
								<button
									onClick={selectAll}
									style={{
										padding: "2px 8px",
										borderRadius: "3px",
										border: "1px solid rgba(255,255,255,0.2)",
										background: "transparent",
										color: "rgba(255,255,255,0.6)",
										cursor: "pointer",
										fontSize: "12px",
									}}
								>
									{selected.size === playlists.length ? "Deselect all" : "Select all"}
								</button>
							</div>
							<div style={{ maxHeight: "300px", overflowY: "auto", borderRadius: "4px", border: "1px solid rgba(255,255,255,0.1)" }}>
								{playlists.map((p) => (
									<label
										key={p.id}
										style={{
											display: "flex",
											alignItems: "center",
											padding: "8px 12px",
											cursor: "pointer",
											borderBottom: "1px solid rgba(255,255,255,0.05)",
											background: selected.has(p.id) ? "rgba(29,185,84,0.1)" : "transparent",
										}}
									>
										<input
											type="checkbox"
											checked={selected.has(p.id)}
											onChange={() => togglePlaylist(p.id)}
											style={{ marginRight: "10px" }}
										/>
										<span style={{ flex: 1, color: "rgba(255,255,255,0.85)", fontSize: "13px" }}>{p.name}</span>
										<span style={{ color: "rgba(255,255,255,0.4)", fontSize: "12px", marginRight: "8px" }}>
											{p.tracks.total} tracks
										</span>
										<span
											style={{
												padding: "1px 6px",
												borderRadius: "3px",
												fontSize: "11px",
												background: tidalNames.has(p.name) ? "rgba(100,200,255,0.15)" : "rgba(29,185,84,0.15)",
												color: tidalNames.has(p.name) ? "rgba(100,200,255,0.8)" : "rgba(29,185,84,0.8)",
											}}
										>
											{tidalNames.has(p.name) ? "Update" : "New"}
										</span>
										{hasSyncMemory(p.id) && (
											<button
												onClick={(e) => {
													e.preventDefault();
													e.stopPropagation();
													clearSyncMemoryFor(p.id);
													bumpMemory();
												}}
												style={{
													padding: "1px 6px",
													borderRadius: "3px",
													border: "1px solid rgba(255,255,255,0.15)",
													background: "transparent",
													color: "rgba(255,255,255,0.45)",
													cursor: "pointer",
													fontSize: "11px",
													marginLeft: "4px",
												}}
											>
												Clear memory
											</button>
										)}
									</label>
								))}
							</div>
						</div>

						{/* Sync button */}
						<div style={{ padding: "12px 0" }}>
							<button
								onClick={handleSync}
								disabled={syncing || (selected.size === 0 && !doSyncFavorites)}
								style={{
									width: "100%",
									padding: "10px",
									borderRadius: "4px",
									border: "none",
									background: syncing || (selected.size === 0 && !doSyncFavorites) ? "rgba(255,255,255,0.1)" : "#1db954",
									color: "#fff",
									cursor: syncing || (selected.size === 0 && !doSyncFavorites) ? "not-allowed" : "pointer",
									fontSize: "14px",
									fontWeight: "bold",
								}}
							>
								{syncing
									? "Syncing..."
									: selected.size > 0
										? `Sync ${selected.size} playlist(s)${doSyncFavorites ? " + favorites" : ""}`
										: "Sync favorites"}
							</button>
						</div>
					</>
				)}

				{loading && (
					<p style={{ color: "rgba(255,255,255,0.5)", fontSize: "13px", padding: "12px 0" }}>Loading playlists...</p>
				)}
			</LunaSettings>

			{showModal && (
				<SyncModal
					phase={modalPhase}
					progressMessage={progressMessage}
					progressInfo={progressInfo}
					prepResults={prepResults}
					results={results}
					onConfirm={handleConfirm}
					onClose={() => setShowModal(false)}
					onCancel={handleCancel}
				/>
			)}
		</>
	);
};
