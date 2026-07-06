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
    var onion = /\.onion$/i.test(location.hostname);
    if (info && info.mode === 'tor' || onion) {
      el.textContent = 'Served over Tor'; el.className = 'badge tor';
    } else if (info && info.mode === 'clearweb') {
      el.textContent = 'Served over the web'; el.className = 'badge web';
    } else if (info) {
      el.textContent = 'Served by No Cloud Quick Share'; el.className = 'badge web';
    } else {
      el.textContent = 'Static preview'; el.className = 'badge';
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
  function vHome() {
    var spots = [
      ['gallery', 'Gallery', 'Eight vector pieces and a raster photo, with a lightbox. Plain files, right MIME.'],
      ['theater', 'Theater', 'A short film that streams and SEEKS over HTTP Range, plus an ambient webm loop.'],
      ['music',   'Music',   'Three MP3s on a record shelf with a playlist player. Scrubbing is a Range request.'],
      ['store',   'Store',   'A storefront with a cart and real delivery - files served as forced downloads.'],
      ['blog',    'Blog',    'Posts from a JSON file, each with a deep link that survives refresh.'],
      ['backend', 'Backend', 'Not just static: a live JSON route answered by the app script itself.']
    ];
    return '' +
      '<section class="hero">' +
        '<h1>A whole little internet &mdash; from a folder you shared.</h1>' +
        '<p>Gallery, cinema, record shelf, shop, blog: everything on this site is a plain file in ' +
        'one shared folder, served by No Cloud Quick Share. Same files whether it reached you ' +
        'over Tor or a direct web link. No cloud, no build step, no framework.</p>' +
        '<div class="pills">' +
          '<span class="pill">Static assets</span><span class="pill">Correct MIME</span>' +
          '<span class="pill">HTTP Range</span><span class="pill">SPA + deep links</span>' +
          '<span class="pill">Forced downloads</span><span class="pill">Live backend</span>' +
          '<span class="pill">Tor or web</span>' +
        '</div>' +
      '</section>' +
      '<div class="spots">' + spots.map(function (s) {
        return '<a class="spot" data-route="' + esc(s[0]) + '" href="' + esc(href(s[0])) + '">' +
          '<b>' + esc(s[1]) + '</b><span>' + esc(s[2]) + '</span></a>';
      }).join('') + '</div>' +
      '<div class="card"><h2>One folder, honestly</h2>' +
        '<p class="muted">Use the tabs above &mdash; every one is a real client-side route. Refresh anywhere ' +
        '(even inside a blog post) and the page still loads: the server hands unknown dot-free paths back to ' +
        '<kbd>index.html</kbd> and this script restores the view. The <b>About</b> tab lists everything ' +
        'this demo exercises.</p></div>';
  }

  // ------------------------------------------------------------------ gallery
  function vGallery() {
    return '<div class="card"><h2>Gallery</h2>' +
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
  function lbClose() {
    var el = document.getElementById('lightbox');
    if (el) el.parentNode.removeChild(el);
    document.removeEventListener('keydown', lbKeys);
    lbIndex = -1;
  }
  function lbKeys(e) {
    if (e.key === 'Escape') lbClose();
    else if (e.key === 'ArrowRight') lbShow(lbIndex + 1);
    else if (e.key === 'ArrowLeft') lbShow(lbIndex - 1);
  }
  function lbShow(i) {
    if (!galleryItems.length) return;
    lbIndex = (i + galleryItems.length) % galleryItems.length;
    var it = galleryItems[lbIndex];
    var el = document.getElementById('lightbox');
    if (!el) {
      el = document.createElement('div');
      el.id = 'lightbox';
      el.className = 'lightbox';
      view.appendChild(el);
      document.addEventListener('keydown', lbKeys);
    }
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
  }

  // ------------------------------------------------------------------ theater
  var CHAPTERS = [
    { at: 0,  name: 'Titles - aurora' },
    { at: 15, name: 'Deep zoom' },
    { at: 30, name: 'Tide' },
    { at: 41, name: 'Credits' }
  ];
  function vTheater() {
    return '<div class="card media"><h2>Now showing: <i>First Light</i> (0:46)</h2>' +
      '<p class="muted">A procedurally generated short, streamed straight from the folder. It is offered ' +
      'twice &mdash; <kbd>video/webm</kbd> (VP9) and <kbd>video/mp4</kbd> (H.264) &mdash; and your browser picks ' +
      'the first one it can play; both were written with their index up front, so the browser can turn any ' +
      'timestamp into a byte offset and fetch just that slice with an <b>HTTP Range</b> request. ' +
      'Jump between chapters and watch how little actually downloads.</p>' +
      '<video id="film" controls preload="metadata" poster="assets/film-poster.jpg" ' +
        'width="640" height="360">' +
        '<source src="assets/film.webm" type="video/webm">' +
        '<source src="assets/film.mp4" type="video/mp4">' +
        'Your browser cannot play WebM or MP4 video.</video>' +
      '<div class="row chapters">' + CHAPTERS.map(function (c, i) {
        return '<button class="btn ghost" data-seek="' + c.at + '">' + fmtTime(c.at) + ' &middot; ' + esc(c.name) + '</button>';
      }).join('') + '</div>' +
      '<p class="status muted" id="seekstat">Press play &mdash; then scrub, or jump to a chapter.</p></div>' +
      '<div class="card media"><h2>The ambient loop</h2>' +
      '<p class="muted">A 10-second seamless loop served as <kbd>video/webm</kbd> (VP9) &mdash; a second video ' +
      'format from the same folder, autoplaying muted like a living poster. The whole file is 29&nbsp;KB.</p>' +
      '<video autoplay muted loop playsinline src="assets/loop.webm" width="640" height="360"></video></div>' +
      '<div class="card"><h2>Bring your own premiere</h2><p class="muted">Drop any folder with an ' +
      '<kbd>.mp4</kbd> into No Cloud Quick Share and it streams the same way &mdash; multi-gigabyte files ' +
      'are served one bounded slice at a time, so the sharer&rsquo;s memory use stays flat no matter how ' +
      'many people press play.</p></div>';
  }
  function wireTheater() {
    var vid = document.getElementById('film');
    var stat = document.getElementById('seekstat');
    if (!vid) return;
    Array.prototype.forEach.call(view.querySelectorAll('[data-seek]'), function (b) {
      b.addEventListener('click', function () {
        vid.currentTime = parseFloat(b.getAttribute('data-seek'));
        vid.play();
      });
    });
    vid.addEventListener('seeked', function () {
      if (stat) stat.innerHTML = 'Seeked to <b>' + fmtTime(vid.currentTime) +
        '</b> &mdash; the browser asked the host for just those bytes (<kbd>Range: bytes=&hellip;</kbd>, answered <kbd>206 Partial Content</kbd>).';
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
    return '<div class="card"><h2>Quick Share Sessions <span class="muted">&mdash; the demo EP</span></h2>' +
      '<p class="muted">Three procedurally composed tracks served as <kbd>audio/mpeg</kbd> (plus one ' +
      '<kbd>audio/wav</kbd> interlude). Pick a track; scrubbing the player issues the same HTTP Range ' +
      'requests the Theater uses. Every track is also a plain file you can open or force-download.</p>' +
      '<audio id="deck" controls preload="none"></audio>' +
      '<ol class="tracks">' + TRACKS.map(function (t, i) {
        return '<li class="track" id="trk-' + i + '">' +
          '<button class="tr-play" data-track="' + i + '" aria-label="Play ' + esc(t.title) + '">&#9654;</button>' +
          '<span class="tr-name"><b>' + esc(t.title) + '</b><span>' + t.note + '</span></span>' +
          '<span class="tr-len">' + esc(t.len) + '</span>' +
          '<span class="tr-links"><a href="' + esc(t.file) + '?dl=1" title="Force a download with ?dl">get</a></span>' +
          '</li>';
      }).join('') + '</ol></div>' +
      '<div class="card"><h2>A record shelf in a folder</h2><p class="muted">A band could hand out its ' +
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
    return '<div class="card"><h2 id="shopname">The No Cloud Shop</h2>' +
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
    bar.innerHTML = '<span><b>' + cart.length + '</b> item' + (cart.length === 1 ? '' : 's') +
      ' in the cart</span>' +
      '<a class="btn" data-route="checkout" href="' + esc(href('checkout')) + '">Check out &mdash; $0.00</a>' +
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
        (inCart ? 'In the cart &#10003;' : 'Add to cart') + '</button></div></div>';
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
    return '<div class="card"><h2>Checkout</h2><div id="order"><p class="muted">Loading&hellip;</p></div></div>' +
      '<div class="card"><h2>Where a real shop would go from here</h2>' +
      '<p class="muted">Everything you just did was static files plus your own browser: the catalog is ' +
      '<kbd>store.json</kbd>, the cart is localStorage, delivery is <kbd>?dl</kbd>. The moment real orders ' +
      'enter the picture, the host can answer dynamic routes too &mdash; register one in the stack script:</p>' +
      '<pre class="code">qsHttpRoute "POST", "/api/order", "myOrderHandler"</pre>' +
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
            '<a class="btn" href="' + esc(p.file) + '?dl=1">Download</a></li>';
        }).join('') + '</ul>' +
        '<div class="row"><a class="btn ghost" data-route="store" href="' + esc(href('store')) + '">Keep browsing</a>' +
        '<button class="btn ghost" id="orderdone">Empty the cart</button></div>' +
        '<p class="muted" style="margin-top:.9em">(The "order" never left your browser &mdash; the cart is ' +
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
    return '<div class="card"><h2 id="blogname">The Folder Papers</h2>' +
      '<div id="blogbox"><p class="muted">Loading&hellip;</p></div></div>';
  }
  function blogBlock(b) {
    if (b.h) return '<h3>' + esc(b.h) + '</h3>';
    if (b.p) return '<p>' + esc(b.p) + '</p>';
    if (b.code) return '<pre class="code">' + esc(b.code) + '</pre>';
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
        box.innerHTML = '<article class="post"><h2>' + esc(post.title) + '</h2>' +
          '<p class="postmeta muted">' + esc(post.date) + ' &middot; ' + post.minutes + ' min read &middot; ' +
          'this page&rsquo;s deep link survives a refresh</p>' +
          post.body.map(blogBlock).join('') + '</article>' + nav2;
        return;
      }
      box.innerHTML = '<p class="muted" id="blogline">' + esc(d.tagline || '') + '</p>' +
        posts.map(function (p) {
          return '<a class="postcard" data-route="blog?post=' + esc(p.slug) + '" href="' +
            esc(href('blog?post=' + p.slug)) + '"><b>' + esc(p.title) + '</b>' +
            '<span class="postmeta muted">' + esc(p.date) + ' &middot; ' + p.minutes + ' min</span>' +
            '<span>' + esc(p.teaser) + '</span></a>';
        }).join('');
    }).catch(function () {
      box.innerHTML = '<p class="muted">Could not load blog.json.</p>';
    });
  }

  // ------------------------------------------------------------------ backend
  function vBackend() {
    return '<div class="card"><h2>Live backend</h2>' +
      '<p class="muted">Not just static files: the host answers dynamic routes from the stack script. ' +
      'This calls the built-in <kbd>GET /_qs/info</kbd> and shows what comes back.</p>' +
      '<div class="row"><button class="btn" id="ping">Call /_qs/info</button>' +
      '<span id="pingstat" class="status muted"></span></div>' +
      '<pre class="code" id="pingout">(calling&hellip;)</pre>' +
      '<p class="muted" style="margin-top:1em">Add your own with <kbd>qsHttpRoute "GET","/api/thing","myHandler"</kbd> ' +
      'in the stack, replying via <kbd>qsHttpReply</kbd> &mdash; the Store&rsquo;s checkout page sketches a ' +
      '<kbd>POST /api/order</kbd> the same way.</p></div>';
  }
  function wireBackend() {
    var btn = document.getElementById('ping');
    var out = document.getElementById('pingout');
    var stat = document.getElementById('pingstat');
    if (!btn) return;
    function ping() {
      stat.textContent = 'requesting...'; stat.className = 'status muted';
      var t0 = (window.performance && performance.now) ? performance.now() : 0;
      fetch(href('_qs/info')).then(function (r) {
        var ms = t0 ? Math.max(1, Math.round(performance.now() - t0)) : null;
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text().then(function (txt) {
          var pretty = txt; try { pretty = JSON.stringify(JSON.parse(txt), null, 2); } catch (e) {}
          out.textContent = pretty;
          stat.innerHTML = '<span class="ok">200 OK</span>' + (ms ? ' in ' + ms + ' ms' : '');
        });
      }).catch(function (e) {
        out.textContent = 'This route answers only when the folder is served by No Cloud Quick Share ' +
          '(not in a plain static preview).\n\n' + e;
        stat.innerHTML = '<span class="no">unavailable here</span>';
      });
    }
    btn.addEventListener('click', ping);
    ping();
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
      return '<li><span class="dot ' + (r[0] === 'ok' ? '' : 'q') + '">' + (r[0] === 'ok' ? '✓' : '?') +
        '</span><span><span class="k">' + esc(r[1]) + '</span> &mdash; ' + esc(r[2]) + '</span></li>';
    }).join('');
    return '<div class="card"><h2>What this demo shows</h2><ul class="feat">' + list + '</ul>' +
      '<p class="status" id="swstat" style="margin-top:1.1em">' +
      (swOk ? 'Service worker: <span id="swval" class="muted">checking&hellip;</span>'
            : 'Service worker: <span class="no">not supported by this browser</span>') + '</p></div>' +
      '<div class="card"><h2>Host it yourself</h2><p class="muted">In No Cloud Quick Share, drag this ' +
      '<kbd>webapp</kbd> folder onto the drop area, then share it over Tor or pick ' +
      '<b>Web link</b>. Open the link and you are looking at this page &mdash; gallery, cinema, shop and ' +
      'all. Every asset is procedurally generated or hand-drawn; nothing here phones home.</p></div>';
  }
  function wireAbout() {
    var val = document.getElementById('swval');
    if (!val) return;
    if (window.isSecureContext && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register(href('sw.js')).then(function () {
        val.textContent = 'registered + active (secure context).'; val.className = 'ok';
      }).catch(function (e) { val.textContent = 'registration failed (' + e + ').'; val.className = 'no'; });
    } else {
      val.textContent = 'unavailable here - needs a secure context (Tor .onion or https).'; val.className = 'no';
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

  // --- boot -------------------------------------------------------------------
  buildNav();
  render();
  loadInfo().then(function (d) { info = d; paintTransport(); });
})();
