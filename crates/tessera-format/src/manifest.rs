//! Manifest (`model.tsm`) and archive (`archive-<i>.tsa`) layouts.
//!
//! ```text
//! model.tsm
//!   "TSM1" u32 version=1
//!   u32 cluster_count, u32 archive_count, u32 level_count
//!   f32 aabb_min[3], f32 aabb_max[3]
//!   u32 total_vertices, u32 total_triangles, u32 source_triangles
//!   archive_count x { u32 byte_len, u32 first_cluster, u32 cluster_count }
//!
//! archive-<i>.tsa
//!   "TSA1"
//!   u32 cluster_count
//!   cluster_count x ClusterRecord (40 bytes, see below)
//!   blobs, back to back, in cluster order (see codec.rs)
//! ```
//!
//! Clusters are numbered globally, coarsest level first; inside a level the
//! clusters produced from one simplification group are contiguous, so
//! `child_first + child_count` describes a cluster's children as one range.
//! Archives cover contiguous cluster ranges, which keeps every group inside one
//! archive. Spheres are quantized against the model AABB (16 bits per component,
//! radius in units of the AABB diagonal).

use crate::quant::{Aabb, Sphere};

pub const MANIFEST_MAGIC: &[u8; 4] = b"TSM1";
pub const ARCHIVE_MAGIC: &[u8; 4] = b"TSA1";
pub const CLUSTER_RECORD_BYTES: usize = 40;
const HEADER_BYTES: usize = 4 + 4 * 4 + 6 * 4 + 3 * 4;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ArchiveInfo {
    /// Whole file size (records + blobs).
    pub byte_len: u32,
    pub first_cluster: u32,
    pub cluster_count: u32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ClusterInfo {
    pub archive: u8,
    pub level: u8,
    pub vertex_count: u8,
    pub triangle_count: u8,
    /// Byte offset of the cluster blob inside the archive's blob section.
    pub offset: u32,
    pub byte_len: u16,
    /// Children: the finer clusters this cluster was simplified from (0 for level 0).
    pub child_count: u16,
    pub child_first: u32,
    /// Error and bounds of the group this cluster was generated from.
    pub lod_sphere: Sphere,
    pub lod_error: f32,
    /// Error and bounds of the group this cluster belongs to (the coarser replacement).
    pub parent_sphere: Sphere,
    pub parent_error: f32,
}

/// The small header file.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Manifest {
    pub aabb: Aabb,
    pub cluster_count: u32,
    pub level_count: u32,
    /// Sum of per-cluster vertex counts: size of the runtime vertex pool.
    pub total_vertices: u32,
    pub total_triangles: u32,
    /// Triangle count of the original (level 0) mesh.
    pub source_triangles: u32,
    pub archives: Vec<ArchiveInfo>,
}

/// Parsed archive header: the records plus where the blobs start.
pub struct ArchiveTable {
    pub clusters: Vec<ClusterInfo>,
    pub blobs_offset: usize,
}

fn put_u16(out: &mut Vec<u8>, v: u16) {
    out.extend_from_slice(&v.to_le_bytes());
}
fn put_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}
fn put_f32(out: &mut Vec<u8>, v: f32) {
    out.extend_from_slice(&v.to_le_bytes());
}

struct Reader<'a> {
    data: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn bytes(&mut self, n: usize) -> Result<&'a [u8], String> {
        if self.at + n > self.data.len() {
            return Err("data truncated".into());
        }
        let s = &self.data[self.at..self.at + n];
        self.at += n;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.bytes(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, String> {
        let b = self.bytes(2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }
    fn u32(&mut self) -> Result<u32, String> {
        let b = self.bytes(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn f32(&mut self) -> Result<f32, String> {
        Ok(f32::from_bits(self.u32()?))
    }
}

fn sphere_to_q(aabb: &Aabb, s: &Sphere) -> [u16; 4] {
    let c = aabb.quantize(&s.center);
    let diag = aabb.diagonal().max(f32::MIN_POSITIVE);
    let r = ((s.radius / diag).clamp(0.0, 1.0) * 65535.0).ceil() as u16;
    [c[0], c[1], c[2], r]
}

fn sphere_from_q(aabb: &Aabb, q: [u16; 4]) -> Sphere {
    Sphere {
        center: aabb.dequantize(&[q[0], q[1], q[2]]),
        radius: q[3] as f32 / 65535.0 * aabb.diagonal(),
    }
}

impl Manifest {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(HEADER_BYTES + self.archives.len() * 12);
        out.extend_from_slice(MANIFEST_MAGIC);
        put_u32(&mut out, 1);
        put_u32(&mut out, self.cluster_count);
        put_u32(&mut out, self.archives.len() as u32);
        put_u32(&mut out, self.level_count);
        for v in self.aabb.min.iter().chain(self.aabb.max.iter()) {
            put_f32(&mut out, *v);
        }
        put_u32(&mut out, self.total_vertices);
        put_u32(&mut out, self.total_triangles);
        put_u32(&mut out, self.source_triangles);
        for a in &self.archives {
            put_u32(&mut out, a.byte_len);
            put_u32(&mut out, a.first_cluster);
            put_u32(&mut out, a.cluster_count);
        }
        out
    }

    pub fn decode(data: &[u8]) -> Result<Manifest, String> {
        let mut r = Reader { data, at: 0 };
        if r.bytes(4)? != MANIFEST_MAGIC {
            return Err("not a TSM1 manifest".into());
        }
        if r.u32()? != 1 {
            return Err("unsupported manifest version".into());
        }
        let cluster_count = r.u32()?;
        let archive_count = r.u32()? as usize;
        let level_count = r.u32()?;
        let mut aabb = Aabb::default();
        for i in 0..3 {
            aabb.min[i] = r.f32()?;
        }
        for i in 0..3 {
            aabb.max[i] = r.f32()?;
        }
        let total_vertices = r.u32()?;
        let total_triangles = r.u32()?;
        let source_triangles = r.u32()?;
        let mut archives = Vec::with_capacity(archive_count);
        for _ in 0..archive_count {
            archives.push(ArchiveInfo {
                byte_len: r.u32()?,
                first_cluster: r.u32()?,
                cluster_count: r.u32()?,
            });
        }
        Ok(Manifest {
            aabb,
            cluster_count,
            level_count,
            total_vertices,
            total_triangles,
            source_triangles,
            archives,
        })
    }
}

/// Serialize one archive: magic, record table, then the concatenated blobs.
pub fn encode_archive(aabb: &Aabb, clusters: &[ClusterInfo], blobs: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + clusters.len() * CLUSTER_RECORD_BYTES + blobs.len());
    out.extend_from_slice(ARCHIVE_MAGIC);
    put_u32(&mut out, clusters.len() as u32);
    for c in clusters {
        out.push(c.archive);
        out.push(c.level);
        out.push(c.vertex_count);
        out.push(c.triangle_count);
        put_u32(&mut out, c.offset);
        put_u16(&mut out, c.byte_len);
        put_u16(&mut out, c.child_count);
        put_u32(&mut out, c.child_first);
        for v in sphere_to_q(aabb, &c.lod_sphere) {
            put_u16(&mut out, v);
        }
        for v in sphere_to_q(aabb, &c.parent_sphere) {
            put_u16(&mut out, v);
        }
        put_f32(&mut out, c.lod_error);
        put_f32(&mut out, c.parent_error);
    }
    out.extend_from_slice(blobs);
    out
}

/// Parse an archive's record table. Blobs follow at `blobs_offset`.
pub fn decode_archive_table(aabb: &Aabb, data: &[u8]) -> Result<ArchiveTable, String> {
    let mut r = Reader { data, at: 0 };
    if r.bytes(4)? != ARCHIVE_MAGIC {
        return Err("not a TSA1 archive".into());
    }
    let count = r.u32()? as usize;
    let clusters = decode_archive_records(aabb, &mut r, count)?;
    Ok(ArchiveTable {
        clusters,
        blobs_offset: r.at,
    })
}

fn decode_archive_records(
    aabb: &Aabb,
    r: &mut Reader<'_>,
    count: usize,
) -> Result<Vec<ClusterInfo>, String> {
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        let archive = r.u8()?;
        let level = r.u8()?;
        let vertex_count = r.u8()?;
        let triangle_count = r.u8()?;
        let offset = r.u32()?;
        let byte_len = r.u16()?;
        let child_count = r.u16()?;
        let child_first = r.u32()?;
        let lq = [r.u16()?, r.u16()?, r.u16()?, r.u16()?];
        let pq = [r.u16()?, r.u16()?, r.u16()?, r.u16()?];
        let lod_error = r.f32()?;
        let parent_error = r.f32()?;
        out.push(ClusterInfo {
            archive,
            level,
            vertex_count,
            triangle_count,
            offset,
            byte_len,
            child_count,
            child_first,
            lod_sphere: sphere_from_q(aabb, lq),
            lod_error,
            parent_sphere: sphere_from_q(aabb, pq),
            parent_error,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_and_archive_roundtrip() {
        let aabb = Aabb {
            min: [-1.0, -1.0, -1.0],
            max: [1.0, 2.0, 3.0],
        };
        let m = Manifest {
            aabb,
            cluster_count: 2,
            level_count: 2,
            total_vertices: 10,
            total_triangles: 4,
            source_triangles: 3,
            archives: vec![ArchiveInfo {
                byte_len: 123,
                first_cluster: 0,
                cluster_count: 2,
            }],
        };
        let d = Manifest::decode(&m.encode()).unwrap();
        assert_eq!(d, m);

        let clusters = vec![
            ClusterInfo {
                archive: 0,
                level: 1,
                vertex_count: 3,
                triangle_count: 1,
                offset: 0,
                byte_len: 29,
                child_count: 1,
                child_first: 1,
                lod_sphere: Sphere {
                    center: [0.0, 0.5, 1.0],
                    radius: 0.25,
                },
                lod_error: 0.01,
                parent_sphere: Sphere {
                    center: [0.0, 0.5, 1.0],
                    radius: 0.5,
                },
                parent_error: f32::INFINITY,
            },
            ClusterInfo {
                archive: 0,
                level: 0,
                vertex_count: 3,
                triangle_count: 1,
                offset: 29,
                byte_len: 29,
                ..Default::default()
            },
        ];
        let blobs = vec![7u8; 58];
        let bytes = encode_archive(&aabb, &clusters, &blobs);
        assert_eq!(bytes.len(), 8 + 2 * CLUSTER_RECORD_BYTES + 58);
        let t = decode_archive_table(&aabb, &bytes).unwrap();
        assert_eq!(t.blobs_offset, 8 + 2 * CLUSTER_RECORD_BYTES);
        let c = &t.clusters[0];
        assert!((c.lod_sphere.radius - 0.25).abs() < 1e-3);
        assert!((c.lod_sphere.center[2] - 1.0).abs() < 1e-3);
        assert!(c.parent_error.is_infinite());
        assert_eq!(c.child_first, 1);
        assert_eq!(t.clusters[1].offset, 29);
    }
}
