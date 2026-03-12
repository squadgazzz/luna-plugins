import React, { useState } from "react";

import type { PlaylistScanResult, TrackChoice } from "./dedup";
import { fullTitle, isRemastered } from "./detection";
import type { ScanMode } from "./state";

function formatDuration(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return `${m}:${s.toString().padStart(2, "0")}`;
}

function qualityLabel(quality?: string): string {
	switch (quality) {
		case "HI_RES_LOSSLESS":
			return "Hi-Res";
		case "LOSSLESS":
			return "Lossless";
		case "HIGH":
			return "High";
		case "LOW":
			return "Low";
		default:
			return quality ?? "?";
	}
}

const QUALITY_RANK: Record<string, number> = {
	LOW: 0, HIGH: 1, LOSSLESS: 2, HI_RES_LOSSLESS: 3,
};

interface UpgradeReason {
	label: string;
	color: string;
	bg: string;
}

function getUpgradeReasons(current: TrackChoice, alternative: TrackChoice): UpgradeReason[] {
	const reasons: UpgradeReason[] = [];
	const curItem = current.track.track.item;
	const altItem = alternative.track.track.item;

	const curQual = QUALITY_RANK[curItem.audioQuality ?? ""] ?? -1;
	const altQual = QUALITY_RANK[altItem.audioQuality ?? ""] ?? -1;

	if (altQual > curQual) {
		reasons.push({
			label: `${qualityLabel(curItem.audioQuality)} → ${qualityLabel(altItem.audioQuality)}`,
			color: "rgba(80,200,180,0.9)",
			bg: "rgba(80,200,180,0.15)",
		});
	}

	const curStream = current.streamInfo;
	const altStream = alternative.streamInfo;
	if (curStream && altStream && curStream.bitDepth > 0 && altStream.bitDepth > 0) {
		if (altStream.bitDepth > curStream.bitDepth) {
			reasons.push({
				label: `${curStream.bitDepth}bit → ${altStream.bitDepth}bit`,
				color: "rgba(100,160,255,0.9)",
				bg: "rgba(100,160,255,0.15)",
			});
		}
		if (altStream.sampleRate > curStream.sampleRate) {
			reasons.push({
				label: `${(curStream.sampleRate / 1000).toFixed(1)}kHz → ${(altStream.sampleRate / 1000).toFixed(1)}kHz`,
				color: "rgba(100,160,255,0.9)",
				bg: "rgba(100,160,255,0.15)",
			});
		}
	}

	const altIsRemaster = isRemastered(altItem.title, altItem.version) || (altItem.album ? isRemastered(altItem.album.title) : false);
	const curIsRemaster = isRemastered(curItem.title, curItem.version) || (curItem.album ? isRemastered(curItem.album.title) : false);
	if (altIsRemaster && !curIsRemaster) {
		reasons.push({
			label: "Remaster",
			color: "rgba(255,200,100,0.9)",
			bg: "rgba(255,200,100,0.15)",
		});
	}

	return reasons;
}

interface Props {
	results: PlaylistScanResult[];
	mode: ScanMode;
	onConfirm: (results: PlaylistScanResult[]) => void;
	onCancel: () => void;
}

export const ResultsModal = ({ results, mode, onConfirm, onCancel }: Props) => {
	const [state, setState] = useState<PlaylistScanResult[]>(results);

	const toggleTrack = (playlistIdx: number, groupIdx: number, choiceIdx: number) => {
		setState((prev) => {
			const next = prev.map((p, pi) => {
				if (pi !== playlistIdx) return p;
				return {
					...p,
					groups: p.groups.map((g, gi) => {
						if (gi !== groupIdx) return g;
						return {
							...g,
							choices: g.choices.map((c, ci) => {
								if (ci !== choiceIdx) return c;
								return { ...c, keep: !c.keep };
							}),
						};
					}),
				};
			});
			return next;
		});
	};

	const totalRemove = state.reduce(
		(sum, p) => sum + p.groups.reduce((gs, g) => gs + g.choices.filter((c) => !c.keep && !c.isAlternative).length, 0),
		0,
	);
	const totalAdd = mode === "upgrade"
		? state.reduce(
				(sum, p) => sum + p.groups.reduce((gs, g) => gs + g.choices.filter((c) => c.keep && c.isAlternative).length, 0),
				0,
			)
		: 0;

	return (
		<div
			style={{
				position: "fixed",
				inset: 0,
				zIndex: 999999,
				background: "rgba(0,0,0,0.85)",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
			}}
			onClick={onCancel}
		>
			<div
				style={{
					background: "#1a1a2e",
					border: "1px solid rgba(255,255,255,0.15)",
					borderRadius: "8px",
					width: "min(700px, 90vw)",
					maxHeight: "80vh",
					display: "flex",
					flexDirection: "column",
					color: "#fff",
				}}
				onClick={(e) => e.stopPropagation()}
			>
				{/* Header */}
				<div style={{ padding: "16px 20px", borderBottom: "1px solid rgba(255,255,255,0.1)", flexShrink: 0 }}>
					<div style={{ fontSize: "16px", fontWeight: 600 }}>
						{mode === "dedup" ? "Duplicate Tracks Found" : "Higher Resolution Alternatives Found"}
					</div>
					<div style={{ fontSize: "12px", color: "rgba(255,255,255,0.5)", marginTop: "4px" }}>
						{mode === "dedup"
							? "Checked tracks will be kept. Unchecked tracks will be removed."
							: "Checked tracks will be kept or added. Unchecked current tracks will be removed."}
					</div>
				</div>

				{/* Scrollable content */}
				<div style={{ overflowY: "auto", flex: 1, padding: "12px 20px" }}>
					{state.map((playlist, pi) => (
						<div key={pi} style={{ marginBottom: "16px" }}>
							<div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "8px", color: "rgba(255,255,255,0.8)" }}>
								{playlist.target.title}
							</div>
							{playlist.groups.map((group, gi) => (
								<div
									key={gi}
									style={{
										marginBottom: "10px",
										border: "1px solid rgba(255,255,255,0.08)",
										borderRadius: "6px",
										background: "rgba(255,255,255,0.03)",
									}}
								>
									{(() => {
									const currentChoice = group.choices.find((c) => !c.isAlternative);
									return group.choices.map((choice, ci) => {
										const t = choice.track.track.item;
										const artists = t.artists.map((a) => a.name).join(", ");
										const year = (t.album?.releaseDate ?? t.streamStartDate)?.slice(0, 4);
										const reasons = mode === "upgrade" && choice.isAlternative && currentChoice
											? getUpgradeReasons(currentChoice, choice)
											: [];
										return (
											<label
												key={ci}
												style={{
													display: "flex",
													alignItems: "center",
													gap: "10px",
													padding: "8px 12px",
													cursor: "pointer",
													userSelect: "none",
													borderBottom: ci < group.choices.length - 1 ? "1px solid rgba(255,255,255,0.05)" : "none",
													background: choice.keep ? "rgba(80,200,120,0.08)" : "rgba(255,80,80,0.08)",
												}}
											>
												<input
													type="checkbox"
													checked={choice.keep}
													onChange={() => toggleTrack(pi, gi, ci)}
													style={{ flexShrink: 0 }}
												/>
												{mode === "upgrade" && (
													<div style={{ display: "flex", gap: "3px", flexShrink: 0, flexWrap: "wrap" }}>
														<span style={{
															fontSize: "9px",
															fontWeight: 600,
															padding: "1px 5px",
															borderRadius: "3px",
															background: choice.isAlternative ? "rgba(80,200,120,0.2)" : "rgba(255,255,255,0.1)",
															color: choice.isAlternative ? "rgba(80,200,120,0.8)" : "rgba(255,255,255,0.5)",
														}}>
															{choice.isAlternative ? "NEW" : "CURRENT"}
														</span>
														{reasons.map((r, ri) => (
															<span key={ri} style={{
																fontSize: "9px",
																fontWeight: 600,
																padding: "1px 5px",
																borderRadius: "3px",
																background: r.bg,
																color: r.color,
															}}>
																{r.label}
															</span>
														))}
													</div>
												)}
												<div style={{ flex: 1, minWidth: 0 }}>
													<div
														style={{
															fontSize: "13px",
															fontWeight: 500,
															overflow: "hidden",
															textOverflow: "ellipsis",
															whiteSpace: "nowrap",
														}}
													>
														{fullTitle(t)}
													</div>
													<div style={{ fontSize: "11px", color: "rgba(255,255,255,0.5)", marginTop: "2px" }}>
														{artists}
														{t.album && (
															<span style={{ marginLeft: "6px", color: "rgba(255,255,255,0.35)" }}>
																— {t.album.title}{year ? ` (${year})` : ""}
															</span>
														)}
														<span style={{ marginLeft: "6px", color: "rgba(255,255,255,0.25)" }}>
															{!choice.isAlternative && <>#{choice.index + 1} · </>}ID:{t.id}
														</span>
													</div>
												</div>
												<div style={{ flexShrink: 0, textAlign: "right", fontSize: "11px", color: "rgba(255,255,255,0.5)" }}>
													<div>{qualityLabel(t.audioQuality)}</div>
													{choice.streamInfo && choice.streamInfo.bitDepth > 0 && (
														<div>{choice.streamInfo.bitDepth}bit / {(choice.streamInfo.sampleRate / 1000).toFixed(1)}kHz</div>
													)}
													<div>{formatDuration(t.duration)}</div>
												</div>
											</label>
										);
									});
								})()}
								</div>
							))}
						</div>
					))}
				</div>

				{/* Footer */}
				<div
					style={{
						padding: "12px 20px",
						borderTop: "1px solid rgba(255,255,255,0.1)",
						display: "flex",
						justifyContent: "space-between",
						alignItems: "center",
						flexShrink: 0,
					}}
				>
					<span style={{ fontSize: "13px", color: "rgba(255,255,255,0.6)" }}>
						{mode === "dedup"
							? `${totalRemove} track${totalRemove !== 1 ? "s" : ""} will be removed`
							: `${totalRemove} removed, ${totalAdd} added`}
					</span>
					<div style={{ display: "flex", gap: "8px" }}>
						<button
							onClick={onCancel}
							style={{
								padding: "8px 16px",
								background: "rgba(255,255,255,0.1)",
								border: "1px solid rgba(255,255,255,0.2)",
								borderRadius: "4px",
								color: "#fff",
								cursor: "pointer",
								fontSize: "13px",
							}}
						>
							Cancel
						</button>
						<button
							onClick={() => onConfirm(state)}
							disabled={mode === "dedup" ? totalRemove === 0 : (totalRemove === 0 && totalAdd === 0)}
							style={{
								padding: "8px 16px",
								background: (mode === "dedup" ? totalRemove === 0 : (totalRemove === 0 && totalAdd === 0)) ? "rgba(255,80,80,0.2)" : "rgba(255,80,80,0.6)",
								border: "1px solid rgba(255,80,80,0.4)",
								borderRadius: "4px",
								color: "#fff",
								cursor: (mode === "dedup" ? totalRemove === 0 : (totalRemove === 0 && totalAdd === 0)) ? "not-allowed" : "pointer",
								fontSize: "13px",
								fontWeight: 500,
							}}
						>
							{mode === "dedup"
								? `Remove ${totalRemove} track${totalRemove !== 1 ? "s" : ""}`
								: `Apply ${totalAdd} replacement${totalAdd !== 1 ? "s" : ""}`}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
};
