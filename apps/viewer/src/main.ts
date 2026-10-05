import "./styles.css";
import { Hud, type HudState } from "./hud";
import { applyArchivesFromMemory, archiveCache, fetchManifest, streamArchives, type LoadProgress } from "./loader";
import { JsRuntime, WasmRuntime, type Runtime } from "./runtime";
import { Viewer, type Mode } from "./scene";
import { importFile } from "./pack/import";
import type { PackMessage, PackRequest } from "./pack/pack.worker";

const base = `${import.meta.env.BASE_URL}asset/`;

interface Session {
  runtime: Runtime;
  manifest: ArrayBuffer;
  wasmAvailable: boolean;
}

async function makeRuntime(manifest: ArrayBuffer): Promise<{ runtime: Runtime; wasmAvailable: boolean }> {
  const wasm = await WasmRuntime.load(manifest);
  return { runtime: wasm ?? new JsRuntime(manifest), wasmAvailable: wasm !== null };
}

async function main(): Promise<void> {
  const canvas = document.getElementById("view") as HTMLCanvasElement;
  const hudRoot = document.getElementById("hud") as HTMLElement;
  const splash = document.getElementById("splash") as HTMLElement;

  const manifest = await fetchManifest(base);
  const { runtime, wasmAvailable } = await makeRuntime(manifest);
  let session: Session = { runtime, manifest, wasmAvailable };

  const viewer = new Viewer(canvas);
  viewer.setRuntime(runtime);

  const hudState = (name: string): HudState => ({
    engine: session.runtime.kind,
    wasmMissing: !session.wasmAvailable,
    sourceTriangles: session.runtime.manifest.sourceTriangles,
    clusterCount: session.runtime.manifest.clusterCount,
    levelCount: session.runtime.manifest.levelCount,
    modelName: name,
    instances: viewer.instanceCount
  });

  let packing = false;

  const hud: Hud = new Hud(hudRoot, hudState("asteroid"), {
    onMode: (mode: Mode) => (viewer.mode = mode),
    onInstances: (n) => (viewer.instanceCount = n),
    onTranslucent: (on) => (viewer.translucentEvery = on ? 3 : 0),
    onThreshold: (px) => (viewer.thresholdPx = px),
    onClusterColors: (on) => (viewer.clusterColors = on),
    onFrustumCull: (on) => (viewer.frustumCull = on),
    onFreeze: (on) => (viewer.freezeCut = on),
    onAbBenchmark: (): Promise<string> => abBenchmark(session, viewer, hud),
    onBenchmark: () => benchmark(session, viewer),
    onLoadFile: (file) => void loadUserModel(file),
    onResetModel: () => void loadAsteroid()
  });
  viewer.onFrame = (f) => hud.frame(f, viewer.fps());
  (window as unknown as { __tessera: unknown }).__tessera = { viewer, get runtime() { return session.runtime; } };

  const loaderEvents = {
    onArchive: (id: number, _range: [number, number], p: LoadProgress) => {
      viewer.invalidateCut();
      hud.progress(p);
      if (id === 0) splash.classList.add("hidden");
    },
    onProgress: (p: LoadProgress) => hud.progress(p)
  };

  async function loadAsteroid(): Promise<void> {
    if (packing) return;
    const m = await fetchManifest(base);
    const r = await makeRuntime(m);
    session = { runtime: r.runtime, manifest: m, wasmAvailable: r.wasmAvailable };
    viewer.translucentEvery = 3;
    hud.setTranslucent(true);
    viewer.setRuntime(session.runtime);
    hud.setModel(hudState("asteroid"));
    hud.packStatus("");
    const progress = await streamArchives(base, session.runtime, loaderEvents, (f, c) => viewer.uploadRange(f, c));
    hud.progress(progress);
    viewer.invalidateCut();
  }

  async function loadUserModel(file: File): Promise<void> {
    if (packing) return;
    packing = true;
    const t0 = performance.now();
    try {
      hud.packStatus(`reading ${file.name}…`, true);
      const src = await importFile(file);
      hud.packStatus(`${file.name}: ${(src.indices.length / 3).toLocaleString("en-US")} triangles · building hierarchy…`, true);

      const packed = await packInWorker(src.positions, src.indices, (level, clusters, trisOut) => {
        hud.packStatus(`${file.name}: level ${level} · ${clusters.toLocaleString("en-US")} clusters · ${trisOut.toLocaleString("en-US")} triangles`, true);
      });

      const r = await makeRuntime(packed.manifest);
      session = { runtime: r.runtime, manifest: packed.manifest, wasmAvailable: r.wasmAvailable };
      // Translucency is tuned for the near-convex asteroid; an arbitrary model shows only its nearest shell.
      viewer.translucentEvery = 0;
      hud.setTranslucent(false);
      viewer.setRuntime(session.runtime);
      hud.setModel(hudState(file.name));
      const total = packed.archives.reduce((s, a) => s + a.byteLength, 0);
      hud.packStatus(
        `${file.name}: ${session.runtime.manifest.clusterCount.toLocaleString("en-US")} clusters, ${session.runtime.manifest.levelCount} levels, ${(total / 1048576).toFixed(1)} MB packed · hierarchy ${(packed.buildMs / 1000).toFixed(1)} s · pack ${packed.packMs.toFixed(0)} ms · total ${((performance.now() - t0) / 1000).toFixed(1)} s`
      );
      const progress = await applyArchivesFromMemory(session.runtime, packed.archives, loaderEvents, (f, c) => viewer.uploadRange(f, c));
      hud.progress(progress);
      viewer.invalidateCut();
    } catch (err) {
      hud.packStatus(`failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      packing = false;
    }
  }

  // Drag and drop anywhere. Only file drags count: a dragged text selection or
  // a slider thumb must not bring the overlay up.
  const isFileDrag = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
  let dragDepth = 0;
  const endDrag = () => {
    dragDepth = 0;
    document.body.classList.remove("dropping");
  };
  window.addEventListener("dragenter", (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth++;
    document.body.classList.add("dropping");
  });
  window.addEventListener("dragleave", (e) => {
    if (!isFileDrag(e)) return;
    if (--dragDepth <= 0) endDrag();
  });
  window.addEventListener("dragover", (e) => {
    if (isFileDrag(e)) e.preventDefault();
  });
  window.addEventListener("drop", (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    endDrag();
    const f = e.dataTransfer?.files?.[0];
    if (f) void loadUserModel(f);
  });
  // A drag that ends outside the window never sends dragleave; clear the overlay on the next pointer move.
  window.addEventListener("dragend", endDrag);
  window.addEventListener("pointermove", () => { if (dragDepth > 0) endDrag(); }, { passive: true });

  const progress = await streamArchives(base, session.runtime, loaderEvents, (f, c) => viewer.uploadRange(f, c));
  hud.progress(progress);
  viewer.invalidateCut();
}

interface PackResult {
  manifest: ArrayBuffer;
  archives: ArrayBuffer[];
  buildMs: number;
  packMs: number;
}

function packInWorker(positions: Float32Array, indices: Uint32Array, onProgress: (level: number, clusters: number, trisOut: number) => void): Promise<PackResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./pack/pack.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<PackMessage>) => {
      const m = e.data;
      if (m.type === "progress") onProgress(m.progress.level, m.progress.clusters, m.progress.trianglesOut);
      else if (m.type === "done") {
        worker.terminate();
        resolve({ manifest: m.manifest, archives: m.archives, buildMs: m.buildMs, packMs: m.packMs });
      } else {
        worker.terminate();
        reject(new Error(m.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "packing worker failed"));
    };
    const req: PackRequest = { type: "pack", positions, indices, groupSize: 8 };
    worker.postMessage(req, [positions.buffer, indices.buffer]);
  });
}

/**
 * Same camera, same scene, Tessera on and then off: frames per second and
 * triangles per frame for each, so the gain is one number.
 */
async function abBenchmark(session: Session, viewer: Viewer, hud: Hud): Promise<string> {
  if (archiveCache.size === 0) return "archives not loaded yet";
  const n = viewer.instanceCount;
  const src = session.runtime.manifest.sourceTriangles;
  const startMode = viewer.mode;
  const wasFrozen = viewer.freezeCut;
  viewer.freezeCut = false;
  const lines: string[] = [
    `${viewer.gpuName()}`,
    `${viewer.engine.getRenderWidth()}×${viewer.engine.getRenderHeight()} · ${n} × ${src.toLocaleString("en-US")} = ${(n * src).toLocaleString("en-US")} source triangles · ${session.runtime.kind} runtime`
  ];
  const results: Record<Mode, Awaited<ReturnType<Viewer["measureFps"]>>> = {} as never;
  for (const mode of ["lod", "full"] as Mode[]) {
    viewer.mode = mode;
    hud.setMode(mode);
    results[mode] = await viewer.measureFps(2500);
    const r = results[mode];
    lines.push(
      `Tessera ${mode === "lod" ? "on " : "off"}  ${r.fps.toFixed(1).padStart(6)} fps · ${r.frameMs.toFixed(1).padStart(6)} ms/frame · ${r.triangles.toLocaleString("en-US").padStart(11)} tris/frame${mode === "lod" ? ` · cut for ${n} instances in ${r.refreshMs.toFixed(1)} ms` : ""}`
    );
  }
  viewer.mode = startMode;
  hud.setMode(startMode);
  viewer.freezeCut = wasFrozen;
  const a = results.lod;
  const b = results.full;
  lines.push(`→ ${(a.fps / Math.max(b.fps, 1e-6)).toFixed(1)}× the frame rate with ${(b.triangles / Math.max(a.triangles, 1)).toFixed(0)}× fewer triangles`);
  return lines.join("\n");
}

/** Re-decode the cached archives and time the cut selection with each engine. */
async function benchmark(session: Session, viewer: Viewer): Promise<string> {
  const archives = [...archiveCache.entries()].sort((a, b) => a[0] - b[0]);
  if (archives.length === 0) return "archives not loaded yet";
  const bytes = archives.reduce((s, [, b]) => s + b.byteLength, 0);
  const view = viewer.viewParams();
  const lines: string[] = [`${archives.length} archives, ${(bytes / 1048576).toFixed(1)} MB, cut at the current view`];
  const engines: Array<["wasm" | "js", () => Promise<Runtime | null>]> = [
    ["wasm", () => WasmRuntime.load(session.manifest)],
    ["js", async () => new JsRuntime(session.manifest)]
  ];
  for (const [name, make] of engines) {
    if (name === "wasm" && !session.wasmAvailable) continue;
    const rt = await make();
    if (!rt) continue;
    await new Promise((r) => setTimeout(r, 0));
    const t0 = performance.now();
    for (const [id, buf] of archives) rt.addArchive(id, buf);
    const decode = performance.now() - t0;
    let stats = rt.select(view);
    const frames = 30;
    const t1 = performance.now();
    for (let i = 0; i < frames; i++) stats = rt.select(view);
    const sel = (performance.now() - t1) / frames;
    lines.push(
      `${name.padEnd(5)} decode ${decode.toFixed(0).padStart(5)} ms (${(bytes / 1048576 / (decode / 1000)).toFixed(0)} MB/s) · select ${sel.toFixed(2)} ms/frame · ${stats.triangles.toLocaleString("en-US")} tris`
    );
  }
  return lines.join("\n");
}

main().catch((err) => {
  const splash = document.getElementById("splash");
  if (splash) splash.textContent = `Failed to load: ${err instanceof Error ? err.message : String(err)}`;
  console.error(err);
});
