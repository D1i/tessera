// Turns a user file into a flat triangle mesh. OBJ and STL are parsed here
// (fast, no dependencies); glTF/GLB goes through Babylon's loader in a
// throw-away scene and all meshes are merged with their world transforms.

import { Engine } from "@babylonjs/core/Engines/engine";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Scene } from "@babylonjs/core/scene";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import "@babylonjs/loaders/glTF";
import type { SourceMesh } from "./hierarchy";

export const ACCEPTED = ".obj,.stl,.glb,.gltf";

export async function importFile(file: File): Promise<SourceMesh> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".obj")) return parseObj(await file.text());
  if (name.endsWith(".stl")) return parseStl(await file.arrayBuffer());
  if (name.endsWith(".glb") || name.endsWith(".gltf")) return importGltf(file);
  throw new Error(`unsupported file type: ${file.name} (use .obj, .stl, .glb or .gltf)`);
}

export function parseObj(text: string): SourceMesh {
  const pos: number[] = [];
  const idx: number[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (line.length < 3) continue;
    const c0 = line.charCodeAt(0);
    if (c0 === 118 /* v */ && line.charCodeAt(1) === 32) {
      const parts = line.trim().split(/\s+/);
      pos.push(+parts[1], +parts[2], +parts[3]);
    } else if (c0 === 102 /* f */ && line.charCodeAt(1) === 32) {
      const parts = line.trim().split(/\s+/);
      const face: number[] = [];
      for (let i = 1; i < parts.length; i++) {
        const s = parts[i];
        const slash = s.indexOf("/");
        const n = parseInt(slash >= 0 ? s.slice(0, slash) : s, 10);
        face.push(n < 0 ? pos.length / 3 + n : n - 1);
      }
      for (let k = 1; k + 1 < face.length; k++) idx.push(face[0], face[k], face[k + 1]);
    }
  }
  if (!pos.length || !idx.length) throw new Error("OBJ has no geometry");
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

export function parseStl(buf: ArrayBuffer): SourceMesh {
  const u8 = new Uint8Array(buf);
  const head = new TextDecoder().decode(u8.subarray(0, Math.min(80, u8.length)));
  const dv = new DataView(buf);
  const binaryCount = buf.byteLength >= 84 ? dv.getUint32(80, true) : 0;
  const isBinary = buf.byteLength >= 84 && 84 + binaryCount * 50 === buf.byteLength;
  if (!isBinary && head.trimStart().startsWith("solid")) {
    const text = new TextDecoder().decode(u8);
    const pos: number[] = [];
    const re = /vertex\s+([-+\deE.]+)\s+([-+\deE.]+)\s+([-+\deE.]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) pos.push(+m[1], +m[2], +m[3]);
    return sequential(new Float32Array(pos));
  }
  const pos = new Float32Array(binaryCount * 9);
  let at = 84;
  for (let t = 0; t < binaryCount; t++) {
    at += 12; // normal
    for (let k = 0; k < 9; k++) {
      pos[t * 9 + k] = dv.getFloat32(at, true);
      at += 4;
    }
    at += 2; // attribute byte count
  }
  return sequential(pos);
}

/** Unindexed triangle soup -> indexed (welding happens later in the hierarchy builder). */
function sequential(positions: Float32Array): SourceMesh {
  const n = positions.length / 3;
  const indices = new Uint32Array(n);
  for (let i = 0; i < n; i++) indices[i] = i;
  return { positions, indices };
}

async function importGltf(file: File): Promise<SourceMesh> {
  const engine: Engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const url = URL.createObjectURL(file);
    const ext = file.name.toLowerCase().endsWith(".glb") ? ".glb" : ".gltf";
    const result = await SceneLoader.ImportMeshAsync("", "", url, scene, undefined, ext);
    URL.revokeObjectURL(url);
    const pos: number[] = [];
    const idx: number[] = [];
    const tmp = new Vector3();
    for (const m of result.meshes) {
      const p = m.getVerticesData(VertexBuffer.PositionKind);
      const ind = m.getIndices();
      if (!p || !ind || ind.length === 0) continue;
      m.computeWorldMatrix(true);
      const w: Matrix = m.getWorldMatrix();
      const base = pos.length / 3;
      for (let i = 0; i < p.length; i += 3) {
        Vector3.TransformCoordinatesFromFloatsToRef(p[i], p[i + 1], p[i + 2], w, tmp);
        pos.push(tmp.x, tmp.y, tmp.z);
      }
      const flip = w.determinant() < 0;
      for (let i = 0; i < ind.length; i += 3) {
        if (flip) idx.push(base + ind[i], base + ind[i + 2], base + ind[i + 1]);
        else idx.push(base + ind[i], base + ind[i + 1], base + ind[i + 2]);
      }
    }
    if (!pos.length) throw new Error("glTF has no triangle meshes");
    return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
  } finally {
    scene.dispose();
    engine.dispose();
  }
}
