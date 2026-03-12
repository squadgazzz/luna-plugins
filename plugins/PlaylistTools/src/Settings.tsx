import React, { useEffect, useRef, useState } from "react";
import { LunaSettings, LunaSwitchSetting } from "@luna/ui";

import { executeRemovals, executeUpgrades, scanForDuplicates, type PlaylistScanResult, type ProgressInfo, type SelectedTarget } from "./dedup";
import { ResultsModal } from "./ResultsModal";
import {
	byId as initById,
	byIsrc as initByIsrc,
	byName as initByName,
	byRemaster as initByRemaster,
	clearCacheForPlaylist,
	getCacheCountForPlaylist,
	keepStrategy as initKeepStrategy,
	scanMode as initScanMode,
	saveUpgradeDecisions,
	setById,
	setByIsrc,
	setByName,
	setByRemaster,
	setKeepStrategy,
	setScanMode,
	type KeepStrategy,
	type ScanMode,
} from "./state";
import { fetchFavoritesCount, fetchUserPlaylists, type PlaylistInfo } from "./tidalApi";
import { scanForUpgrades } from "./upgrade";

const FAVORITES_UUID = "__favorites__";

export const Settings = () => {
	const [running, setRunning] = useState(false);
	const [status, setStatus] = useState("");
	const [playlists, setPlaylists] = useState<PlaylistInfo[]>([]);
	const [favCount, setFavCount] = useState<number | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [loading, setLoading] = useState(true);
	const [scanResults, setScanResults] = useState<PlaylistScanResult[] | null>(null);
	const [currentKeep, setCurrentKeep] = useState<KeepStrategy>(initKeepStrategy);
	const abortRef = useRef<AbortController | null>(null);
	const [currentScanMode, setCurrentScanMode] = useState<ScanMode>(initScanMode);
	const [progress, setProgress] = useState<ProgressInfo | null>(null);
	const [dismissedVersion, setDismissedVersion] = useState(0);

	const selectScanMode = (mode: ScanMode) => {
		setScanMode(mode);
		setCurrentScanMode(mode);
	};

	const refreshPlaylists = () => {
		Promise.all([fetchUserPlaylists(), fetchFavoritesCount()])
			.then(([pl, fc]) => {
				setPlaylists(pl);
				setFavCount(fc);
				setLoading(false);
			})
			.catch(() => setLoading(false));
	};

	useEffect(() => {
		refreshPlaylists();
	}, []);

	const selectKeep = (strategy: KeepStrategy) => {
		setKeepStrategy(strategy);
		setCurrentKeep(strategy);
	};

	const toggleSelected = (uuid: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(uuid)) next.delete(uuid);
			else next.add(uuid);
			return next;
		});
	};

	const toggleAll = () => {
		const allUuids = [FAVORITES_UUID, ...playlists.map((p) => p.uuid)];
		if (selected.size === allUuids.length) {
			setSelected(new Set());
		} else {
			setSelected(new Set(allUuids));
		}
	};

	const handleScan = async () => {
		const targets: SelectedTarget[] = [];
		if (selected.has(FAVORITES_UUID)) {
			targets.push({ type: "favorites", uuid: FAVORITES_UUID, title: "Favorites" });
		}
		for (const pl of playlists) {
			if (selected.has(pl.uuid)) {
				targets.push({ type: "playlist", uuid: pl.uuid, title: pl.title });
			}
		}

		const controller = new AbortController();
		abortRef.current = controller;
		setRunning(true);
		setStatus("Scanning...");
		setProgress(null);
		try {
			const onStatus = (msg: string, p?: ProgressInfo) => { setStatus(msg); setProgress(p ?? null); };
			const results = currentScanMode === "dedup"
				? await scanForDuplicates(targets, onStatus, controller.signal)
				: await scanForUpgrades(targets, onStatus, controller.signal);
			refreshPlaylists();
			if (results.length === 0) {
				setStatus(currentScanMode === "dedup" ? "No duplicates found." : "No alternatives found.");
			} else {
				setScanResults(results);
				setStatus("");
			}
		} catch (err) {
			if (err instanceof DOMException && err.name === "AbortError") {
				setStatus("Cancelled.");
			} else {
				setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
			}
		} finally {
			setRunning(false);
			setProgress(null);
			abortRef.current = null;
		}
	};

	const handleConfirm = async (results: PlaylistScanResult[]) => {
		// Save upgrade decisions per playlist:
		// - User kept original + unchecked alternatives → dismissed (never suggest again)
		// - User replaced original + checked alternatives → accepted (skip while in playlist, re-suggest if removed)
		if (currentScanMode === "upgrade") {
			for (const r of results) {
				const dismissed = new Map<number, number[]>();
				const accepted = new Map<number, number[]>();
				for (const g of r.groups) {
					const current = g.choices.find((c) => !c.isAlternative);
					if (!current) continue;
					const originalId = current.track.track.item.id;

					if (current.keep) {
						const ids = g.choices.filter((c) => c.isAlternative && !c.keep).map((c) => c.track.track.item.id);
						if (ids.length > 0) dismissed.set(originalId, ids);
					} else {
						const ids = g.choices.filter((c) => c.isAlternative && c.keep).map((c) => c.track.track.item.id);
						if (ids.length > 0) accepted.set(originalId, ids);
					}
				}
				if (dismissed.size > 0 || accepted.size > 0) {
					saveUpgradeDecisions(r.target.uuid, dismissed, accepted);
				}
			}
			setDismissedVersion((v) => v + 1);
		}

		setScanResults(null);
		const controller = new AbortController();
		abortRef.current = controller;
		setRunning(true);
		setStatus(currentScanMode === "dedup" ? "Removing..." : "Replacing...");
		setProgress(null);
		try {
			const onStatus = (msg: string, p?: ProgressInfo) => { setStatus(msg); setProgress(p ?? null); };
			const result = currentScanMode === "dedup"
				? await executeRemovals(results, onStatus, controller.signal)
				: await executeUpgrades(results, onStatus, controller.signal);
			setStatus(result);
			refreshPlaylists();
		} catch (err) {
			if (err instanceof DOMException && err.name === "AbortError") {
				setStatus("Cancelled.");
			} else {
				setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
			}
		} finally {
			setRunning(false);
			setProgress(null);
			abortRef.current = null;
		}
	};

	const handleCancel = () => {
		abortRef.current?.abort();
	};

	const allUuids = [FAVORITES_UUID, ...playlists.map((p) => p.uuid)];
	const allSelected = allUuids.length > 0 && selected.size === allUuids.length;

	return (
		<>
			<LunaSettings>
				<div style={{ padding: "12px 0" }}>
					<div style={{ fontSize: "14px", fontWeight: 500, color: "#fff", marginBottom: "8px" }}>Mode</div>
					<RadioOption
						name="scanMode"
						label="Deduplicate"
						desc="Find and remove duplicate tracks"
						checked={currentScanMode === "dedup"}
						onChange={() => selectScanMode("dedup")}
					/>
					<RadioOption
						name="scanMode"
						label="Find remastered & Hi-Res versions"
						desc="Find higher resolution versions, remasters, and reissues"
						checked={currentScanMode === "upgrade"}
						onChange={() => selectScanMode("upgrade")}
					/>
					{currentScanMode === "upgrade" && (
						<div style={{ fontSize: "11px", color: "rgba(255,200,100,0.7)", padding: "4px 0 2px 26px", lineHeight: "1.4" }}>
							Note: Higher bitrate/sample rate doesn't always mean better sound. Remasters may have lower dynamic range than originals. Review alternatives before applying.
						</div>
					)}
				</div>

				{currentScanMode === "dedup" && (
					<>
						<LunaSwitchSetting
							title="Detect by ID"
							desc="Find tracks with the same Tidal track ID"
							defaultChecked={initById}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => setById(e.target.checked)}
						/>
						<LunaSwitchSetting
							title="Detect by ISRC"
							desc="Find tracks with the same ISRC code (with artist verification)"
							defaultChecked={initByIsrc}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => setByIsrc(e.target.checked)}
						/>
						<LunaSwitchSetting
							title="Detect by name"
							desc="Find tracks with the same name, artist, and similar duration"
							defaultChecked={initByName}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => setByName(e.target.checked)}
						/>
						<LunaSwitchSetting
							title="Detect remasters"
							desc="Find remastered versions of the same track (e.g. 'Angel' vs 'Angel (Remastered 2015)')"
							defaultChecked={initByRemaster}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => setByRemaster(e.target.checked)}
						/>

						<div style={{ padding: "12px 0" }}>
							<div style={{ fontSize: "14px", fontWeight: 500, color: "#fff", marginBottom: "8px" }}>Keep strategy</div>
							<RadioOption
								name="keepStrategy"
								label="Best quality"
								desc="Keep the highest quality version"
								checked={currentKeep === "best-quality"}
								onChange={() => selectKeep("best-quality")}
							/>
							<RadioOption
								name="keepStrategy"
								label="Oldest"
								desc="Keep the first occurrence in the playlist"
								checked={currentKeep === "oldest"}
								onChange={() => selectKeep("oldest")}
							/>
							<RadioOption
								name="keepStrategy"
								label="Newest"
								desc="Keep the last occurrence in the playlist"
								checked={currentKeep === "newest"}
								onChange={() => selectKeep("newest")}
							/>
						</div>
					</>
				)}

				<div style={{ padding: "16px 0" }}>
					<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
						<span style={{ fontSize: "14px", fontWeight: 500, color: "#fff" }}>Playlists</span>
						<label style={{ fontSize: "12px", color: "rgba(255,255,255,0.6)", cursor: "pointer", userSelect: "none" }}>
							<input
								type="checkbox"
								checked={allSelected}
								onChange={toggleAll}
								style={{ marginRight: "4px", verticalAlign: "middle" }}
							/>
							Select all
						</label>
					</div>

					<div
						style={{
							maxHeight: "240px",
							overflowY: "auto",
							border: "1px solid rgba(255,255,255,0.1)",
							borderRadius: "4px",
							background: "rgba(0,0,0,0.2)",
						}}
					>
						{loading ? (
							<div style={{ padding: "12px", fontSize: "13px", color: "rgba(255,255,255,0.5)" }}>Loading playlists...</div>
						) : (
							<>
								<PlaylistRow
									uuid={FAVORITES_UUID}
									title="Favorites"
									trackCount={favCount}
									checked={selected.has(FAVORITES_UUID)}
									onToggle={toggleSelected}
									cacheCount={currentScanMode === "upgrade" ? getCacheCountForPlaylist(FAVORITES_UUID) : 0}
									onClearCache={() => { clearCacheForPlaylist(FAVORITES_UUID); setDismissedVersion((v) => v + 1); }}
									cacheVersion={dismissedVersion}
								/>
								{playlists.map((pl) => (
									<PlaylistRow
										key={pl.uuid}
										uuid={pl.uuid}
										title={pl.title}
										trackCount={pl.numberOfTracks}
										checked={selected.has(pl.uuid)}
										onToggle={toggleSelected}
										cacheCount={currentScanMode === "upgrade" ? getCacheCountForPlaylist(pl.uuid) : 0}
										onClearCache={() => { clearCacheForPlaylist(pl.uuid); setDismissedVersion((v) => v + 1); }}
										cacheVersion={dismissedVersion}
									/>
								))}
							</>
						)}
					</div>
				</div>

				<div style={{ padding: "0 0 16px" }}>
					<div style={{ display: "flex", gap: "8px" }}>
						<button
							onClick={handleScan}
							disabled={running || selected.size === 0}
							style={{
								flex: 1,
								padding: "10px 16px",
								background: running || selected.size === 0 ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.15)",
								border: "1px solid rgba(255,255,255,0.2)",
								borderRadius: "4px",
								color: "#fff",
								cursor: running || selected.size === 0 ? "not-allowed" : "pointer",
								fontSize: "14px",
								fontWeight: 500,
							}}
						>
							{!running
								? currentScanMode === "dedup"
									? `Scan for duplicates (${selected.size} selected)`
									: `Find remastered & Hi-Res (${selected.size} selected)`
								: status}
						</button>
						{running && (
							<button
								onClick={handleCancel}
								style={{
									padding: "10px 20px",
									borderRadius: "4px",
									border: "1px solid rgba(255,100,100,0.4)",
									background: "transparent",
									color: "rgba(255,100,100,0.8)",
									cursor: "pointer",
									fontSize: "14px",
									fontWeight: 500,
									flexShrink: 0,
								}}
							>
								Cancel
							</button>
						)}
					</div>
					{running && progress && (
						<div style={{ marginTop: "8px" }}>
							<div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", color: "rgba(255,255,255,0.5)", marginBottom: "4px" }}>
								<span>{progress.current}/{progress.total}</span>
								<span>{Math.round((progress.current / progress.total) * 100)}%</span>
							</div>
							<div style={{ height: "4px", borderRadius: "2px", background: "rgba(255,255,255,0.1)", overflow: "hidden" }}>
								<div style={{
									height: "100%",
									borderRadius: "2px",
									background: "rgba(80,200,120,0.7)",
									width: `${(progress.current / progress.total) * 100}%`,
									transition: "width 0.2s ease",
								}} />
							</div>
						</div>
					)}
					{!running && status && (
						<div style={{ marginTop: "8px", fontSize: "12px", color: "rgba(255,255,255,0.6)" }}>{status}</div>
					)}
				</div>
			</LunaSettings>

			{scanResults !== null && (
				<ResultsModal results={scanResults} mode={currentScanMode} onConfirm={handleConfirm} onCancel={() => setScanResults(null)} />
			)}
		</>
	);
};

const RadioOption = ({
	name,
	label,
	desc,
	checked,
	onChange,
}: {
	name: string;
	label: string;
	desc: string;
	checked: boolean;
	onChange: () => void;
}) => (
	<label
		style={{
			display: "flex",
			alignItems: "center",
			padding: "6px 0",
			cursor: "pointer",
			userSelect: "none",
		}}
	>
		<input
			type="radio"
			name={name}
			checked={checked}
			onChange={onChange}
			style={{ marginRight: "10px", flexShrink: 0 }}
		/>
		<div>
			<div style={{ fontSize: "13px", color: "#fff" }}>{label}</div>
			<div style={{ fontSize: "11px", color: "rgba(255,255,255,0.5)" }}>{desc}</div>
		</div>
	</label>
);

const PlaylistRow = ({
	uuid,
	title,
	trackCount,
	checked,
	onToggle,
	cacheCount,
	onClearCache,
	cacheVersion: _cacheVersion,
}: {
	uuid: string;
	title: string;
	trackCount: number | null;
	checked: boolean;
	onToggle: (uuid: string) => void;
	cacheCount: number;
	onClearCache: () => void;
	cacheVersion: number;
}) => (
	<div
		style={{
			display: "flex",
			alignItems: "center",
			padding: "8px 12px",
			borderBottom: "1px solid rgba(255,255,255,0.05)",
			background: checked ? "rgba(255,255,255,0.05)" : "transparent",
		}}
	>
		<label
			style={{
				display: "flex",
				alignItems: "center",
				cursor: "pointer",
				userSelect: "none",
				flex: 1,
				minWidth: 0,
			}}
		>
			<input
				type="checkbox"
				checked={checked}
				onChange={() => onToggle(uuid)}
				style={{ marginRight: "10px", flexShrink: 0 }}
			/>
			<span style={{ fontSize: "13px", color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
				{title}
			</span>
		</label>
		{cacheCount > 0 && (
			<button
				onClick={(e) => { e.stopPropagation(); onClearCache(); }}
				title={`Clear ${cacheCount} cached decision(s)`}
				style={{
					fontSize: "10px",
					color: "rgba(255,255,255,0.4)",
					background: "transparent",
					border: "1px solid rgba(255,255,255,0.12)",
					borderRadius: "3px",
					padding: "1px 5px",
					cursor: "pointer",
					marginLeft: "6px",
					flexShrink: 0,
					whiteSpace: "nowrap",
				}}
			>
				{cacheCount} cached
			</button>
		)}
		{trackCount !== null && (
			<span style={{ fontSize: "11px", color: "rgba(255,255,255,0.4)", marginLeft: "8px", flexShrink: 0 }}>
				{trackCount} tracks
			</span>
		)}
	</div>
);
