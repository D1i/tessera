//! Source meshes: procedural generators (so the repository ships no large assets)
//! and a minimal OBJ reader for real models.

use std::fs;
use std::path::Path;

#[derive(Clone, Debug, Default)]
pub struct Mesh {
    pub positions: Vec<[f32; 3]>,
    pub normals: Vec<[f32; 3]>,
    /// Three per triangle.
    pub indices: Vec<u32>,
}

impl Mesh {
    pub fn triangle_count(&self) -> usize {
        self.indices.len() / 3
    }

    /// Area-weighted smooth normals from the triangle list.
    pub fn compute_normals(&mut self) {
        let mut acc = vec![[0f32; 3]; self.positions.len()];
        for t in self.indices.chunks_exact(3) {
            let (a, b, c) = (
                self.positions[t[0] as usize],
                self.positions[t[1] as usize],
                self.positions[t[2] as usize],
            );
            let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            let n = [
                u[1] * v[2] - u[2] * v[1],
                u[2] * v[0] - u[0] * v[2],
                u[0] * v[1] - u[1] * v[0],
            ];
            for &i in t {
                let s = &mut acc[i as usize];
                s[0] += n[0];
                s[1] += n[1];
                s[2] += n[2];
            }
        }
        self.normals = acc
            .into_iter()
            .map(|n| {
                let l = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
                if l > 0.0 {
                    [n[0] / l, n[1] / l, n[2] / l]
                } else {
                    [0.0, 1.0, 0.0]
                }
            })
            .collect();
    }
}

// ----------------------------------------------------------------- noise

fn hash3(x: i32, y: i32, z: i32, seed: u32) -> f32 {
    let mut h = (x as u32).wrapping_mul(0x8da6_b343)
        ^ (y as u32).wrapping_mul(0xd816_3841)
        ^ (z as u32).wrapping_mul(0xcb1a_b31f)
        ^ seed.wrapping_mul(0x9e37_79b9);
    h ^= h >> 15;
    h = h.wrapping_mul(0x2c1b_3c6d);
    h ^= h >> 12;
    h = h.wrapping_mul(0x297a_2d39);
    h ^= h >> 15;
    (h & 0xffff) as f32 / 65535.0
}

fn smooth(t: f32) -> f32 {
    t * t * (3.0 - 2.0 * t)
}

/// Trilinear value noise in [0, 1].
fn value_noise(p: [f32; 3], seed: u32) -> f32 {
    let f = [p[0].floor(), p[1].floor(), p[2].floor()];
    let t = [
        smooth(p[0] - f[0]),
        smooth(p[1] - f[1]),
        smooth(p[2] - f[2]),
    ];
    let (x, y, z) = (f[0] as i32, f[1] as i32, f[2] as i32);
    let mut v = 0.0;
    for dz in 0..2 {
        for dy in 0..2 {
            for dx in 0..2 {
                let w = (if dx == 1 { t[0] } else { 1.0 - t[0] })
                    * (if dy == 1 { t[1] } else { 1.0 - t[1] })
                    * (if dz == 1 { t[2] } else { 1.0 - t[2] });
                v += w * hash3(x + dx, y + dy, z + dz, seed);
            }
        }
    }
    v
}

/// Fractional Brownian motion, roughly in [-1, 1].
pub fn fbm(p: [f32; 3], octaves: u32, seed: u32) -> f32 {
    let mut amp = 0.5;
    let mut freq = 1.0;
    let mut sum = 0.0;
    let mut norm = 0.0;
    for o in 0..octaves {
        sum += amp * (value_noise([p[0] * freq, p[1] * freq, p[2] * freq], seed + o) * 2.0 - 1.0);
        norm += amp;
        amp *= 0.5;
        freq *= 2.03;
    }
    sum / norm
}

// ------------------------------------------------------------ generators

/// A sphere displaced by layered noise: craters, ridges, no symmetry, lots of
/// high-frequency detail that LOD has to work for. `rings` x `segments` grid.
pub fn asteroid(rings: usize, segments: usize, seed: u32) -> Mesh {
    let mut m = Mesh::default();
    m.positions.reserve((rings + 1) * (segments + 1));
    for r in 0..=rings {
        let v = r as f32 / rings as f32;
        let phi = v * std::f32::consts::PI;
        for s in 0..=segments {
            let u = s as f32 / segments as f32;
            let theta = u * std::f32::consts::TAU;
            let d = [phi.sin() * theta.cos(), phi.cos(), phi.sin() * theta.sin()];
            let low = fbm(
                [d[0] * 2.0 + 7.0, d[1] * 2.0 + 3.0, d[2] * 2.0 + 11.0],
                4,
                seed,
            );
            let mid = fbm([d[0] * 9.0, d[1] * 9.0, d[2] * 9.0], 5, seed + 17);
            let high = fbm([d[0] * 48.0, d[1] * 48.0, d[2] * 48.0], 4, seed + 101);
            let crater = {
                let c = value_noise([d[0] * 5.0 + 20.0, d[1] * 5.0, d[2] * 5.0], seed + 7);
                if c > 0.74 {
                    -(c - 0.74) * 1.4
                } else {
                    0.0
                }
            };
            let radius = (1.0 + 0.26 * low + 0.07 * mid + 0.012 * high + crater).max(0.55);
            m.positions
                .push([d[0] * radius, d[1] * radius, d[2] * radius]);
        }
    }
    grid_indices(&mut m, rings, segments, true);
    m.compute_normals();
    m
}

/// A heightfield terrain with ridged mountains; `n` x `n` cells.
pub fn terrain(n: usize, seed: u32) -> Mesh {
    let mut m = Mesh::default();
    m.positions.reserve((n + 1) * (n + 1));
    for j in 0..=n {
        let z = j as f32 / n as f32 * 2.0 - 1.0;
        for i in 0..=n {
            let x = i as f32 / n as f32 * 2.0 - 1.0;
            let base = fbm([x * 3.0, z * 3.0, 0.5], 5, seed);
            let ridge = 1.0 - fbm([x * 7.0 + 3.0, z * 7.0, 1.5], 6, seed + 31).abs();
            let detail = fbm([x * 60.0, z * 60.0, 2.5], 4, seed + 77);
            let y = 0.18 * base + 0.22 * ridge * ridge + 0.006 * detail;
            m.positions.push([x, y, z]);
        }
    }
    grid_indices(&mut m, n, n, false);
    m.compute_normals();
    m
}

fn grid_indices(m: &mut Mesh, rows: usize, cols: usize, _wrap: bool) {
    let w = cols + 1;
    m.indices.reserve(rows * cols * 6);
    for r in 0..rows {
        for c in 0..cols {
            let a = (r * w + c) as u32;
            let b = a + 1;
            let d = a + w as u32;
            let e = d + 1;
            m.indices.extend_from_slice(&[a, d, b, b, d, e]);
        }
    }
}

/// Minimal OBJ reader: `v` and `f` lines, triangulates polygons as fans.
pub fn load_obj(path: &Path) -> Result<Mesh, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut m = Mesh::default();
    for line in text.lines() {
        let mut it = line.split_whitespace();
        match it.next() {
            Some("v") => {
                let v: Vec<f32> = it.take(3).filter_map(|s| s.parse().ok()).collect();
                if v.len() == 3 {
                    m.positions.push([v[0], v[1], v[2]]);
                }
            }
            Some("f") => {
                let idx: Vec<u32> = it
                    .filter_map(|s| s.split('/').next().and_then(|a| a.parse::<i64>().ok()))
                    .map(|i| {
                        if i < 0 {
                            (m.positions.len() as i64 + i) as u32
                        } else {
                            (i - 1) as u32
                        }
                    })
                    .collect();
                for k in 1..idx.len().saturating_sub(1) {
                    m.indices.extend_from_slice(&[idx[0], idx[k], idx[k + 1]]);
                }
            }
            _ => {}
        }
    }
    if m.positions.is_empty() || m.indices.is_empty() {
        return Err("obj has no geometry".into());
    }
    m.compute_normals();
    Ok(m)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asteroid_is_closed_grid() {
        let m = asteroid(32, 64, 1);
        assert_eq!(m.triangle_count(), 32 * 64 * 2);
        assert_eq!(m.normals.len(), m.positions.len());
        for p in &m.positions {
            let r = (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt();
            assert!(r > 0.5 && r < 1.6, "radius {r}");
        }
    }

    #[test]
    fn fbm_is_bounded() {
        for i in 0..200 {
            let v = fbm([i as f32 * 0.37, 1.3, -2.1], 5, 9);
            assert!((-1.0..=1.0).contains(&v));
        }
    }
}
