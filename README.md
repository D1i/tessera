# infinity-grid-canvas

Infinite drag-and-drop layout grid on Canvas 2D: a dynamic coordinate grid with placement prediction, collision resolution by pushing neighbours, resize anchors, undo/redo, pan and zoom, and virtualized rendering that stays at 60 fps with 50 000 items on the sheet.

**Live demo:** https://d1i.github.io/infinity-grid-canvas/

![Dragging a field onto an occupied row: the prediction (dashed) shows where it lands and which neighbour is pushed right](docs/drag-prediction.png)

## What is in the box

| Package | What it does | Runtime deps |
|---|---|---|
| `packages/core` | Grid model, placement prediction, resize, history, viewport, Canvas 2D renderer, pointer/keyboard controller | none |
| `packages/flow` | Flowchart canvas used by the demo's "no-code scheme" view: layered DAG generator, orthogonal edges with labels, node shapes, pan/zoom | none |
| `apps/demo` | React 18 + Vite shell: palette, inspector, benchmark HUD, theme switch | react, react-dom |
| `bench` | Playwright runner with DevTools CPU throttling; writes `bench/results/latest.md` | playwright |

The core is plain TypeScript with no framework dependency, so it can sit under React, Vue, or a vanilla page. React is only used for the chrome around the canvas.

## Engine

**Row-indexed model.** Items live in a `Map<id, item>` plus a `Map<row, item[]>`. Every operation that matters during a drag (hit tests, free-space checks, prediction) touches a single row, so cost does not depend on how many items the sheet holds.

**Placement prediction.** While dragging, `grid.predict(x, y, w)` returns where the item would land and which neighbours would move:

- the cell under the pointer is free: valid, no shifts;
- it overlaps: items to the right are pushed in a cascade, each one only as far as needed;
- the cascade runs past the last column: the prediction is marked invalid and nothing moves.

The renderer draws the prediction (dashed outline, pushed neighbours tinted) on every pointer move; `grid.commit(prediction, item)` applies it as one undoable step.

**Resize anchors.** Left and right edges of a hovered item are anchors; dragging one resizes the item with the opposite edge pinned and the same prediction overlay, which turns red when the new width would overlap a neighbour.

**Infinite rows.** The sheet grows as items are placed below the last row and keeps a few empty rows as a tail. Nothing is pre-allocated.

**Batch allocator.** `grid.addMany(n, spec)` packs `n` items into free rows in one pass (50 000 items in about 70 ms) and records a single undo entry.

**History.** Command stack with batching, capped at 200 entries; `Ctrl+Z` / `Ctrl+Y`.

**Virtualized rendering.** The renderer only visits rows that intersect the viewport, so the frame cost depends on the screen, not on the item count. Level of detail follows the zoom: full titles above 50 %, glyph badges only between 30 % and 50 %, tinted tiles below that, which turns a 50 000-field sheet into a readable occupancy map at 20 %.

**Viewport.** Zoom 20 %–400 % around the pointer (`Ctrl` + wheel, `+` / `-` / `0`, double-click on empty space), pan by dragging empty space or with the wheel, edge auto-pan while dragging, reset view with `0`.

**Input.** Pointer-based drag from the palette (window-level listeners, no HTML5 DnD), drag threshold, keyboard nudging with arrows, `Del` to remove, `Esc` to cancel a drag.

![Zoomed-out overview of 10 000 fields in the dark theme](docs/overview-10k-dark.png)

## No-code scheme view

Every field has a gear. It opens a flowchart canvas with an automation attached to that field. The view is **visual only**: "Generate scheme" builds a plausible layered graph (trigger, conditions with yes/no branches, data and notification steps, end states) with a seeded PRNG, lays it out, and draws orthogonal edges with arrowheads and label pills over a dotted background. Nodes can be dragged (snapped to an 8 px grid), the canvas pans and zooms. "Save" shows a warning that this is a demo and nothing is persisted.

![Generated no-code scheme](docs/flow-editor.png)

## Benchmark

Numbers from `npm run bench` on a 2-vCPU Linux VM (Intel Xeon 2.10 GHz), headless Chromium 141, 1440×900 viewport. Frame times are p50 / p95 of 200 synchronous renders; "drawn" is how many items intersected the viewport; "drag" is the `requestAnimationFrame` rate while an item is dragged across the sheet with prediction running on every pointer move.

**No throttling**

| fields | add | undo | frame @100 % | frame @20 % | drag |
|---:|---:|---:|---|---|---:|
| 1 000 | 4 ms | 1 ms | 0.3 / 0.7 ms (41 drawn) | 0.3 / 0.5 ms (193 drawn) | 60 fps |
| 10 000 | 11 ms | 4 ms | 0.3 / 0.6 ms (42 drawn) | 0.3 / 0.6 ms (194 drawn) | 60 fps |
| 50 000 | 72 ms | 21 ms | 0.3 / 0.6 ms (42 drawn) | 0.4 / 0.6 ms (194 drawn) | 60 fps |

**10x CPU throttling** (DevTools `Emulation.setCPUThrottlingRate`)

| fields | add | undo | frame @100 % | frame @20 % | drag |
|---:|---:|---:|---|---|---:|
| 1 000 | 24 ms | 1 ms | 4.0 / 8.7 ms | 3.4 / 6.0 ms | 41 fps |
| 10 000 | 139 ms | 12 ms | 3.8 / 6.9 ms | 3.5 / 7.2 ms | 40 fps |
| 50 000 | 620 ms | 219 ms | 4.3 / 8.1 ms | 4.1 / 6.8 ms | 46 fps |

Frame time is flat across sheet sizes because only visible rows are rendered. Under 10x throttling a frame still fits in a 16 ms budget; the drag rate there is bounded by the test driver's pointer-event cadence as much as by rendering. Full table with the 40 % column and redo timings: [`bench/results/latest.md`](bench/results/latest.md).

```sh
npm run build
npm run bench                       # unthrottled + 10x
npm run bench -- --throttle 4       # other rate
npm run bench -- --sizes 1000,100000 --frames 500
```

The runner starts Vite's preview server in-process, drives the demo through `window.__infinityGrid` (grid, controller, `addMany`, `clear`) and `controller.renderOnce()`, and writes `bench/results/latest.md` and `latest.json`. Playwright needs a browser once: `npx playwright install chromium`.

## Getting started

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # apps/demo/dist
npm run typecheck
```

Node 20.19+ or 22.12+ (Vite 7).

## Using the core without the demo

```ts
import { Grid, GridController, lightTheme } from "@infinity-grid-canvas/core";

const grid = new Grid({ columns: 12, rowHeight: 44, minRows: 14 });
const controller = new GridController(canvas, grid, {
  select: (item) => console.log("selected", item),
  gear: (item) => console.log("gear", item),
  change: () => console.log("layout changed"),
  view: (zoom) => console.log("zoom", zoom)
}, lightTheme);

grid.add({ id: "name", type: "text", title: "Full name", x: 0, y: 0, w: 6, required: true });

// Drag something in from outside the canvas (e.g. a palette button):
button.addEventListener("pointerdown", (e) =>
  controller.beginExternalDrag({ type: "money", title: "Amount", w: 3 }, e)
);
```

`grid.toJSON()` / `grid.load(snapshot)` serialize the layout. `controller.stats` exposes fps, last frame time and the number of items drawn.

## Project layout

```
packages/core/src
  model.ts        item/prediction types, defaults, width helpers
  grid.ts         row-indexed model, predict/commit, resize, addMany, history
  viewport.ts     zoom/pan math, visible-row range, constraints
  renderer.ts     Canvas 2D drawing, level of detail, hit-test cache
  controller.ts   pointer/keyboard state machine, render loop, stats
  glyphs.ts       field-type icons drawn with canvas paths
  theme.ts        light/dark tokens
packages/flow/src
  model.ts        node kinds and sizes
  generator.ts    seeded layered DAG generator + layout
  flow-canvas.ts  flowchart renderer and interaction
apps/demo/src     React shell (App, FlowEditor, inspector, palette, styles)
bench/run.mjs     Playwright benchmark
```

## License

MIT © Maxim Kalin
