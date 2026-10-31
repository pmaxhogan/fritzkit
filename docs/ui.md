# fritzkit ui

`fritzkit ui` is a local web editor for `part.json`: drag pads on the reference photo,
edit the pin table, calibrate the photo, and see the four compiled views and the
validator after every save. It is a thin shell over the same core as the CLI and the MCP
server, so a part edited in the UI exports exactly as `fritzkit export` would.

```
fritzkit ui [part] [--port <n>] [--no-open]
```

- Starts a server on `127.0.0.1` only (never on other interfaces), on port 5173 or the
  next free one. With `--port <n>` exactly that port is used (0 = any free port).
- Opens `http://127.0.0.1:<port>/` in the default browser (`--no-open` prints the URL
  instead). With `[part]` (a slug, or a part folder) the app opens on that part; a part
  folder outside the workspace makes its parent folder the workspace for this session.
- Runs until Ctrl+C. Example output:

```
fritzkit ui: editing C:\Users\me\fritzkit\parts
  http://127.0.0.1:5173/#/xiao-esp32-c6
opened in your browser; press Ctrl+C to stop
```

The app is served from `dist/ui` (built by `npm run build` or `npm run ui:build`). When it
is missing, `fritzkit ui` exits 2 and says how to build it. `FRITZKIT_UI_DIST` overrides
the folder.

## The editor

Left: the canvas, in millimetres of the part frame (origin at the outline's top-left).
The reference photo (`artwork.photo.src`, else the asset picked in Outline &
Calibration, else just the outline) is drawn cropped and rotated exactly as the compiler
will crop and rotate it, stretched over the outline. Every connector is a marker labelled
`<key> #<connector number>`:

- a pin or pad moves itself;
- a header pin moves the whole header;
- a lead moves its from-point (the whole lead follows).

Toolbar: snap to 0.1 in (applies while dragging; a pin with `"snap": true` always snaps),
zoom, and X/Y (mm) of the selected item. Arrow keys nudge the selected item by 0.1 mm
(shift: 1 mm) when no input field has focus.

Right, the tabs:

| tab                   | what it edits                                                                                                                                                                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pins                  | the pin table (key read-only after creation, name, label, type, role, description, pad shape/w/h/hole, x/y, bus membership, Up/Down reorder, add/remove); headers (placement, pin names/labels/roles, add a 1-row header); wire leads                    |
| Outline & Calibration | width/height/shape/corner radius; asset picker and upload; Auto-detect board (sets the crop to the detected board); Click two points (click two features, type their real distance, the crop is sized from the px/mm); rotate 0/90/180/270; crop x/y/w/h |
| Artwork               | style (vector/photo), board and silk colours, silkscreen text items                                                                                                                                                                                      |
| Buses                 | add/remove buses, pick their pins                                                                                                                                                                                                                        |
| Preview               | the four compiled views, the validator with explanations, Run Fritzing checker, Export .fzpz, Install into Fritzing (disabled while Fritzing is running)                                                                                                 |
| Raw                   | the part.json text with Apply                                                                                                                                                                                                                            |

Edits stay in the page until saved: Save writes immediately, and every change is
auto-saved 600 ms after the last edit if it passes the schema (the same zod schema the
CLI uses runs in the browser). Saving allocates connector numbers for new keys into
`pinIds` (D12a) so the numbers on the markers are final.

Live reload: when `part.json` changes on disk (an agent editing it, `fritzkit export`
persisting pinIds), the app reloads it if you have no unsaved edits; otherwise a bar asks
"part.json changed on disk - reload?". New files under `assets/` refresh the asset list
and the previews.

## Development

`npm run ui:dev` starts Vite on `127.0.0.1:5173` with hot reload and mounts the same
`/api` handler inside the dev server (workspace from `$FRITZKIT_WORKSPACE`, else
`~/fritzkit/parts`), so no second process is needed. `npm run ui:build` typechecks the app
(`tsconfig.ui.json`) and writes `dist/ui`. The app has no unit tests (spec D30); the
server is tested in `test/ui-server.test.ts`. The app imports the pure core modules
(`schema/part.ts`, `resolve.ts`) and never `src/core/image` (sharp).

## HTTP API

JSON under `/api`. Errors are always `{ "error": "...", ... }` with a status code; the
server never drops a connection on a bad request. Requests whose `Host` (or `Origin`) is
not a loopback name are refused with 403 (DNS-rebinding guard).

| route                                   | does                                                                                                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/parts`                        | `{ workspace, parts: [{ slug, dir, title }] }`                                                                                                                                  |
| `GET /api/parts/:slug`                  | `{ slug, dir, text, hash, raw, valid, issues, spec, connectors, buses, frame, pinIds, assets }`; an invalid part.json comes back with `valid: false` and the issues (still 200) |
| `PUT /api/parts/:slug`                  | body = the part.json object; validated (zod + resolve), pinIds allocated, written atomically; 200 with the GET payload, 422 `{ issues }`, slug must not change                  |
| `GET /api/parts/:slug/render/:view.svg` | compiled `breadboard`, `schematic`, `pcb` or `icon` SVG (header `x-fritzkit-module-id`, compile warnings in `x-fritzkit-warnings`); compile errors are 422 JSON                 |
| `GET /api/parts/:slug/validate`         | `fritzkit validate` as JSON, each issue with `explain`; `?checker=1` also runs the vendored Fritzing checker                                                                    |
| `POST /api/parts/:slug/export`          | writes `<partdir>/<moduleId>.fzpz`; `{ path, moduleId, issues }`; 422 when the validator reports errors (body `{ "force": true }` exports anyway)                               |
| `POST /api/parts/:slug/install`         | export + install into Fritzing's user parts folder; 409 `{ reason: "fritzing-running" }` while Fritzing is running                                                              |
| `GET /api/parts/:slug/assets`           | `{ assets: [{ name: "assets/top.png", size }] }`                                                                                                                                |
| `GET /api/parts/:slug/assets/<name>`    | a file under the part's `assets/` (path-safe); raster images only as images, anything else as an attachment                                                                     |
| `POST /api/parts/:slug/assets?name=x`   | raw body upload into `assets/<name>`; one file name with a raster extension (png, jpg, jpeg, webp, gif, avif, tif, tiff), no separators or `..`; 201                            |
| `POST /api/parts/:slug/calibrate`       | body `{ asset, rotate? }`: detects the board bbox; `{ bbox, crop, widthPx, heightPx, pxPerMm }` for the outline                                                                 |
| `GET /api/parts/:slug/events`           | SSE: `event: changed` with `{ kind: "part", hash }` or `{ kind: "assets" }`, debounced, from fs.watch                                                                           |
| `GET /api/doctor`                       | the `fritzkit doctor` report plus `fritzingRunning`                                                                                                                             |

Asset and preview responses carry `X-Content-Type-Options: nosniff` and a sandboxed
`Content-Security-Policy`, so a crafted SVG or HTML file can never run script on the
editor's origin.

`createServer({ workspace, ctx })` in `src/server/index.ts` builds the server with the
same injectable `CommandContext` as the CLI (fixed date, fake `isRunning`, Fritzing folder
overrides), which is how the tests drive it.

## Known limitations

- Photo placement: `preparePhoto` trims the keyed photo to the detected board box before
  stretching it over the outline. The canvas shows the photo with only crop and rotation
  applied, so a crop looser than the board box shifts pads in the export. Use Auto-detect
  (which sets the crop to the board box) before placing pads on a photo.
- Concurrent edits: PUT has no version check. An external write landing inside the app's
  autosave window can be overwritten; the "changed on disk" bar covers the common case.
- `GET /api/parts/:slug/validate` persists newly allocated pinIds (same as the CLI).
