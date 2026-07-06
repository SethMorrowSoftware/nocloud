# Custom API endpoints without LiveCode (`.qsroutes.json`)

You can add your own HTTP endpoints to a shared folder **without opening the stack script**.
Drop a file named **`.qsroutes.json`** in the folder you share, declare your routes in it, and
No Cloud Quick Share serves them alongside your static files.

It is **declarative and safe by design**: a route can only return a **canned body** or a
**redirect** — no code runs. Paths under `/_qs/` and `/_edit/` are reserved, header values are
sanitised, and the `.qsroutes.json` file itself is never served or listed (it is a dotfile).

> Requires the engine's JSON support. Custom routes are **fail-closed**: if the build has no
> JSON decoder, the feature is simply off and everything else works. When you build a
> standalone, tick the **JSON Library** in the Inclusions pane (see
> `building-a-standalone.md`).

## The file

`.qsroutes.json` at the root of your shared folder:

```json
{
  "routes": [
    {
      "method": "GET",
      "path": "/api/hello",
      "type": "application/json; charset=utf-8",
      "body": "{\"hello\":\"from a folder\",\"cloud\":false}",
      "cors": true
    },
    {
      "method": "GET",
      "path": "/api/note",
      "type": "text/plain; charset=utf-8",
      "body": "Declared in .qsroutes.json - no LiveCode, no cloud.",
      "headers": { "X-Defined-By": "qsroutes.json" }
    },
    {
      "method": "GET",
      "path": "/go/gallery",
      "redirect": "/gallery",
      "status": 302
    }
  ]
}
```

Now `GET /api/hello` (at the onion root over Tor, or under `/<token>/` over a web link)
returns your JSON with an `Access-Control-Allow-Origin: *` header, and `/go/gallery` redirects.

## Route fields

| Field | Meaning | Default |
|---|---|---|
| `method` | HTTP method to match (`GET`, `POST`, …) | `GET` |
| `path` | The URL path. Must start with `/`; may not contain `..` or control bytes; may not be under the reserved `/_qs/` or `/_edit/`. | *(required)* |
| `body` | The response body (any text). Capped at 64 KB. | `""` |
| `type` | `Content-Type` for a body response. | `text/plain; charset=utf-8` |
| `status` | HTTP status code. | `200` (body) / `302` (redirect) |
| `redirect` | If present, the route becomes a redirect to this `Location`. `status` may be `301/302/303/307/308`. | — |
| `cors` | `true` adds `Access-Control-Allow-Origin: *` (so other pages/tools may fetch it). | `false` |
| `headers` | An object of extra response headers. Names are limited to letters/digits/`-`; CR/LF/control bytes are stripped from values. | — |

## Good to know

- **What it's for:** mock/JSON APIs, config endpoints, CORS-enabled data, redirects and
  short-links — anything a *canned* response covers. There is no scripting; for genuinely
  dynamic logic the stack still offers `qsHttpRoute "GET","/api/thing","myHandler"` →
  `qsHttpReply` inside the script.
- **Reserved:** paths under `/_qs/` (the host's own info/transparency routes) and `/_edit/`
  (the LAN editor) can never be overridden, and an invalid route is skipped, not fatal.
- **Reload:** the file is read when you start sharing the folder. If you edit it while
  sharing, stop and re-share (or share it again) to pick up the changes.
- **Limits:** up to 100 routes per file; the config file is read up to 256 KB; each inline
  body is capped at 64 KB. A malformed file disables *only* custom routes, never the server.
- **Privacy:** these routes are served over whichever transport you picked, with the same
  honesty as everything else — a web link exposes your IP; Tor hides both ends. Nothing here
  changes that (see `what-it-hides.md`).
