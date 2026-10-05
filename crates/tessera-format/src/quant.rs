//! Quantization helpers shared by the packer and the runtime.

#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Aabb {
    pub min: [f32; 3],
    pub max: [f32; 3],
}

impl Aabb {
    pub fn empty() -> Self {
        Aabb {
            min: [f32::INFINITY; 3],
            max: [f32::NEG_INFINITY; 3],
        }
    }

    pub fn from_points<'a>(points: impl IntoIterator<Item = &'a [f32; 3]>) -> Self {
        let mut b = Aabb::empty();
        for p in points {
            for i in 0..3 {
                b.min[i] = b.min[i].min(p[i]);
                b.max[i] = b.max[i].max(p[i]);
            }
        }
        b
    }

    pub fn extent(&self) -> [f32; 3] {
        [
            self.max[0] - self.min[0],
            self.max[1] - self.min[1],
            self.max[2] - self.min[2],
        ]
    }

    /// Length of the diagonal; used as the unit for quantized radii and errors.
    pub fn diagonal(&self) -> f32 {
        let e = self.extent();
        (e[0] * e[0] + e[1] * e[1] + e[2] * e[2]).sqrt()
    }

    /// Quantize a point to 16 bits per axis inside the box.
    pub fn quantize(&self, p: &[f32; 3]) -> [u16; 3] {
        let e = self.extent();
        let mut q = [0u16; 3];
        for i in 0..3 {
            let t = if e[i] > 0.0 {
                (p[i] - self.min[i]) / e[i]
            } else {
                0.0
            };
            q[i] = (t.clamp(0.0, 1.0) * 65535.0 + 0.5) as u16;
        }
        q
    }

    pub fn dequantize(&self, q: &[u16; 3]) -> [f32; 3] {
        let e = self.extent();
        let mut p = [0f32; 3];
        for i in 0..3 {
            p[i] = self.min[i] + (q[i] as f32 / 65535.0) * e[i];
        }
        p
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Sphere {
    pub center: [f32; 3],
    pub radius: f32,
}

impl Sphere {
    /// Bounding sphere of a point set: centroid plus the farthest distance.
    /// Not minimal, but cheap and conservative, which is what the LOD metric needs.
    pub fn from_points<'a>(points: impl IntoIterator<Item = &'a [f32; 3]> + Clone) -> Self {
        let mut c = [0f64; 3];
        let mut n = 0usize;
        for p in points.clone() {
            for i in 0..3 {
                c[i] += p[i] as f64;
            }
            n += 1;
        }
        if n == 0 {
            return Sphere::default();
        }
        let center = [
            (c[0] / n as f64) as f32,
            (c[1] / n as f64) as f32,
            (c[2] / n as f64) as f32,
        ];
        let mut r2 = 0f32;
        for p in points {
            let d = [p[0] - center[0], p[1] - center[1], p[2] - center[2]];
            r2 = r2.max(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
        }
        Sphere {
            center,
            radius: r2.sqrt(),
        }
    }

    /// Smallest sphere (by the simple "grow to enclose" rule) containing all given spheres.
    pub fn enclosing(spheres: &[Sphere]) -> Self {
        let mut it = spheres.iter();
        let Some(first) = it.next() else {
            return Sphere::default();
        };
        let mut s = *first;
        for o in it {
            let d = [
                o.center[0] - s.center[0],
                o.center[1] - s.center[1],
                o.center[2] - s.center[2],
            ];
            let dist = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
            if dist + o.radius <= s.radius {
                continue;
            }
            if dist + s.radius <= o.radius {
                s = *o;
                continue;
            }
            let new_r = (dist + s.radius + o.radius) * 0.5;
            let t = if dist > 0.0 {
                (new_r - s.radius) / dist
            } else {
                0.0
            };
            s.center = [
                s.center[0] + d[0] * t,
                s.center[1] + d[1] * t,
                s.center[2] + d[2] * t,
            ];
            s.radius = new_r;
        }
        s
    }
}

/// Octahedral normal encoding to two bytes.
pub fn encode_normal(n: &[f32; 3]) -> [u8; 2] {
    let l = n[0].abs() + n[1].abs() + n[2].abs();
    let (mut x, mut y) = if l > 0.0 {
        (n[0] / l, n[1] / l)
    } else {
        (0.0, 0.0)
    };
    if n[2] < 0.0 {
        let ox = (1.0 - y.abs()) * if x >= 0.0 { 1.0 } else { -1.0 };
        let oy = (1.0 - x.abs()) * if y >= 0.0 { 1.0 } else { -1.0 };
        x = ox;
        y = oy;
    }
    [
        ((x * 0.5 + 0.5) * 255.0 + 0.5) as u8,
        ((y * 0.5 + 0.5) * 255.0 + 0.5) as u8,
    ]
}

pub fn decode_normal(e: &[u8; 2]) -> [f32; 3] {
    let x = e[0] as f32 / 255.0 * 2.0 - 1.0;
    let y = e[1] as f32 / 255.0 * 2.0 - 1.0;
    let z = 1.0 - x.abs() - y.abs();
    let (x, y) = if z < 0.0 {
        (
            (1.0 - y.abs()) * if x >= 0.0 { 1.0 } else { -1.0 },
            (1.0 - x.abs()) * if y >= 0.0 { 1.0 } else { -1.0 },
        )
    } else {
        (x, y)
    };
    let l = (x * x + y * y + z * z).sqrt();
    if l > 0.0 {
        [x / l, y / l, z / l]
    } else {
        [0.0, 0.0, 1.0]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normal_roundtrip_is_close() {
        for n in [
            [0.0, 0.0, 1.0],
            [0.0, 0.0, -1.0],
            [0.6, -0.8, 0.0],
            [0.3, 0.4, -0.866],
        ] {
            let d = decode_normal(&encode_normal(&n));
            let dot = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
            assert!(dot > 0.995, "{n:?} -> {d:?}");
        }
    }

    #[test]
    fn position_roundtrip_error_is_bounded() {
        let b = Aabb {
            min: [-1.0, -2.0, 0.0],
            max: [3.0, 2.0, 1.0],
        };
        let p = [0.123, -1.5, 0.77];
        let d = b.dequantize(&b.quantize(&p));
        for i in 0..3 {
            assert!((d[i] - p[i]).abs() <= b.extent()[i] / 65535.0);
        }
    }

    #[test]
    fn enclosing_sphere_contains_inputs() {
        let a = Sphere {
            center: [0.0, 0.0, 0.0],
            radius: 1.0,
        };
        let b = Sphere {
            center: [4.0, 0.0, 0.0],
            radius: 2.0,
        };
        let s = Sphere::enclosing(&[a, b]);
        for o in [a, b] {
            let d = ((o.center[0] - s.center[0]).powi(2)).sqrt();
            assert!(d + o.radius <= s.radius + 1e-5);
        }
    }
}
