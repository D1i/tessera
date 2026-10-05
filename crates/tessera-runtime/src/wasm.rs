//! wasm-bindgen surface. Buffers are exposed as (pointer, length) pairs into
//! linear memory so the JavaScript side can wrap them in typed arrays without
//! copying; it re-reads the pointers after every call that may grow memory.

use crate::{Runtime, View};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct TesseraRuntime {
    inner: Runtime,
}

#[wasm_bindgen]
impl TesseraRuntime {
    #[wasm_bindgen(constructor)]
    pub fn new(manifest: &[u8]) -> Result<TesseraRuntime, JsError> {
        Runtime::new(manifest)
            .map(|inner| TesseraRuntime { inner })
            .map_err(|e| JsError::new(&e))
    }

    pub fn cluster_count(&self) -> u32 {
        self.inner.cluster_count() as u32
    }

    pub fn archive_count(&self) -> u32 {
        self.inner.archive_count() as u32
    }

    pub fn total_vertices(&self) -> u32 {
        self.inner.manifest.total_vertices
    }

    pub fn source_triangles(&self) -> u32 {
        self.inner.manifest.source_triangles
    }

    pub fn level_count(&self) -> u32 {
        self.inner.manifest.level_count
    }

    pub fn aabb(&self) -> Vec<f32> {
        let b = self.inner.manifest.aabb;
        vec![b.min[0], b.min[1], b.min[2], b.max[0], b.max[1], b.max[2]]
    }

    pub fn is_archive_loaded(&self, id: u32) -> bool {
        self.inner.is_archive_loaded(id as usize)
    }

    /// Returns `[first_vertex, vertex_count]` of the pool range that was filled.
    pub fn add_archive(&mut self, id: u32, bytes: &[u8]) -> Result<Vec<u32>, JsError> {
        self.inner
            .add_archive(id as usize, bytes)
            .map(|(a, b)| vec![a, b])
            .map_err(|e| JsError::new(&e))
    }

    pub fn pool_vertex_count(&self) -> u32 {
        self.inner.pool_vertex_count()
    }

    /// Select the cut. Returns stats as
    /// `[clusters, triangles, culled, loaded_clusters, loaded_triangles, pending_refinement, finest_level]`.
    #[allow(clippy::too_many_arguments)]
    pub fn select(
        &mut self,
        cam_x: f32,
        cam_y: f32,
        cam_z: f32,
        view_proj: &[f32],
        viewport_height: f32,
        fov_y: f32,
        threshold_px: f32,
        frustum_cull: bool,
    ) -> Vec<u32> {
        let mut vp = [0f32; 16];
        vp.copy_from_slice(&view_proj[..16]);
        let s = self.inner.select(&View {
            position: [cam_x, cam_y, cam_z],
            view_proj: vp,
            viewport_height,
            fov_y,
            threshold_px,
            frustum_cull,
        });
        vec![
            s.clusters,
            s.triangles,
            s.culled,
            s.loaded_clusters,
            s.loaded_triangles,
            s.pending_refinement,
            s.coarsest_level_in_cut,
        ]
    }

    pub fn positions_ptr(&self) -> *const f32 {
        self.inner.positions.as_ptr()
    }
    pub fn normals_ptr(&self) -> *const f32 {
        self.inner.normals.as_ptr()
    }
    pub fn colors_ptr(&self) -> *const u8 {
        self.inner.colors.as_ptr()
    }
    pub fn cut_ptr(&self) -> *const u32 {
        self.inner.cut.as_ptr()
    }
    pub fn cut_len(&self) -> u32 {
        self.inner.cut.len() as u32
    }
}
