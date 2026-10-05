//! Per-cluster blob encoding.
//!
//! Layout (little-endian):
//! ```text
//! u8  vertex_count (1..=64)
//! u8  triangle_count (1..=128)
//! [vertex_count] x { u16 qx, u16 qy, u16 qz, u8 nx, u8 ny }   8 bytes per vertex
//! [triangle_count * 3] x u8 local index
//! ```
//! Positions are quantized in the model AABB (see [`crate::Aabb`]), normals are
//! octahedral. A full cluster is at most 2 + 64*8 + 128*3 = 898 bytes before LZ4.

use crate::quant::{decode_normal, encode_normal, Aabb};
use crate::{MAX_CLUSTER_TRIANGLES, MAX_CLUSTER_VERTICES};

/// A cluster ready to be encoded: already-compact vertex set plus local indices.
pub struct ClusterBlob<'a> {
    pub positions: &'a [[f32; 3]],
    pub normals: &'a [[f32; 3]],
    /// Local indices into `positions`, three per triangle.
    pub indices: &'a [u8],
}

pub fn encode_cluster(out: &mut Vec<u8>, aabb: &Aabb, c: &ClusterBlob<'_>) {
    assert!(!c.positions.is_empty() && c.positions.len() <= MAX_CLUSTER_VERTICES);
    assert_eq!(c.positions.len(), c.normals.len());
    assert!(c.indices.len() % 3 == 0 && c.indices.len() / 3 <= MAX_CLUSTER_TRIANGLES);
    out.push(c.positions.len() as u8);
    out.push((c.indices.len() / 3) as u8);
    for (p, n) in c.positions.iter().zip(c.normals) {
        let q = aabb.quantize(p);
        out.extend_from_slice(&q[0].to_le_bytes());
        out.extend_from_slice(&q[1].to_le_bytes());
        out.extend_from_slice(&q[2].to_le_bytes());
        out.extend_from_slice(&encode_normal(n));
    }
    out.extend_from_slice(c.indices);
}

pub struct DecodedCluster {
    pub vertex_count: usize,
    pub triangle_count: usize,
    /// Bytes consumed from the input.
    pub byte_len: usize,
}

/// Decode one cluster blob, appending dequantized vertices to the flat `positions`
/// and `normals` arrays (xyz triples) and writing global `u32` indices (offset by
/// `base_vertex`) into `indices`.
pub fn decode_cluster(
    aabb: &Aabb,
    data: &[u8],
    base_vertex: u32,
    positions: &mut Vec<f32>,
    normals: &mut Vec<f32>,
    indices: &mut Vec<u32>,
) -> Result<DecodedCluster, String> {
    if data.len() < 2 {
        return Err("cluster blob truncated".into());
    }
    let vc = data[0] as usize;
    let tc = data[1] as usize;
    let need = 2 + vc * 8 + tc * 3;
    if vc == 0 || vc > MAX_CLUSTER_VERTICES || tc > MAX_CLUSTER_TRIANGLES || data.len() < need {
        return Err(format!(
            "cluster blob malformed: vc={vc} tc={tc} len={}",
            data.len()
        ));
    }
    let mut at = 2;
    for _ in 0..vc {
        let q = [
            u16::from_le_bytes([data[at], data[at + 1]]),
            u16::from_le_bytes([data[at + 2], data[at + 3]]),
            u16::from_le_bytes([data[at + 4], data[at + 5]]),
        ];
        let p = aabb.dequantize(&q);
        let n = decode_normal(&[data[at + 6], data[at + 7]]);
        positions.extend_from_slice(&p);
        normals.extend_from_slice(&n);
        at += 8;
    }
    for i in 0..tc * 3 {
        let li = data[at + i] as usize;
        if li >= vc {
            return Err("cluster index out of range".into());
        }
        indices.push(base_vertex + li as u32);
    }
    Ok(DecodedCluster {
        vertex_count: vc,
        triangle_count: tc,
        byte_len: need,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cluster_roundtrip() {
        let aabb = Aabb {
            min: [0.0; 3],
            max: [10.0; 3],
        };
        let positions = [[1.0, 2.0, 3.0], [4.0, 5.0, 6.0], [7.0, 8.0, 9.0]];
        let normals = [[0.0, 0.0, 1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
        let indices = [0u8, 1, 2];
        let mut blob = Vec::new();
        encode_cluster(
            &mut blob,
            &aabb,
            &ClusterBlob {
                positions: &positions,
                normals: &normals,
                indices: &indices,
            },
        );
        assert_eq!(blob.len(), 2 + 3 * 8 + 3);
        let (mut p, mut n, mut i) = (Vec::new(), Vec::new(), Vec::new());
        let d = decode_cluster(&aabb, &blob, 100, &mut p, &mut n, &mut i).unwrap();
        assert_eq!(
            (d.vertex_count, d.triangle_count, d.byte_len),
            (3, 1, blob.len())
        );
        assert_eq!(i, vec![100, 101, 102]);
        assert!((p[3] - 4.0).abs() < 1e-3 && (p[8] - 9.0).abs() < 1e-3);
        assert!((n[2] - 1.0).abs() < 1e-2);
    }
}
