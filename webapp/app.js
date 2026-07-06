/* No Cloud Quick Share Web App Demo - a dependency-free single-page app.
 *
 * The whole point is to exercise what the QuickShare host can do - and to look
 * like a real little internet while doing it:
 *   - many static asset types with correct MIME (svg, png, jpg, wav, mp3, mp4,
 *     webm, zip, css, js, json, webmanifest)
 *   - HTTP Range: the Theater's <video> and the Music page's <audio> stream and
 *     SEEK without downloading whole files
 *   - client-side ROUTING that survives a refresh, because the server falls back
 *     to index.html for any unknown dot-free path (qsSiteSpaTarget). Routes are
 *     deliberately SINGLE-SEGMENT: a nested path like blog/<slug> would move the
 *     document's base directory, so the shell's relative app.js/app.css would
 *     resolve to dotted paths that get a real 404 instead of the fallback. Deep
 *     links into content therefore ride the QUERY STRING (blog?post=<slug>),
 *     which survives refresh at any mount point with zero asset breakage.
 *   - forced downloads: any file URL with ?dl is served Content-Disposition:
 *     attachment (the Store's "delivery")
 *   - a live BACKEND route (GET /_qs/info) fetched at runtime
 *   - the same files working at the root (over Tor) AND under /<token>/ (web link)
 *
 * The base-path trick: every asset uses a RELATIVE URL, and the router computes
 * its base by scanning location.pathname for the right-most segment that names a
 * known route - so no build step, no <base>, and it does not matter whether we
 * sit at "/" or "/<abc123>/".
 */
(function () {
  'use strict';

  var ROUTES = [
    { id: '',         label: 'Home' },
    { id: 'gallery',  label: 'Gallery' },
    { id: 'theater',  label: 'Theater' },
    { id: 'music',    label: 'Music' },
    { id: 'store',    label: 'Store' },
    { id: 'checkout', label: 'Checkout', hidden: true },   // reached from the cart, not the nav
    { id: 'blog',     label: 'Blog' },
    { id: 'backend',  label: 'Backend' },
    { id: 'about',    label: 'About' }
  ];
  var NAMED = ROUTES.map(function (r) { return r.id; }).filter(Boolean);

  var view = document.getElementById('view');
  var nav = document.getElementById('nav');
  var info = null;                 // cached /_qs/info result, or null if unavailable
  var manifests = {};              // cached JSON fetches, keyed by file name

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // --- inline SVG icon set (24x24, stroke-based, echoes the logo glyph) ---------
  // Kept inline (not an external sprite/font) so the whole UI stays self-contained:
  // no CDN, no icon font, no data: URI - drawable under a strict CSP and offline.
  var ICONS = {
    gallery: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M4 15l4-4 4 4 3-3 5 5"/><circle cx="8.5" cy="9" r="1.4"/>',
    theater: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M10 9l5 3-5 3z" fill="currentColor" stroke="none"/>',
    music:   '<path d="M9 17V5l10-2v12"/><circle cx="6.8" cy="17" r="2.2"/><circle cx="16.8" cy="15" r="2.2"/>',
    store:   '<path d="M6 8h12l-.8 11.2H6.8z"/><path d="M9 8V6.6a3 3 0 0 1 6 0V8"/>',
    blog:    '<path d="M6.5 3.5h8L18 7v13.5H6.5z"/><path d="M9.5 8h3M9.5 11h5M9.5 14h5"/>',
    backend: '<rect x="4" y="4.5" width="16" height="6" rx="1.5"/><rect x="4" y="13" width="16" height="6" rx="1.5"/><path d="M7.4 7.5h.01M7.4 16h.01"/>',
    about:   '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
    arrow:   '<path d="M5 12h13M13 6l6 6-6 6"/>',
    check:   '<path d="M5 12.5l4.5 4.5L19 7"/>',
    play:    '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
    download:'<path d="M12 4v10M8 11l4 4 4-4"/><path d="M5.5 19h13"/>',
    layers:  '<path d="M12 3l8 4-8 4-8-4z"/><path d="M4 12l8 4 8-4"/>',
    tag:     '<path d="M4 4h7l9 9-7 7-9-9z"/><circle cx="8" cy="8" r="1.3"/>',
    range:   '<path d="M7 6v12M17 6v12M7 12h10"/><circle cx="12" cy="12" r="2.1" fill="currentColor" stroke="none"/>',
    link:    '<path d="M9.5 14.5l5-5"/><path d="M10.5 6.5l1-1a3.5 3.5 0 0 1 5 5l-1 1"/><path d="M13.5 17.5l-1 1a3.5 3.5 0 0 1-5-5l1-1"/>',
    bolt:    '<path d="M13 3L5 13.5h5.5L11 21l8-10.5h-5.5z" fill="currentColor" stroke="none"/>',
    shield:  '<path d="M12 3.5l7 3v5c0 5-3 7.5-7 9.5-4-2-7-4.5-7-9.5v-5z"/><path d="M9 12l2 2 4-4.5"/>',
    folder:  '<path d="M4 7.5h5l2 2h9v9.5H4z"/>'
  };
  function icon(name, cls) {
    return '<svg class="ic' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true">' +
      (ICONS[name] || '') + '</svg>';
  }
  // A code/output block dressed as a little terminal window: three brand node-dots
  // and an optional mono path title. pText is ALREADY-escaped-safe raw text.
  function codeBlock(pText, pTitle) {
    return '<div class="term"><div class="term-bar"><span class="term-dots"></span>' +
      (pTitle ? '<span class="term-title">' + esc(pTitle) + '</span>' : '') +
      '</div><pre class="code">' + esc(pText) + '</pre></div>';
  }

  // --- base + route derivation (works at "/" or "/<token>/") ------------------
  // Scan the path's segments right-to-left for a known route name; everything
  // before it is the serving base ("/tok/blog" -> base "/tok/", route "blog").
  function splitPath() {
    var p = location.pathname.replace(/\/+$/, '');
    var segs = p.split('/');
    for (var i = segs.length - 1; i >= 1; i--) {
      if (NAMED.indexOf(segs[i]) !== -1) {
        return { base: segs.slice(0, i).join('/') + '/', route: segs.slice(i).join('/') };
      }
    }
    return { base: (p || '') + '/', route: '' };
  }
  function base() { return splitPath().base; }
  function route() { return splitPath().route; }
  function href(id) { return base() + id; }
  function qparam(name) {
    var m = location.search.match(new RegExp('[?&]' + name + '=([^&]*)'));
    return m ? decodeURIComponent(m[1].replace(/\+/g, '%20')) : '';
  }

  function loadJson(file) {
    if (manifests[file]) return manifests[file];
    manifests[file] = fetch(href(file)).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
    return manifests[file];
  }

  // --- transport detection (via the live backend route, else a heuristic) -----
  function loadInfo() {
    return fetch(href('_qs/info'), { headers: { 'accept': 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }
  function paintTransport() {
    var el = document.getElementById('transport');
    if (!el) return;
    var txt = el.querySelector('.badge-txt') || el;   // tolerate the plain fallback
    var onion = /\.onion$/i.test(location.hostname);
    // A "live" badge (pulsing dot) means the page was reached through the running
    // host - a real Tor onion or the live web server - not a plain static preview.
    if (info && info.mode === 'tor' || onion) {
      txt.textContent = 'Served over Tor'; el.className = 'badge tor live';
    } else if (info && info.mode === 'clearweb') {
      txt.textContent = 'Served over the web'; el.className = 'badge web live';
    } else if (info) {
      txt.textContent = 'Served by No Cloud Quick Share'; el.className = 'badge web live';
    } else {
      txt.textContent = 'Static preview'; el.className = 'badge';
    }
  }

  function fmtTime(s) {
    s = Math.max(0, Math.round(s));
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }

  // --- the cart (Store state; localStorage so it survives a refresh) ----------
  var cartMem = null;              // in-page fallback when localStorage is blocked
  function cartLoad() {
    if (cartMem !== null) return cartMem.slice();
    try {
      var c = JSON.parse(localStorage.getItem('qsCart') || '[]');
      return Object.prototype.toString.call(c) === '[object Array]' ? c : [];
    } catch (e) { return []; }
  }
  function cartSave(c) {
    try { localStorage.setItem('qsCart', JSON.stringify(c)); cartMem = null; }
    catch (e) { cartMem = c.slice(); }
  }

  // --- views ------------------------------------------------------------------
  // The inline-SVG "network bloom": a source folder radiating to peer nodes with
  // packets in flight and signal rings - the logo's 3-node glyph, brought to life.
  // Packets translate along straight links (universally supported; no offset-path),
  // and every motion here freezes gracefully under prefers-reduced-motion.
  function heroArt() {
    return '<div class="hero-art">' +
      '<svg class="qs-net" viewBox="0 0 360 300" fill="none" role="img" ' +
        'aria-label="A source folder sharing files peer-to-peer to three nodes">' +
      '<defs>' +
        '<linearGradient id="qsg" x1="0" y1="0" x2="1" y2="1">' +
          '<stop offset="0" stop-color="#3b82f6"/><stop offset=".55" stop-color="#8b5cf6"/><stop offset="1" stop-color="#ec4899"/>' +
        '</linearGradient>' +
        '<radialGradient id="qsc" cx=".5" cy=".38" r=".7">' +
          '<stop offset="0" stop-color="#a5b4fc"/><stop offset="1" stop-color="#6366f1"/>' +
        '</radialGradient>' +
      '</defs>' +
      '<circle class="qs-ring" cx="180" cy="110" r="20" stroke="#8b5cf6" stroke-width="2"/>' +
      '<circle class="qs-ring b" cx="180" cy="110" r="20" stroke="#3b82f6" stroke-width="2"/>' +
      '<circle class="qs-ring c" cx="180" cy="110" r="20" stroke="#22d3ee" stroke-width="2"/>' +
      '<path class="qs-link" d="M180 110 L95 225"  stroke="url(#qsg)" stroke-width="2.5"/>' +
      '<path class="qs-link" d="M180 110 L265 225" stroke="url(#qsg)" stroke-width="2.5"/>' +
      '<path class="qs-link" d="M180 110 L180 52"  stroke="url(#qsg)" stroke-width="2.5"/>' +
      '<circle class="pkt pkt-l" cx="180" cy="110" r="4" fill="#22d3ee"/>' +
      '<circle class="pkt pkt-r" cx="180" cy="110" r="4" fill="#ec4899"/>' +
      '<circle class="pkt pkt-t" cx="180" cy="110" r="4" fill="#3b82f6"/>' +
      '<g class="qs-peer core">' +
        '<rect x="150" y="84" width="60" height="50" rx="14" fill="url(#qsc)"/>' +
        '<path d="M162 106h14l4-5h13" stroke="#fff" stroke-width="2" fill="none" opacity=".85"/>' +
      '</g>' +
      '<g class="qs-peer b"><circle cx="95" cy="225" r="17" fill="#0f1428" stroke="url(#qsg)" stroke-width="2.5"/><circle cx="95" cy="225" r="4.5" fill="#22d3ee"/></g>' +
      '<g class="qs-peer c"><circle cx="265" cy="225" r="17" fill="#0f1428" stroke="url(#qsg)" stroke-width="2.5"/><circle cx="265" cy="225" r="4.5" fill="#ec4899"/></g>' +
      '<g class="qs-peer"><circle cx="180" cy="52" r="15" fill="#0f1428" stroke="url(#qsg)" stroke-width="2.5"/><circle cx="180" cy="52" r="4" fill="#3b82f6"/></g>' +
      '</svg>' +
      '<span class="hero-status"><span class="dot"></span>peers&nbsp;<b>3/3</b> &middot; onion bound &middot; <b>live</b></span>' +
      '</div>';
  }

  function vHome() {
    var spots = [
      ['gallery', 'Gallery', 'Eight vector pieces and a raster photo, with a lightbox. Plain files, right MIME.'],
      ['theater', 'Theater', 'A short film that streams and SEEKS over HTTP Range, plus an ambient webm loop.'],
      ['music',   'Music',   'Three MP3s on a record shelf with a playlist player. Scrubbing is a Range request.'],
      ['store',   'Store',   'A storefront with a cart and real delivery - files served as forced downloads.'],
      ['blog',    'Blog',    'Posts from a JSON file, each with a deep link that survives refresh.'],
      ['backend', 'Backend', 'Not just static: a live JSON route answered by the app script itself.']
    ];
    var pills = [
      ['layers', 'Static assets'], ['tag', 'Correct MIME'], ['range', 'HTTP Range'],
      ['link', 'SPA + deep links'], ['download', 'Forced downloads'], ['bolt', 'Live backend'],
      ['shield', 'Tor or web']
    ];
    return '' +
      '<section class="hero"><div class="hero-grid"><div class="hero-copy">' +
        '<span class="kicker">Peer-to-peer &middot; No server &middot; Ephemeral</span>' +
        '<h1>A whole little internet &mdash; <span class="grad">from a folder you shared.</span></h1>' +
        '<p>Gallery, cinema, record shelf, shop, blog: every page here is a plain file in ' +
        'one shared folder, served by No Cloud Quick Share. Same files whether it reached you ' +
        'over Tor or a direct web link. No cloud, no build step, no framework.</p>' +
        '<div class="btn-row">' +
          '<a class="btn" data-route="gallery" href="' + esc(href('gallery')) + '">Take the tour ' + icon('arrow') + '</a>' +
          '<a class="btn ghost" data-route="backend" href="' + esc(href('backend')) + '">' + icon('bolt') + 'See the live backend</a>' +
        '</div>' +
        '<div class="pills">' + pills.map(function (p) {
          return '<span class="pill">' + icon(p[0]) + esc(p[1]) + '</span>';
        }).join('') + '</div>' +
      '</div>' + heroArt() + '</div></section>' +
      '<div class="spots">' + spots.map(function (s, i) {
        return '<a class="spot s-' + esc(s[0]) + '" data-route="' + esc(s[0]) + '" href="' + esc(href(s[0])) + '">' +
          '<span class="spot-top"><span class="spot-badge">' + icon(s[0]) + '</span>' +
          '<span class="spot-idx">0' + (i + 1) + '</span>' +
          '<span class="spot-arrow">' + icon('arrow') + '</span></span>' +
          '<b>' + esc(s[1]) + '</b>' +
          '<span class="spot-desc">' + esc(s[2]) + '</span></a>';
      }).join('') + '</div>' +
      '<div class="card"><span class="kicker">One folder, honestly</span>' +
        '<h2>Refresh anywhere &mdash; it still loads</h2>' +
        '<p class="muted">Use the tabs above &mdash; every one is a real client-side route. Refresh anywhere ' +
        '(even inside a blog post) and the page still loads: the server hands unknown dot-free paths back to ' +
        '<kbd>index.html</kbd> and this script restores the view. The <b>About</b> tab lists everything ' +
        'this demo exercises.</p></div>';
  }

  // ------------------------------------------------------------------ gallery
  function vGallery() {
    return '<div class="card"><span class="kicker">Gallery &middot; static assets</span><h2>Gallery</h2>' +
      '<p class="muted">Images served as ordinary files with the right content type &mdash; eight vector ' +
      '<kbd>.svg</kbd> pieces plus a raster <kbd>.png</kbd>, listed from <kbd>data.json</kbd> at runtime. ' +
      'Click any piece for the lightbox; every one links to its raw file and a forced ' +
      '<kbd>?dl</kbd> download.</p>' +
      '<div id="gal" class="grid"><p class="muted">Loading&hellip;</p></div></div>';
  }
  var galleryItems = [];
  function fillGallery() {
    var box = document.getElementById('gal');
    loadJson('data.json').then(function (d) {
      var items = (d && d.gallery) || [];
      galleryItems = items;
      if (!items.length) { box.innerHTML = '<p class="muted">No items.</p>'; return; }
      box.innerHTML = items.map(function (it, i) {
        return '<figure class="tile" data-lightbox="' + i + '" tabindex="0" role="button" ' +
          'aria-label="Open ' + esc(it.title) + '">' +
          '<img loading="lazy" src="' + esc(it.file) + '" alt="' + esc(it.title) + '">' +
          '<figcaption class="cap"><b>' + esc(it.title) + '</b><span>' + esc(it.note) + '</span></figcaption></figure>';
      }).join('');
    }).catch(function () { box.innerHTML = '<p class="muted">Could not load data.json.</p>'; });
  }

  // The lightbox lives inside #view, so navigating away naturally removes it;
  // the document-level key handler is removed both on close and on re-render.
  var lbIndex = -1;
  var lbReturnFocus = null;         // element to restore focus to on close (a11y)
  function lbClose() {
    var el = document.getElementById('lightbox');
    if (el) el.parentNode.removeChild(el);
    document.removeEventListener('keydown', lbKeys);
    lbIndex = -1;
    // Restore focus to the tile that opened the lightbox (WCAG 2.4.3 focus order).
    if (lbReturnFocus && lbReturnFocus.focus) { try { lbReturnFocus.focus(); } catch (e) {} }
    lbReturnFocus = null;
  }
  function lbKeys(e) {
    if (e.key === 'Escape') { lbClose(); return; }
    if (e.key === 'ArrowRight') { lbShow(lbIndex + 1); return; }
    if (e.key === 'ArrowLeft') { lbShow(lbIndex - 1); return; }
    if (e.key === 'Tab') {                                   // trap Tab inside the dialog
      var el = document.getElementById('lightbox');
      if (!el) return;
      var f = el.querySelectorAll('button, [href]');
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (!el.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  function lbShow(i) {
    if (!galleryItems.length) return;
    lbIndex = (i + galleryItems.length) % galleryItems.length;
    var it = galleryItems[lbIndex];
    var el = document.getElementById('lightbox');
    if (!el) {
      lbReturnFocus = document.activeElement;   // remember what to restore on close
      el = document.createElement('div');
      el.id = 'lightbox';
      el.className = 'lightbox';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('tabindex', '-1');
      view.appendChild(el);
      document.addEventListener('keydown', lbKeys);
    }
    el.setAttribute('aria-label', 'Image viewer: ' + it.title);
    el.innerHTML = '<div class="lb-frame">' +
      '<img src="' + esc(it.file) + '" alt="' + esc(it.title) + '">' +
      '<div class="lb-bar"><span class="lb-title"><b>' + esc(it.title) + '</b> &mdash; ' + esc(it.note) +
      '</span><span class="lb-links">' +
      '<a href="' + esc(it.file) + '" target="_blank" rel="noopener">raw file</a>' +
      '<a href="' + esc(it.file) + '?dl=1">download</a></span></div>' +
      '<button class="lb-x" data-lb="close" aria-label="Close">&#10005;</button>' +
      '<button class="lb-nav lb-prev" data-lb="prev" aria-label="Previous">&#8249;</button>' +
      '<button class="lb-nav lb-next" data-lb="next" aria-label="Next">&#8250;</button>' +
      '</div>';
    // Move focus into the dialog (on open, and after a prev/next rebuild that would
    // otherwise drop focus to <body>) so keyboard + screen-reader users stay inside it.
    if (!el.contains(document.activeElement)) {
      var closeBtn = el.querySelector('[data-lb="close"]');
      if (closeBtn) closeBtn.focus();
    }
  }

  // ------------------------------------------------------------------ theater
  var CHAPTERS = [
    { at: 0,  name: 'Titles - aurora' },
    { at: 15, name: 'Deep zoom' },
    { at: 30, name: 'Tide' },
    { at: 41, name: 'Credits' }
  ];
  function vTheater() {
    return '<div class="card media"><span class="kicker">Theater &middot; HTTP Range</span>' +
      '<h2>Now showing: <i>First Light</i> <span class="muted">(0:46)</span></h2>' +
      '<p class="muted">A procedurally generated short, streamed straight from the folder. It is offered ' +
      'twice &mdash; <kbd>video/webm</kbd> (VP9) and <kbd>video/mp4</kbd> (H.264) &mdash; and your browser picks ' +
      'the first one it can play; both were written with their index up front, so the browser can turn any ' +
      'timestamp into a byte offset and fetch just that slice with an <b>HTTP Range</b> request. ' +
      'Jump between chapters and watch how little actually downloads.</p>' +
      '<div class="frame"><video id="film" controls preload="metadata" poster="assets/film-poster.jpg" ' +
        'width="640" height="360">' +
        '<source src="assets/film.webm" type="video/webm">' +
        '<source src="assets/film.mp4" type="video/mp4">' +
        'Your browser cannot play WebM or MP4 video.</video></div>' +
      '<div class="row chapters">' + CHAPTERS.map(function (c, i) {
        return '<button class="chip-btn" data-seek="' + c.at + '"><span class="t">' + fmtTime(c.at) + '</span>' + esc(c.name) + '</button>';
      }).join('') + '</div>' +
      '<p class="statusline" id="seekstat"><span class="dot"></span>Press play &mdash; then scrub, or jump to a chapter.</p></div>' +
      '<div class="card media"><span class="kicker">Living poster</span><h2>The ambient loop</h2>' +
      '<p class="muted">A 10-second seamless loop served as <kbd>video/webm</kbd> (VP9) &mdash; a second video ' +
      'format from the same folder, autoplaying muted like a living poster. The whole file is 29&nbsp;KB.</p>' +
      '<div class="frame"><video id="loopvid" autoplay muted loop playsinline src="assets/loop.webm" width="640" height="360"></video></div></div>' +
      '<div class="card"><span class="kicker">Bring your own premiere</span><h2>Any file streams the same way</h2>' +
      '<p class="muted">Drop any folder with an ' +
      '<kbd>.mp4</kbd> into No Cloud Quick Share and it streams the same way &mdash; multi-gigabyte files ' +
      'are served one bounded slice at a time, so the sharer&rsquo;s memory use stays flat no matter how ' +
      'many people press play.</p></div>';
  }
  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  function wireTheater() {
    var vid = document.getElementById('film');
    var stat = document.getElementById('seekstat');
    // Honor prefers-reduced-motion for the autoplaying ambient loop (WCAG 2.2.2):
    // stop the perpetual motion and expose controls so it can be played on demand.
    var loop = document.getElementById('loopvid');
    if (loop && prefersReducedMotion()) {
      loop.removeAttribute('autoplay'); loop.loop = false; loop.controls = true;
      try { loop.pause(); } catch (e) {}
    }
    if (!vid) return;
    Array.prototype.forEach.call(view.querySelectorAll('[data-seek]'), function (b) {
      b.addEventListener('click', function () {
        vid.currentTime = parseFloat(b.getAttribute('data-seek'));
        vid.play();
      });
    });
    vid.addEventListener('seeked', function () {
      if (!stat) return;
      stat.className = 'statusline on';
      stat.innerHTML = '<span class="dot"></span>Seeked to <b>' + fmtTime(vid.currentTime) +
        '</b> &mdash; the browser asked the host for just those bytes (<code>Range: bytes=&hellip;</code>, answered <code>206 Partial Content</code>).';
    });
  }

  // -------------------------------------------------------------------- music
  var TRACKS = [
    { file: 'assets/music/first-light.mp3', title: 'First Light (title theme)', len: '1:04',
      note: 'slow pads, far-away bells - the film&rsquo;s theme' },
    { file: 'assets/music/packet-rain.mp3', title: 'Packet Rain', len: '0:54',
      note: 'sixteenth-note plucks falling like packets on a wire' },
    { file: 'assets/music/harbor.mp3', title: 'Harbor', len: '0:56',
      note: 'slow water, deep bass, a little moonlight' },
    { file: 'assets/chime.wav', title: 'Chime (interlude)', len: '0:03',
      note: 'the original demo tone - yes, even a plain .wav streams' }
  ];
  function vMusic() {
    return '<div class="card"><span class="kicker">Music &middot; the demo EP</span>' +
      '<h2>Quick Share Sessions</h2>' +
      '<p class="muted">Three procedurally composed tracks served as <kbd>audio/mpeg</kbd> (plus one ' +
      '<kbd>audio/wav</kbd> interlude). Pick a track; scrubbing the player issues the same HTTP Range ' +
      'requests the Theater uses. Every track is also a plain file you can open or force-download.</p>' +
      '<div class="deck"><audio id="deck" controls preload="none"></audio></div>' +
      '<ol class="tracks">' + TRACKS.map(function (t, i) {
        return '<li class="track" id="trk-' + i + '">' +
          '<button class="tr-play" data-track="' + i + '" aria-label="Play ' + esc(t.title) + '">' + icon('play') + '</button>' +
          '<span class="tr-name"><b>' + esc(t.title) + '</b><span>' + t.note + '</span></span>' +
          '<span class="eq" aria-hidden="true"><span></span><span></span><span></span><span></span></span>' +
          '<span class="tr-len">' + esc(t.len) + '</span>' +
          '<span class="tr-links"><a href="' + esc(t.file) + '?dl=1" title="Force a download with ?dl">' + icon('download') + 'get</a></span>' +
          '</li>';
      }).join('') + '</ol></div>' +
      '<div class="card"><span class="kicker">Distribution as a verb</span><h2>A record shelf in a folder</h2>' +
      '<p class="muted">A band could hand out its ' +
      'whole discography this way: drop the files in a folder, share once, and the "site" is the player ' +
      'you are looking at. When the window closes, the shop shuts &mdash; distribution as a verb.</p></div>';
  }
  function wireMusic() {
    var deck = document.getElementById('deck');
    if (!deck) return;
    var current = -1;
    function mark() {
      for (var i = 0; i < TRACKS.length; i++) {
        var row = document.getElementById('trk-' + i);
        if (row) row.className = 'track' + (i === current ? ' on' : '');
      }
    }
    function play(i) {
      current = ((i % TRACKS.length) + TRACKS.length) % TRACKS.length;
      deck.src = TRACKS[current].file;
      deck.play();
      mark();
    }
    Array.prototype.forEach.call(view.querySelectorAll('[data-track]'), function (b) {
      b.addEventListener('click', function () { play(parseInt(b.getAttribute('data-track'), 10)); });
    });
    deck.addEventListener('ended', function () { if (current >= 0) play(current + 1); });
  }

  // -------------------------------------------------------------------- store
  function vStore() {
    return '<div class="card"><span class="kicker">Store &middot; forced downloads</span>' +
      '<h2 id="shopname">The No Cloud Shop</h2>' +
      '<p class="muted" id="shopline">Digital goods delivered by the very server you are browsing. The ' +
      'catalog is <kbd>store.json</kbd>, the cart lives in your browser, and "delivery" is the host&rsquo;s ' +
      '<kbd>?dl</kbd> trick: the same URL that displays a file inline will <b>force a download</b> when ' +
      'asked. Demo prices: zero.</p>' +
      '<div class="cartbar" id="cartbar"></div>' +
      '<div id="shelf" class="grid shopgrid"><p class="muted">Loading&hellip;</p></div></div>';
  }
  function productById(products, id) {
    for (var i = 0; i < products.length; i++) if (products[i].id === id) return products[i];
    return null;
  }
  function paintCartbar(products) {
    var bar = document.getElementById('cartbar');
    if (!bar) return;
    var cart = cartLoad();
    if (!cart.length) { bar.innerHTML = '<span class="muted">Your cart is empty.</span>'; return; }
    bar.innerHTML = '<span class="cart-count">' + icon('store') + ' <b>' + cart.length + '</b> item' +
      (cart.length === 1 ? '' : 's') + ' in the cart</span>' +
      '<a class="btn grow" data-route="checkout" href="' + esc(href('checkout')) + '">Check out &mdash; $0.00</a>' +
      '<button class="btn ghost" id="cartclear">Empty cart</button>';
    var clear = document.getElementById('cartclear');
    if (clear) clear.addEventListener('click', function () {
      cartSave([]);
      paintCartbar(products);
      paintShelf(products);
    });
  }
  function paintShelf(products) {
    var box = document.getElementById('shelf');
    if (!box) return;
    var cart = cartLoad();
    box.innerHTML = products.map(function (p) {
      var inCart = cart.indexOf(p.id) !== -1;
      return '<div class="tile prod">' +
        '<img loading="lazy" src="' + esc(p.image) + '" alt="' + esc(p.title) + '">' +
        '<div class="cap"><b>' + esc(p.title) + '</b><span>' + esc(p.blurb) + '</span>' +
        '<span class="prodmeta"><span class="chip">' + esc(p.kind) + ' &middot; ' + esc(p.size) + '</span>' +
        '<span class="price">$' + Number(p.price).toFixed(2) + '</span></span>' +
        '<button class="btn' + (inCart ? ' ghost' : '') + '" data-add="' + esc(p.id) + '">' +
        (inCart ? icon('check') + 'In the cart' : 'Add to cart') + '</button></div></div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('[data-add]'), function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-add');
        var c = cartLoad();
        if (c.indexOf(id) === -1) c.push(id); else c.splice(c.indexOf(id), 1);
        cartSave(c);
        paintCartbar(products);
        paintShelf(products);
      });
    });
  }
  function wireStore() {
    loadJson('store.json').then(function (d) {
      var products = (d && d.products) || [];
      var name = document.getElementById('shopname');
      if (name && d.shop) name.textContent = d.shop;
      paintCartbar(products);
      paintShelf(products);
    }).catch(function () {
      var box = document.getElementById('shelf');
      if (box) box.innerHTML = '<p class="muted">Could not load store.json.</p>';
    });
  }
  function vCheckout() {
    return '<div class="card"><span class="kicker">Checkout &middot; real delivery</span>' +
      '<h2>Your order</h2><div id="order"><p class="muted">Loading&hellip;</p></div></div>' +
      '<div class="card"><span class="kicker">Beyond static</span><h2>Where a real shop would go from here</h2>' +
      '<p class="muted">Everything you just did was static files plus your own browser: the catalog is ' +
      '<kbd>store.json</kbd>, the cart is localStorage, delivery is <kbd>?dl</kbd>. The moment real orders ' +
      'enter the picture, the host can answer dynamic routes too &mdash; register one in the stack script:</p>' +
      codeBlock('qsHttpRoute "POST", "/api/order", "myOrderHandler"', 'stack script') +
      '<p class="muted">&hellip;and reply with <kbd>qsHttpReply</kbd>. The Backend tab calls a live route ' +
      'exactly like that.</p></div>';
  }
  function wireCheckout() {
    var box = document.getElementById('order');
    loadJson('store.json').then(function (d) {
      var products = (d && d.products) || [];
      var cart = cartLoad();
      var items = [];
      for (var i = 0; i < cart.length; i++) {
        var p = productById(products, cart[i]);
        if (p) items.push(p);
      }
      if (!items.length) {
        box.innerHTML = '<p class="muted">The cart is empty. ' +
          '<a data-route="store" href="' + esc(href('store')) + '">Back to the shelves</a>.</p>';
        return;
      }
      box.innerHTML = '<p class="muted">Pay-what-you-want came to <b>$0.00</b>, so your order is ready ' +
        'immediately. Each button below is the product&rsquo;s own file with <kbd>?dl</kbd> on the end &mdash; ' +
        'the host serves it as <kbd>Content-Disposition: attachment</kbd>, so it lands in your downloads ' +
        'with its real name.</p>' +
        '<ul class="order">' + items.map(function (p) {
          return '<li><span class="oi"><b>' + esc(p.title) + '</b><span class="muted"> &middot; ' +
            esc(p.kind) + ' &middot; ' + esc(p.size) + '</span></span>' +
            '<a class="btn" href="' + esc(p.file) + '?dl=1">' + icon('download') + 'Download</a></li>';
        }).join('') + '</ul>' +
        '<div class="row"><a class="btn ghost" data-route="store" href="' + esc(href('store')) + '">Keep browsing</a>' +
        '<button class="btn ghost" id="orderdone">Empty the cart</button></div>' +
        '<p class="muted note">(The "order" never left your browser &mdash; the cart is ' +
        'localStorage, and this receipt is rendered client-side. Refresh: it survives.)</p>';
      var done = document.getElementById('orderdone');
      if (done) done.addEventListener('click', function () {
        cartSave([]);
        go('store');
      });
    }).catch(function () {
      box.innerHTML = '<p class="muted">Could not load store.json.</p>';
    });
  }

  // --------------------------------------------------------------------- blog
  // A post's deep link is blog?post=<slug> - the QUERY carries the slug so the
  // path stays single-segment and the shell's relative assets keep resolving
  // (see the routing note up top). It survives a refresh like any other route.
  function vBlog() {
    return '<div class="card"><span class="kicker">Blog &middot; deep links</span>' +
      '<h2 id="blogname">The Folder Papers</h2>' +
      '<div id="blogbox"><p class="muted">Loading&hellip;</p></div></div>';
  }
  function blogBlock(b) {
    if (b.h) return '<h3>' + esc(b.h) + '</h3>';
    if (b.p) return '<p>' + esc(b.p) + '</p>';
    if (b.code) return codeBlock(b.code);
    if (b.ul) return '<ul class="post-ul">' + b.ul.map(function (li) {
      return '<li>' + esc(li) + '</li>';
    }).join('') + '</ul>';
    return '';
  }
  function wireBlog(sub) {
    var box = document.getElementById('blogbox');
    loadJson('blog.json').then(function (d) {
      var posts = (d && d.posts) || [];
      var name = document.getElementById('blogname');
      if (name && d.blog) name.textContent = d.blog;
      if (sub) {
        var post = null, idx = -1;
        for (var i = 0; i < posts.length; i++) {
          if (posts[i].slug === sub) { post = posts[i]; idx = i; break; }
        }
        if (!post) {
          box.innerHTML = '<p class="muted">No such post. <a data-route="blog" href="' +
            esc(href('blog')) + '">All posts</a>.</p>';
          return;
        }
        var nav2 = '<div class="row postnav">' +
          '<a class="btn ghost" data-route="blog" href="' + esc(href('blog')) + '">&#8249; All posts</a>' +
          (idx + 1 < posts.length
            ? '<a class="btn ghost" data-route="blog?post=' + esc(posts[idx + 1].slug) + '" href="' +
              esc(href('blog?post=' + posts[idx + 1].slug)) + '">Next: ' + esc(posts[idx + 1].title) + ' &#8250;</a>'
            : '') + '</div>';
        box.innerHTML = '<article class="post"><span class="kicker">' + esc(post.date) +
          ' &middot; ' + post.minutes + ' min read</span><h2>' + esc(post.title) + '</h2>' +
          '<p class="postmeta muted">This page&rsquo;s deep link survives a refresh &mdash; ' +
          'the slug rides the query string.</p>' +
          post.body.map(blogBlock).join('') + '</article>' + nav2;
        return;
      }
      box.innerHTML = '<p class="muted" id="blogline">' + esc(d.tagline || '') + '</p>' +
        posts.map(function (p, i) {
          return '<a class="postcard" data-route="blog?post=' + esc(p.slug) + '" href="' +
            esc(href('blog?post=' + p.slug)) + '">' +
            '<span class="p-idx">0' + (i + 1) + '</span>' +
            '<div class="p-body"><div class="p-head"><b>' + esc(p.title) + '</b>' +
            '<span class="spot-arrow">' + icon('arrow') + '</span></div>' +
            '<span class="postmeta">' + esc(p.date) + ' &middot; ' + p.minutes + ' min</span>' +
            '<span class="p-teaser">' + esc(p.teaser) + '</span></div></a>';
        }).join('');
    }).catch(function () {
      box.innerHTML = '<p class="muted">Could not load blog.json.</p>';
    });
  }

  // ------------------------------------------------------------------ backend
  function vBackend() {
    return '<div class="card"><span class="kicker">Backend &middot; live route</span>' +
      '<h2>Not just static files</h2>' +
      '<p class="muted">The host answers dynamic routes from the stack script. ' +
      'This calls the built-in <kbd>GET /_qs/info</kbd> and shows what comes back &mdash; a real request ' +
      'to the very program serving this page.</p>' +
      '<div class="row"><button class="btn" id="ping">' + icon('bolt') + 'Inspect the live host</button></div>' +
      '<div class="term"><div class="term-bar"><span class="term-dots"></span>' +
        '<span class="term-title">GET /_qs/info</span>' +
        '<span class="term-status" id="pingstat"></span></div>' +
        '<pre class="code" id="pingout">(calling&hellip;)</pre></div>' +
      '<div class="term"><div class="term-bar"><span class="term-dots"></span>' +
        '<span class="term-title">response headers</span></div>' +
        '<pre class="code" id="hdrout">(reading&hellip;)</pre></div>' +
      '<div class="term"><div class="term-bar"><span class="term-dots"></span>' +
        '<span class="term-title">OPTIONS /</span>' +
        '<span class="term-status" id="optstat"></span></div>' +
        '<pre class="code" id="optout">(calling&hellip;)</pre></div>' +
      '<p class="muted note">Every response carries a <kbd>Date</kbd> and the host answers ' +
      '<kbd>OPTIONS</kbd> with an <kbd>Allow</kbd> header. Add your own routes with ' +
      '<kbd>qsHttpRoute "GET","/api/thing","myHandler"</kbd>, replying via <kbd>qsHttpReply</kbd> &mdash; ' +
      'the Store&rsquo;s checkout page sketches a <kbd>POST /api/order</kbd> the same way.</p></div>';
  }
  // The response headers worth surfacing (readable same-origin), in display order.
  var SHOWN_HEADERS = ['server', 'date', 'content-type', 'content-length',
    'cache-control', 'accept-ranges', 'x-content-type-options'];
  function dumpHeaders(r) {
    var lines = [];
    for (var i = 0; i < SHOWN_HEADERS.length; i++) {
      var v = null;
      try { v = r.headers.get(SHOWN_HEADERS[i]); } catch (e) {}
      if (v) lines.push(SHOWN_HEADERS[i].replace(/\b\w/g, function (c) { return c.toUpperCase(); }) + ': ' + v);
    }
    return lines.length ? lines.join('\n') : '(no readable headers)';
  }
  function wireBackend() {
    var btn = document.getElementById('ping');
    var out = document.getElementById('pingout');
    var stat = document.getElementById('pingstat');
    var hdr = document.getElementById('hdrout');
    var optOut = document.getElementById('optout');
    var optStat = document.getElementById('optstat');
    if (!btn) return;
    function ping() {
      stat.className = 'term-status'; stat.textContent = 'requesting...';
      if (hdr) hdr.textContent = '(reading...)';
      var t0 = (window.performance && performance.now) ? performance.now() : 0;
      fetch(href('_qs/info')).then(function (r) {
        var ms = t0 ? Math.max(1, Math.round(performance.now() - t0)) : null;
        if (hdr) hdr.textContent = dumpHeaders(r);       // shows the live Date + Server + ...
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text().then(function (txt) {
          var pretty = txt; try { pretty = JSON.stringify(JSON.parse(txt), null, 2); } catch (e) {}
          out.textContent = pretty;
          stat.className = 'term-status live';
          stat.innerHTML = '<span class="dot"></span><span class="ok">200 OK</span>' + (ms ? ' &middot; ' + ms + ' ms' : '');
        });
      }).catch(function (e) {
        out.textContent = 'This route answers only when the folder is served by No Cloud Quick Share ' +
          '(not in a plain static preview).\n\n' + e;
        stat.className = 'term-status';
        stat.innerHTML = '<span class="no">unavailable here</span>';
      });
    }
    // A live OPTIONS preflight to the folder root: the host replies 200 with an Allow header.
    function options() {
      if (!optOut) return;
      optStat.className = 'term-status'; optStat.textContent = 'requesting...';
      fetch(href(''), { method: 'OPTIONS' }).then(function (r) {
        var allow = null; try { allow = r.headers.get('allow'); } catch (e) {}
        optOut.textContent = allow ? ('Allow: ' + allow) : ('HTTP ' + r.status + ' (no Allow header exposed here)');
        optStat.className = 'term-status live';
        optStat.innerHTML = '<span class="dot"></span><span class="ok">' + r.status + '</span>';
      }).catch(function (e) {
        optOut.textContent = 'OPTIONS is answered by the live host (not a plain static preview).\n\n' + e;
        optStat.className = 'term-status';
        optStat.innerHTML = '<span class="no">unavailable here</span>';
      });
    }
    btn.addEventListener('click', function () { ping(); options(); });
    ping();
    options();
  }

  // -------------------------------------------------------------------- about
  function vAbout() {
    var secure = (window.isSecureContext === true);
    var swOk = ('serviceWorker' in navigator);
    var rows = [
      ['ok', 'Static hosting', 'Every file type here (html/css/js/svg/png/jpg/wav/mp3/mp4/webm/zip/json/webmanifest) is served with the right MIME type.'],
      ['ok', 'SPA routing + deep links', 'Unknown dot-free routes fall back to index.html, so refresh works anywhere - and content deep links (blog?post=...) ride the query string so relative assets never break.'],
      ['ok', 'HTTP Range', 'The Theater and Music pages stream and SEEK; a scrub becomes "Range: bytes=..." answered with 206 Partial Content.'],
      ['ok', 'Forced downloads', 'The Store delivers real files by putting ?dl on a URL - the host flips Content-Disposition to attachment.'],
      ['ok', 'Live backend', 'GET /_qs/info is answered by the stack script; add your own routes with qsHttpRoute.'],
      ['ok', 'Tor or web link', 'Relative paths mean the same folder works at the root (Tor) or under /<token>/ (web).'],
      [secure ? 'ok' : 'q', 'Secure context', secure
        ? 'This page is a secure context, so features like service workers are allowed (typical over a Tor .onion).'
        : 'This page is NOT a secure context (plain http). Service workers and some Web APIs are blocked here; a Tor .onion would enable them.'],
      ['q', 'Live editing', 'Turn on the LAN-only editor in Quick Share and open this folder with /_edit on the end to edit these files in the browser.']
    ];
    var list = rows.map(function (r) {
      return '<li><span class="dot ' + (r[0] === 'ok' ? '' : 'q') + '">' +
        (r[0] === 'ok' ? icon('check') : '?') +
        '</span><span><span class="k">' + esc(r[1]) + '</span> &mdash; ' + esc(r[2]) + '</span></li>';
    }).join('');
    return '<div class="card"><span class="kicker">About &middot; what it proves</span>' +
      '<h2>What this demo shows</h2><ul class="feat">' + list + '</ul>' +
      '<div class="status" id="swstat">Service worker: ' +
      (swOk ? '<span class="live-chip" id="swchip"><span class="dot"></span><span id="swval">checking&hellip;</span></span>'
            : '<span class="no">not supported by this browser</span>') + '</div></div>' +
      '<div class="card"><span class="kicker">Transparency &middot; what it hides</span>' +
      '<h2>The honest privacy model</h2>' +
      '<p class="muted">Fetched live from <kbd>GET /_qs/transparency</kbd> &mdash; the host stating, in ' +
      'machine-readable form, exactly what the current transport does and does not hide.</p>' +
      '<ul class="feat" id="transp"><li><span class="muted">Loading&hellip;</span></li></ul></div>' +
      '<div class="card"><span class="kicker">Host it yourself</span><h2>One folder, no cloud</h2>' +
      '<p class="muted">In No Cloud Quick Share, drag this ' +
      '<kbd>webapp</kbd> folder onto the drop area, then share it over Tor or pick ' +
      '<b>Web link</b>. Open the link and you are looking at this page &mdash; gallery, cinema, shop and ' +
      'all. Every asset is procedurally generated or hand-drawn; nothing here phones home.</p></div>';
  }
  // Turn the /_qs/transparency JSON into a friendly, honest checklist. Each row is
  // [good?, label] where good=true shows a green check, false an amber caution.
  function transparencyRows(d) {
    var tor = d.transport === 'tor';
    return [
      [true, 'Transport: ' + esc(d.transport)],
      [!d.ip_visible_to_peers, d.ip_visible_to_peers
        ? 'Your IP is visible to visitors (it is in the web-link address)'
        : 'Your IP is hidden from visitors'],
      [!!d.both_ends_hidden, d.both_ends_hidden
        ? 'Both ends are hidden from each other' : 'The other end is not hidden'],
      [!!d.transport_encrypted, d.transport_encrypted
        ? 'Encrypted in transit (onion stream)' : 'Plain HTTP - not encrypted in transit'],
      [!!d.files_encrypted, d.files_encrypted
        ? 'Files are passphrase-encrypted' : 'Files are served as-is (passphrase encryption is a separate share-code feature)'],
      [d.logging === 'none', 'Request logging: ' + esc(String(d.logging))],
      [!!d.ephemeral, d.ephemeral
        ? 'Ephemeral - the site exists only while the sharing window is open' : 'Persistent'],
      [true, tor ? 'Over Tor, this is the strongest posture the tool offers'
                 : 'Pick the Tor front door for a stronger posture']
    ];
  }
  function wireAbout() {
    var val = document.getElementById('swval');
    var chip = document.getElementById('swchip');
    var transp = document.getElementById('transp');
    if (transp) {
      fetch(href('_qs/transparency'), { headers: { 'accept': 'application/json' } })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (d) {
          transp.innerHTML = transparencyRows(d).map(function (row) {
            return '<li><span class="dot ' + (row[0] ? '' : 'q') + '">' +
              (row[0] ? icon('check') : '?') + '</span><span>' + row[1] + '</span></li>';
          }).join('');
        })
        .catch(function () {
          transp.innerHTML = '<li><span class="muted">This lights up when the folder is served by ' +
            'No Cloud Quick Share (not in a plain static preview). The honest, full write-up lives in ' +
            '<kbd>docs/what-it-hides.md</kbd>.</span></li>';
        });
    }
    if (!val) return;
    if (window.isSecureContext && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register(href('sw.js')).then(function () {
        val.textContent = 'registered + active (secure context)'; val.className = 'ok';
        if (chip) chip.className = 'live-chip on';
      }).catch(function (e) { val.textContent = 'registration failed (' + e + ')'; val.className = 'no'; });
    } else {
      val.textContent = 'unavailable here - needs a secure context (Tor .onion or https)'; val.className = 'no';
    }
  }

  var VIEWS = {
    '':         { html: vHome,     after: null },
    'gallery':  { html: vGallery,  after: fillGallery },
    'theater':  { html: vTheater,  after: wireTheater },
    'music':    { html: vMusic,    after: wireMusic },
    'store':    { html: vStore,    after: wireStore },
    'checkout': { html: vCheckout, after: wireCheckout },
    'blog':     { html: vBlog,     after: wireBlog },
    'backend':  { html: vBackend,  after: wireBackend },
    'about':    { html: vAbout,    after: wireAbout }
  };

  // --- render + routing -------------------------------------------------------
  function buildNav() {
    nav.innerHTML = ROUTES.filter(function (r) { return !r.hidden; }).map(function (r) {
      return '<a data-route="' + r.id + '" href="' + esc(href(r.id)) + '">' + esc(r.label) + '</a>';
    }).join('');
  }
  function render() {
    lbClose();                                        // never leak the key handler
    var top = route().split('/')[0];                  // tolerate a stray nested URL
    if (!VIEWS[top]) top = '';
    var sub = qparam('post');                         // the blog's deep-link slug
    var navTop = (top === 'checkout') ? 'store' : top; // checkout highlights Store
    Array.prototype.forEach.call(nav.children, function (a) {
      a.className = (a.getAttribute('data-route') === navTop) ? 'on' : '';
    });
    var v = VIEWS[top];
    view.innerHTML = v.html(sub);
    window.scrollTo(0, 0);
    if (v.after) v.after(sub);
  }
  function go(id) {
    try { history.pushState(null, '', href(id)); }
    catch (e) { location.href = href(id); return; }   // file:// fallback
    render();
  }

  document.addEventListener('click', function (e) {
    var lb = e.target.closest ? e.target.closest('[data-lb]') : null;
    if (lb) {
      var op = lb.getAttribute('data-lb');
      if (op === 'close') lbClose();
      else if (op === 'prev') lbShow(lbIndex - 1);
      else if (op === 'next') lbShow(lbIndex + 1);
      return;
    }
    if (e.target && e.target.id === 'lightbox') { lbClose(); return; }   // backdrop only
    var t = e.target.closest ? e.target.closest('[data-lightbox]') : null;
    if (t) { lbShow(parseInt(t.getAttribute('data-lightbox'), 10)); return; }
    var a = e.target.closest ? e.target.closest('[data-route]') : null;
    if (!a) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;   // let new-tab work
    e.preventDefault();
    go(a.getAttribute('data-route'));
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var t = e.target;
    if (t && t.hasAttribute && t.hasAttribute('data-lightbox')) {
      e.preventDefault();
      lbShow(parseInt(t.getAttribute('data-lightbox'), 10));
    }
  });
  window.addEventListener('popstate', render);

  // Elevate the glass chrome once the page scrolls under it (border + soft shadow),
  // so the sticky bar reads as a floating pane rather than a flat strip. rAF-throttled
  // to stay off the single paint thread's critical path.
  var chrome = document.getElementById('chrome');
  if (chrome) {
    var ticking = false;
    window.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(function () {
        chrome.className = (window.pageYOffset > 8) ? 'chrome scrolled' : 'chrome';
        ticking = false;
      });
    }, { passive: true });
  }

  // --- boot -------------------------------------------------------------------
  buildNav();
  render();
  loadInfo().then(function (d) { info = d; paintTransport(); });
})();
