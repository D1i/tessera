// Fetches the manifest and all archives concurrently (HTTP/2 multiplexes them)
// and hands archives to the runtime strictly in order, so the coarse proxy is
// always on screen before anything finer refines it.

import type { Runtime } from "./runtime";

export interface LoadProgress {
  archivesLoaded: number;
  archivesTotal: number;
  bytesLoaded: number;
  bytesTotal: number;
  /** ms since start when the first archive was decoded. */
  firstFrameMs: number | null;
  /** ms since start when the last archive was decoded. */
  fullMs: number | null;
  decodeMs: number;
  uploadMs: number;
}

export interface LoaderEvents {
  onArchive(id: number, range: [number, number], progress: LoadProgress): void;
  onProgress(progress: LoadProgress): void;
}

export async function fetchManifest(base: string): Promise<ArrayBuffer> {
  const r = await fetch(`${base}model.tsm`, { cache: "no-cache" });
  if (!r.ok) throw new Error(`manifest: HTTP ${r.status}`);
  const buf = await r.arrayBuffer();
  const head = new Uint8Array(buf.slice(0, 4));
  if (String.fromCharCode(...head) !== "TSM1") {
    // The dev server answers a missing file with index.html; say what is actually wrong.
    throw new Error("packed model not found in apps/viewer/public/asset — run `npm run asset` first (cargo run -p tessera-pack)");
  }
  return buf;
}

/** Downloaded archives are kept so the benchmark can re-decode them without the network. */
export const archiveCache = new Map<number, ArrayBuffer>();

export async function streamArchives(base: string, runtime: Runtime, events: LoaderEvents, uploadRange: (first: number, count: number) => number): Promise<LoadProgress> {
  const t0 = performance.now();
  archiveCache.clear();
  const archives = runtime.manifest.archives;
  const progress: LoadProgress = {
    archivesLoaded: 0,
    archivesTotal: archives.length,
    bytesLoaded: 0,
    bytesTotal: archives.reduce((s, a) => s + a.byteLen, 0),
    firstFrameMs: null,
    fullMs: null,
    decodeMs: 0,
    uploadMs: 0
  };
  const pending = new Map<number, ArrayBuffer>();
  let next = 0;

  const apply = () => {
    while (pending.has(next)) {
      const bytes = pending.get(next)!;
      pending.delete(next);
      const td = performance.now();
      const range = runtime.addArchive(next, bytes);
      progress.decodeMs += performance.now() - td;
      progress.uploadMs += uploadRange(range[0], range[1]);
      progress.archivesLoaded++;
      if (progress.firstFrameMs === null) progress.firstFrameMs = performance.now() - t0;
      events.onArchive(next, range, progress);
      next++;
    }
    if (next === archives.length) progress.fullMs = performance.now() - t0;
  };

  await Promise.all(
    archives.map(async (a, id) => {
      const r = await fetch(`${base}archive-${id}.tsa`);
      if (!r.ok) throw new Error(`archive ${id}: HTTP ${r.status}`);
      const buf = await readWithProgress(r, (delta) => {
        progress.bytesLoaded += delta;
        events.onProgress(progress);
      });
      if (buf.byteLength !== a.byteLen) throw new Error(`archive ${id}: size mismatch`);
      archiveCache.set(id, buf);
      pending.set(id, buf);
      apply();
    })
  );
  return progress;
}

async function readWithProgress(r: Response, onDelta: (n: number) => void): Promise<ArrayBuffer> {
  if (!r.body) {
    const b = await r.arrayBuffer();
    onDelta(b.byteLength);
    return b;
  }
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    onDelta(value.byteLength);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out.buffer;
}

/**
 * Same progression as [`streamArchives`] for archives that are already in memory
 * (packed in the browser): one archive per animation frame, coarse first, so the
 * refinement is visible and the timings mean the same thing.
 */
export async function applyArchivesFromMemory(runtime: Runtime, archives: ArrayBuffer[], events: LoaderEvents, uploadRange: (first: number, count: number) => number): Promise<LoadProgress> {
  const t0 = performance.now();
  archiveCache.clear();
  const progress: LoadProgress = {
    archivesLoaded: 0,
    archivesTotal: archives.length,
    bytesLoaded: 0,
    bytesTotal: archives.reduce((s, a) => s + a.byteLength, 0),
    firstFrameMs: null,
    fullMs: null,
    decodeMs: 0,
    uploadMs: 0
  };
  for (let id = 0; id < archives.length; id++) {
    const bytes = archives[id];
    archiveCache.set(id, bytes);
    const td = performance.now();
    const range = runtime.addArchive(id, bytes);
    progress.decodeMs += performance.now() - td;
    progress.uploadMs += uploadRange(range[0], range[1]);
    progress.archivesLoaded++;
    progress.bytesLoaded += bytes.byteLength;
    if (progress.firstFrameMs === null) progress.firstFrameMs = performance.now() - t0;
    events.onArchive(id, range, progress);
    events.onProgress(progress);
    await new Promise((r) => requestAnimationFrame(r));
  }
  progress.fullMs = performance.now() - t0;
  return progress;
}
