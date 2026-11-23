import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export { THREE };

// ── Materials ────────────────────────────────────────────────────────────────
export const RARITY = {
  common: { metal: 0xc8773e, light: 0xffa060, glow: 0xff9a50 },
  rare: { metal: 0xc4ccd6, light: 0x9cc8ff, glow: 0x7fb6ff },
  epic: { metal: 0xf2b43a, light: 0xffc860, glow: 0xb07cff },
  legendary: { metal: 0x7fd4ff, light: 0x6fd0ff, glow: 0x4fc3ff },
  // The Poderes emblem itself: the brand green
  brand: { metal: 0xf2b43a, light: 0x5cff6e, glow: 0x00ff1e },
};

export function metal(color, roughness = 0.28) {
  return new THREE.MeshPhysicalMaterial({ color, metalness: 1, roughness, clearcoat: 0.3, clearcoatRoughness: 0.2 });
}
export function enamel(color, roughness = 0.32) {
  return new THREE.MeshPhysicalMaterial({ color, metalness: 0, roughness, clearcoat: 1, clearcoatRoughness: 0.08 });
}
export function matte(color, roughness = 0.75) {
  return new THREE.MeshStandardMaterial({ color, metalness: 0, roughness });
}
export function glow(color, intensity = 2.2) {
  return new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: intensity, roughness: 0.4 });
}
export function crystal(color = 0x6fd0ff, emissive = 0.35) {
  return new THREE.MeshPhysicalMaterial({
    color, metalness: 0.05, roughness: 0.04, transmission: 0.55, thickness: 0.6, ior: 2.0,
    clearcoat: 1, clearcoatRoughness: 0.02, emissive: color, emissiveIntensity: emissive, flatShading: true,
  });
}
export function wood(color = 0x8a5228) {
  return new THREE.MeshPhysicalMaterial({ color, roughness: 0.6, clearcoat: 0.25, clearcoatRoughness: 0.4 });
}

// ── Geometry helpers ─────────────────────────────────────────────────────────
export function mesh(geometry, material, opts = {}) {
  const m = new THREE.Mesh(geometry, material);
  if (opts.pos) m.position.set(...opts.pos);
  if (opts.rot) m.rotation.set(...opts.rot);
  if (opts.scale) m.scale.set(...(Array.isArray(opts.scale) ? opts.scale : [opts.scale, opts.scale, opts.scale]));
  return m;
}

/** A 2D shape from points [[x,y],...] (or a THREE.Shape), extruded with a soft bevel, centred in z. */
export function extrude(shapeOrPoints, depth = 0.3, bevel = 0.08, segments = 6, curveSegments = 32) {
  const shape = Array.isArray(shapeOrPoints) ? new THREE.Shape(shapeOrPoints.map(([x, y]) => new THREE.Vector2(x, y))) : shapeOrPoints;
  const g = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel * 0.9, bevelSegments: segments, curveSegments,
  });
  g.translate(0, 0, -depth / 2);
  g.computeVertexNormals();
  return g;
}

export function lathe(points, segments = 64) {
  return new THREE.LatheGeometry(points.map(([x, y]) => new THREE.Vector2(x, y)), segments);
}

export function rbox(w, h, d, r = 0.08, seg = 4) {
  return new RoundedBoxGeometry(w, h, d, seg, r);
}

export function cyl(rt, rb, h, seg = 48) {
  return new THREE.CylinderGeometry(rt, rb, h, seg);
}

export function sphere(r, w = 48, h = 32) {
  return new THREE.SphereGeometry(r, w, h);
}

export function torus(r, tube, arc = Math.PI * 2, rs = 24, ts = 96) {
  return new THREE.TorusGeometry(r, tube, rs, ts, arc);
}

export function tube(points, radius = 0.05, segs = 64) {
  const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p)));
  return new THREE.TubeGeometry(curve, segs, radius, 16, false);
}

/** Shape helper: rounded rectangle path. */
export function roundedRect(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

export function group(...children) {
  const g = new THREE.Group();
  children.forEach(c => c && g.add(c));
  return g;
}

/** A glowing spark (emissive sphere + soft halo sprite). */
export function spark(color, size = 0.12) {
  const g = new THREE.Group();
  g.add(mesh(sphere(size * 0.45), glow(color, 6)));
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const grd = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  const col = new THREE.Color(color);
  const rgb = `${Math.round(col.r * 255)},${Math.round(col.g * 255)},${Math.round(col.b * 255)}`;
  grd.addColorStop(0, `rgba(255,255,255,1)`);
  grd.addColorStop(0.25, `rgba(${rgb},0.9)`);
  grd.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, blending: THREE.AdditiveBlending, depthWrite: false }));
  sprite.scale.set(size * 4, size * 4, 1);
  g.add(sprite);
  return g;
}

/** Canvas texture helper (for faces, maps, labels). */
export function canvasTexture(draw, size = 512) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
