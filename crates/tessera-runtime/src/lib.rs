//! Streaming LOD runtime.
//!
//! Owns one vertex pool for the whole model (sized from the manifest up front so
//! the GPU buffers can be allocated once), decodes archives into it as they
//! arrive, and every frame picks the *cut*: the set of clusters whose projected
//! error is below the pixel threshold while their coarser replacement's error is
//! above it. Clusters whose finer children are not loaded yet stay in the cut, so
//! the picture is always complete and refines as archives stream in.
//!
//! The same code runs natively (tests, benchmarks) and in WebAssembly through
//! the thin `wasm` module.

use tessera_format::{decode_archive_table, decode_cluster, ClusterInfo, Manifest, Sphere};

#[cfg(target_arch = "wasm32")]
pub mod wasm;

/// Per-frame camera input. `view_proj` is column-major, as WebGL and Babylon.js store it.
#[derive(Clone, Copy, Debug)]
pub struct View {
    pub position: [f32; 3],
    pub view_proj: [f32; 16],
    /// Viewport height in pixels.
    pub viewport_height: f32,
    /// Vertical field of view in radians.
    pub fov_y: f32,
    /// Allowed screen-space error in pixels.
    pub threshold_px: f32,
    pub frustum_cull: bool,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct CutStats {
    pub clusters: u32,
    pub triangles: u32,
    pub culled: u32,
    pub loaded_clusters: u32,
    pub loaded_triangles: u32,
    pub pending_refinement: u32,
    pub coarsest_level_in_cut: u32,
}

pub struct Runtime {
    pub manifest: Manifest,
    clusters: Vec<ClusterInfo>,
    loaded: Vec<bool>,
    archive_loaded: Vec<bool>,
    /// First vertex of each cluster in the pool.
    vertex_base: Vec<u32>,
    /// First index of each cluster in `indices`.
    index_first: Vec<u32>,
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    /// RGBA per vertex, a stable colour per cluster for the debug view.
    pub colors: Vec<u8>,
    /// Global pool indices of every loaded cluster, back to back.
    indices: Vec<u32>,
    pool_vertices: u32,
    pub cut: Vec<u32>,
    pub stats: CutStats,
    scratch_render: Vec<bool>,
}

fn cluster_color(id: u32) -> [u8; 4] {
    // Golden-ratio hue walk gives neighbouring ids clearly different colours.
    let h = ((id as f32 * 0.618_034) % 1.0) * 6.0;
    let s = 0.55;
    let v = 0.95;
    let c = v * s;
    let x = c * (1.0 - ((h % 2.0) - 1.0).abs());
    let (r, g, b) = match h as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = v - c;
    [
        ((r + m) * 255.0) as u8,
        ((g + m) * 255.0) as u8,
        ((b + m) * 255.0) as u8,
        255,
    ]
}

impl Runtime {
    pub fn new(manifest_bytes: &[u8]) -> Result<Runtime, String> {
        let manifest = Manifest::decode(manifest_bytes)?;
        let n = manifest.cluster_count as usize;
        let tv = manifest.total_vertices as usize;
        let ti = manifest.total_triangles as usize * 3;
        Ok(Runtime {
            clusters: vec![ClusterInfo::default(); n],
            loaded: vec![false; n],
            archive_loaded: vec![false; manifest.archives.len()],
            vertex_base: vec![0; n],
            index_first: vec![0; n],
            positions: Vec::with_capacity(tv * 3),
            normals: Vec::with_capacity(tv * 3),
            colors: Vec::with_capacity(tv * 4),
            indices: Vec::with_capacity(ti),
            pool_vertices: 0,
            cut: Vec::new(),
            stats: CutStats::default(),
            scratch_render: vec![false; n],
            manifest,
        })
    }

    pub fn cluster_count(&self) -> usize {
        self.clusters.len()
    }

    pub fn archive_count(&self) -> usize {
        self.manifest.archives.len()
    }

    pub fn is_archive_loaded(&self, id: usize) -> bool {
        self.archive_loaded.get(id).copied().unwrap_or(false)
    }

    /// Decode one archive into the pool. Archives must be added in order (coarse
    /// first) so a cluster's coarser replacement is always present before it.
    /// Returns the pool vertex range `[first, first + count)` that was filled.
    pub fn add_archive(&mut self, id: usize, bytes: &[u8]) -> Result<(u32, u32), String> {
        let info = *self
            .manifest
            .archives
            .get(id)
            .ok_or("archive id out of range")?;
        if self.archive_loaded[id] {
            return Err(format!("archive {id} already loaded"));
        }
        if id > 0 && !self.archive_loaded[id - 1] {
            return Err(format!("archive {id} added before archive {}", id - 1));
        }
        if bytes.len() != info.byte_len as usize {
            return Err(format!(
                "archive {id}: expected {} bytes, got {}",
                info.byte_len,
                bytes.len()
            ));
        }
        let table = decode_archive_table(&self.manifest.aabb, bytes)?;
        if table.clusters.len() != info.cluster_count as usize {
            return Err(format!("archive {id}: cluster count mismatch"));
        }
        let blobs = &bytes[table.blobs_offset..];
        let first_vertex = self.pool_vertices;
        for (k, c) in table.clusters.iter().enumerate() {
            let ci = info.first_cluster as usize + k;
            let blob = blobs
                .get(c.offset as usize..c.offset as usize + c.byte_len as usize)
                .ok_or("cluster blob out of archive bounds")?;
            let base = self.pool_vertices;
            self.vertex_base[ci] = base;
            self.index_first[ci] = self.indices.len() as u32;
            let d = decode_cluster(
                &self.manifest.aabb,
                blob,
                base,
                &mut self.positions,
                &mut self.normals,
                &mut self.indices,
            )?;
            if d.vertex_count != c.vertex_count as usize
                || d.triangle_count != c.triangle_count as usize
            {
                return Err("cluster record does not match blob".into());
            }
            let col = cluster_color(ci as u32);
            for _ in 0..d.vertex_count {
                self.colors.extend_from_slice(&col);
            }
            self.pool_vertices += d.vertex_count as u32;
            self.clusters[ci] = *c;
            self.loaded[ci] = true;
        }
        self.archive_loaded[id] = true;
        Ok((first_vertex, self.pool_vertices - first_vertex))
    }

    pub fn pool_vertex_count(&self) -> u32 {
        self.pool_vertices
    }

    /// Screen-space size of a world-space error at a sphere, in pixels.
    fn project_error(view: &View, error: f32, s: &Sphere, scale: f32) -> f32 {
        if !error.is_finite() {
            return f32::INFINITY;
        }
        let d = [
            s.center[0] - view.position[0],
            s.center[1] - view.position[1],
            s.center[2] - view.position[2],
        ];
        let dist = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt() - s.radius;
        if dist <= 0.0 {
            return f32::INFINITY;
        }
        error * scale / dist
    }

    /// Pick the cut for this view and assemble its index buffer into `self.cut`.
    pub fn select(&mut self, view: &View) -> CutStats {
        let scale = view.viewport_height / (2.0 * (view.fov_y * 0.5).tan());
        let planes = frustum_planes(&view.view_proj);
        let mut stats = CutStats::default();
        let n = self.clusters.len();
        let render = &mut self.scratch_render;
        let mut cut_triangles = 0usize;
        for ci in 0..n {
            render[ci] = false;
            if !self.loaded[ci] {
                continue;
            }
            let c = &self.clusters[ci];
            stats.loaded_clusters += 1;
            stats.loaded_triangles += c.triangle_count as u32;
            let parent_px = Self::project_error(view, c.parent_error, &c.parent_sphere, scale);
            if parent_px <= view.threshold_px {
                continue; // the coarser replacement is good enough
            }
            // A leaf has nothing finer, so it is drawn whenever its parent is not.
            if c.child_count != 0 {
                let own_px = Self::project_error(view, c.lod_error, &c.lod_sphere, scale);
                if own_px > view.threshold_px {
                    // A group always sits inside one archive, so one child tells for all.
                    if self.loaded[c.child_first as usize] {
                        continue; // a finer level takes over
                    }
                    stats.pending_refinement += 1;
                }
            }
            if view.frustum_cull && !sphere_in_frustum(&planes, &c.lod_sphere) {
                stats.culled += 1;
                continue;
            }
            render[ci] = true;
            stats.clusters += 1;
            cut_triangles += c.triangle_count as usize;
            stats.coarsest_level_in_cut = stats.coarsest_level_in_cut.max(c.level as u32);
        }
        self.cut.clear();
        self.cut.reserve(cut_triangles * 3);
        for ci in 0..n {
            if render[ci] {
                let first = self.index_first[ci] as usize;
                let len = self.clusters[ci].triangle_count as usize * 3;
                self.cut
                    .extend_from_slice(&self.indices[first..first + len]);
            }
        }
        stats.triangles = cut_triangles as u32;
        self.stats = stats;
        stats
    }

    /// Ids of the clusters in the last cut (test helper).
    pub fn cut_clusters(&self) -> Vec<usize> {
        (0..self.clusters.len())
            .filter(|&i| self.scratch_render[i])
            .collect()
    }

    pub fn cluster(&self, i: usize) -> Option<&ClusterInfo> {
        if self.loaded.get(i).copied().unwrap_or(false) {
            Some(&self.clusters[i])
        } else {
            None
        }
    }
}

/// Six planes (a, b, c, d) with the inside being `a*x + b*y + c*z + d >= 0`.
fn frustum_planes(m: &[f32; 16]) -> [[f32; 4]; 6] {
    // Rows of the column-major matrix.
    let row = |r: usize| [m[r], m[4 + r], m[8 + r], m[12 + r]];
    let (r0, r1, r2, r3) = (row(0), row(1), row(2), row(3));
    let add = |a: [f32; 4], b: [f32; 4]| [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];
    let sub = |a: [f32; 4], b: [f32; 4]| [a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]];
    let mut planes = [
        add(r3, r0),
        sub(r3, r0),
        add(r3, r1),
        sub(r3, r1),
        add(r3, r2),
        sub(r3, r2),
    ];
    for p in planes.iter_mut() {
        let l = (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt();
        if l > 0.0 {
            for v in p.iter_mut() {
                *v /= l;
            }
        }
    }
    planes
}

fn sphere_in_frustum(planes: &[[f32; 4]; 6], s: &Sphere) -> bool {
    planes
        .iter()
        .all(|p| p[0] * s.center[0] + p[1] * s.center[1] + p[2] * s.center[2] + p[3] >= -s.radius)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tessera_pack::hierarchy::{build, BuildOptions};
    use tessera_pack::mesh::asteroid;
    use tessera_pack::pack::{pack, DEFAULT_SCHEDULE};

    fn packed() -> tessera_pack::pack::Packed {
        let m = asteroid(60, 120, 11);
        let h = build(
            &m,
            &BuildOptions {
                group_size: 8,
                verbose: false,
            },
        );
        pack(&h, &DEFAULT_SCHEDULE)
    }

    fn view(distance: f32, threshold_px: f32) -> View {
        // Camera on +Z looking at the origin, 60 degree fov, 1080 px tall.
        let fov: f32 = 60f32.to_radians();
        let f = 1.0 / (fov * 0.5).tan();
        let (near, far) = (0.1f32, 100f32);
        let aspect = 16.0 / 9.0;
        // Column-major projection * view (view = translate(0,0,-distance)).
        let mut vp = [0f32; 16];
        vp[0] = f / aspect;
        vp[5] = f;
        vp[10] = -(far + near) / (far - near);
        vp[11] = -1.0;
        vp[14] = -2.0 * far * near / (far - near) + (-(far + near) / (far - near)) * (-distance);
        vp[15] = distance;
        View {
            position: [0.0, 0.0, distance],
            view_proj: vp,
            viewport_height: 1080.0,
            fov_y: fov,
            threshold_px,
            frustum_cull: false,
        }
    }

    #[test]
    fn streams_in_order_and_refines() {
        let p = packed();
        let mut rt = Runtime::new(&p.manifest.encode()).unwrap();
        assert!(
            rt.add_archive(1, &p.archives[1]).is_err(),
            "out of order must be refused"
        );
        rt.add_archive(0, &p.archives[0]).unwrap();
        let coarse = rt.select(&view(3.0, 1.0));
        assert!(coarse.clusters > 0 && coarse.pending_refinement > 0);
        for i in 1..p.archives.len() {
            rt.add_archive(i, &p.archives[i]).unwrap();
        }
        assert_eq!(rt.pool_vertex_count(), p.manifest.total_vertices);
        let fine = rt.select(&view(3.0, 1.0));
        assert_eq!(fine.pending_refinement, 0);
        assert!(fine.triangles > coarse.triangles);
        let far = rt.select(&view(60.0, 1.0));
        assert!(far.triangles < fine.triangles);
    }

    #[test]
    fn cut_never_overlaps_across_levels() {
        let p = packed();
        let mut rt = Runtime::new(&p.manifest.encode()).unwrap();
        for i in 0..p.archives.len() {
            rt.add_archive(i, &p.archives[i]).unwrap();
        }
        // parent of every cluster, from the children ranges
        let mut parent = vec![usize::MAX; p.clusters.len()];
        for (ci, c) in p.clusters.iter().enumerate() {
            for ch in c.child_first..c.child_first + c.child_count as u32 {
                parent[ch as usize] = ci;
            }
        }
        // Three distances, a camera standing inside a leaf's bounding sphere
        // (its error projects to infinity, and it must still be drawn), and
        // threshold 0, which is the "Tessera off" full-resolution cut.
        let leaf = p.clusters.iter().position(|c| c.level == 0).unwrap();
        let inside = {
            let mut v = view(2.5, 2.0);
            v.position = p.clusters[leaf].lod_sphere.center;
            v.frustum_cull = false;
            v
        };
        let full = {
            let mut v = view(6.0, 0.0);
            v.frustum_cull = false;
            v
        };
        let views = [(view(2.5, 2.0), "d=2.5"), (view(6.0, 2.0), "d=6"), (view(20.0, 2.0), "d=20"), (inside, "inside leaf"), (full, "threshold 0")];
        for (v, distance) in views {
            let stats = rt.select(&v);
            let in_cut: std::collections::HashSet<usize> = rt.cut_clusters().into_iter().collect();
            if distance == "inside leaf" {
                assert!(in_cut.contains(&leaf), "leaf containing the camera dropped from the cut");
            }
            if distance == "threshold 0" {
                let leaves = p.clusters.iter().filter(|c| c.level == 0).count() as u32;
                assert_eq!(stats.clusters, leaves, "threshold 0 must draw exactly the leaves");
            }
            for &ci in &in_cut {
                let mut a = parent[ci];
                while a != usize::MAX {
                    assert!(
                        !in_cut.contains(&a),
                        "cluster {ci} and ancestor {a} both in cut at d={distance}"
                    );
                    a = parent[a];
                }
            }
            // Every level-0 cluster is represented by exactly one ancestor-or-self.
            for (ci, c) in p.clusters.iter().enumerate() {
                if c.level != 0 {
                    continue;
                }
                let mut a = ci;
                let mut hits = 0;
                while a != usize::MAX {
                    if in_cut.contains(&a) {
                        hits += 1;
                    }
                    a = parent[a];
                }
                assert_eq!(
                    hits, 1,
                    "level-0 cluster {ci} covered {hits} times at d={distance}"
                );
            }
        }
    }

    #[test]
    fn frustum_culling_removes_clusters_behind_the_camera() {
        let p = packed();
        let mut rt = Runtime::new(&p.manifest.encode()).unwrap();
        for i in 0..p.archives.len() {
            rt.add_archive(i, &p.archives[i]).unwrap();
        }
        let mut v = view(1.6, 1.0); // inside the asteroid's bounding sphere, looking at the far wall
        v.frustum_cull = true;
        let s = rt.select(&v);
        assert!(s.culled > 0);
        assert!(s.clusters > 0);
    }
}
