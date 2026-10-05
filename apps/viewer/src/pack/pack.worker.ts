// Runs the hierarchy build + packing off the main thread.
import { build, ready, type BuildProgress, type SourceMesh } from "./hierarchy";
import { pack } from "./pack";

export interface PackRequest {
  type: "pack";
  positions: Float32Array;
  indices: Uint32Array;
  groupSize: number;
}

export type PackMessage =
  | { type: "progress"; progress: BuildProgress }
  | { type: "done"; manifest: ArrayBuffer; archives: ArrayBuffer[]; buildMs: number; packMs: number }
  | { type: "error"; message: string };

self.onmessage = async (e: MessageEvent<PackRequest>) => {
  const post = (m: PackMessage, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);
  try {
    await ready();
    const src: SourceMesh = { positions: e.data.positions, indices: e.data.indices };
    const t0 = performance.now();
    const h = build(src, e.data.groupSize, (progress) => post({ type: "progress", progress }));
    const t1 = performance.now();
    const p = pack(h);
    const t2 = performance.now();
    post({ type: "done", manifest: p.manifest, archives: p.archives, buildMs: t1 - t0, packMs: t2 - t1 }, [p.manifest, ...p.archives]);
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
