// Stats panel and controls. Plain DOM, no framework.

import type { LoadProgress } from "./loader";
import type { FrameInfo, Mode } from "./scene";
import { ACCEPTED } from "./pack/import";

export interface HudState {
  engine: "wasm" | "js";
  wasmMissing: boolean;
  sourceTriangles: number;
  clusterCount: number;
  levelCount: number;
  /** Name of the model on screen. */
  modelName: string;
  instances: number;
}

export interface HudControls {
  onMode(mode: Mode): void;
  onInstances(n: number): void;
  onTranslucent(on: boolean): void;
  onThreshold(px: number): void;
  onClusterColors(on: boolean): void;
  onFrustumCull(on: boolean): void;
  onFreeze(on: boolean): void;
  onAbBenchmark(): Promise<string>;
  onBenchmark(): Promise<string>;
  onLoadFile(file: File): void;
  onResetModel(): void;
}

const fmt = (n: number) => n.toLocaleString("en-US");
const mb = (b: number) => (b / 1048576).toFixed(1);
const sourceLine = (s: HudState) =>
  s.instances > 1
    ? `${s.modelName} · ${fmt(s.sourceTriangles)} triangles × ${s.instances} = ${fmt(s.sourceTriangles * s.instances)} · ${fmt(s.clusterCount)} clusters · ${s.levelCount} levels`
    : `${s.modelName} · ${fmt(s.sourceTriangles)} triangles · ${fmt(s.clusterCount)} clusters · ${s.levelCount} levels`;

export class Hud {
  private v: Record<string, HTMLElement> = {};
  private frames = 0;
  private selectAcc = 0;
  private lastTick = performance.now();
  private state: HudState;

  constructor(root: HTMLElement, state: HudState, controls: HudControls) {
    this.state = state;
    root.innerHTML = `
      <div class="hud-head">
        <div class="hud-title">Tessera</div>
        <span class="badge ${state.engine}">${state.engine === "wasm" ? "Rust / WebAssembly" : "TypeScript fallback"}</span>
      </div>
      ${state.wasmMissing ? `<div class="hud-note">WebAssembly package not built (<code>npm run build:wasm</code>); running the TypeScript reference runtime.</div>` : ""}
      <label class="switch">
        <input type="checkbox" data-k="mode" checked>
        <span class="track"></span>
        <span class="switch-text">Tessera <b data-k="modeText">on</b><small data-k="modeSub">cluster LOD, per-instance cut</small></span>
      </label>
      <div class="hud-grid">
        <div class="stat"><b data-k="fps">0</b><span>fps</span></div>
        <div class="stat"><b data-k="select">0.0</b><span>ms select / frame</span></div>
        <div class="stat"><b data-k="tris">0</b><span>triangles / frame</span></div>
        <div class="stat"><b data-k="draws">0</b><span>draw calls</span></div>
      </div>
      <div class="hud-rows">
        <div><span>Scene</span><b class="scene-row">
          <select data-k="instances">
            <option value="1">1 instance</option>
            <option value="9">9 instances</option>
            <option value="27" selected>27 instances</option>
            <option value="64">64 instances</option>
          </select>
          <label class="check"><input type="checkbox" data-k="ice" checked> a third translucent</label>
        </b></div>
        <div><span>Model</span><b data-k="model">${sourceLine(state)}</b></div>
        <div><span>Loaded</span><b data-k="loaded">0 / 0 archives · 0.0 MB</b></div>
        <div><span>First frame</span><b data-k="first">–</b></div>
        <div><span>Full detail</span><b data-k="full">–</b></div>
        <div><span>Decode</span><b data-k="decode">–</b></div>
        <div><span>Cut</span><b data-k="cut">–</b></div>
      </div>
      <div class="hud-progress"><div data-k="bar"></div></div>
      <div class="hud-controls">
        <button class="btn" data-k="ab">Run A/B benchmark: Tessera on vs off</button>
        <pre class="bench-out" data-k="abOut"></pre>
        <label class="range"><span>Error threshold <b data-k="thr">1.0 px</b></span>
          <input type="range" min="-2" max="3" step="0.05" value="0" data-k="thrInput"></label>
        <label class="check"><input type="checkbox" data-k="colors"> Cluster colours</label>
        <label class="check"><input type="checkbox" data-k="cull" checked> Frustum culling</label>
        <label class="check"><input type="checkbox" data-k="freeze"> Freeze cut (move the camera to inspect the LOD)</label>
        <button class="btn ghost" data-k="bench">Decode + select: WebAssembly vs TypeScript</button>
        <pre class="bench-out" data-k="benchOut"></pre>
      </div>
      <div class="hud-controls">
        <div class="row">
          <button class="btn ghost" data-k="load">Load your model…</button>
          <button class="btn ghost" data-k="reset">Asteroid</button>
          <input type="file" data-k="file" accept="${ACCEPTED}" hidden>
        </div>
        <div class="hud-sub">Drop an .obj, .stl, .glb or .gltf anywhere on the page. The cluster hierarchy is built in your browser (meshoptimizer WebAssembly, in a worker) and streamed from memory.</div>
        <div class="hud-status" data-k="packStatus"></div>
      </div>
      <div class="hud-help">Drag to orbit · wheel to zoom · right-drag to pan. Zoom in: clusters split into finer ones; zoom out: they merge.</div>
    `;
    root.querySelectorAll<HTMLElement>("[data-k]").forEach((e) => (this.v[e.dataset.k!] = e));

    const modeInput = this.v.mode as HTMLInputElement;
    modeInput.addEventListener("change", () => {
      this.setModeLabel(modeInput.checked ? "lod" : "full");
      controls.onMode(modeInput.checked ? "lod" : "full");
    });
    (this.v.instances as HTMLSelectElement).addEventListener("change", (e) => {
      const n = Number((e.target as HTMLSelectElement).value);
      this.state = { ...this.state, instances: n };
      this.v.model.textContent = sourceLine(this.state);
      controls.onInstances(n);
    });
    (this.v.ice as HTMLInputElement).addEventListener("change", (e) => controls.onTranslucent((e.target as HTMLInputElement).checked));
    const thr = this.v.thrInput as HTMLInputElement;
    thr.addEventListener("input", () => {
      const px = Math.pow(2, Number(thr.value));
      this.v.thr.textContent = `${px.toFixed(2)} px`;
      controls.onThreshold(px);
    });
    (this.v.colors as HTMLInputElement).addEventListener("change", (e) => controls.onClusterColors((e.target as HTMLInputElement).checked));
    (this.v.cull as HTMLInputElement).addEventListener("change", (e) => controls.onFrustumCull((e.target as HTMLInputElement).checked));
    (this.v.freeze as HTMLInputElement).addEventListener("change", (e) => controls.onFreeze((e.target as HTMLInputElement).checked));
    const fileInput = this.v.file as HTMLInputElement;
    (this.v.load as HTMLButtonElement).addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      const f = fileInput.files?.[0];
      if (f) controls.onLoadFile(f);
      fileInput.value = "";
    });
    (this.v.reset as HTMLButtonElement).addEventListener("click", () => controls.onResetModel());
    this.wireBenchButton(this.v.ab as HTMLButtonElement, this.v.abOut, controls.onAbBenchmark, "measuring… keep the camera still");
    this.wireBenchButton(this.v.bench as HTMLButtonElement, this.v.benchOut, controls.onBenchmark, "running…");
  }

  private wireBenchButton(btn: HTMLButtonElement, out: HTMLElement, run: () => Promise<string>, busyText: string): void {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      out.textContent = busyText;
      try {
        out.textContent = await run();
      } catch (err) {
        out.textContent = String(err);
      }
      btn.disabled = false;
    });
  }

  private setModeLabel(mode: Mode): void {
    this.v.modeText.textContent = mode === "lod" ? "on" : "off";
    this.v.modeSub.textContent = mode === "lod" ? "cluster LOD, per-instance cut" : "every instance draws all its triangles";
    (this.v.mode.parentElement as HTMLElement).classList.toggle("off", mode === "full");
  }

  /** Reflect a mode set from code (the A/B benchmark toggles it). */
  setMode(mode: Mode): void {
    (this.v.mode as HTMLInputElement).checked = mode === "lod";
    this.setModeLabel(mode);
  }

  frame(info: FrameInfo, fps: number): void {
    this.frames++;
    this.selectAcc += info.selectMs;
    const now = performance.now();
    if (now - this.lastTick < 250) return;
    const s = info.stats;
    this.v.fps.textContent = String(Math.round(fps));
    this.v.select.textContent = (this.selectAcc / this.frames).toFixed(2);
    this.v.tris.textContent = fmt(s.triangles);
    this.v.draws.textContent = fmt(info.drawCalls);
    this.v.cut.textContent = info.mode === "lod"
      ? `${fmt(s.clusters)} clusters · coarsest level ${s.coarsestLevelInCut} · ${fmt(s.culled)} culled · ${fmt(s.pendingRefinement)} awaiting finer data${info.pendingInstances ? ` · ${info.pendingInstances} instances updating` : ""}`
      : `full resolution: ${fmt(s.clusters)} leaf clusters, no selection, no culling`;
    this.frames = 0;
    this.selectAcc = 0;
    this.lastTick = now;
  }

  /** Replace the model line and badge after a model switch. */
  setModel(state: HudState): void {
    this.state = state;
    this.v.model.textContent = sourceLine(state);
    this.v.first.textContent = "–";
    this.v.full.textContent = "–";
    this.v.decode.textContent = "–";
    this.v.bar.style.width = "0%";
  }

  packStatus(text: string, busy = false): void {
    this.v.packStatus.textContent = text;
    this.v.packStatus.classList.toggle("busy", busy);
    (this.v.load as HTMLButtonElement).disabled = busy;
    (this.v.reset as HTMLButtonElement).disabled = busy;
  }

  progress(p: LoadProgress): void {
    this.v.loaded.textContent = `${p.archivesLoaded} / ${p.archivesTotal} archives · ${mb(p.bytesLoaded)} / ${mb(p.bytesTotal)} MB`;
    this.v.bar.style.width = `${(p.bytesLoaded / Math.max(1, p.bytesTotal)) * 100}%`;
    if (p.firstFrameMs !== null) this.v.first.textContent = `${(p.firstFrameMs / 1000).toFixed(2)} s`;
    if (p.fullMs !== null) this.v.full.textContent = `${(p.fullMs / 1000).toFixed(2)} s`;
    if (p.archivesLoaded > 0) this.v.decode.textContent = `${p.decodeMs.toFixed(0)} ms decode · ${p.uploadMs.toFixed(0)} ms GPU upload`;
  }
}
