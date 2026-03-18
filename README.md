# Luna Plugins

A collection of **[Tidal Luna](https://github.com/Inrixia/TidaLuna)** plugins.

---

### PlaylistTools

Deduplicate tracks and find quality upgrades in your Tidal playlists and favorites.

**The Problem:** Over time, playlists accumulate duplicate tracks — the same song added twice, re-releases, or remastered versions sitting alongside originals. Meanwhile, better quality versions of your tracks may become available on Tidal without you knowing. Tidal provides no built-in tools to detect or fix either issue.

**Features:**

*Deduplicate mode:*
- **Multiple detection strategies** — find duplicates by track ID, ISRC code, title + artist match, or remaster detection (e.g. "Angel" vs "Angel (Remastered 2015)")
- **Keep strategy** — choose which duplicate to keep: best quality, oldest (first occurrence), or newest (last occurrence)

*Find upgrades mode:*
- **Quality upgrades** — finds higher quality versions of your tracks (e.g. HIGH → LOSSLESS → Hi-Res), including stream-level comparison of bit depth (16 vs 24 bit) and sample rate (44.1 vs 48 vs 96 kHz) within the same quality tier
- **Remaster detection** — finds remastered versions when your library has the original
- **Reissue detection** — finds newer reissues (e.g. 2015 reissue of a 1999 original)
- **ISRC + search** — looks up alternatives by ISRC code first, then falls back to search to catch remasters with different ISRCs

*Shared:*
- **Review before changing** — a modal shows all detected groups with track details (quality, bit depth, sample rate, album, year) so you can toggle which tracks to keep, remove, or replace before confirming
- **Batch scanning** — select multiple playlists and favorites to scan at once
- **Stream quality enrichment** — fetches actual stream info (bit depth / sample rate) to help differentiate versions

**Demo:**

https://github.com/user-attachments/assets/4a1df562-1d16-42a7-9091-37860a42076d

---

### SpotifySync

Sync your Spotify library to Tidal — playlists, liked songs, followed artists, and saved albums.

**The Problem:** If you use both Spotify and Tidal, keeping your libraries in sync means manually searching and adding tracks one by one.

**Features:**
- **Playlist sync** — select Spotify playlists to sync; creates matching Tidal playlists if they don't exist. Supports both owned and followed playlists
- **Favorites sync** — sync Spotify liked songs to Tidal favorites
- **Artist sync** — sync Spotify followed artists to Tidal, with manual review for ambiguous matches
- **Album sync** — sync Spotify saved albums to Tidal favorites, matching by album name and artist
- **Smart matching** — finds Tidal tracks via search with fuzzy name/artist/duration matching and ISRC cross-checking
- **Album-aware track matching** — prefers tracks from the correct album, falls back to highest quality when no album match is found
- **Cross-release detection** — recognizes tracks already in your library even when Tidal has different regional releases (e.g. "Хаски" vs "Husky") using ISRC comparison
- **Similar version handling** — detects when a similar version already exists (e.g. remaster vs original) and lets you choose which to keep
- **Transliteration support** — handles non-Latin scripts (Cyrillic, CJK, etc.) via Unicode-to-ASCII transliteration
- **Abbreviation normalization** — matches "Pt. I" to "Part 1", "Ft." to "Feat.", roman to arabic numerals
- **Sync memory** — remembers matched tracks, artists, and albums per sync, skipping re-lookups on subsequent syncs
- **Manual mode** — review every track, artist, and album before adding, with controls to select/deselect individual items or resolve ambiguous matches
- **Copy unmatched** — copy the list of items that couldn't be found on Tidal to clipboard

https://github.com/user-attachments/assets/c145c9db-d64e-4f1d-95f3-c23728fe9322

---

### FilteredQueueFix

Keeps the playback queue in sync with the in-playlist filter so "Next" stays within filtered results.

**The Problem:** When you filter a playlist in Tidal and start playing a track, the queue still contains **all** tracks from the playlist — not just the ones matching your filter. Pressing "Next" jumps to unrelated tracks outside your filter.

**How It Works:** Intercepts queue-building Redux actions and replaces the full track list with only the tracks matching the current filter text. Matches against track title, version, artist name(s), and album title. Shuffle is respected.

**Demo:**

https://github.com/user-attachments/assets/e247e855-11e3-4216-8a31-6c0f641f2f8d

---

### PlaylistIndicator

Shows which playlists already contain a track in the "Add to Playlist" menu.

**The Problem:** Tidal's "Add to playlist" popup doesn't show whether a track is already in any of the listed playlists, making it easy to add duplicates.

**How It Works:**
- Adds a green **✓** checkmark next to playlist names that already contain the track
- Works in both the "+" button popup and the three-dots context menu's "Add to playlist" submenu
- When a duplicate is detected and Tidal shows the "This track is already in your playlist" dialog, a **"Remove from Playlist"** button is injected alongside "Cancel" and "Add Anyway" — removing all occurrences of the track from that playlist

**Demo:**

https://github.com/user-attachments/assets/9b1f3260-0c2a-4462-91b7-442b5a92b0f2

---

### ScrollToPlaying

Highlights the currently playing track and source playlist, auto-scrolls to the playing track, and adds a scroll-to-playing button.

**The Problem:** When using Tidal Connect (remote playback), the desktop app doesn't highlight which track is currently playing in the playlist, making it hard to find it — especially in long playlists. It's also unclear which playlist the music is playing from.

**Features:**
- **Track row highlight** — the currently playing track row is highlighted with a colored background, left accent bar, and tinted text
- **Source playlist highlight** — the playlist the queue was built from is highlighted in the sidebar
- **Auto-scroll on track change** — when the track changes, the playlist automatically scrolls to the playing track (toggleable in settings)
- **Scroll-to-playing button** — a floating arrow button appears when the playing track is scrolled out of view, pointing toward it; click to scroll back
- **Configurable colors** — highlight color (RGB) and background opacity are adjustable in settings

**How It Works:** Intercepts Tidal Connect `MEDIA_CHANGED` events and syncs the play queue index. Detects the source playlist by matching queue tracks against loaded track lists. Scrolls the `<main>` container using position estimation for virtualized lists, with a refinement pass once the track row renders.

**Demo:**

https://github.com/user-attachments/assets/c68dc654-04bd-4477-b367-11cd86b3ba6b

---

### TrackRadio

Makes the native "Go to track radio" context menu button work immediately — even when Tidal hasn't finished loading the radio data.

**The Problem:** Tidal's "Go to track radio" context menu button starts greyed out and only becomes clickable after the app fetches the mix data in the background. Sometimes it never becomes clickable at all.

**How It Works:** When the native radio button is disabled, the plugin removes the disabled styling and hijacks its click to force-fetch the radio via `mix/LOAD_TRACK_MIX_ID`, then navigates to the mix page. When the native button is already clickable, the plugin does nothing. If no radio exists for the track, an error banner is shown.

**Demo:**

https://github.com/user-attachments/assets/480180c1-d6b8-4cf5-ba06-556a49bd7084

---

### ClearFavorites

Delete all tracks from your Tidal favorites in one click.

**The Problem:** Tidal has no built-in way to clear your entire favorites library. If you want to start fresh or do a full resync, you'd have to manually remove tracks one by one.

**Features:**
- **Safety confirmation** — requires typing "DELETE ALL" before the button activates
- **Progress tracking** — shows real-time deletion progress
- **Cancellable** — abort the operation at any time

---

## Installation

Install individual plugins from the releases page:

```
https://github.com/squadgazzz/luna-plugins/releases/download/latest/luna.filtered-queue-fix
```

```
https://github.com/squadgazzz/luna-plugins/releases/download/latest/luna.playlist-indicator
```

```
https://github.com/squadgazzz/luna-plugins/releases/download/latest/luna.scroll-to-playing
```

```
https://github.com/squadgazzz/luna-plugins/releases/download/latest/luna.playlist-tools
```

```
https://github.com/squadgazzz/luna-plugins/releases/download/latest/luna.track-radio
```

```
https://github.com/squadgazzz/luna-plugins/releases/download/latest/luna.spotify-sync
```

```
https://github.com/squadgazzz/luna-plugins/releases/download/latest/luna.clear-favorites
```

Or install the full store:

```
https://github.com/squadgazzz/luna-plugins/releases/download/latest/store.json
```
