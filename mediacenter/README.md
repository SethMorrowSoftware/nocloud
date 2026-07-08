# No Cloud Media Center (`mediacenter/`)

Your movies and TV, streamed across your own LAN - served straight out of this folder
by **No Cloud Quick Share** (`../src/nocloudquickshare.livecodescript`). No media
server software, no account, no transcoding, no cloud: drop files into two folders,
share this folder, open the link on any device in the house.

Built from the same cloth as the sibling `webapp/` demo (dependency-free SPA, relative
paths, one CSS file, one JS file, strict-CSP-safe, no external requests ever), but it
is a real application rather than a showcase.

## Use it

1. Open `nocloudquickshare.livecodescript` in OpenXTalk and run it.
2. Put your media inside **this folder**:

   ```
   mediacenter/
     Movies/
       Inception (2010).mkv                a file straight in the folder
       The Iron Giant (1999)/              ...or one folder per film
         The.Iron.Giant.1999.1080p.mkv
         poster.jpg                        shown on the poster wall
         The.Iron.Giant.1999.en.srt        subtitles, auto-detected
     TV/
       The Expanse/
         poster.jpg
         Season 1/
           The.Expanse.S01E01.mkv
       Fawlty Towers/                      season folders are optional
         Fawlty.Towers.1x01.mp4
   ```

3. Drag **this `mediacenter` folder** onto the drop area and share it - over a
   **web link** for the LAN (any browser: TVs, phones, laptops), or over **Tor**
   if you want to reach it from outside without exposing your IP.
4. Open the link. The app scans `Movies/` and `TV/`, builds the library, and plays.

Everything is optional beyond that: posters, subtitles, seasons, `library.json`.
No step 5.

## What it does

- **A real library, not a file list.** Release-style names are cleaned for display
  (`The.Iron.Giant.1999.1080p.BluRay.x264-GRP.mkv` shows as *The Iron Giant (1999)*
  with `1080p` / `BluRay` chips); episodes are read from `S01E02`, `1x02`, or `E02`
  patterns; `Season 1` / `S2` / `Series 3` / `Specials` folders are understood.
- **Poster wall** with real artwork (`poster.jpg`, `cover.png`, or an image named
  like the film) and handsome generated posters when there is none. Grid or list
  view for movie sections, sort by title / year / size, and a "Surprise me" shuffle.
- **A full player**: seek bar with buffer indicator, ±10s, playback speed, volume,
  fullscreen, keyboard shortcuts (Space, arrows, F, M, S, N, 0-9, < >), and
  Media-Session integration for lockscreen/media keys.
- **Resume everywhere it makes sense.** Positions are remembered per browser;
  a *Continue watching* shelf sits on the home screen; watched items are ticked;
  finishing an episode offers the next one with a countdown.
- **Subtitles that just work.** Sidecar `.srt` and `.vtt` files (including in a
  `Subs/` subfolder, and with language tags like `Movie.en.srt`) appear in the
  player's CC menu. The app renders cues itself, so `.srt` works even though the
  host serves it as a plain byte stream - and styling is consistent everywhere.
- **Honest fallbacks.** If the browser cannot decode a container/codec (`.avi`,
  exotic audio), the player says so and offers the escapes: **Copy stream URL**
  (paste into VLC / mpv - it is a plain HTTP URL) and **Download** (served as an
  attachment via the host's `?dl=1`). On a Tor share the player leads with
  Download instead - a stock VLC/mpv cannot reach a `.onion` address unless it
  is Tor-proxied itself, and the app says so.
- **Search** across titles, years, episode codes, and file names (press `/`).
- **Dark / light / auto** theme, responsive from phone to TV-sized windows,
  `prefers-reduced-motion` respected, keyboard- and screen-reader-friendly.
- **Transport awareness**: the header badge reads `GET /_qs/info` from the host and
  shows whether you are on Tor, the LAN link, or a static preview.

## `library.json` (optional)

Rename the folders, add sections, or title the app - edit `library.json` in this
folder (keys starting with `_` are comments):

```json
{
  "title": "The Morrow Family Cinema",
  "tagline": "Movie night starts here.",
  "sections": [
    { "id": "movies", "label": "Movies", "path": "Movies",      "kind": "movies" },
    { "id": "kids",   "label": "Kids",   "path": "Kids Movies", "kind": "movies" },
    { "id": "tv",     "label": "TV",     "path": "TV",          "kind": "tv" }
  ]
}
```

`kind: "movies"` is a poster wall of standalone files; `kind: "tv"` expects
folder-per-show. Delete the file entirely for the defaults (`Movies/` + `TV/`).

## How it leans on the host (design notes)

Everything here runs within what the Quick Share web host already does - the app
needed **zero changes** to the stack script:

| Host capability | How the app uses it |
|---|---|
| Auto **directory listing** for index-less folders (`qsFsListing`) | the library scan: fetch `Movies/`, parse the `ul.fl` rows (name, href, size), recurse - bounded depth, bounded folder count, a few requests in flight |
| **HTTP Range** streaming (`qsFsServeFile`) | all playback and seeking; multi-GB files stream in bounded slices, several viewers at once |
| **MIME by extension** (`qsFsMime`) | `<video>` gets `video/mp4` / `video/webm` / `video/x-matroska`...; posters get real image types |
| **`?dl=1`** forced download (`qsHttpDisposition`) | the Download buttons (note: the value is required - a bare `?dl` reads as empty) |
| **SPA fallback** (`qsSiteSpaTarget`) | refresh safety for the shell; app routes live in the **hash**, so nested media paths never hit the server as pathnames |
| `GET /_qs/info` | the transport badge and the Help page |
| Dotfiles are never served or listed | `.qsroutes.json`-style server config stays invisible; the scanner also skips nothing it cannot see, keeping app and host views consistent |

Two roads deliberately **not** taken, and why:

- **No `<track>` subtitles.** The host serves `.srt` as `application/octet-stream`,
  and converting via `blob:`/`data:` URLs would violate the folder's strict-CSP
  discipline. Rendering cues in an overlay is simpler and uniform.
- **No pathname routing.** The demo's rule ("routes must be single-segment or
  relative assets break on refresh") cannot hold for `TV/Show/Season 2/` deep links;
  the hash carries any depth at any mount point instead.

A missing media folder still answers `200` with the app shell (the SPA fallback
catches the dot-free path `Movies/`), so the scanner does not trust status codes:
it requires the listing's `ul.fl` signature before believing any response, and
treats everything else as "not there".

## Files

```
index.html        the shell (header, nav, search, one <main>)
app.js            the whole app: scanner, name parsers, router, views, player
app.css           the whole look: midnight-cinema theme, light variant, responsive
library.json      optional config (sections, title) - safe to delete
site.webmanifest  installable PWA metadata
sw.js             minimal service worker (secure contexts only, deliberately no cache)
assets/logo.svg   the mark
Movies/ TV/       where your media goes (each ships with a README.txt of examples)
```

## Format reality check

The host streams any file faithfully; whether the *browser* can decode it is the
only question. MP4 (H.264/AAC) and WebM play everywhere; MKV usually plays in
Chrome/Edge; MOV in Safari (and Chrome for H.264); AVI rarely anywhere. For the
rest, the player's *Copy stream URL* into VLC/mpv works on any LAN share - the URL
is a plain HTTP Range endpoint (over Tor, the player itself must be Tor-proxied;
Download works regardless). If you re-encode, `H.264 + AAC in .mp4 with +faststart`
is the universal answer.

One address gotcha: a web-link share lives under `http://<ip>:<port>/<token>/` -
**keep the trailing slash** if you retype it. The host does not canonicalize the
bare `/<token>` form, so without the slash the page loads with a wrong base URL
and its relative assets miss.

## Privacy, honestly

A **web link** share is plain HTTP gated by the random token in the URL - fine for
a home LAN, visible to whoever can see your traffic. **Tor** hides both ends and
encrypts transport, at Tor speeds. The host keeps no accounts, no logs, no state
about viewers; watch positions and theme live in each viewer's own browser
(`localStorage`) and never leave it. See `../docs/what-it-hides.md` for the precise
model before relying on it.
