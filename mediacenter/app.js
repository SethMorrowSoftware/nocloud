/* No Cloud Media Center - a LAN media library served straight out of a shared folder
 * by No Cloud Quick Share (../src/nocloudquickshare.livecodescript). Dependency-free:
 * plain JS, no build step, no CDN, no network calls other than to the serving folder.
 *
 * How it works, and why it can work at all:
 *
 *   - LIBRARY DISCOVERY rides the host's auto directory listing. A folder with no
 *     index.html of its own is answered with a small HTML listing (qsFsListing) whose
 *     markup is stable and parseable: <ul class='fl'> rows, each entry an <a> with an
 *     ALREADY-%-ENCODED href (dirs end in "/"), a .nm span holding the decoded name,
 *     and a .sz span holding the human size. So the app fetches "Movies/" and "TV/",
 *     parses the rows, and recurses - no manifest, no build step, no server change.
 *     Posters and subtitles are found in the same rows for free.
 *
 *   - STREAMING is the host's HTTP Range pipeline: <video> seeks issue byte-range
 *     requests answered 206 one bounded slice at a time, so a multi-GB film never
 *     sits in anyone's memory, and several devices can watch at once.
 *
 *   - ROUTING is hash-based (#/movies, #/play/<path>), NOT pathname-based like the
 *     sibling webapp demo. Media paths are arbitrarily nested (TV/Show/Season 2/ep.mkv)
 *     and the host's SPA fallback only carries single-segment dot-free paths across a
 *     refresh - a nested pathname would also move the document base and break every
 *     relative asset. A location hash never reaches the server, so any route survives
 *     refresh at the onion root and under /<token>/ alike.
 *
 *   - DOWNLOADS use the host's ?dl switch (Content-Disposition: attachment). The value
 *     matters: qsQueryParam treats a bare "?dl" as empty, so links say "?dl=1".
 *
 *   - SUBTITLES are rendered by the app itself (a cue overlay synced to the video
 *     clock) rather than a <track> element: the host serves .vtt as text/vtt but .srt
 *     as octet-stream, and converting srt via a blob: URL would break the folder's
 *     no-data:/strict-CSP discipline. Fetch text, parse both formats, draw the cues.
 *
 * Everything else - resume positions, watched marks, theme - lives in localStorage on
 * the WATCHING device; the host stays a dumb byte pipe with zero server-side state.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- constants ---
  var LS_PROGRESS = 'ncmcProgress';   // { path: {t,d,at,done} } - resume + watched
  var LS_THEME    = 'ncmcTheme';      // 'auto' | 'dark' | 'light'
  var LS_VOLUME   = 'ncmcVolume';     // { v: 0..1, muted: bool }
  var LS_VIEWMODE = 'ncmcView';       // { sectionId: 'grid'|'list' }
  var LS_SORT     = 'ncmcSort';       // { sectionId: 'title'|'year'|'size' }
  var SS_LIBRARY  = 'ncmcLib:';       // + pathname -> cached scan (per mount point)

  var VIDEO_EXT = { mp4: 1, m4v: 1, webm: 1, ogv: 1, mov: 1, mkv: 1, avi: 1 };
  // How likely a browser is to decode it: 2 = broadly, 1 = often (Chromium demuxes
  // Matroska; MOV is MP4's cousin), 0 = almost never natively. Used only for honest
  // labelling - playback is always ATTEMPTED and failure handled, never pre-blocked.
  var PLAYABILITY = { mp4: 2, m4v: 2, webm: 2, ogv: 1, mov: 1, mkv: 1, avi: 0 };
  var SUB_EXT   = { srt: 1, vtt: 1 };
  var IMG_EXT   = { jpg: 1, jpeg: 1, png: 1, webp: 1, avif: 1, gif: 1, bmp: 1 };

  var SCAN_MAX_FOLDERS = 600;   // crawl ceiling: keeps a pathological tree polite
  var SCAN_MAX_DEPTH   = 4;     // relative to a section root (Show/Season/Subs = 3)
  var SCAN_CONCURRENCY = 4;     // the host is single-threaded; a few in flight is plenty

  // Tokens that end the "title" part of a release-style file name. Order-free set.
  var JUNK_TOKENS = ('1080p 720p 2160p 4320p 480p 576p 4k uhd bluray blu-ray brrip bdrip ' +
    'webrip web-dl webdl hdtv dvdrip dvdscr dvd remux hdr hdr10 hdr10+ dovi dv sdr ' +
    'x264 x265 h264 h265 h.264 h.265 hevc avc av1 xvid divx 10bit 8bit aac ac3 eac3 ' +
    'dd5 ddp ddp5 dts dts-hd atmos truehd flac opus mp3 5.1 7.1 2.0 proper repack ' +
    'internal limited unrated extended remastered imax multi dual dubbed subbed hc ' +
    'cam ts tc scr r5 retail complete season pack').split(' ');
  var JUNK = {};
  JUNK_TOKENS.forEach(function (t) { JUNK[t] = 1; });

  // Tags worth SHOWING as chips (resolution / source / codec / HDR), pulled from the
  // same token stream the title cleaner discards.
  var CHIP_MAP = {
    '2160p': '4K', '4k': '4K', 'uhd': '4K', '1080p': '1080p', '720p': '720p',
    'bluray': 'BluRay', 'blu-ray': 'BluRay', 'remux': 'Remux', 'webrip': 'WEB',
    'web-dl': 'WEB', 'webdl': 'WEB', 'hdtv': 'HDTV', 'dvdrip': 'DVD', 'dvd': 'DVD',
    'x265': 'HEVC', 'h265': 'HEVC', 'h.265': 'HEVC', 'hevc': 'HEVC', 'av1': 'AV1',
    'hdr': 'HDR', 'hdr10': 'HDR', 'hdr10+': 'HDR10+', 'dovi': 'Dolby Vision', 'dv': 'Dolby Vision'
  };

  var LANG_NAMES = {
    en: 'English', eng: 'English', english: 'English', es: 'Spanish', spa: 'Spanish',
    spanish: 'Spanish', fr: 'French', fre: 'French', fra: 'French', french: 'French',
    de: 'German', ger: 'German', deu: 'German', german: 'German', it: 'Italian',
    ita: 'Italian', italian: 'Italian', pt: 'Portuguese', por: 'Portuguese',
    portuguese: 'Portuguese', nl: 'Dutch', dut: 'Dutch', dutch: 'Dutch', ru: 'Russian',
    rus: 'Russian', russian: 'Russian', ja: 'Japanese', jpn: 'Japanese',
    japanese: 'Japanese', zh: 'Chinese', chi: 'Chinese', chinese: 'Chinese',
    ko: 'Korean', kor: 'Korean', korean: 'Korean', ar: 'Arabic', ara: 'Arabic',
    arabic: 'Arabic', hi: 'Hindi', hin: 'Hindi', hindi: 'Hindi', sv: 'Swedish',
    swe: 'Swedish', swedish: 'Swedish', no: 'Norwegian', nor: 'Norwegian', da: 'Danish',
    dan: 'Danish', fi: 'Finnish', fin: 'Finnish', pl: 'Polish', pol: 'Polish',
    polish: 'Polish', tr: 'Turkish', tur: 'Turkish', turkish: 'Turkish', sdh: 'SDH',
    forced: 'Forced', cc: 'CC'
  };

  // ------------------------------------------------------------- tiny helpers ---
  var view = document.getElementById('view');
  var navEl = document.getElementById('nav');

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }
  function extOf(name) {
    var i = name.lastIndexOf('.');
    return i > 0 ? name.slice(i + 1).toLowerCase() : '';
  }
  function baseOf(name) {
    var i = name.lastIndexOf('.');
    return i > 0 ? name.slice(0, i) : name;
  }
  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    var mm = (h ? ('0' + m).slice(-2) : m), ss = ('0' + sec).slice(-2);
    return (h ? h + ':' + mm : mm) + ':' + ss;
  }
  function fmtLeft(s) {
    s = Math.max(0, Math.round(s));
    if (s < 90) return s + ' sec left';
    var m = Math.round(s / 60);
    if (m < 90) return m + ' min left';
    return Math.floor(m / 60) + ' h ' + (m % 60) + ' min left';
  }
  // Human sizes in the SAME IEC units the host's listing prints (qsBytes), and the
  // inverse: parse a listing's ".sz" text back to approximate bytes for sorting/sums.
  function fmtBytes(n) {
    if (!isFinite(n) || n <= 0) return '';
    var units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'], i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : Math.round(n * 10) / 10) + ' ' + units[i];
  }
  function parseBytes(txt) {
    var m = /([\d.]+)\s*(B|KiB|MiB|GiB|TiB)/.exec(txt || '');
    if (!m) return 0;
    var mult = { B: 1, KiB: 1024, MiB: 1048576, GiB: 1073741824, TiB: 1099511627776 };
    return parseFloat(m[1]) * mult[m[2]];
  }
  function hashHue(s) {           // deterministic 0..11 bucket for generated posters
    var h = 5381, i;
    for (i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h % 12;
  }
  function initialsOf(title) {
    var words = String(title).replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
    if (!words.length) return '?';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  function lsGet(key, fallback) {
    try {
      var v = JSON.parse(localStorage.getItem(key) || 'null');
      return v === null ? fallback : v;
    } catch (e) { return fallback; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* private mode */ }
  }

  // --------------------------------------------------------------------- URLs ---
  // With hash routing the document URL never moves, so every fetch/src can simply be
  // RELATIVE to the page. absUrl() exists for the clipboard ("open in VLC") case.
  function absUrl(enc) { return new URL(enc, document.baseURI).href; }
  function dlHref(enc) { return enc + '?dl=1'; }   // qsQueryParam needs a VALUE: bare ?dl is empty

  // --------------------------------------------------------------- inline SVG ---
  var ICONS = {
    play:   '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
    pause:  '<path d="M8 5.5v13M16 5.5v13" stroke-width="2.6"/>',
    back10: '<path d="M11.5 4.5L8 8l3.5 3.5"/><path d="M8 8h7a5.5 5.5 0 1 1-5.4 8.5"/>',
    fwd10:  '<path d="M12.5 4.5L16 8l-3.5 3.5"/><path d="M16 8H9a5.5 5.5 0 1 0 5.4 8.5"/>',
    next:   '<path d="M6 5.5v13l9-6.5z" fill="currentColor" stroke="none"/><path d="M18 5.5v13" stroke-width="2.4"/>',
    full:   '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    unfull: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
    vol:    '<path d="M4 9.5v5h3.5L12 18V6L7.5 9.5z" fill="currentColor" stroke="none"/><path d="M15.5 9a4.5 4.5 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/>',
    mute:   '<path d="M4 9.5v5h3.5L12 18V6L7.5 9.5z" fill="currentColor" stroke="none"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
    cc:     '<rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><path d="M10.5 10.2a2.3 2.3 0 1 0 0 3.6M16.5 10.2a2.3 2.3 0 1 0 0 3.6"/>',
    gauge:  '<path d="M5 17a8 8 0 1 1 14 0"/><path d="M12 13l3.5-3.5"/><circle cx="12" cy="14" r="1.6" fill="currentColor" stroke="none"/>',
    down:   '<path d="M12 4v10M8 11l4 4 4-4"/><path d="M5.5 19h13"/>',
    link:   '<path d="M9.5 14.5l5-5"/><path d="M10.5 6.5l1-1a3.5 3.5 0 0 1 5 5l-1 1"/><path d="M13.5 17.5l-1 1a3.5 3.5 0 0 1-5-5l1-1"/>',
    film:   '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M7.5 4.5v15M16.5 4.5v15M3.5 9h4M3.5 15h4M16.5 9h4M16.5 15h4"/>',
    tv:     '<rect x="3.5" y="6" width="17" height="12.5" rx="2.5"/><path d="M8.5 2.5L12 6l3.5-3.5"/>',
    folder: '<path d="M4 7.5h5l2 2h9v9.5H4z"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l5 5"/>',
    check:  '<path d="M5 12.5l4.5 4.5L19 7"/>',
    left:   '<path d="M14.5 5.5L8 12l6.5 6.5"/>',
    clock:  '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    shuffle:'<path d="M3.5 6.5h3l10 11h4"/><path d="M20.5 17.5l-2.5 2.5v-5z" fill="currentColor" stroke="none"/><path d="M3.5 17.5h3l3.2-3.5M13.6 9.9l2.9-3.4h4"/><path d="M20.5 6.5L18 9V4z" fill="currentColor" stroke="none"/>',
    grid:   '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
    list:   '<path d="M8.5 6h12M8.5 12h12M8.5 18h12"/><circle cx="4.5" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r="1.3" fill="currentColor" stroke="none"/>',
    info:   '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
    warn:   '<path d="M12 4L2.8 19.5h18.4z"/><path d="M12 10v4.2"/><path d="M12 17.2h.01"/>',
    subs:   '<rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><path d="M7 12h5M14 12h3M7 15.2h3M12 15.2h5"/>',
    refresh:'<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 3v4h-4"/>'
  };
  function icon(name, cls) {
    return '<svg class="ic' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true">' +
      (ICONS[name] || '') + '</svg>';
  }

  // -------------------------------------------------------------- name parsing ---
  // Turn "The.Iron.Giant.1999.1080p.BluRay.x264-GROUP.mkv" into
  // { title: "The Iron Giant", year: "1999", chips: ["1080p","BluRay"] }.
  // Conservative on purpose: a name that already looks human ("Inception (2010)")
  // passes through nearly untouched.
  function parseMovieName(fileName) {
    var name = baseOf(fileName), year = '', chips = [], chipSeen = {};
    // A "(1999)" or "[1999]" wins outright and splits the title cleanly.
    var m = /^(.*?)[([]((?:19|20)\d\d)[)\]]/.exec(name);
    if (m && m[1].replace(/[\s._-]+/g, '')) {
      year = m[2];
      name = m[1];
    }
    // Scene names carry dots/underscores instead of spaces.
    var spaced = name.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
    var tokens = spaced.split(' ');
    var cut = tokens.length, i, low;
    for (i = 0; i < tokens.length; i++) {
      low = tokens[i].toLowerCase().replace(/^[-[(]+|[-\])]+$/g, '');
      if (!year && i > 0 && /^(19|20)\d\d$/.test(low)) {
        year = low;
        if (i < cut) cut = i;
        continue;
      }
      if (JUNK[low]) {
        if (i < cut) cut = i;
      }
      if (CHIP_MAP[low] && !chipSeen[CHIP_MAP[low]]) {
        chipSeen[CHIP_MAP[low]] = 1;
        chips.push(CHIP_MAP[low]);
      }
    }
    var title = tokens.slice(0, cut).join(' ').replace(/[-_.\s]+$/g, '').trim();
    if (!title) title = spaced;                       // never end up with an empty title
    if (title === title.toLowerCase() || title === title.toUpperCase()) {
      title = title.replace(/\w\S*/g, function (w) {
        return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
      });
    }
    return { title: title, year: year, chips: chips };
  }

  // Episode markers, most specific first: S01E02(E03/-E03), 1x02, then a bare
  // E02/Ep02/Episode 2. Returns null when the name carries no episode signal.
  function parseEpisodeName(fileName) {
    var name = baseOf(fileName).replace(/[._]+/g, ' ');
    var m = /\bS(\d{1,2})[ .\-]?E(\d{1,3})(?:[ .\-]?E?(\d{1,3}))?/i.exec(name);
    var season = null, ep = null, ep2 = null, at = -1, len = 0;
    if (m) {
      season = +m[1]; ep = +m[2]; ep2 = m[3] ? +m[3] : null;
      at = m.index; len = m[0].length;
    } else if ((m = /\b(\d{1,2})x(\d{2,3})\b/.exec(name))) {
      season = +m[1]; ep = +m[2]; at = m.index; len = m[0].length;
    } else if ((m = /\bE(?:p(?:isode)?)?[ .]?(\d{1,3})\b/i.exec(name))) {
      ep = +m[1]; at = m.index; len = m[0].length;
    } else {
      return null;
    }
    // Whatever follows the marker is usually the episode's own title; clean it the
    // same way movie titles are cleaned (junk tokens end it).
    var tail = name.slice(at + len).replace(/^[ .\-]+/, '');
    var tokens = tail ? tail.split(' ') : [];
    var cut = tokens.length, i, low;
    for (i = 0; i < tokens.length; i++) {
      low = tokens[i].toLowerCase().replace(/^[-[(]+|[-\])]+$/g, '');
      if (JUNK[low] || /^(19|20)\d\d$/.test(low)) { cut = i; break; }
    }
    var title = tokens.slice(0, cut).join(' ').replace(/[-_.\s]+$/g, '').trim();
    return { season: season, ep: ep, ep2: ep2, title: title };
  }

  function parseSeasonFolder(name) {
    var m = /^(?:season|series)[ ._-]*(\d{1,3})\b/i.exec(name) || /^s(\d{1,2})$/i.exec(name);
    if (m) return +m[1];
    if (/^specials?$/i.test(name)) return 0;
    return null;
  }

  function epCode(it) {
    var s = (it.season === null || it.season === undefined) ? '' : 'S' + it.season + ' ';
    if (it.ep === null || it.ep === undefined) return s.trim();
    return s + 'E' + it.ep + (it.ep2 ? '–' + it.ep2 : '');
  }

  // Subtitle sidecar: "Movie.en.srt" / "Movie.English.forced.srt" -> a label. The
  // basename must extend the video's own basename (or be a lone file in a Subs/
  // folder, matched by the caller).
  function subLabel(subName, vidBase) {
    var base = baseOf(subName);
    var tail = base;
    if (vidBase && base.toLowerCase().indexOf(vidBase.toLowerCase()) === 0) {
      tail = base.slice(vidBase.length);
    }
    var parts = tail.split(/[ ._\-()[\]]+/).filter(Boolean);
    var words = [], i, low;
    for (i = 0; i < parts.length; i++) {
      low = parts[i].toLowerCase();
      if (LANG_NAMES[low] && words.indexOf(LANG_NAMES[low]) === -1) words.push(LANG_NAMES[low]);
    }
    if (words.length) return words.join(' ');
    if (parts.length && tail !== base) return parts.join(' ');
    return '';
  }

  // ------------------------------------------------------------ listing crawl ---
  // One bounded semaphore for the whole scan: the host serves everything on a single
  // interpreted thread, so a handful of listing fetches in flight is fast AND polite.
  var scanActive = 0, scanWaiters = [];
  function scanAcquire() {
    if (scanActive < SCAN_CONCURRENCY) { scanActive++; return Promise.resolve(); }
    return new Promise(function (res) { scanWaiters.push(res); });
  }
  function scanRelease() {
    var next = scanWaiters.shift();
    if (next) next(); else scanActive--;
  }

  // Fetch one directory listing and parse it. Returns { dirs:[{name,href}],
  // files:[{name,href,size}] } or null when the URL is not a host listing - a 404,
  // the SPA fallback echoing our own shell (a MISSING folder still answers 200 with
  // index.html, because "Movies/" is a dot-free path), or a foreign static server.
  // The ul.fl signature is the discriminator.
  function fetchListing(relEnc, progress) {
    return scanAcquire().then(function () {
      return fetch(relEnc, { headers: { accept: 'text/html' } }).then(function (r) {
        if (!r.ok) return null;
        return r.text();
      }).then(function (html) {
        if (html === null || html === undefined) return null;
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var ul = doc.querySelector('ul.fl');
        if (!ul) return null;
        var out = { dirs: [], files: [] };
        $all('li', ul).forEach(function (li) {
          var a = li.querySelector('a');
          if (!a) return;
          var href = a.getAttribute('href') || '';
          if (!href || href === '../' || li.className.indexOf('up') !== -1) return;
          if (href.charAt(0) === '/' || href.indexOf(':') !== -1) return;  // never leave the share
          var nmEl = a.querySelector('.nm');
          var name = (nmEl ? nmEl.textContent : a.textContent) || '';
          name = name.trim();
          if (!name) return;
          if (href.slice(-1) === '/') {
            out.dirs.push({ name: name, href: href });
          } else {
            var szEl = a.querySelector('.sz');
            out.files.push({ name: name, href: href, size: szEl ? szEl.textContent.trim() : '' });
          }
        });
        if (progress) progress.folders++;
        return out;
      });
    }).catch(function () { return null; })
      .then(function (r) { scanRelease(); return r; });
  }

  // Pick the poster / backdrop images out of one folder's file rows.
  function pickPoster(imgs, vidBase, soloVideo) {
    var byName = {}, i, b;
    for (i = 0; i < imgs.length; i++) byName[baseOf(imgs[i].name).toLowerCase()] = imgs[i];
    if (vidBase && byName[vidBase.toLowerCase()]) return byName[vidBase.toLowerCase()];
    var prefs = ['poster', 'cover', 'folder', 'movie', 'default'];
    for (i = 0; i < prefs.length; i++) if (byName[prefs[i]]) return byName[prefs[i]];
    if (soloVideo) {
      for (i = 0; i < imgs.length; i++) {
        b = baseOf(imgs[i].name).toLowerCase();
        if (!/fanart|backdrop|background|banner|landscape|thumb/.test(b)) return imgs[i];
      }
    }
    return null;
  }
  function pickBackdrop(imgs) {
    for (var i = 0; i < imgs.length; i++) {
      if (/fanart|backdrop|background/.test(baseOf(imgs[i].name).toLowerCase())) return imgs[i];
    }
    return null;
  }

  // Match subtitle rows to one video: same-folder sidecars whose basename extends the
  // video's, plus everything a Subs/ folder holds when the video stands alone.
  // pDirEnc is the folder's OWN encoded path: row hrefs are folder-relative, but the
  // player fetches them relative to the app root, so they are absolutized here.
  function matchSubs(subRows, vidBase, soloVideo, pDirEnc) {
    var out = [], seen = {}, i, s, b;
    for (i = 0; i < subRows.length; i++) {
      s = subRows[i];
      b = baseOf(s.name).toLowerCase();
      var isMine = b === vidBase.toLowerCase() ||
        b.indexOf(vidBase.toLowerCase() + '.') === 0 ||
        b.indexOf(vidBase.toLowerCase() + '_') === 0 ||
        b.indexOf(vidBase.toLowerCase() + '-') === 0 ||
        b.indexOf(vidBase.toLowerCase() + ' ') === 0;
      if (!isMine && !(soloVideo && s.fromSubsDir)) continue;
      if (seen[s.href]) continue;
      seen[s.href] = 1;
      var label = subLabel(s.name, isMine ? vidBase : '') ||
        (isMine ? 'Subtitles' : baseOf(s.name));
      out.push({ label: label, href: (pDirEnc || '') + s.href, ext: extOf(s.name), name: s.name });
    }
    // Stable, English-first ordering so the "s" hotkey cycles predictably.
    out.sort(function (a, b2) {
      var ae = /english/i.test(a.label) ? 0 : 1, be = /english/i.test(b2.label) ? 0 : 1;
      return ae - be || a.label.localeCompare(b2.label);
    });
    for (i = 0; i < out.length; i++) {
      if (!out[i].label || out[i].label === 'Subtitles') {
        out[i].label = 'Subtitles' + (out.length > 1 ? ' ' + (i + 1) : '');
      }
    }
    return out;
  }

  // Is this directory row a subtitle side-folder rather than real content?
  function isSubsDir(name) { return /^sub(s|titles?)?$/i.test(name); }

  // -------- movies: walk a section folder, one item per video file found ---------
  function scanMovies(section, progress) {
    var items = [];
    function walk(relPath, relEnc, depth) {
      if (progress.folders >= SCAN_MAX_FOLDERS) return Promise.resolve();
      return fetchListing(relEnc, progress).then(function (ls) {
        if (!ls) {
          if (depth === 0) section.missing = true;
          return;
        }
        section.missing = false;
        var vids = [], imgs = [], subs = [];
        ls.files.forEach(function (f) {
          var e = extOf(f.name);
          if (VIDEO_EXT[e]) vids.push(f);
          else if (IMG_EXT[e]) imgs.push(f);
          else if (SUB_EXT[e]) subs.push(f);
        });
        progress.files += ls.files.length;
        var subDirWork = [];
        ls.dirs.forEach(function (d) {
          if (isSubsDir(d.name) && vids.length) {
            subDirWork.push(fetchListing(relEnc + d.href, progress).then(function (sl) {
              if (!sl) return;
              sl.files.forEach(function (f) {
                if (SUB_EXT[extOf(f.name)]) {
                  subs.push({ name: f.name, href: d.href + f.href, size: f.size, fromSubsDir: true });
                }
              });
            }));
          }
        });
        return Promise.all(subDirWork).then(function () {
          vids.forEach(function (v) {
            var parsed = parseMovieName(v.name);
            var vb = baseOf(v.name);
            var poster = pickPoster(imgs, vb, vids.length === 1);
            var backdrop = pickBackdrop(imgs);
            items.push({
              kind: 'movie', section: section.id,
              path: relPath + v.name, enc: relEnc + v.href,
              file: v.name, ext: extOf(v.name), size: v.size, bytes: parseBytes(v.size),
              title: parsed.title, year: parsed.year, chips: parsed.chips,
              poster: poster ? relEnc + poster.href : '',
              backdrop: backdrop ? relEnc + backdrop.href : '',
              subs: matchSubs(subs, vb, vids.length === 1, relEnc)
            });
          });
          var deeper = [];
          ls.dirs.forEach(function (d) {
            if (isSubsDir(d.name)) return;
            if (depth + 1 <= SCAN_MAX_DEPTH - 1 && progress.folders < SCAN_MAX_FOLDERS) {
              deeper.push(walk(relPath + d.name + '/', relEnc + d.href, depth + 1));
            }
          });
          return Promise.all(deeper);
        });
      });
    }
    return walk(section.path + '/', encPathSegs(section.path) + '/', 0).then(function () {
      items.sort(function (a, b) { return a.title.localeCompare(b.title) || a.path.localeCompare(b.path); });
      section.items = items;
      return section;
    });
  }

  // -------- tv: folder-per-show, optional Season folders, then episode files ------
  function scanTv(section, progress) {
    var shows = [], loose = [];
    var rootEnc = encPathSegs(section.path) + '/';
    var rootPath = section.path + '/';

    function episodeFrom(showRef, relPath, relEnc, f, folderSeason, subRows, soloVideo) {
      var parsed = parseEpisodeName(f.name);
      var movieish = parseMovieName(f.name);
      var season = parsed && parsed.season !== null ? parsed.season : folderSeason;
      return {
        kind: 'episode', section: section.id,
        path: relPath + f.name, enc: relEnc + f.href,
        file: f.name, ext: extOf(f.name), size: f.size, bytes: parseBytes(f.size),
        show: showRef ? showRef.name : '', showPath: showRef ? showRef.path : '',
        season: season === undefined ? null : season,
        ep: parsed ? parsed.ep : null, ep2: parsed ? parsed.ep2 : null,
        title: (parsed && parsed.title) ? parsed.title : movieish.title,
        chips: movieish.chips,
        subs: matchSubs(subRows, baseOf(f.name), soloVideo, relEnc)
      };
    }

    function scanEpisodeFolder(showRef, relPath, relEnc, folderSeason, depth) {
      if (progress.folders >= SCAN_MAX_FOLDERS) return Promise.resolve();
      return fetchListing(relEnc, progress).then(function (ls) {
        if (!ls) return;
        var vids = [], imgs = [], subs = [];
        ls.files.forEach(function (f) {
          var e = extOf(f.name);
          if (VIDEO_EXT[e]) vids.push(f);
          else if (IMG_EXT[e]) imgs.push(f);
          else if (SUB_EXT[e]) subs.push(f);
        });
        progress.files += ls.files.length;
        if (depth === 1) {    // the show's own folder: poster + backdrop live here
          var poster = pickPoster(imgs, '', false);
          if (poster) showRef.poster = relEnc + poster.href;
          var bd = pickBackdrop(imgs);
          if (bd) showRef.backdrop = relEnc + bd.href;
        }
        var work = [];
        ls.dirs.forEach(function (d) {
          if (isSubsDir(d.name) && vids.length) {
            work.push(fetchListing(relEnc + d.href, progress).then(function (sl) {
              if (!sl) return;
              sl.files.forEach(function (f) {
                if (SUB_EXT[extOf(f.name)]) {
                  subs.push({ name: f.name, href: d.href + f.href, size: f.size, fromSubsDir: true });
                }
              });
            }));
          }
        });
        return Promise.all(work).then(function () {
          vids.forEach(function (v) {
            showRef.episodes.push(episodeFrom(showRef, relPath, relEnc, v, folderSeason, subs, vids.length === 1));
          });
          var deeper = [];
          ls.dirs.forEach(function (d) {
            if (isSubsDir(d.name)) return;
            if (depth + 1 > SCAN_MAX_DEPTH || progress.folders >= SCAN_MAX_FOLDERS) return;
            var season = parseSeasonFolder(d.name);
            deeper.push(scanEpisodeFolder(showRef, relPath + d.name + '/', relEnc + d.href,
              season !== null ? season : folderSeason, depth + 1));
          });
          return Promise.all(deeper);
        });
      });
    }

    return fetchListing(rootEnc, progress).then(function (ls) {
      if (!ls) { section.missing = true; section.items = []; section.loose = []; return section; }
      section.missing = false;
      progress.files += ls.files.length;
      var subs = ls.files.filter(function (f) { return SUB_EXT[extOf(f.name)]; });
      ls.files.forEach(function (f) {
        if (VIDEO_EXT[extOf(f.name)]) {
          loose.push(episodeFrom(null, rootPath, rootEnc, f, null, subs, false));
        }
      });
      var work = ls.dirs.map(function (d) {
        if (isSubsDir(d.name)) return Promise.resolve();
        var showTitle = parseMovieName(d.name).title || d.name;
        var showRef = {
          kind: 'show', section: section.id, name: showTitle, folder: d.name,
          path: rootPath + d.name + '/', enc: rootEnc + d.href,
          poster: '', backdrop: '', episodes: []
        };
        shows.push(showRef);
        return scanEpisodeFolder(showRef, showRef.path, showRef.enc, null, 1);
      });
      return Promise.all(work).then(function () {
        shows = shows.filter(function (s) { return s.episodes.length; });
        shows.forEach(function (s) {
          s.episodes.sort(function (a, b) {
            var as = a.season === null ? 999 : a.season, bs = b.season === null ? 999 : b.season;
            return as - bs || (a.ep || 0) - (b.ep || 0) || a.path.localeCompare(b.path);
          });
          s.epCount = s.episodes.length;
          s.bytes = s.episodes.reduce(function (n, e) { return n + e.bytes; }, 0);
          var seasons = {};
          s.episodes.forEach(function (e) { seasons[e.season === null ? '' : e.season] = 1; });
          s.seasonCount = Object.keys(seasons).length;
        });
        shows.sort(function (a, b) { return a.name.localeCompare(b.name); });
        section.items = shows;
        section.loose = loose;
        return section;
      });
    });
  }

  function encPathSegs(path) {
    return path.split('/').map(encodeURIComponent).join('/');
  }

  // ------------------------------------------------------------- library state ---
  var CONFIG = {
    title: '', tagline: '',
    sections: [
      { id: 'movies', label: 'Movies', path: 'Movies', kind: 'movies' },
      { id: 'tv', label: 'TV', path: 'TV', kind: 'tv' }
    ]
  };
  var LIB = null;          // { sections:[], byPath:{}, shows:{}, at, folders, files }
  var SCANNING = null;     // in-flight scan promise
  var scanStatus = { folders: 0, files: 0, label: '' };
  var INFO = null;         // /_qs/info payload (transport badge), or null

  function libCacheKey() { return SS_LIBRARY + location.pathname; }

  function indexLibrary(lib) {
    lib.byPath = {}; lib.shows = {};
    lib.sections.forEach(function (sec) {
      (sec.items || []).forEach(function (it) {
        if (it.kind === 'show') {
          lib.shows[it.path] = it;
          it.episodes.forEach(function (e) { lib.byPath[e.path] = e; });
        } else {
          lib.byPath[it.path] = it;
        }
      });
      (sec.loose || []).forEach(function (e) { lib.byPath[e.path] = e; });
    });
    return lib;
  }

  function scanLibrary(force) {
    if (SCANNING) return SCANNING;
    if (!force) {
      try {
        var cached = JSON.parse(sessionStorage.getItem(libCacheKey()) || 'null');
        if (cached && cached.sections) {
          LIB = indexLibrary(cached);
          return Promise.resolve(LIB);
        }
      } catch (e) { /* fall through to a real scan */ }
    }
    scanStatus.folders = 0; scanStatus.files = 0;
    var lib = { sections: [], at: Date.now() };
    SCANNING = Promise.all(CONFIG.sections.map(function (cfg) {
      var section = {
        id: cfg.id, label: cfg.label, path: cfg.path, kind: cfg.kind,
        items: [], loose: [], missing: false
      };
      lib.sections.push(section);
      scanStatus.label = cfg.label;
      return cfg.kind === 'tv' ? scanTv(section, scanStatus) : scanMovies(section, scanStatus);
    })).then(function () {
      lib.folders = scanStatus.folders; lib.files = scanStatus.files;
      LIB = indexLibrary(lib);
      SCANNING = null;
      try {
        var slim = { sections: lib.sections, at: lib.at, folders: lib.folders, files: lib.files };
        sessionStorage.setItem(libCacheKey(), JSON.stringify(slim));
      } catch (e) { /* a giant library may not fit; scanning again is fine */ }
      return LIB;
    }, function (err) {
      SCANNING = null;
      throw err;
    });
    return SCANNING;
  }

  // ------------------------------------------------------------- progress store ---
  function progAll() { return lsGet(LS_PROGRESS, {}); }
  function progGet(path) { return progAll()[path] || null; }
  function progSet(path, rec) {
    var all = progAll();
    all[path] = rec;
    var keys = Object.keys(all);
    if (keys.length > 300) {        // keep the store bounded: oldest-touched leave first
      keys.sort(function (a, b) { return (all[a].at || 0) - (all[b].at || 0); });
      keys.slice(0, keys.length - 300).forEach(function (k) { delete all[k]; });
    }
    lsSet(LS_PROGRESS, all);
  }
  function progClear(path) {
    var all = progAll();
    delete all[path];
    lsSet(LS_PROGRESS, all);
  }
  function progPct(rec) {
    if (!rec || !rec.d) return 0;
    return Math.max(0, Math.min(100, rec.t / rec.d * 100));
  }

  // ------------------------------------------------------------------- router ---
  var currentCleanup = null;

  function go(hash) { location.hash = hash; }

  function parseHash() {
    var h = location.hash.replace(/^#\/?/, '');
    if (!h) return { name: 'home' };
    var seg = h.split('/');
    if (seg[0] === 's' && seg[1]) return { name: 'section', id: seg[1] };
    if (seg[0] === 'show' && seg[1]) return { name: 'show', path: decodeHashPart(seg.slice(1).join('/')) };
    if (seg[0] === 'play' && seg[1]) return { name: 'play', path: decodeHashPart(seg.slice(1).join('/')) };
    if (seg[0] === 'search') return { name: 'search', q: decodeHashPart(seg.slice(1).join('/')) };
    if (seg[0] === 'help') return { name: 'help' };
    return { name: 'home' };
  }
  function decodeHashPart(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }
  function playHref(item) { return '#/play/' + encodeURIComponent(item.path); }
  function showHref(show) { return '#/show/' + encodeURIComponent(show.path); }

  function render() {
    if (currentCleanup) { try { currentCleanup(); } catch (e) { /* view teardown must never wedge the router */ } }
    currentCleanup = null;
    var r = parseHash();
    paintNav(r);
    window.scrollTo(0, 0);
    if (!LIB) {
      renderScanning();
      scanLibrary(false).then(function () { render(); }, function () { renderScanFailed(); });
      return;
    }
    if (r.name === 'home') return vHome();
    if (r.name === 'section') return vSection(r.id);
    if (r.name === 'show') return vShow(r.path);
    if (r.name === 'play') return vPlay(r.path);
    if (r.name === 'search') return vSearch(r.q || '');
    if (r.name === 'help') return vHelp();
    return vHome();
  }

  function paintNav(r) {
    var links = [{ id: '', label: 'Home', href: '#/' }];
    CONFIG.sections.forEach(function (s) {
      links.push({ id: 's/' + s.id, label: s.label, href: '#/s/' + s.id, active: r.name === 'section' && r.id === s.id });
    });
    links[0].active = r.name === 'home';
    navEl.innerHTML = links.map(function (l) {
      return '<a class="nav-link' + (l.active ? ' on' : '') + '" href="' + l.href + '">' + esc(l.label) + '</a>';
    }).join('');
  }

  function setTitle(t) {
    var app = CONFIG.title || 'No Cloud Media Center';
    document.title = t ? t + ' · ' + app : app;
  }

  // ------------------------------------------------------------------ toasts ---
  var toastTimer = null;
  function toast(msg, ms) {
    var el = $('#toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast'; el.className = 'toast'; el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, ms || 2600);
  }

  function copyText(txt, okMsg) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = txt; ta.className = 'copy-src'; ta.setAttribute('readonly', '');
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { /* clipboard denied */ }
      document.body.removeChild(ta);
      toast(ok ? okMsg : 'Copy failed - the URL is: ' + txt, ok ? 2600 : 6000);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { toast(okMsg); }, fallback);
    } else fallback();
  }

  // ------------------------------------------------------------- view: pieces ---
  // pExtra rides INSIDE the poster box (progress bars etc.), so absolute children
  // anchor to the artwork rather than to the whole card.
  function posterHtml(item, cls, pExtra) {
    var title = item.kind === 'show' ? item.name : item.title;
    if (item.poster) {
      return '<span class="poster ' + (cls || '') + '"><img loading="lazy" src="' +
        esc(item.poster) + '" alt="">' + (pExtra || '') + '</span>';
    }
    return '<span class="poster pgen ph' + hashHue(title) + ' ' + (cls || '') + '">' +
      '<span class="p-init" aria-hidden="true">' + esc(initialsOf(title)) + '</span>' +
      '<span class="p-name">' + esc(title) + '</span>' + (pExtra || '') + '</span>';
  }

  function cardHtml(item) {
    var rec = progGet(item.path);
    var sub = [];
    if (item.year) sub.push(item.year);
    if (item.size) sub.push(item.size);
    var watched = rec && rec.done;
    var prog = rec && !rec.done && progPct(rec) > 1
      ? '<span class="c-prog"><span class="c-prog-b" data-prog="' + progPct(rec).toFixed(1) + '"></span></span>' : '';
    return '<a class="card" href="' + playHref(item) + '" data-path="' + esc(item.path) + '">' +
      posterHtml(item, '', prog) +
      '<span class="c-play">' + icon('play') + '</span>' +
      (watched ? '<span class="c-done" title="Watched">' + icon('check') + '</span>' : '') +
      '<span class="c-title">' + esc(item.title) + '</span>' +
      (sub.length ? '<span class="c-sub">' + esc(sub.join(' · ')) + '</span>' : '') +
      '</a>';
  }

  function showCardHtml(show) {
    var eps = show.epCount + ' episode' + (show.epCount === 1 ? '' : 's');
    var seasons = show.seasonCount > 1 ? show.seasonCount + ' seasons · ' : '';
    return '<a class="card" href="' + showHref(show) + '">' +
      posterHtml(show) +
      '<span class="c-play">' + icon('tv') + '</span>' +
      '<span class="c-title">' + esc(show.name) + '</span>' +
      '<span class="c-sub">' + esc(seasons + eps) + '</span>' +
      '</a>';
  }

  function episodeRowHtml(ep, opts) {
    var rec = progGet(ep.path);
    var code = epCode(ep);
    var meta = [];
    if (ep.size) meta.push(ep.size);
    if (ep.chips && ep.chips.length) meta.push(ep.chips.join(' · '));
    var pct = rec && !rec.done ? progPct(rec) : 0;
    return '<a class="ep' + (rec && rec.done ? ' seen' : '') + '" href="' + playHref(ep) + '">' +
      '<span class="ep-no">' + (ep.ep !== null && ep.ep !== undefined ? 'E' + ep.ep + (ep.ep2 ? '–' + ep.ep2 : '') : icon('play')) + '</span>' +
      '<span class="ep-body"><span class="ep-t">' +
      esc(ep.title || ep.file) + '</span>' +
      '<span class="ep-m">' + esc((opts && opts.withShow && ep.show ? ep.show + ' · ' : '') + (code ? code + ' · ' : '') + meta.join(' · ')) + '</span>' +
      (pct > 1 ? '<span class="ep-prog"><span class="ep-prog-b" data-prog="' + pct.toFixed(1) + '"></span></span>' : '') +
      '</span>' +
      '<span class="ep-go">' + (rec && rec.done ? icon('check') : icon('play')) + '</span>' +
      '</a>';
  }

  // Continue-watching entries: not finished, more than a toe in, still in the library.
  function continueList(limit) {
    if (!LIB) return [];
    var all = progAll();
    var rows = [];
    Object.keys(all).forEach(function (path) {
      var rec = all[path];
      if (rec.done || !rec.d || rec.t < 30 || progPct(rec) > 96) return;
      var item = LIB.byPath[path];
      if (!item) return;
      rows.push({ item: item, rec: rec });
    });
    rows.sort(function (a, b) { return (b.rec.at || 0) - (a.rec.at || 0); });
    return rows.slice(0, limit || 12);
  }

  function continueCardHtml(row) {
    var item = row.item, rec = row.rec;
    var label = item.kind === 'episode'
      ? (item.show ? item.show : item.title)
      : item.title;
    var sub = item.kind === 'episode'
      ? epCode(item) + (item.title ? ' · ' + item.title : '')
      : (item.year || '');
    var left = rec.d ? fmtLeft(rec.d - rec.t) : '';
    return '<a class="ccard" href="' + playHref(item) + '">' +
      posterHtml(item, 'wide') +
      '<span class="cc-body"><span class="cc-t">' + esc(label) + '</span>' +
      (sub ? '<span class="cc-s">' + esc(sub) + '</span>' : '') +
      '<span class="cc-left">' + icon('clock') + esc(left) + '</span>' +
      '<span class="cc-prog"><span class="cc-prog-b" data-prog="' + progPct(rec).toFixed(1) + '"></span></span></span>' +
      '<span class="c-play">' + icon('play') + '</span>' +
      '</a>';
  }

  // After any innerHTML pass: progress-bar widths land through the CSSOM (a style=""
  // attribute in markup would die under a strict CSP; element.style assignment is fine).
  function paintProgressBars(root) {
    $all('[data-prog]', root).forEach(function (el) {
      el.style.width = el.getAttribute('data-prog') + '%';
    });
  }

  function emptySectionHtml(section) {
    var isTv = section.kind === 'tv';
    var mk = section.missing;
    var head = mk
      ? 'The folder "' + section.path + '" was not found in the share'
      : 'Nothing in "' + section.path + '" yet';
    var layout = isTv
      ? section.path + '/\n  The Expanse/\n    Season 1/\n      The.Expanse.S01E01.mkv\n      The.Expanse.S01E01.en.srt\n  Fawlty Towers/\n    Fawlty.Towers.1x01.mp4'
      : section.path + '/\n  Inception (2010).mkv\n  The Iron Giant (1999)/\n    The.Iron.Giant.1999.1080p.mkv\n    poster.jpg';
    return '<div class="panel pad empty">' +
      '<h2>' + icon(isTv ? 'tv' : 'film') + ' ' + esc(head) + '</h2>' +
      '<ol class="steps">' +
      '<li>On the host computer, open the folder you are sharing with <b>No Cloud Quick Share</b>.</li>' +
      (mk ? '<li>Create a folder named <b>' + esc(section.path) + '</b> inside it (or point this section elsewhere in <code>library.json</code>).</li>' : '') +
      '<li>Drop your ' + (isTv ? 'shows' : 'movies') + ' in, like this:<pre class="code">' + esc(layout) + '</pre></li>' +
      '<li>Come back here and press <b>Rescan</b> ' + icon('refresh') + ' in the top bar.</li>' +
      '</ol>' +
      '<p class="dim">Files can also be added from another device on the LAN: the host&rsquo;s optional ' +
      '<b>web editor</b> (enable it in the sharing window, then open <code>/_edit</code>) uploads ' +
      'straight into the shared folder.</p>' +
      '</div>';
  }

  // -------------------------------------------------------------- view: home ---
  function vHome() {
    setTitle('');
    var cont = continueList(12);
    var html = '';
    var heroTitle = CONFIG.title || 'Your library';
    var heroTag = CONFIG.tagline ||
      'Streaming from the shared folder, across your own network. Nothing leaves the house.';
    html += '<section class="home-hero"><h1>' + esc(heroTitle) + '</h1><p class="dim">' + esc(heroTag) + '</p></section>';

    if (cont.length) {
      html += '<section class="rowsec"><h2>' + icon('clock') + ' Continue watching</h2>' +
        '<div class="hscroll">' + cont.map(continueCardHtml).join('') + '</div></section>';
    }

    LIB.sections.forEach(function (sec) {
      var items = sec.items || [];
      var stat;
      if (sec.kind === 'tv') {
        var eps = items.reduce(function (n, s) { return n + s.epCount; }, 0) + (sec.loose ? sec.loose.length : 0);
        stat = items.length + ' show' + (items.length === 1 ? '' : 's') + ' · ' + eps + ' episodes';
      } else {
        var bytes = items.reduce(function (n, m) { return n + m.bytes; }, 0);
        stat = items.length + ' film' + (items.length === 1 ? '' : 's') + (bytes ? ' · ' + fmtBytes(bytes) : '');
      }
      html += '<section class="rowsec"><h2>' + icon(sec.kind === 'tv' ? 'tv' : 'film') + ' ' +
        esc(sec.label) + ' <span class="h-stat">' + esc(stat) + '</span>' +
        '<a class="h-all" href="#/s/' + esc(sec.id) + '">See all &rarr;</a></h2>';
      if (!items.length && !(sec.loose && sec.loose.length)) {
        html += emptySectionHtml(sec);
      } else {
        var strip = items.slice(0, 14);
        html += '<div class="hscroll">' +
          strip.map(sec.kind === 'tv' ? showCardHtml : cardHtml).join('') +
          '</div>';
      }
      html += '</section>';
    });

    html += '<section class="panel pad meta-line">' + icon('info') +
      '<span>Scanned <b>' + LIB.files + '</b> files in <b>' + LIB.folders + '</b> folders' +
      (LIB.at ? ', ' + esc(agoLabel(LIB.at)) : '') +
      '. Add or rename media on the host, then press Rescan.</span></section>';

    view.innerHTML = html;
    paintProgressBars(view);
  }

  function agoLabel(at) {
    var s = Math.max(0, (Date.now() - at) / 1000);
    if (s < 90) return 'just now';
    if (s < 5400) return Math.round(s / 60) + ' min ago';
    return Math.round(s / 3600) + ' h ago';
  }

  // ----------------------------------------------------------- view: section ---
  function vSection(id) {
    var sec = null;
    LIB.sections.forEach(function (s) { if (s.id === id) sec = s; });
    if (!sec) { view.innerHTML = '<div class="panel pad">Unknown section.</div>'; return; }
    setTitle(sec.label);

    var items = sec.items || [];
    var sorts = lsGet(LS_SORT, {});
    var modes = lsGet(LS_VIEWMODE, {});
    var sort = sorts[id] || 'title';
    var mode = modes[id] || 'grid';
    var isTv = sec.kind === 'tv';

    function sortItems(arr) {
      var a = arr.slice();
      if (sort === 'year' && !isTv) {
        a.sort(function (x, y) { return (y.year || '0') - (x.year || '0') || x.title.localeCompare(y.title); });
      } else if (sort === 'size') {
        a.sort(function (x, y) { return (y.bytes || 0) - (x.bytes || 0); });
      } else {
        a.sort(function (x, y) { return (isTv ? x.name : x.title).localeCompare(isTv ? y.name : y.title); });
      }
      return a;
    }

    var html = '<section class="sec-head"><h1>' + icon(isTv ? 'tv' : 'film') + ' ' + esc(sec.label) + '</h1>' +
      '<div class="sec-tools">' +
      '<label class="sel-wrap">' + icon('gauge') + '<select id="sortSel" aria-label="Sort by">' +
      '<option value="title"' + (sort === 'title' ? ' selected' : '') + '>A&ndash;Z</option>' +
      (!isTv ? '<option value="year"' + (sort === 'year' ? ' selected' : '') + '>Newest year</option>' : '') +
      '<option value="size"' + (sort === 'size' ? ' selected' : '') + '>Largest</option>' +
      '</select></label>' +
      (!isTv ? '<button id="shuffleBtn" class="btn ghost" type="button" title="Play something at random">' + icon('shuffle') + ' Surprise me</button>' : '') +
      '<button id="modeBtn" class="icon-btn" type="button" title="Toggle grid / list view" aria-label="Toggle grid or list view">' +
      icon(mode === 'grid' ? 'list' : 'grid') + '</button>' +
      '</div></section>';

    if (!items.length && !(sec.loose && sec.loose.length)) {
      html += emptySectionHtml(sec);
      view.innerHTML = html;
      return;
    }

    var sorted = sortItems(items);
    if (mode === 'list' && !isTv) {
      html += '<div class="rows">' + sorted.map(function (m) {
        var rec = progGet(m.path);
        return '<a class="ep' + (rec && rec.done ? ' seen' : '') + '" href="' + playHref(m) + '">' +
          '<span class="ep-no">' + icon('film') + '</span>' +
          '<span class="ep-body"><span class="ep-t">' + esc(m.title) + (m.year ? ' <i class="yr">(' + m.year + ')</i>' : '') + '</span>' +
          '<span class="ep-m">' + esc([m.size, m.chips.join(' · '), m.ext.toUpperCase()].filter(Boolean).join(' · ')) + '</span>' +
          (rec && !rec.done && progPct(rec) > 1 ? '<span class="ep-prog"><span class="ep-prog-b" data-prog="' + progPct(rec).toFixed(1) + '"></span></span>' : '') +
          '</span><span class="ep-go">' + (rec && rec.done ? icon('check') : icon('play')) + '</span></a>';
      }).join('') + '</div>';
    } else {
      html += '<div class="grid">' + sorted.map(isTv ? showCardHtml : cardHtml).join('') + '</div>';
    }

    if (isTv && sec.loose && sec.loose.length) {
      html += '<section class="rowsec"><h2>' + icon('folder') + ' Loose episodes <span class="h-stat">files sitting directly in ' +
        esc(sec.path) + '/</span></h2><div class="rows">' +
        sec.loose.map(function (e) { return episodeRowHtml(e, {}); }).join('') + '</div></section>';
    }

    view.innerHTML = html;
    paintProgressBars(view);

    var sortSel = $('#sortSel');
    if (sortSel) sortSel.addEventListener('change', function () {
      sorts[id] = sortSel.value; lsSet(LS_SORT, sorts); render();
    });
    var modeBtn = $('#modeBtn');
    if (modeBtn) modeBtn.addEventListener('click', function () {
      modes[id] = mode === 'grid' ? 'list' : 'grid'; lsSet(LS_VIEWMODE, modes); render();
    });
    var shuffleBtn = $('#shuffleBtn');
    if (shuffleBtn) shuffleBtn.addEventListener('click', function () {
      var pool = items.filter(function (m) { var r = progGet(m.path); return !(r && r.done); });
      if (!pool.length) pool = items;
      if (pool.length) go(playHref(pool[Math.floor(Math.random() * pool.length)]).slice(1));
    });
  }

  // -------------------------------------------------------------- view: show ---
  function vShow(path) {
    var show = LIB.shows[path];
    if (!show) {
      view.innerHTML = '<div class="panel pad">That show is not in the current scan. ' +
        '<a href="#/">Back home</a> or press Rescan.</div>';
      return;
    }
    setTitle(show.name);
    var seasons = {};   // season key -> episodes
    show.episodes.forEach(function (e) {
      var k = e.season === null ? '' : String(e.season);
      (seasons[k] = seasons[k] || []).push(e);
    });
    var keys = Object.keys(seasons).sort(function (a, b) {
      if (a === '') return 1;
      if (b === '') return -1;
      return (+a) - (+b);
    });

    // "Next up": the first not-done episode in order (or the most recently started).
    var nextUp = null;
    for (var i = 0; i < show.episodes.length; i++) {
      var rec = progGet(show.episodes[i].path);
      if (!rec || !rec.done) { nextUp = show.episodes[i]; break; }
    }

    var html = '<section class="show-hero">' +
      posterHtml(show, 'hero') +
      '<div class="show-hero-body"><h1>' + esc(show.name) + '</h1>' +
      '<p class="dim">' + show.epCount + ' episode' + (show.epCount === 1 ? '' : 's') +
      (show.seasonCount > 1 ? ' · ' + show.seasonCount + ' seasons' : '') +
      (show.bytes ? ' · ' + fmtBytes(show.bytes) : '') + '</p>' +
      (nextUp ? '<a class="btn primary" href="' + playHref(nextUp) + '">' + icon('play') + ' ' +
        (progGet(nextUp.path) ? 'Continue' : 'Start watching') + ' ' + esc(epCode(nextUp) || nextUp.title || '') + '</a>' : '') +
      '</div></section>';

    keys.forEach(function (k) {
      var label = k === '' ? 'Episodes' : (k === '0' ? 'Specials' : 'Season ' + k);
      html += '<section class="rowsec"><h2>' + esc(label) +
        ' <span class="h-stat">' + seasons[k].length + ' episode' + (seasons[k].length === 1 ? '' : 's') + '</span></h2>' +
        '<div class="rows">' + seasons[k].map(function (e) { return episodeRowHtml(e, {}); }).join('') + '</div></section>';
    });

    view.innerHTML = html;
    paintProgressBars(view);
  }

  // ------------------------------------------------------------ view: search ---
  function searchLibrary(q) {
    var needle = q.trim().toLowerCase();
    if (!needle) return { movies: [], shows: [], episodes: [] };
    function score(text) {
      var t = text.toLowerCase();
      if (t === needle) return 0;
      if (t.indexOf(needle) === 0) return 1;
      if (t.indexOf(needle) !== -1) return 2;
      return -1;
    }
    var movies = [], shows = [], episodes = [];
    LIB.sections.forEach(function (sec) {
      (sec.items || []).forEach(function (it) {
        if (it.kind === 'show') {
          var s = score(it.name);
          if (s >= 0) shows.push({ s: s, it: it });
          it.episodes.forEach(function (e) {
            var se = score((e.title || '') + ' ' + e.file + ' ' + epCode(e));
            if (se >= 0) episodes.push({ s: se, it: e });
          });
        } else {
          var sm = score(it.title + ' ' + it.file + ' ' + (it.year || ''));
          if (sm >= 0) movies.push({ s: sm, it: it });
        }
      });
      (sec.loose || []).forEach(function (e) {
        var se = score((e.title || '') + ' ' + e.file);
        if (se >= 0) episodes.push({ s: se, it: e });
      });
    });
    function bySc(a, b) { return a.s - b.s; }
    return {
      movies: movies.sort(bySc).map(function (r) { return r.it; }),
      shows: shows.sort(bySc).map(function (r) { return r.it; }),
      episodes: episodes.sort(bySc).slice(0, 60).map(function (r) { return r.it; })
    };
  }

  function vSearch(q) {
    setTitle(q ? 'Search: ' + q : 'Search');
    var box = $('#searchBox');
    if (box && box.value !== q) box.value = q;
    var res = searchLibrary(q);
    var total = res.movies.length + res.shows.length + res.episodes.length;
    var html = '<section class="sec-head"><h1>' + icon('search') + ' ' +
      (q ? 'Results for &ldquo;' + esc(q) + '&rdquo; <span class="h-stat">' + total + ' match' + (total === 1 ? '' : 'es') + '</span>'
         : 'Search') + '</h1></section>';
    if (!q) {
      html += '<div class="panel pad dim">Type in the search box above - titles, years, episode codes (S02E04) and file names all match.</div>';
    } else if (!total) {
      html += '<div class="panel pad dim">No matches. The scan only sees what is in the media folders right now - press Rescan if you just added files.</div>';
    }
    if (res.movies.length) {
      html += '<section class="rowsec"><h2>' + icon('film') + ' Movies</h2><div class="grid">' +
        res.movies.map(cardHtml).join('') + '</div></section>';
    }
    if (res.shows.length) {
      html += '<section class="rowsec"><h2>' + icon('tv') + ' Shows</h2><div class="grid">' +
        res.shows.map(showCardHtml).join('') + '</div></section>';
    }
    if (res.episodes.length) {
      html += '<section class="rowsec"><h2>' + icon('play') + ' Episodes</h2><div class="rows">' +
        res.episodes.map(function (e) { return episodeRowHtml(e, { withShow: true }); }).join('') + '</div></section>';
    }
    view.innerHTML = html;
    paintProgressBars(view);
  }

  // ------------------------------------------------------------- view: play ---
  // The heart of the app: a custom player over one <video>. All controls are our
  // own (buttons + a pointer-driven seek bar), subtitles render into an overlay div,
  // and every stream/seek is a plain HTTP Range request answered by the host.
  function vPlay(path) {
    var item = LIB.byPath[path];
    if (!item) {
      view.innerHTML = '<div class="panel pad">That file is not in the current scan. ' +
        'It may have been renamed on the host. <a href="#/">Back home</a> or press Rescan.</div>';
      return;
    }
    setTitle(item.kind === 'episode' ? (item.show ? item.show + ' ' + epCode(item) : item.title) : item.title);

    var show = item.kind === 'episode' && item.showPath ? LIB.shows[item.showPath] : null;
    var epIdx = -1, nextEp = null;
    if (show) {
      show.episodes.forEach(function (e, i) { if (e.path === item.path) epIdx = i; });
      if (epIdx >= 0 && epIdx + 1 < show.episodes.length) nextEp = show.episodes[epIdx + 1];
    }

    var backHref = show ? showHref(show) : (item.section ? '#/s/' + item.section : '#/');
    var chips = (item.chips || []).slice();
    chips.push(item.ext.toUpperCase());
    if (PLAYABILITY[item.ext] === 1) chips.push('may not play in every browser');
    var headTitle = item.kind === 'episode'
      ? (item.show ? item.show : 'Episode')
      : item.title + (item.year ? ' (' + item.year + ')' : '');
    var headSub = item.kind === 'episode'
      ? (epCode(item) + (item.title ? ' · ' + item.title : ''))
      : '';

    var html = '<div class="player">' +
      '<div class="p-top"><a class="btn ghost" href="' + backHref + '">' + icon('left') + ' Back</a>' +
      '<div class="p-head"><h1>' + esc(headTitle) + '</h1>' +
      (headSub ? '<span class="p-sub">' + esc(headSub) + '</span>' : '') + '</div></div>' +

      '<div class="stage" id="stage">' +
      '<video id="vid" preload="metadata" playsinline' +
      (item.backdrop || item.poster ? ' poster="' + esc(item.backdrop || item.poster) + '"' : '') +
      ' src="' + esc(item.enc) + '"></video>' +
      '<div class="sub-layer" id="subLayer" aria-live="off"></div>' +
      '<div class="stage-note" id="stageNote" hidden></div>' +
      '<div class="next-over" id="nextOver" hidden></div>' +
      '<div class="ctl" id="ctl">' +
      '<div class="seek" id="seek" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">' +
      '<span class="seek-buf" id="seekBuf"></span><span class="seek-fill" id="seekFill"></span><span class="seek-thumb" id="seekThumb"></span>' +
      '</div>' +
      '<div class="ctl-row">' +
      '<button class="cbtn" id="playBtn" type="button" aria-label="Play or pause (space)">' + icon('play') + '</button>' +
      '<button class="cbtn" id="backBtn" type="button" aria-label="Back 10 seconds (left arrow)">' + icon('back10') + '</button>' +
      '<button class="cbtn" id="fwdBtn" type="button" aria-label="Forward 10 seconds (right arrow)">' + icon('fwd10') + '</button>' +
      (nextEp ? '<button class="cbtn" id="nextBtn" type="button" aria-label="Next episode (n)">' + icon('next') + '</button>' : '') +
      '<span class="ctl-time" id="timeLbl">0:00 / 0:00</span>' +
      '<span class="ctl-spacer"></span>' +
      (item.subs && item.subs.length ? '<button class="cbtn" id="subBtn" type="button" aria-label="Subtitles (s)" title="Subtitles">' + icon('cc') + '</button>' : '') +
      '<button class="cbtn" id="rateBtn" type="button" aria-label="Playback speed" title="Playback speed"><span class="rate-lbl">1&times;</span></button>' +
      '<button class="cbtn" id="muteBtn" type="button" aria-label="Mute (m)">' + icon('vol') + '</button>' +
      '<input class="vol" id="volSlider" type="range" min="0" max="100" step="1" value="100" aria-label="Volume">' +
      '<button class="cbtn" id="fullBtn" type="button" aria-label="Fullscreen (f)">' + icon('full') + '</button>' +
      '</div></div>' +
      '<div class="ctl-menu" id="ctlMenu" hidden></div>' +
      '</div>' +

      '<div class="p-meta panel pad">' +
      '<div class="p-chips">' + chips.map(function (c) { return '<span class="chip">' + esc(c) + '</span>'; }).join('') +
      (item.size ? '<span class="chip dim-chip">' + esc(item.size) + '</span>' : '') + '</div>' +
      '<div class="p-actions">' +
      '<a class="btn ghost" href="' + esc(dlHref(item.enc)) + '">' + icon('down') + ' Download</a>' +
      '<button class="btn ghost" id="copyBtn" type="button" title="Copy a direct stream URL for VLC or mpv">' + icon('link') + ' Copy stream URL</button>' +
      '</div>' +
      '<p class="p-file dim">' + icon('folder') + ' <code>' + esc(item.path) + '</code></p>' +
      '</div>' +
      (show ? '<section class="rowsec" id="upNextSec"><h2>' + icon('tv') + ' ' + esc(show.name) +
        ' <span class="h-stat">episode ' + (epIdx + 1) + ' of ' + show.episodes.length + '</span></h2><div class="rows">' +
        show.episodes.map(function (e) {
          return e.path === item.path
            ? '<span class="ep now">' + '<span class="ep-no">' + icon('play') + '</span><span class="ep-body"><span class="ep-t">' +
              esc(e.title || e.file) + '</span><span class="ep-m">Now playing</span></span></span>'
            : episodeRowHtml(e, {});
        }).join('') + '</div></section>' : '') +
      '</div>';

    view.innerHTML = html;
    paintProgressBars(view);

    // ------------------------------------------------ the player wiring ----
    var vid = $('#vid'), stage = $('#stage'), ctl = $('#ctl');
    var playBtn = $('#playBtn'), timeLbl = $('#timeLbl'), rateBtn = $('#rateBtn');
    var muteBtn = $('#muteBtn'), volSlider = $('#volSlider'), fullBtn = $('#fullBtn');
    var seek = $('#seek'), seekFill = $('#seekFill'), seekBuf = $('#seekBuf'), seekThumb = $('#seekThumb');
    var subLayer = $('#subLayer'), stageNote = $('#stageNote'), nextOver = $('#nextOver');
    var ctlMenu = $('#ctlMenu');
    var disposed = false, idleTimer = null, saveTimer = null, rafId = 0;
    var cues = null, cueIdx = 0, activeSub = -1, wakeLock = null, nextTimer = null;

    var vol = lsGet(LS_VOLUME, { v: 1, muted: false });
    vid.volume = Math.max(0, Math.min(1, vol.v));
    vid.muted = !!vol.muted;
    volSlider.value = String(Math.round(vid.volume * 100));

    function setIcon(btn, name) { btn.innerHTML = icon(name); }

    function persistVolume() { lsSet(LS_VOLUME, { v: vid.volume, muted: vid.muted }); }

    function saveProgress(final) {
      if (!vid.duration || !isFinite(vid.duration)) return;
      var t = vid.currentTime, d = vid.duration;
      if (t / d > 0.96 || (final && vid.ended)) {
        progSet(item.path, { t: 0, d: d, at: Date.now(), done: true });
      } else if (t > 15) {
        progSet(item.path, { t: t, d: d, at: Date.now(), done: false });
      }
    }

    function togglePlay() { if (vid.paused) vid.play(); else vid.pause(); }
    function seekBy(dt) {
      if (!vid.duration) return;
      vid.currentTime = Math.max(0, Math.min(vid.duration, vid.currentTime + dt));
      wake();
    }

    // ------- controls visibility: fade when idle over a PLAYING video -------
    function wake() {
      stage.classList.remove('idle');
      clearTimeout(idleTimer);
      idleTimer = setTimeout(function () {
        if (!vid.paused && !ctlMenu.matches(':not([hidden])')) stage.classList.add('idle');
      }, 2800);
    }

    // -------------------------------------------------- seek bar painting ---
    function paintSeek() {
      if (vid.duration) {
        var pct = vid.currentTime / vid.duration * 100;
        seekFill.style.width = pct + '%';
        seekThumb.style.left = pct + '%';
        seek.setAttribute('aria-valuenow', pct.toFixed(1));
        seek.setAttribute('aria-valuetext', fmtTime(vid.currentTime) + ' of ' + fmtTime(vid.duration));
        try {
          if (vid.buffered.length) {
            // paint the range the playhead sits in (the one that matters visually)
            var i, s, e2, bufEnd = 0;
            for (i = 0; i < vid.buffered.length; i++) {
              s = vid.buffered.start(i); e2 = vid.buffered.end(i);
              if (vid.currentTime >= s - 0.5 && vid.currentTime <= e2 + 0.5) { bufEnd = e2; break; }
              if (e2 > bufEnd) bufEnd = e2;
            }
            seekBuf.style.width = (bufEnd / vid.duration * 100) + '%';
          }
        } catch (e) { /* buffered can throw mid-teardown */ }
        timeLbl.textContent = fmtTime(vid.currentTime) + ' / ' + fmtTime(vid.duration);
      }
    }

    function seekFromPointer(ev) {
      var r = seek.getBoundingClientRect();
      var x = (ev.touches && ev.touches[0] ? ev.touches[0].clientX : ev.clientX) - r.left;
      var f = Math.max(0, Math.min(1, x / r.width));
      if (vid.duration) vid.currentTime = f * vid.duration;
      paintSeek();
    }
    var seekDrag = false;
    seek.addEventListener('pointerdown', function (ev) {
      seekDrag = true; seek.setPointerCapture(ev.pointerId); seekFromPointer(ev); wake();
    });
    seek.addEventListener('pointermove', function (ev) { if (seekDrag) seekFromPointer(ev); });
    seek.addEventListener('pointerup', function () { seekDrag = false; });
    seek.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowLeft') { seekBy(-10); ev.preventDefault(); }
      if (ev.key === 'ArrowRight') { seekBy(10); ev.preventDefault(); }
    });

    // ------------------------------------------------------- subtitles -----
    // Parse SRT and VTT into one cue list. Cue text is escaped, then the harmless
    // inline tags (<i> <b> <u>) are re-enabled; ASS-style {\...} runs are dropped.
    function parseSubText(text) {
      var t = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
      var isVtt = /^WEBVTT/.test(t);
      var blocks = t.split(/\n{2,}/);
      var out = [];
      var timeRe = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
      blocks.forEach(function (b) {
        var lines = b.split('\n').filter(function (l) { return l.trim() !== ''; });
        if (!lines.length) return;
        if (isVtt && (/^WEBVTT/.test(lines[0]) || /^(NOTE|STYLE|REGION)\b/.test(lines[0]))) return;
        var ti = -1, m = null, i;
        for (i = 0; i < lines.length && i < 2; i++) {
          m = timeRe.exec(lines[i]);
          if (m) { ti = i; break; }
        }
        if (ti === -1) return;
        var start = (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (+((m[4] + '00').slice(0, 3))) / 1000;
        var end = (+(m[5] || 0)) * 3600 + (+m[6]) * 60 + (+m[7]) + (+((m[8] + '00').slice(0, 3))) / 1000;
        var body = lines.slice(ti + 1).join('\n')
          .replace(/\{\\[^}]*\}/g, '')
          .replace(/<\/?(?:font|c|v|ruby|rt|lang)[^>]*>/gi, '');
        var safe = esc(body)
          .replace(/&lt;(\/?)(i|b|u)&gt;/gi, '<$1$2>')
          .replace(/\n/g, '<br>');
        if (end > start && safe) out.push({ s: start, e: end, html: safe });
      });
      out.sort(function (a, b) { return a.s - b.s; });
      return out;
    }

    function paintCues() {
      if (!cues) { subLayer.innerHTML = ''; return; }
      var t = vid.currentTime, active = [], i;
      // cueIdx is a moving cursor; a big seek resets it below
      if (cueIdx > 0 && cues[cueIdx - 1] && cues[cueIdx - 1].s > t) cueIdx = 0;
      for (i = cueIdx; i < cues.length; i++) {
        if (cues[i].s > t) break;
        if (cues[i].e > t) active.push(cues[i].html);
        else if (i === cueIdx) cueIdx++;
      }
      var htmlNow = active.length ? '<span class="cue">' + active.join('<br>') + '</span>' : '';
      if (subLayer.innerHTML !== htmlNow) subLayer.innerHTML = htmlNow;
    }

    function selectSub(idx) {
      activeSub = idx;
      cues = null; cueIdx = 0; subLayer.innerHTML = '';
      if (idx < 0) { toast('Subtitles off'); return; }
      var sub = item.subs[idx];
      fetch(sub.href).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      }).then(function (text) {
        if (disposed || activeSub !== idx) return;
        cues = parseSubText(text);
        cueIdx = 0;
        toast(cues.length ? sub.label + ' · ' + cues.length + ' cues' : 'No cues found in ' + sub.name);
        paintCues();
      }).catch(function () {
        if (!disposed) toast('Could not load ' + sub.name);
      });
    }

    // ----------------------------------------------------- small menus -----
    function closeMenu() { ctlMenu.hidden = true; ctlMenu.innerHTML = ''; }
    function openMenu(items2, anchor) {
      ctlMenu.innerHTML = items2.map(function (m, i) {
        return '<button type="button" class="menu-it' + (m.on ? ' on' : '') + '" data-i="' + i + '">' +
          (m.on ? icon('check') : '<span class="menu-pad"></span>') + esc(m.label) + '</button>';
      }).join('');
      ctlMenu.hidden = false;
      // pin above the anchoring button, right-aligned to it
      var ar = anchor.getBoundingClientRect(), sr = stage.getBoundingClientRect();
      ctlMenu.style.right = Math.max(8, sr.right - ar.right) + 'px';
      $all('.menu-it', ctlMenu).forEach(function (b) {
        b.addEventListener('click', function () {
          var pick = items2[+b.getAttribute('data-i')];
          closeMenu();
          if (pick && pick.act) pick.act();
        });
      });
    }

    var subBtn = $('#subBtn');
    if (subBtn) subBtn.addEventListener('click', function () {
      if (!ctlMenu.hidden) { closeMenu(); return; }
      var entries = [{ label: 'Off', on: activeSub === -1, act: function () { selectSub(-1); } }];
      item.subs.forEach(function (s, i) {
        entries.push({ label: s.label + ' (' + s.ext + ')', on: activeSub === i, act: function () { selectSub(i); } });
      });
      openMenu(entries, subBtn);
    });

    var RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
    rateBtn.addEventListener('click', function () {
      if (!ctlMenu.hidden) { closeMenu(); return; }
      openMenu(RATES.map(function (r) {
        return {
          label: r + '×', on: vid.playbackRate === r,
          act: function () { vid.playbackRate = r; $('.rate-lbl', rateBtn).innerHTML = String(r).replace('0.', '.') + '&times;'; }
        };
      }), rateBtn);
    });

    // -------------------------------------------------- next episode -------
    function armNextOverlay() {
      if (!nextEp) return;
      var left = 8;
      nextOver.innerHTML = '<div class="next-card"><span class="dim">Up next</span>' +
        '<b>' + esc(epCode(nextEp) + (nextEp.title ? ' · ' + nextEp.title : '')) + '</b>' +
        '<div class="next-row"><a class="btn primary" id="nextGo" href="' + playHref(nextEp) + '">' +
        icon('play') + '<span>Play now (<span id="nextN">' + left + '</span>)</span></a>' +
        '<button class="btn ghost" id="nextStay" type="button">Stay here</button></div></div>';
      nextOver.hidden = false;
      nextTimer = setInterval(function () {
        left--;
        var n = $('#nextN');
        if (n) n.textContent = String(left);
        if (left <= 0) { clearInterval(nextTimer); go(playHref(nextEp).slice(1)); }
      }, 1000);
      var stay = $('#nextStay');
      if (stay) stay.addEventListener('click', function () {
        clearInterval(nextTimer); nextOver.hidden = true;
      });
    }

    // ------------------------------------------------------ media events ---
    vid.addEventListener('play', function () {
      setIcon(playBtn, 'pause'); wake(); startLoop();
      if ('wakeLock' in navigator && !wakeLock) {   // only granted in a secure context; fail soft
        navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; }, function () { });
      }
    });
    vid.addEventListener('pause', function () {
      setIcon(playBtn, 'play'); stage.classList.remove('idle'); saveProgress(false);
      if (wakeLock) { try { wakeLock.release(); } catch (e) { } wakeLock = null; }
    });
    vid.addEventListener('timeupdate', function () { paintSeek(); paintCues(); });
    vid.addEventListener('seeking', function () { cueIdx = 0; });
    vid.addEventListener('progress', paintSeek);
    vid.addEventListener('loadedmetadata', function () {
      paintSeek();
      var rec = progGet(item.path);
      if (rec && !rec.done && rec.t > 30 && rec.d && rec.t / rec.d < 0.95) {
        vid.currentTime = rec.t;
        toast('Resumed at ' + fmtTime(rec.t) + ' · press 0 to start over', 3400);
      }
    });
    vid.addEventListener('ended', function () {
      saveProgress(true);
      setIcon(playBtn, 'play');
      stage.classList.remove('idle');
      if (nextEp) armNextOverlay();
    });
    vid.addEventListener('volumechange', function () {
      setIcon(muteBtn, vid.muted || vid.volume === 0 ? 'mute' : 'vol');
      volSlider.value = String(Math.round((vid.muted ? 0 : vid.volume) * 100));
      persistVolume();
    });
    vid.addEventListener('error', function () {
      // The honest fallback: the bytes stream fine (the host is a Range pipe), the
      // BROWSER just cannot decode this container/codec. Offer the paths that work.
      stageNote.innerHTML = '<div class="note-card">' + icon('warn') +
        '<h3>This browser can&rsquo;t decode ' + esc(item.ext.toUpperCase()) + ' · ' + esc(item.file) + '</h3>' +
        '<p>The file itself streams fine - it is the video decoder that is missing. Try one of these:</p>' +
        '<div class="next-row">' +
        '<button class="btn primary" id="vlcCopy" type="button">' + icon('link') + ' Copy URL for VLC / mpv</button>' +
        '<a class="btn ghost" href="' + esc(dlHref(item.enc)) + '">' + icon('down') + ' Download the file</a></div>' +
        '<p class="dim">In VLC: Media &rarr; Open Network Stream and paste the URL. Chrome and Edge usually ' +
        'play MKV; MP4 (H.264/AAC) and WebM play everywhere.</p></div>';
      stageNote.hidden = false;
      ctl.classList.add('gone');
    });

    playBtn.addEventListener('click', togglePlay);
    $('#backBtn').addEventListener('click', function () { seekBy(-10); });
    $('#fwdBtn').addEventListener('click', function () { seekBy(10); });
    var nextBtn = $('#nextBtn');
    if (nextBtn) nextBtn.addEventListener('click', function () { go(playHref(nextEp).slice(1)); });
    muteBtn.addEventListener('click', function () { vid.muted = !vid.muted; });
    volSlider.addEventListener('input', function () {
      vid.volume = (+volSlider.value) / 100;
      vid.muted = vid.volume === 0;
    });
    fullBtn.addEventListener('click', function () {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (stage.requestFullscreen) stage.requestFullscreen();
    });
    document.addEventListener('fullscreenchange', onFullChange);
    function onFullChange() { setIcon(fullBtn, document.fullscreenElement ? 'unfull' : 'full'); }

    // click = play/pause, double-click = fullscreen (the classic 250 ms dance)
    var clickTimer = null;
    vid.addEventListener('click', function () {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
      clickTimer = setTimeout(function () { clickTimer = null; togglePlay(); }, 250);
    });
    vid.addEventListener('dblclick', function () { fullBtn.click(); });

    stage.addEventListener('pointermove', wake);
    stage.addEventListener('touchstart', wake, { passive: true });

    var copyBtn = $('#copyBtn');
    if (copyBtn) copyBtn.addEventListener('click', function () {
      copyText(absUrl(item.enc), 'Stream URL copied - paste it into VLC or mpv');
    });

    // rAF loop only while playing: subtitle cadence needs better than timeupdate's 4 Hz
    function startLoop() {
      cancelAnimationFrame(rafId);
      (function loop() {
        if (disposed || vid.paused) return;
        paintCues();
        rafId = requestAnimationFrame(loop);
      })();
    }

    // periodic progress save while playing (crash/battery-safe resume)
    saveTimer = setInterval(function () { if (!vid.paused) saveProgress(false); }, 5000);

    // ------------------------------------------------------- keyboard ------
    function onKey(ev) {
      if (ev.target && /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName)) return;
      var k = ev.key;
      if (k === ' ' || k === 'k') { togglePlay(); ev.preventDefault(); }
      else if (k === 'ArrowLeft') { seekBy(-10); ev.preventDefault(); }
      else if (k === 'ArrowRight') { seekBy(10); ev.preventDefault(); }
      else if (k === 'ArrowUp') { vid.volume = Math.min(1, vid.volume + 0.05); vid.muted = false; ev.preventDefault(); }
      else if (k === 'ArrowDown') { vid.volume = Math.max(0, vid.volume - 0.05); ev.preventDefault(); }
      else if (k === 'f') fullBtn.click();
      else if (k === 'm') vid.muted = !vid.muted;
      else if (k === 'n' && nextEp) go(playHref(nextEp).slice(1));
      else if (k === 's' && item.subs && item.subs.length) {
        selectSub(activeSub + 1 >= item.subs.length ? -1 : activeSub + 1);
      }
      else if (k >= '0' && k <= '9' && vid.duration) {
        vid.currentTime = vid.duration * (+k) / 10;
      }
      else if (k === '<' || k === ',') bumpRate(-1);
      else if (k === '>' || k === '.') bumpRate(1);
      wake();
    }
    function bumpRate(dir) {
      var i = RATES.indexOf(vid.playbackRate);
      if (i === -1) i = 2;
      i = Math.max(0, Math.min(RATES.length - 1, i + dir));
      vid.playbackRate = RATES[i];
      $('.rate-lbl', rateBtn).innerHTML = String(RATES[i]).replace('0.', '.') + '&times;';
      toast('Speed ' + RATES[i] + '×', 1200);
    }
    document.addEventListener('keydown', onKey);

    // Auto-select an English (or the only) subtitle track? Deliberately not: quiet by
    // default, one keypress ("s") or two clicks away. But DO surface that subs exist.
    if (item.subs && item.subs.length) {
      toast(item.subs.length + ' subtitle track' + (item.subs.length === 1 ? '' : 's') + ' available · press S', 3000);
    }

    // MediaSession: lockscreen / media-key integration where the browser offers it.
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: item.kind === 'episode' ? (epCode(item) + ' ' + (item.title || '')) : item.title,
          artist: item.kind === 'episode' ? item.show : (item.year || ''),
          album: CONFIG.title || 'No Cloud Media Center',
          artwork: item.poster ? [{ src: absUrl(item.poster) }] : []
        });
        navigator.mediaSession.setActionHandler('play', function () { vid.play(); });
        navigator.mediaSession.setActionHandler('pause', function () { vid.pause(); });
        navigator.mediaSession.setActionHandler('seekbackward', function () { seekBy(-10); });
        navigator.mediaSession.setActionHandler('seekforward', function () { seekBy(10); });
      } catch (e) { /* optional nicety only */ }
    }

    function onUnload() { saveProgress(false); }
    window.addEventListener('pagehide', onUnload);

    currentCleanup = function () {
      disposed = true;
      saveProgress(false);
      try { vid.pause(); } catch (e) { }
      vid.removeAttribute('src');
      try { vid.load(); } catch (e) { }   // detach the stream so the host connection closes
      clearInterval(saveTimer); clearTimeout(idleTimer); clearInterval(nextTimer);
      cancelAnimationFrame(rafId);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFullChange);
      window.removeEventListener('pagehide', onUnload);
      if (wakeLock) { try { wakeLock.release(); } catch (e) { } wakeLock = null; }
      if (document.fullscreenElement) { try { document.exitFullscreen(); } catch (e) { } }
    };
  }

  // -------------------------------------------------------------- view: help ---
  function vHelp() {
    setTitle('Help');
    var mode = INFO && INFO.mode;
    var transport = mode === 'tor'
      ? 'over <b>Tor</b> - both ends hidden, the address is the capability'
      : mode === 'clearweb'
        ? 'over a <b>direct web link</b> on your LAN - the <code>/&lt;token&gt;/</code> in the address is the key'
        : 'as a <b>static preview</b> (the live host was not detected)';
    var html = '<section class="sec-head"><h1>' + icon('info') + ' Help</h1></section>' +

      '<div class="panel pad"><h2>What this is</h2>' +
      '<p>A media library served straight out of a folder by <b>No Cloud Quick Share</b> - ' +
      'no server software, no account, no cloud. This page reached you ' + transport + '.' +
      (INFO && INFO.share ? ' Share name: <b>' + esc(INFO.share) + '</b>.' : '') +
      (INFO && INFO.version ? ' Host version: <b>' + esc(INFO.version) + '</b>.' : '') + '</p>' +
      '<p class="dim">Playback is plain HTTP Range streaming: your browser asks for byte ranges, the host ' +
      'answers 206 with bounded slices, and a multi-GB film never sits in anyone&rsquo;s memory. Watch ' +
      'positions and the theme live in <i>this browser&rsquo;s</i> localStorage - the host keeps no state about you.</p></div>' +

      '<div class="panel pad"><h2>Adding media</h2>' +
      '<p>On the host, drop files into the shared folder and press Rescan ' + icon('refresh') + ' here:</p>' +
      '<pre class="code">' + esc(
        'Movies/\n  Inception (2010).mkv                 <- a file straight in the folder\n' +
        '  The Iron Giant (1999)/               <- ...or one folder per film\n' +
        '    The.Iron.Giant.1999.1080p.mkv\n    poster.jpg                         <- shown on the poster wall\n' +
        '    The.Iron.Giant.1999.en.srt         <- subtitles, auto-detected\n\n' +
        'TV/\n  The Expanse/\n    poster.jpg\n    Season 1/\n      The.Expanse.S01E01.mkv\n' +
        '  Fawlty Towers/                       <- season folders are optional\n    Fawlty.Towers.1x01.mp4') + '</pre>' +
      '<p class="dim">Episode numbers are read from names (S01E02, 1x02, E02); years from "(2010)" or ".2010."; ' +
      'release tags (1080p, BluRay, x264...) are stripped for display. Sections, their folders, and the app title ' +
      'are configurable in <code>library.json</code> in the shared folder.</p></div>' +

      '<div class="panel pad"><h2>What plays where</h2>' +
      '<table class="tbl"><tr><th>Format</th><th>In the browser</th></tr>' +
      '<tr><td>MP4 / M4V (H.264 + AAC)</td><td>everywhere</td></tr>' +
      '<tr><td>WebM (VP9/AV1)</td><td>everywhere except older Safari</td></tr>' +
      '<tr><td>MKV</td><td>usually in Chrome / Edge (same engine as WebM); not Safari or Firefox</td></tr>' +
      '<tr><td>MOV</td><td>Safari; Chrome when the codecs are H.264/AAC</td></tr>' +
      '<tr><td>AVI and others</td><td>rarely - use the player&rsquo;s <b>Copy stream URL</b> and paste it into VLC or mpv, or Download</td></tr>' +
      '</table>' +
      '<p class="dim">When the browser cannot decode a file the player says so and offers both escapes. ' +
      'Subtitles: sidecar <code>.srt</code> / <code>.vtt</code> files are detected and rendered by the app itself, ' +
      'so both formats work on every transport.</p></div>' +

      '<div class="panel pad"><h2>Keyboard shortcuts (in the player)</h2>' +
      '<div class="keys">' +
      [['Space / K', 'play & pause'], ['&larr; / &rarr;', 'back / forward 10 s'],
       ['&uarr; / &darr;', 'volume'], ['0&ndash;9', 'jump to 0&ndash;90%'],
       ['F', 'fullscreen'], ['M', 'mute'], ['S', 'cycle subtitles'],
       ['N', 'next episode'], ['&lt; / &gt;', 'playback speed'], ['/', 'search (anywhere)']]
        .map(function (kv) { return '<span class="key-row"><kbd>' + kv[0] + '</kbd><span>' + kv[1] + '</span></span>'; }).join('') +
      '</div></div>' +

      '<div class="panel pad"><h2>Privacy, honestly</h2>' +
      '<p class="dim">A <b>web link</b> share is visible to anyone who has the link on your network path - ' +
      'the random token in the URL is the only gate, and the stream is plain HTTP. Over <b>Tor</b>, both ends ' +
      'are hidden and the transport is encrypted, at Tor speeds. The host logs nothing and remembers nothing ' +
      'about viewers; this app stores its little state (positions, theme) only in your browser. ' +
      'See the host&rsquo;s <code>docs/what-it-hides.md</code> for the precise model.</p></div>';

    view.innerHTML = html;
  }

  // ------------------------------------------------------- scanning screens ---
  function renderScanning() {
    var shimmer = '';
    for (var i = 0; i < 12; i++) shimmer += '<span class="poster skel"></span>';
    view.innerHTML = '<section class="home-hero"><h1>Opening your library&hellip;</h1>' +
      '<p class="dim" id="scanLine">Scanning the shared folder for movies and shows.</p></section>' +
      '<div class="grid">' + shimmer + '</div>';
    var line = $('#scanLine');
    var tick = setInterval(function () {
      if (!line || !document.body.contains(line)) { clearInterval(tick); return; }
      line.textContent = 'Scanning… ' + scanStatus.folders + ' folders · ' +
        scanStatus.files + ' files found';
    }, 200);
  }
  function renderScanFailed() {
    view.innerHTML = '<div class="panel pad empty"><h2>' + icon('warn') + ' Could not scan the library</h2>' +
      '<p>The media folders could not be read. This usually means the page is not being served by ' +
      'the No Cloud Quick Share host (its folder listings are what the scan reads).</p>' +
      '<p><button class="btn primary" id="retryBtn" type="button">' + icon('refresh') + ' Try again</button></p></div>';
    var b = $('#retryBtn');
    if (b) b.addEventListener('click', function () { scanLibrary(true).then(render, renderScanFailed); });
  }

  // ------------------------------------------------------------ transport ---
  function paintTransport() {
    var el = document.getElementById('transport');
    if (!el) return;
    var txt = $('.badge-txt', el) || el;
    var onion = /\.onion$/i.test(location.hostname);
    if ((INFO && INFO.mode === 'tor') || onion) {
      txt.textContent = 'Over Tor'; el.className = 'badge tor live';
    } else if (INFO && INFO.mode === 'clearweb') {
      txt.textContent = 'On your LAN'; el.className = 'badge web live';
    } else if (INFO) {
      txt.textContent = 'Quick Share host'; el.className = 'badge web live';
    } else {
      txt.textContent = 'Static preview'; el.className = 'badge';
    }
  }

  // ----------------------------------------------------------------- theme ---
  var THEMES = ['auto', 'dark', 'light'];
  function applyTheme() {
    var t = lsGet(LS_THEME, 'auto');
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    var btn = $('#themeBtn');
    if (btn) {
      btn.setAttribute('data-mode', t);
      btn.title = 'Theme: ' + t;
    }
  }
  function cycleTheme() {
    var t = lsGet(LS_THEME, 'auto');
    var next = THEMES[(THEMES.indexOf(t) + 1) % THEMES.length];
    lsSet(LS_THEME, next);
    applyTheme();
    toast('Theme: ' + next, 1400);
  }

  // ------------------------------------------------------------------ boot ---
  function boot() {
    applyTheme();
    $('#themeBtn').addEventListener('click', cycleTheme);
    $('#rescanBtn').addEventListener('click', function () {
      try { sessionStorage.removeItem(libCacheKey()); } catch (e) { }
      LIB = null;
      toast('Rescanning the media folders…');
      render();
    });
    $('#searchForm').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var q = $('#searchBox').value.trim();
      go('#/search/' + encodeURIComponent(q));
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName)) {
        ev.preventDefault();
        $('#searchBox').focus();
      }
    });

    // Optional config: library.json in the shared folder. Absent (the SPA fallback
    // answers a dot-free path, but "library.json" HAS a dot, so a missing file is a
    // real 404) or malformed simply means the defaults - fail closed, like the host.
    fetch('library.json', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (cfg) {
        if (cfg && typeof cfg === 'object') {
          if (typeof cfg.title === 'string' && cfg.title.trim()) CONFIG.title = cfg.title.trim();
          if (typeof cfg.tagline === 'string' && cfg.tagline.trim()) CONFIG.tagline = cfg.tagline.trim();
          if (Object.prototype.toString.call(cfg.sections) === '[object Array]' && cfg.sections.length) {
            var secs = [];
            cfg.sections.forEach(function (s) {
              if (!s || typeof s !== 'object') return;
              var p = String(s.path || '').replace(/^\/+|\/+$/g, '');
              // keep the crawl inside the share: no dot-segments, no separators-only
              if (!p || p.indexOf('..') !== -1 || p.charAt(0) === '.') return;
              secs.push({
                id: String(s.id || p).replace(/[^\w-]/g, '_') || ('s' + secs.length),
                label: String(s.label || p),
                path: p,
                kind: s.kind === 'tv' ? 'tv' : 'movies'
              });
            });
            if (secs.length) CONFIG.sections = secs;
          }
        }
        if (CONFIG.title) {
          var bn = $('.brand-name');
          if (bn) bn.textContent = CONFIG.title;
          setTitle('');
        }
        // config decided -> paint nav & first view
        render();
      });

    // transport badge rides /_qs/info exactly like the sibling demo
    fetch('_qs/info', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (j) { INFO = j; paintTransport(); });

    // the same deliberately cache-less service worker as the demo (secure contexts only)
    if ('serviceWorker' in navigator && window.isSecureContext) {
      navigator.serviceWorker.register('sw.js').catch(function () { /* optional */ });
    }

    window.addEventListener('hashchange', render);
    // click-away closes any open player menu
    document.addEventListener('click', function (ev) {
      var m = $('#ctlMenu');
      if (m && !m.hidden && !m.contains(ev.target) &&
          !(ev.target.closest && (ev.target.closest('#subBtn') || ev.target.closest('#rateBtn')))) {
        m.hidden = true; m.innerHTML = '';
      }
    });
  }

  boot();
})();
