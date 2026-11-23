import {
  THREE, metal, enamel, matte, glow, crystal, wood, mesh, extrude, lathe, rbox, cyl, sphere, torus, tube,
  roundedRect, group, spark, canvasTexture,
} from './lib.js';

const PI = Math.PI;

// ── Shared parts ────────────────────────────────────────────────────────────
function heaterShield(w = 1.5, h = 1.8) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, h / 2);
  s.lineTo(w / 2, h / 2);
  s.lineTo(w / 2, 0.1);
  s.quadraticCurveTo(w / 2, -h * 0.35, 0, -h / 2);
  s.quadraticCurveTo(-w / 2, -h * 0.35, -w / 2, 0.1);
  s.lineTo(-w / 2, h / 2);
  return s;
}

function star(points, outer, inner) {
  const s = new THREE.Shape();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = PI / 2 + (i * PI) / points;
    const p = [Math.cos(a) * r, Math.sin(a) * r];
    i === 0 ? s.moveTo(...p) : s.lineTo(...p);
  }
  return s;
}

function bolt() {
  return [[0.18, 1.0], [-0.52, -0.08], [-0.05, -0.08], [-0.22, -1.0], [0.55, 0.12], [0.08, 0.12], [0.3, 1.0]];
}

function coin(m, r = 0.22) {
  const g = group(mesh(cyl(r, r, 0.06, 40), m));
  g.add(mesh(torus(r * 0.78, 0.015, PI * 2, 8, 48), m, { pos: [0, 0.03, 0], rot: [PI / 2, 0, 0] }));
  return g;
}

function gemMaterial(color) {
  return new THREE.MeshPhysicalMaterial({ color, roughness: 0.05, metalness: 0.1, clearcoat: 1, emissive: color, emissiveIntensity: 0.35, flatShading: true });
}

function gem(color, r = 0.14) {
  return mesh(new THREE.OctahedronGeometry(r, 0), gemMaterial(color), { scale: [1, 1.25, 1] });
}

function flame(scale = 1, colors = [0xe8340a, 0xff8a00, 0xffd23f]) {
  const g = new THREE.Group();
  const outline = (k) => {
    const s = new THREE.Shape();
    s.moveTo(0, 1.0 * k);
    s.bezierCurveTo(0.25 * k, 0.6 * k, 0.62 * k, 0.35 * k, 0.6 * k, -0.15 * k);
    s.bezierCurveTo(0.58 * k, -0.62 * k, 0.28 * k, -0.85 * k, 0, -0.85 * k);
    s.bezierCurveTo(-0.28 * k, -0.85 * k, -0.6 * k, -0.62 * k, -0.6 * k, -0.15 * k);
    s.bezierCurveTo(-0.6 * k, 0.15 * k, -0.4 * k, 0.3 * k, -0.33 * k, 0.55 * k);
    s.bezierCurveTo(-0.2 * k, 0.4 * k, -0.08 * k, 0.55 * k, 0, 1.0 * k);
    return s;
  };
  [1, 0.7, 0.42].forEach((k, i) => {
    const m = new THREE.MeshPhysicalMaterial({ color: colors[i], emissive: colors[i], emissiveIntensity: 0.12 + i * 0.12, roughness: 0.4, clearcoat: 0.8, clearcoatRoughness: 0.15 });
    g.add(mesh(extrude(outline(k), 0.22 + i * 0.12, 0.08), m, { pos: [0, -0.12 * (1 - k), i * 0.12] }));
  });
  g.scale.setScalar(scale);
  return g;
}

function person(m, headM) {
  const g = new THREE.Group();
  g.add(mesh(lathe([[0, 0], [0.34, 0.02], [0.36, 0.1], [0.3, 0.45], [0.2, 0.62], [0, 0.66]]), m));
  g.add(mesh(sphere(0.2), headM ?? m, { pos: [0, 0.85, 0] }));
  return g;
}

function arrowHead(m, size = 0.22) {
  return mesh(new THREE.ConeGeometry(size, size * 1.5, 32), m);
}

function brickWall(rows, cols, bw, bh, brickM, mortarM, depth = 0.34) {
  const g = new THREE.Group();
  for (let r = 0; r < rows; r++) {
    const offset = r % 2 ? bw / 2 : 0;
    for (let c = -1; c < cols; c++) {
      const x = c * bw + offset - ((cols - 1) * bw) / 2;
      if (x < -((cols) * bw) / 2 - 0.01 || x > ((cols) * bw) / 2 - bw / 2 + 0.01) continue;
      const shade = 0.88 + ((r * 7 + c * 13) % 5) * 0.03;
      const m = brickM.clone();
      m.color.multiplyScalar(shade);
      g.add(mesh(rbox(bw - 0.05, bh - 0.05, depth, 0.04), m, { pos: [x, r * bh - ((rows - 1) * bh) / 2, 0] }));
    }
  }
  g.add(mesh(rbox(cols * bw - 0.06, rows * bh - 0.06, depth - 0.08, 0.02), mortarM));
  return g;
}

function parchmentTexture(draw) {
  return canvasTexture((ctx, n) => {
    const grd = ctx.createRadialGradient(n / 2, n / 2, n * 0.1, n / 2, n / 2, n * 0.7);
    grd.addColorStop(0, '#f6e3b4');
    grd.addColorStop(1, '#c99a5b');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, n, n);
    for (let i = 0; i < 900; i++) {
      ctx.fillStyle = `rgba(120,80,30,${Math.random() * 0.06})`;
      ctx.fillRect(Math.random() * n, Math.random() * n, 2 + Math.random() * 6, 1 + Math.random() * 3);
    }
    draw?.(ctx, n);
  });
}

// ── The powers ──────────────────────────────────────────────────────────────
export const MODELS = {
  // Defense
  shield: (r) => {
    const steel = metal(r.metal, 0.22);
    const g = group(mesh(extrude(heaterShield(1.6, 1.9), 0.18, 0.1), steel));
    g.add(mesh(extrude(heaterShield(1.2, 1.5), 0.1, 0.05), enamel(0x1f5fbf), { pos: [0, 0.05, 0.16] }));
    g.add(mesh(extrude(star(4, 0.42, 0.13), 0.1, 0.04), metal(0xf0f4ff, 0.15), { pos: [0, 0.12, 0.28] }));
    [[-0.62, 0.78], [0.62, 0.78], [0, -0.78]].forEach(([x, y]) => g.add(mesh(sphere(0.07), steel, { pos: [x, y, 0.18] })));
    return g;
  },

  invisibility: (r) => {
    // A hooded cloak of shadows with two glowing eyes
    const cloak = new THREE.MeshPhysicalMaterial({ color: 0x2a1650, roughness: 0.5, clearcoat: 0.5, sheen: 1, sheenColor: new THREE.Color(0x7a5cff) });
    const g = group(mesh(lathe([[0, -1.0], [0.82, -1.0], [0.86, -0.92], [0.7, -0.4], [0.58, 0.2], [0.56, 0.55], [0.44, 0.88], [0.22, 1.05], [0, 1.1]]), cloak));
    g.add(mesh(sphere(0.44, 48, 32), matte(0x05030c, 0.9), { pos: [0, 0.55, 0.26], scale: [1, 1.08, 0.7] }));
    [-0.15, 0.15].forEach(x => g.add(spark(r.glow, 0.1)).children.at(-1).position.set(x, 0.6, 0.62));
    g.add(mesh(torus(0.62, 0.04, PI * 2, 12, 64), crystal(r.metal, 0.8), { pos: [0, -0.15, 0], rot: [PI / 2, 0, 0] }));
    return g;
  },

  time_bomb: (r) => {
    const g = group(mesh(sphere(0.82), new THREE.MeshPhysicalMaterial({ color: 0x1c1e24, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.1 }), { pos: [0, -0.15, 0] }));
    g.add(mesh(cyl(0.26, 0.3, 0.26), metal(r.metal, 0.3), { pos: [0.36, 0.62, 0], rot: [0, 0, -0.45] }));
    g.add(mesh(tube([[0.44, 0.78, 0], [0.62, 1.0, 0.05], [0.78, 1.0, 0.1], [0.88, 1.15, 0.1]], 0.04), matte(0xcaa476, 0.8)));
    const s = spark(0xffb030, 0.16); s.position.set(0.9, 1.2, 0.1); g.add(s);
    // Clock face on the bomb
    const face = canvasTexture((ctx, n) => {
      ctx.fillStyle = '#f3efe6'; ctx.beginPath(); ctx.arc(n / 2, n / 2, n / 2, 0, PI * 2); ctx.fill();
      ctx.strokeStyle = '#222'; ctx.lineWidth = 14;
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * PI * 2; ctx.beginPath();
        ctx.moveTo(n / 2 + Math.cos(a) * n * 0.38, n / 2 + Math.sin(a) * n * 0.38);
        ctx.lineTo(n / 2 + Math.cos(a) * n * 0.45, n / 2 + Math.sin(a) * n * 0.45); ctx.stroke();
      }
      ctx.lineWidth = 22; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(n / 2, n / 2); ctx.lineTo(n / 2, n * 0.2); ctx.stroke();
      ctx.strokeStyle = '#d32f2f';
      ctx.beginPath(); ctx.moveTo(n / 2, n / 2); ctx.lineTo(n * 0.74, n * 0.6); ctx.stroke();
    });
    g.add(mesh(cyl(0.36, 0.36, 0.06, 48), [metal(r.metal), new THREE.MeshPhysicalMaterial({ map: face, clearcoat: 1, roughness: 0.3 }), metal(r.metal)], { pos: [-0.12, -0.12, 0.8], rot: [PI / 2, 0, 0] }));
    g.add(mesh(torus(0.37, 0.05), metal(r.metal, 0.2), { pos: [-0.12, -0.12, 0.83] }));
    return g;
  },

  wall: (r) => {
    const g = brickWall(4, 3, 0.62, 0.36, enamel(0xc4522b, 0.55), matte(0xb8a890));
    // Steel band and rivets (rare)
    g.add(mesh(rbox(2.0, 0.16, 0.42, 0.04), metal(r.metal), { pos: [0, 0.2, 0.02] }));
    [-0.8, -0.27, 0.27, 0.8].forEach(x => g.add(mesh(sphere(0.05), metal(0xffffff, 0.2), { pos: [x, 0.2, 0.24] })));
    g.rotation.y = -0.2;
    return g;
  },

  sentinel: (r) => {
    const copper = metal(r.metal, 0.25);
    const g = group(mesh(lathe([[0, 0.95], [0.18, 0.92], [0.3, 0.75], [0.38, 0.3], [0.5, -0.25], [0.78, -0.62], [0.8, -0.7], [0.0, -0.7]]), copper));
    g.add(mesh(torus(0.16, 0.06), copper, { pos: [0, 1.02, 0] }));
    g.add(mesh(sphere(0.17), metal(0xffd27a, 0.2), { pos: [0, -0.82, 0] }));
    g.add(mesh(torus(0.79, 0.05, PI * 2, 16, 96), metal(0xffd27a, 0.2), { pos: [0, -0.66, 0], rot: [PI / 2, 0, 0] }));
    // Ringing waves
    [-1, 1].forEach(side => [0.95, 1.2].forEach((rad, i) => g.add(mesh(torus(rad, 0.04, 0.9, 8, 32), glow(r.light, 1.6 - i * 0.5), { pos: [0, 0.1, 0], rot: [0, 0, side > 0 ? -0.45 : PI - 0.45] }))));
    return g;
  },

  // Attack
  double_area: (r) => {
    const gold = metal(r.metal, 0.18);
    const g = group(mesh(extrude(bolt(), 0.28, 0.08), gold, { pos: [-0.28, 0, 0.1] }));
    g.add(mesh(extrude(bolt(), 0.22, 0.06), enamel(0x8b5cf6, 0.25), { pos: [0.32, -0.05, -0.3], scale: 0.85 }));
    const s = spark(r.light, 0.18); s.position.set(-0.05, 0.75, 0.35); g.add(s);
    return g;
  },

  steal_boost: (r) => {
    const steel = metal(0xe2e8ef, 0.12);
    const gold = metal(r.metal, 0.2);
    const blade = [[-0.11, -0.2], [0.11, -0.2], [0.11, 1.35], [0, 1.6], [-0.11, 1.35]];
    const g = group(mesh(extrude(blade, 0.06, 0.035), steel));
    g.add(mesh(rbox(0.9, 0.14, 0.18, 0.06), gold, { pos: [0, -0.24, 0] }));
    g.add(mesh(cyl(0.08, 0.08, 0.55), wood(0x5a2a12), { pos: [0, -0.6, 0] }));
    g.add(mesh(sphere(0.12), gold, { pos: [0, -0.92, 0] }));
    g.add(mesh(new THREE.OctahedronGeometry(0.1, 0), gemMaterial(0xe0193a), { pos: [0, -0.24, 0.12] }));
    g.rotation.z = -PI / 4;
    return g;
  },

  magnet: (r) => {
    const red = enamel(0xd92b2b, 0.25);
    const steel = metal(r.metal, 0.15);
    const g = group(mesh(torus(0.55, 0.24, PI, 32, 64), red, { pos: [0, 0.2, 0] }));
    [-0.55, 0.55].forEach(x => {
      g.add(mesh(cyl(0.24, 0.24, 0.5, 32), red, { pos: [x, -0.05, 0] }));
      g.add(mesh(cyl(0.245, 0.245, 0.32, 32), steel, { pos: [x, -0.46, 0] }));
    });
    [[-0.95, -0.85], [0.95, -0.85], [0, -1.0]].forEach(([x, y]) => { const s = spark(r.light, 0.09); s.position.set(x, y, 0.2); g.add(s); });
    g.rotation.z = PI;
    g.position.y = -0.1;
    return group(g);
  },

  bulldozer: (r) => {
    const yellow = enamel(0xf2b01e, 0.3);
    const dark = matte(0x26282d, 0.6);
    const g = group(mesh(rbox(1.5, 0.55, 0.9, 0.1), yellow, { pos: [0.05, -0.05, 0] }));
    g.add(mesh(rbox(0.7, 0.55, 0.8, 0.08), yellow, { pos: [0.35, 0.48, 0] }));
    g.add(mesh(rbox(0.5, 0.36, 0.82, 0.05), new THREE.MeshPhysicalMaterial({ color: 0x9fd3ff, roughness: 0.05, metalness: 0.2, clearcoat: 1 }), { pos: [0.3, 0.52, 0.01] }));
    [-0.5, 0.5].forEach(z => {
      g.add(mesh(rbox(1.7, 0.42, 0.24, 0.2), dark, { pos: [0.05, -0.48, z] }));
      [-0.55, 0, 0.55].forEach(x => g.add(mesh(cyl(0.15, 0.15, 0.26, 24), metal(0x8a8f98, 0.4), { pos: [x + 0.05, -0.48, z], rot: [PI / 2, 0, 0] })));
    });
    g.add(mesh(rbox(0.16, 0.85, 1.4, 0.05), metal(r.metal, 0.25), { pos: [-1.0, -0.25, 0], rot: [0, 0, 0.12] }));
    g.add(mesh(rbox(0.5, 0.1, 0.1, 0.03), dark, { pos: [-0.72, -0.12, 0.3] }));
    g.add(mesh(rbox(0.5, 0.1, 0.1, 0.03), dark, { pos: [-0.72, -0.12, -0.3] }));
    g.add(mesh(cyl(0.06, 0.06, 0.4), dark, { pos: [0.65, 0.4, 0.25] }));
    g.rotation.y = 0.55;
    return g;
  },

  battering_ram: (r) => {
    const log = wood(0x7a4a24);
    const g = group(mesh(cyl(0.34, 0.38, 2.1, 40), log, { rot: [0, 0, PI / 2] }));
    // A big crystal ram head
    const head = new THREE.Group();
    head.add(mesh(cyl(0.46, 0.4, 0.4, 8), crystal(r.metal, 0.6), { rot: [0, 0, PI / 2] }));
    head.add(mesh(new THREE.ConeGeometry(0.46, 0.45, 8), crystal(r.metal, 0.75), { pos: [-0.42, 0, 0], rot: [0, 0, PI / 2] }));
    head.position.x = -1.2;
    g.add(head);
    [-0.65, 0.0, 0.65].forEach(x => {
      g.add(mesh(cyl(0.4, 0.4, 0.12, 40), metal(0xd0d6de, 0.25), { pos: [x, 0, 0], rot: [0, 0, PI / 2] }));
      for (let k = 0; k < 6; k++) { const a = (k / 6) * PI * 2; g.add(mesh(sphere(0.035), metal(0xf2f4f7, 0.2), { pos: [x, Math.cos(a) * 0.4, Math.sin(a) * 0.4] })); }
    });
    g.add(mesh(torus(0.16, 0.05), metal(0xd0d6de, 0.3), { pos: [1.15, 0, 0], rot: [0, PI / 2, 0] }));
    [[-1.75, 0.35], [-1.85, -0.3], [-1.7, 0.0]].forEach(([x, y], i) => { const s = spark(r.light, 0.16 - i * 0.03); s.position.set(x, y, 0.15); g.add(s); });
    g.rotation.set(0.25, 0.55, 0.35);
    return g;
  },

  sabotage: (r) => {
    // Caltrops (abrojos) thrown on the rival's path: four-pointed spikes that always land point up
    const gold = metal(r.metal, 0.2);
    const tips = metal(0xf2f4f7, 0.12);
    const caltrop = (scale) => {
      const g = new THREE.Group();
      const dirs = [[0, 1, 0], [0.943, -0.333, 0], [-0.471, -0.333, 0.816], [-0.471, -0.333, -0.816]];
      dirs.forEach(d => {
        const v = new THREE.Vector3(...d);
        const spike = new THREE.Group();
        spike.add(mesh(new THREE.ConeGeometry(0.12, 0.62, 24), gold, { pos: [0, 0.31, 0] }));
        spike.add(mesh(new THREE.ConeGeometry(0.05, 0.16, 16), tips, { pos: [0, 0.6, 0] }));
        spike.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v);
        g.add(spike);
      });
      g.add(mesh(sphere(0.15), enamel(0x8b5cf6, 0.2)));
      g.scale.setScalar(scale);
      return g;
    };
    const a = caltrop(1.2); a.position.set(0, 0.1, 0.25); a.rotation.y = 0.4;
    const b = caltrop(0.85); b.position.set(0.6, -0.12, -0.45); b.rotation.y = 1.2;
    const c = caltrop(0.75); c.position.set(-0.65, -0.16, -0.5); c.rotation.y = 2.1;
    const g = group(a, b, c);
    g.rotation.x = 0.6;
    return g;
  },

  rally: (r) => {
    const shell = enamel(0x1d4ed8, 0.25);
    const g = group(mesh(lathe([[0.12, -0.6], [0.2, -0.55], [0.6, 0.45], [0.66, 0.6], [0.0, 0.6]], 48), shell));
    g.add(mesh(cyl(0.14, 0.14, 0.35, 24), metal(0xd8dee8, 0.2), { pos: [0, -0.75, 0] }));
    g.add(mesh(torus(0.64, 0.07, PI * 2, 16, 64), crystal(r.metal, 1.0), { pos: [0, 0.58, 0], rot: [PI / 2, 0, 0] }));
    g.add(mesh(cyl(0.6, 0.6, 0.02, 48), glow(r.light, 1.4), { pos: [0, 0.6, 0] }));
    g.add(mesh(rbox(0.14, 0.45, 0.14, 0.05), matte(0x22252b), { pos: [0, -0.35, -0.3], rot: [0.5, 0, 0] }));
    g.rotation.set(0, 0, -PI / 2 + 0.35);
    const out = group(g);
    [0.9, 1.15, 1.4].forEach((rad, i) => out.add(mesh(torus(rad, 0.035, 0.9, 8, 32), glow(r.light, 2 - i * 0.5), { pos: [-0.2, 0.1, 0], rot: [0, 0, -0.45 + 0.35] })));
    return out;
  },

  head_start: (r) => {
    const body = enamel(0xf3f4f6, 0.25);
    const red = enamel(0xe23b3b, 0.25);
    const g = group(mesh(lathe([[0, -0.75], [0.3, -0.7], [0.36, -0.2], [0.33, 0.3], [0.2, 0.75], [0, 0.98]]), body));
    g.add(mesh(lathe([[0, 0.55], [0.26, 0.55], [0.2, 0.75], [0, 0.98]]), red));
    g.add(mesh(cyl(0.13, 0.13, 0.06, 32), metal(r.metal), { pos: [0, 0.15, 0.32], rot: [PI / 2, 0, 0] }));
    g.add(mesh(cyl(0.09, 0.09, 0.08, 32), new THREE.MeshPhysicalMaterial({ color: 0x6ec6ff, roughness: 0.05, clearcoat: 1 }), { pos: [0, 0.15, 0.34], rot: [PI / 2, 0, 0] }));
    for (let i = 0; i < 3; i++) {
      const fin = mesh(extrude([[0, 0], [0.38, -0.25], [0.38, -0.55], [0, -0.35]], 0.06, 0.02), red);
      const a = (i / 3) * PI * 2;
      fin.position.set(Math.sin(a) * 0.3, -0.35, Math.cos(a) * 0.3);
      fin.rotation.y = a - PI / 2;
      g.add(fin);
    }
    g.add(mesh(cyl(0.22, 0.28, 0.12, 32), metal(r.metal, 0.3), { pos: [0, -0.8, 0] }));
    const f = flame(0.42); f.rotation.z = PI; f.position.set(0, -1.15, 0); g.add(f);
    g.rotation.z = -0.6;
    return g;
  },

  // Utility
  spy: (r) => {
    const copper = metal(r.metal, 0.3);
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x4fb0ff, roughness: 0.02, metalness: 0.1, clearcoat: 1, emissive: 0x1a4a7a, emissiveIntensity: 0.4 });
    const g = new THREE.Group();
    [-0.42, 0.42].forEach(x => {
      g.add(mesh(cyl(0.32, 0.36, 0.9, 40), matte(0x2a2d33, 0.5), { pos: [x, 0, 0], rot: [PI / 2, 0, 0] }));
      g.add(mesh(torus(0.34, 0.06), copper, { pos: [x, 0, 0.45] }));
      g.add(mesh(cyl(0.3, 0.3, 0.04, 40), glass, { pos: [x, 0, 0.47], rot: [PI / 2, 0, 0] }));
      g.add(mesh(torus(0.37, 0.05), copper, { pos: [x, 0, -0.1] }));
    });
    g.add(mesh(rbox(0.36, 0.3, 0.5, 0.08), copper, { pos: [0, 0, -0.1] }));
    g.rotation.set(0.35, -0.5, 0);
    return g;
  },

  nickname: (r) => {
    const feather = new THREE.Shape();
    feather.moveTo(0, -0.9);
    feather.bezierCurveTo(0.5, -0.4, 0.55, 0.5, 0.05, 1.1);
    feather.bezierCurveTo(-0.3, 0.6, -0.42, -0.2, 0, -0.9);
    const vane = new THREE.MeshPhysicalMaterial({ color: 0x18b38a, roughness: 0.45, sheen: 1, sheenColor: new THREE.Color(0x9fffe0), clearcoat: 0.4 });
    const g = group(mesh(extrude(feather, 0.05, 0.04), vane));
    g.add(mesh(tube([[0, -1.25, 0.05], [0.02, -0.2, 0.06], [0.06, 1.0, 0.05]], 0.03), matte(0xf3efe2, 0.5)));
    g.add(mesh(new THREE.ConeGeometry(0.07, 0.35, 24), metal(r.metal, 0.2), { pos: [-0.01, -1.4, 0.05], rot: [0, 0, PI] }));
    g.rotation.z = -0.6;
    return g;
  },

  reveal: (r) => {
    // Lighthouse with a glowing lamp
    const white = enamel(0xf4f4f2, 0.3), red = enamel(0xd8352f, 0.3);
    const g = new THREE.Group();
    const bands = 4;
    for (let i = 0; i < bands; i++) {
      const y0 = -0.9 + i * 0.36, r0 = 0.48 - i * 0.06, r1 = 0.48 - (i + 1) * 0.06;
      g.add(mesh(cyl(r1, r0, 0.36, 48), i % 2 ? white : red, { pos: [0, y0 + 0.18, 0] }));
    }
    g.add(mesh(cyl(0.34, 0.34, 0.06, 48), metal(r.metal), { pos: [0, 0.57, 0] }));
    g.add(mesh(cyl(0.22, 0.22, 0.3, 32), glow(0xfff2b0, 3), { pos: [0, 0.75, 0] }));
    g.add(mesh(new THREE.ConeGeometry(0.3, 0.28, 32), red, { pos: [0, 1.04, 0] }));
    g.add(mesh(sphere(0.05), metal(r.metal), { pos: [0, 1.2, 0] }));
    const beam = canvasTexture((ctx, n) => {
      const grd = ctx.createLinearGradient(0, 0, n, 0);
      grd.addColorStop(0, 'rgba(255,240,170,0.85)'); grd.addColorStop(1, 'rgba(255,240,170,0)');
      ctx.fillStyle = grd; ctx.beginPath(); ctx.moveTo(0, n * 0.45); ctx.lineTo(n, 0); ctx.lineTo(n, n); ctx.lineTo(0, n * 0.55); ctx.fill();
    });
    [1, -1].forEach(side => {
      const plane = mesh(new THREE.PlaneGeometry(1.4, 0.9), new THREE.MeshBasicMaterial({ map: beam, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }), { pos: [side * 0.8, 0.75, 0], rot: [0, 0, 0] });
      if (side < 0) plane.scale.x = -1;
      g.add(plane);
    });
    const s = spark(0xfff2b0, 0.2); s.position.set(0, 0.75, 0.25); g.add(s);
    return g;
  },

  revenge: (r) => {
    const gold = metal(r.metal, 0.2);
    const red = enamel(0xd92b3a, 0.25);
    const g = new THREE.Group();
    [[0, gold], [PI, red]].forEach(([rot, m]) => {
      const arc = group(mesh(torus(0.72, 0.13, PI * 0.78, 24, 64), m));
      const head = arrowHead(m, 0.26);
      head.position.set(Math.cos(PI * 0.78) * 0.72, Math.sin(PI * 0.78) * 0.72, 0);
      head.rotation.z = PI * 0.78;
      arc.add(head);
      arc.rotation.z = rot + 0.3;
      g.add(arc);
    });
    g.add(mesh(extrude(star(5, 0.3, 0.13), 0.1, 0.04), metal(0xffffff, 0.15), { pos: [0, 0, 0.05] }));
    g.rotation.x = -0.25;
    return g;
  },

  ambush: (r) => {
    // A spring trap with a piece of cheese, hidden in the grass
    const g = group(mesh(rbox(1.7, 0.16, 0.95, 0.05), wood(0xb7793f), { pos: [0, -0.4, 0] }));
    const steel = metal(r.metal, 0.2);
    g.add(mesh(tube([[-0.7, -0.28, 0.35], [-0.7, 0.25, 0.35], [0.4, 0.25, 0.35], [0.4, -0.28, 0.35]], 0.035), steel));
    g.add(mesh(tube([[-0.7, -0.28, -0.35], [-0.7, 0.25, -0.35], [0.4, 0.25, -0.35], [0.4, -0.28, -0.35]], 0.035), steel));
    g.add(mesh(tube([[0.4, 0.25, 0.35], [0.4, 0.25, -0.35]], 0.035), steel));
    g.add(mesh(torus(0.14, 0.035, PI * 2, 12, 32), steel, { pos: [-0.1, -0.24, 0.42] }));
    g.add(mesh(torus(0.14, 0.035, PI * 2, 12, 32), steel, { pos: [-0.1, -0.24, -0.42] }));
    const cheese = new THREE.Shape([[0, 0], [0.55, 0], [0, 0.4]].map(([x, y]) => new THREE.Vector2(x, y)));
    g.add(mesh(extrude(cheese, 0.28, 0.03), enamel(0xffc93c, 0.4), { pos: [0.35, -0.3, 0], rot: [-PI / 2, 0, 0.0] }));
    g.rotation.set(0.45, -0.5, 0);
    return g;
  },

  bastion: (r) => {
    const stone = new THREE.MeshPhysicalMaterial({ color: 0xbfc4cc, roughness: 0.55, clearcoat: 0.2 });
    const g = group(mesh(cyl(0.6, 0.7, 1.4, 48), stone, { pos: [0, -0.2, 0] }));
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * PI * 2;
      g.add(mesh(rbox(0.26, 0.26, 0.22, 0.04), stone, { pos: [Math.sin(a) * 0.6, 0.62, Math.cos(a) * 0.6], rot: [0, a, 0] }));
    }
    g.add(mesh(cyl(0.62, 0.62, 0.1, 48), metal(r.metal), { pos: [0, 0.5, 0] }));
    g.add(mesh(rbox(0.32, 0.5, 0.1, 0.15), matte(0x3a2a1c), { pos: [0, -0.65, 0.66] }));
    g.add(mesh(cyl(0.025, 0.025, 0.8), metal(0xdddddd), { pos: [0, 1.0, 0] }));
    g.add(mesh(extrude([[0, 0], [0.5, -0.12], [0, -0.28]], 0.02, 0.01), enamel(0x1f5fbf), { pos: [0.02, 1.36, 0] }));
    [0.1, 0.45].forEach(y => g.add(mesh(cyl(0.705 - (y + 0.2) * 0.07, 0.705 - (y + 0.2) * 0.07, 0.05, 48), metal(r.metal, 0.3), { pos: [0, y - 0.5, 0] })));
    return g;
  },

  club_wall: (r) => {
    const stone = new THREE.MeshPhysicalMaterial({ color: 0x8e97a6, roughness: 0.55, clearcoat: 0.3 });
    const g = group(mesh(rbox(2.0, 0.9, 0.5, 0.06), stone, { pos: [0, -0.35, 0] }));
    [-0.62, 0.62].forEach(x => g.add(mesh(rbox(0.36, 0.7, 0.04, 0.02), enamel(0x1d4ed8, 0.3), { pos: [x, -0.3, 0.27] })));
    for (let i = 0; i < 5; i++) g.add(mesh(rbox(0.28, 0.3, 0.5, 0.05), stone, { pos: [-0.84 + i * 0.42, 0.24, 0] }));
    const sh = mesh(extrude(heaterShield(0.95, 1.15), 0.16, 0.07), crystal(0x2aa8ff, 1.1), { pos: [0, 0.15, 0.35] });
    g.add(sh);
    g.add(mesh(extrude(star(5, 0.22, 0.09), 0.06, 0.02), metal(0xffffff, 0.1), { pos: [0, 0.22, 0.48] }));
    const s = spark(r.light, 0.22); s.position.set(0.3, 0.55, 0.5); g.add(s);
    g.rotation.y = -0.3;
    return g;
  },

  radar: (r) => {
    const dish = new THREE.MeshPhysicalMaterial({ color: 0xeef1f5, metalness: 0.4, roughness: 0.25, clearcoat: 1, side: THREE.DoubleSide });
    const pts = [];
    for (let i = 0; i <= 20; i++) { const x = (i / 20) * 0.9; pts.push([x, x * x * 0.55]); }
    const g = group(mesh(lathe(pts, 64), dish, { pos: [0, 0.2, 0], rot: [-0.9, 0, 0.35] }));
    g.add(mesh(cyl(0.03, 0.03, 0.55), metal(r.metal), { pos: [0.1, 0.42, 0.18], rot: [-0.9, 0, 0.35] }));
    g.add(mesh(sphere(0.07), glow(0xff4040, 3), { pos: [0.2, 0.62, 0.38] }));
    g.add(mesh(cyl(0.1, 0.16, 0.7), metal(r.metal, 0.3), { pos: [0, -0.4, 0] }));
    g.add(mesh(cyl(0.45, 0.55, 0.14, 48), metal(0x5c6068, 0.4), { pos: [0, -0.8, 0] }));
    [0.5, 0.75, 1.0].forEach((rad, i) => g.add(mesh(torus(rad, 0.03, 1.2, 8, 32), glow(r.glow, 2.2 - i * 0.5), { pos: [0.25, 0.7, 0.3], rot: [0, 0.4, 0.6] })));
    return g;
  },

  double_or_nothing: (r) => {
    const die = (pips, m, pipM) => {
      const g = group(mesh(rbox(0.9, 0.9, 0.9, 0.16, 6), m));
      const faces = [
        [[0, 0, 1], [0, 0, 0]], [[0, 1, 0], [-PI / 2, 0, 0]], [[1, 0, 0], [0, PI / 2, 0]],
      ];
      const layouts = { 1: [[0, 0]], 2: [[-0.2, -0.2], [0.2, 0.2]], 3: [[-0.22, -0.22], [0, 0], [0.22, 0.22]], 4: [[-0.2, -0.2], [0.2, 0.2], [-0.2, 0.2], [0.2, -0.2]], 5: [[-0.22, -0.22], [0.22, 0.22], [-0.22, 0.22], [0.22, -0.22], [0, 0]], 6: [[-0.22, -0.24], [-0.22, 0], [-0.22, 0.24], [0.22, -0.24], [0.22, 0], [0.22, 0.24]] };
      faces.forEach(([n, rot], fi) => {
        layouts[pips[fi]].forEach(([u, v]) => {
          const pip = mesh(sphere(0.075, 24, 16), pipM, { scale: [1, 1, 0.45] });
          const holder = new THREE.Group();
          holder.rotation.set(...rot);
          pip.position.set(u, v, 0.45);
          holder.add(pip);
          g.add(holder);
        });
      });
      return g;
    };
    const g = new THREE.Group();
    const a = die([5, 2, 3], enamel(0xf7f5ef, 0.2), matte(0x1d1f24, 0.4)); a.position.set(-0.5, -0.25, 0); a.rotation.set(0.5, 0.6, 0.15);
    const b = die([6, 1, 4], metal(r.metal, 0.2), enamel(0x7b3df0, 0.3)); b.position.set(0.55, 0.35, -0.2); b.rotation.set(-0.3, -0.5, 0.4);
    g.add(a, b);
    return g;
  },

  plunder: (r) => {
    const sack = new THREE.MeshPhysicalMaterial({ color: 0x9b6b3a, roughness: 0.8, sheen: 1, sheenColor: new THREE.Color(0xd9b07a) });
    const g = group(mesh(lathe([[0, -0.85], [0.55, -0.8], [0.78, -0.45], [0.75, 0.05], [0.42, 0.38], [0.2, 0.48], [0.32, 0.7], [0.18, 0.82], [0, 0.78]]), sack));
    g.add(mesh(torus(0.22, 0.05), matte(0xd6a64a, 0.6), { pos: [0, 0.48, 0], rot: [PI / 2, 0, 0] }));
    const dollar = canvasTexture((ctx, n) => {
      ctx.fillStyle = 'rgba(0,0,0,0)'; ctx.clearRect(0, 0, n, n);
      ctx.fillStyle = '#f2c14e'; ctx.font = `bold ${n * 0.7}px Georgia`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('$', n / 2, n / 2 + n * 0.04);
    });
    g.add(mesh(new THREE.PlaneGeometry(0.6, 0.6), new THREE.MeshStandardMaterial({ map: dollar, transparent: true, metalness: 0.8, roughness: 0.3 }), { pos: [0, -0.2, 0.77] }));
    const gold = metal(0xf2c14e, 0.22);
    [[-0.75, -0.82, 0.35, 0.3], [-0.45, -0.88, 0.6, -0.2], [0.75, -0.84, 0.3, 0.5]].forEach(([x, y, z, rz]) => { const c = coin(gold, 0.2); c.position.set(x, y, z); c.rotation.set(0.3, 0, rz); g.add(c); });
    return g;
  },

  // Global
  explorer: (r) => {
    const gold = metal(r.metal, 0.2);
    const leather = matte(0x5b3518, 0.55);
    const g = group(
      mesh(cyl(0.2, 0.24, 0.8, 40), leather, { pos: [0, -0.45, 0] }),
      mesh(cyl(0.16, 0.2, 0.7, 40), gold, { pos: [0, 0.25, 0] }),
      mesh(cyl(0.12, 0.16, 0.55, 40), leather, { pos: [0, 0.85, 0] }),
    );
    [-0.05, 0.6].forEach(y => g.add(mesh(torus(0.215, 0.035), gold, { pos: [0, y, 0], rot: [PI / 2, 0, 0] })));
    g.add(mesh(cyl(0.14, 0.14, 0.04, 32), new THREE.MeshPhysicalMaterial({ color: 0x88d0ff, roughness: 0.02, clearcoat: 1, emissive: 0x2266aa, emissiveIntensity: 0.4 }), { pos: [0, 1.13, 0] }));
    g.rotation.z = -0.9;
    g.rotation.x = 0.3;
    const s = spark(r.light, 0.18); s.position.set(1.0, 0.75, 0.2);
    return group(g, s);
  },

  wide_trail: (r) => {
    const road = new THREE.Shape();
    road.moveTo(-1.0, -1.0);
    road.bezierCurveTo(-0.6, -0.2, 0.2, -0.3, 0.25, 1.0);
    road.lineTo(0.75, 1.0);
    road.bezierCurveTo(0.7, -0.6, -0.2, -0.6, -0.35, -1.0);
    road.lineTo(-1.0, -1.0);
    const g = group(mesh(extrude(road, 0.1, 0.04), matte(0x3a3d44, 0.6)));
    const centre = new THREE.CubicBezierCurve3(new THREE.Vector3(-0.68, -1.0, 0.12), new THREE.Vector3(-0.4, -0.4, 0.12), new THREE.Vector3(0.45, -0.45, 0.12), new THREE.Vector3(0.5, 1.0, 0.12));
    for (let i = 0; i < 6; i++) {
      const t = i / 6 + 0.04, p = centre.getPoint(t), q = centre.getPoint(t + 0.06);
      const seg = mesh(rbox(0.06, p.distanceTo(q), 0.02, 0.01), glow(0xfff1a0, 1.2), { pos: [(p.x + q.x) / 2, (p.y + q.y) / 2, 0.12] });
      seg.rotation.z = Math.atan2(q.y - p.y, q.x - p.x) - PI / 2;
      g.add(seg);
    }
    // Wide glowing edges (the extra 25 m)
    [[-0.2, 0], [0.2, 0]].forEach(([dx]) => {
      const edge = mesh(extrude(road, 0.02, 0.0), new THREE.MeshBasicMaterial({ color: r.glow, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }), { pos: [dx, 0, -0.08], scale: [1.12, 1, 1] });
      g.add(edge);
    });
    g.rotation.x = -0.75;
    return g;
  },

  streak_saver: (r) => {
    const g = group(flame(1.0));
    g.add(mesh(torus(0.8, 0.05, PI * 1.6, 12, 64), metal(r.metal, 0.2), { pos: [0, -0.1, -0.1], rot: [0, 0, -PI * 1.3] }));
    const head = arrowHead(metal(r.metal, 0.2), 0.14);
    head.position.set(Math.cos(-PI * 1.3 + PI * 1.6) * 0.8, Math.sin(-PI * 1.3 + PI * 1.6) * 0.8 - 0.1, -0.1);
    head.rotation.z = -PI * 1.3 + PI * 1.6;
    g.add(head);
    return g;
  },

  compass: (r) => {
    const copper = metal(r.metal, 0.22);
    const face = canvasTexture((ctx, n) => {
      const grd = ctx.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
      grd.addColorStop(0, '#fbf3df'); grd.addColorStop(1, '#e3cfa2');
      ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(n / 2, n / 2, n / 2, 0, PI * 2); ctx.fill();
      ctx.strokeStyle = '#6b4a24'; ctx.lineWidth = 6;
      for (let i = 0; i < 32; i++) {
        const a = (i / 32) * PI * 2, l = i % 8 === 0 ? 0.34 : 0.4;
        ctx.beginPath(); ctx.moveTo(n / 2 + Math.cos(a) * n * l, n / 2 + Math.sin(a) * n * l);
        ctx.lineTo(n / 2 + Math.cos(a) * n * 0.45, n / 2 + Math.sin(a) * n * 0.45); ctx.stroke();
      }
      ctx.fillStyle = '#6b4a24'; ctx.font = `bold ${n * 0.1}px Georgia`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('N', n / 2, n * 0.2); ctx.fillText('S', n / 2, n * 0.8); ctx.fillText('E', n * 0.8, n / 2); ctx.fillText('O', n * 0.2, n / 2);
    });
    const g = group(mesh(cyl(0.95, 0.95, 0.22, 64), [copper, new THREE.MeshPhysicalMaterial({ map: face, roughness: 0.5 }), copper], { rot: [PI / 2, 0, 0] }));
    g.add(mesh(torus(0.95, 0.09, PI * 2, 24, 96), copper, { pos: [0, 0, 0.1] }));
    g.add(mesh(torus(0.14, 0.05), copper, { pos: [0, 1.08, 0] }));
    const needle = new THREE.Group();
    needle.add(mesh(extrude([[0, 0.7], [0.12, 0], [-0.12, 0]], 0.05, 0.02), enamel(0xd92b2b, 0.2)));
    needle.add(mesh(extrude([[0, -0.7], [0.12, 0], [-0.12, 0]], 0.05, 0.02), metal(0xe8edf2, 0.2)));
    needle.add(mesh(sphere(0.07), copper));
    needle.position.z = 0.16; needle.rotation.z = -0.5;
    g.add(needle);
    g.add(mesh(cyl(0.86, 0.86, 0.02, 64), new THREE.MeshPhysicalMaterial({ color: 0xffffff, transmission: 1, roughness: 0, thickness: 0.1, clearcoat: 1, transparent: true, opacity: 0.25 }), { pos: [0, 0, 0.22], rot: [PI / 2, 0, 0] }));
    g.rotation.x = -0.35;
    return g;
  },

  tourist: (r) => {
    const white = enamel(0xf6f7f9, 0.2);
    const gold = metal(r.metal, 0.2);
    const g = group(mesh(new THREE.CapsuleGeometry(0.24, 1.6, 12, 32), white, { rot: [0, 0, PI / 2] }));
    g.add(mesh(extrude([[-0.25, 0], [0.25, 0], [0.05, 1.05], [-0.2, 1.05]], 0.05, 0.03), white, { pos: [0.05, 0, 0], rot: [PI / 2, 0, 0] }));
    g.add(mesh(extrude([[-0.25, 0], [0.25, 0], [0.05, -1.05], [-0.2, -1.05]], 0.05, 0.03), white, { pos: [0.05, 0, 0], rot: [PI / 2, 0, 0] }));
    g.add(mesh(extrude([[0, 0], [0.3, 0], [0.12, 0.45], [-0.05, 0.45]], 0.04, 0.02), gold, { pos: [-0.85, 0.12, 0] }));
    g.add(mesh(rbox(0.9, 0.06, 0.5, 0.03), gold, { pos: [-0.8, 0.0, 0] }));
    [-0.4, 0.45].forEach(z => g.add(mesh(cyl(0.09, 0.09, 0.3, 24), gold, { pos: [0.15, -0.12, z], rot: [0, 0, PI / 2] })));
    for (let i = 0; i < 6; i++) g.add(mesh(sphere(0.045), new THREE.MeshPhysicalMaterial({ color: 0x5ab4ff, roughness: 0.05, clearcoat: 1 }), { pos: [0.55 - i * 0.2, 0.1, 0.22] }));
    g.add(mesh(sphere(0.1, 24, 16), new THREE.MeshPhysicalMaterial({ color: 0x5ab4ff, roughness: 0.05, clearcoat: 1 }), { pos: [0.86, 0.06, 0], scale: [1.4, 0.7, 1.5] }));
    g.rotation.set(0.45, -0.5, 0.35);
    return g;
  },

  expedition: (r) => {
    const g = new THREE.Group();
    const a = person(metal(r.metal, 0.25), enamel(0xf3d3b5, 0.5)); a.position.set(-0.42, -0.75, 0);
    const b = person(enamel(0x2e9e48, 0.3), enamel(0xd8a882, 0.5)); b.position.set(0.42, -0.75, -0.15); b.scale.setScalar(0.9);
    g.add(a, b);
    g.add(mesh(cyl(0.02, 0.02, 1.4), metal(0xdddddd), { pos: [0.05, 0.05, 0.2] }));
    g.add(mesh(extrude([[0, 0], [0.55, -0.14], [0, -0.3]], 0.02, 0.01), enamel(0x00e01a, 0.3), { pos: [0.07, 0.72, 0.2] }));
    return g;
  },

  dawn: (r) => {
    const g = new THREE.Group();
    g.add(mesh(sphere(0.6, 64, 32, 0), new THREE.MeshPhysicalMaterial({ color: 0xff9a1a, emissive: 0xff6a00, emissiveIntensity: 0.35, clearcoat: 1, roughness: 0.3 }), { pos: [0, -0.2, -0.2] }));
    for (let i = 0; i < 9; i++) {
      const a = (i / 8) * PI;
      g.add(mesh(rbox(0.1, 0.35, 0.08, 0.04), glow(0xffa31a, 0.6), { pos: [Math.cos(a) * 0.95, Math.sin(a) * 0.95 - 0.2, -0.2], rot: [0, 0, a - PI / 2] }));
    }
    const hills = new THREE.Shape();
    hills.moveTo(-1.2, -1.0); hills.lineTo(-1.2, -0.3);
    hills.bezierCurveTo(-0.8, 0.05, -0.4, -0.1, -0.1, -0.35);
    hills.bezierCurveTo(0.3, -0.05, 0.8, 0.0, 1.2, -0.35);
    hills.lineTo(1.2, -1.0); hills.lineTo(-1.2, -1.0);
    g.add(mesh(extrude(hills, 0.3, 0.06), enamel(0x2f7d4a, 0.45), { pos: [0, 0, 0.1] }));
    g.add(mesh(extrude(hills, 0.2, 0.05), enamel(0x1f5a35, 0.5), { pos: [0.3, -0.18, 0.35], scale: [0.9, 0.8, 1] }));
    g.add(mesh(torus(1.25, 0.04, PI, 8, 64), metal(r.metal, 0.2), { pos: [0, -0.2, -0.25] }));
    return g;
  },

  cartographer: (r) => {
    const tex = parchmentTexture((ctx, n) => {
      ctx.strokeStyle = 'rgba(90,60,25,0.6)'; ctx.lineWidth = 3;
      for (let i = 0; i < 6; i++) { ctx.beginPath(); ctx.arc(n * 0.3, n * 0.6, 30 + i * 22, 0, PI * 2); ctx.stroke(); }
      ctx.strokeStyle = '#1f8a4c'; ctx.lineWidth = 14; ctx.setLineDash([26, 18]); ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(n * 0.1, n * 0.85); ctx.bezierCurveTo(n * 0.4, n * 0.4, n * 0.6, n * 0.9, n * 0.85, n * 0.25); ctx.stroke();
    });
    const g = new THREE.Group();
    const panels = 3, w = 0.68;
    for (let i = 0; i < panels; i++) {
      const p = mesh(new THREE.BoxGeometry(w, 1.6, 0.03), new THREE.MeshPhysicalMaterial({ map: tex, roughness: 0.75, clearcoat: 0.1 }));
      const uv = p.geometry.attributes.uv;
      for (let k = 0; k < uv.count; k++) uv.setX(k, (uv.getX(k) + i) / panels);
      p.position.set((i - 1) * w * 0.94, 0, i === 1 ? -0.12 : 0);
      p.rotation.y = i === 1 ? 0 : (i === 0 ? 0.35 : -0.35);
      g.add(p);
    }
    const pin = new THREE.Group();
    pin.add(mesh(sphere(0.2), crystal(r.metal, 0.9), { pos: [0, 0.35, 0] }));
    pin.add(mesh(new THREE.ConeGeometry(0.12, 0.38, 32), crystal(r.metal, 0.9), { pos: [0, 0.08, 0], rot: [PI, 0, 0] }));
    pin.position.set(0.55, 0.15, 0.25);
    g.add(pin);
    const s = spark(r.light, 0.2); s.position.set(0.55, 0.5, 0.35); g.add(s);
    g.rotation.x = -0.3;
    return g;
  },

  // Rest days
  master_key: (r) => {
    const steel = metal(r.metal, 0.18);
    const g = group(mesh(torus(0.38, 0.11, PI * 2, 24, 64), steel, { pos: [0, 0.65, 0] }));
    g.add(mesh(extrude(star(4, 0.22, 0.1), 0.08, 0.03), metal(0xf2c14e, 0.2), { pos: [0, 0.65, 0] }));
    g.add(mesh(cyl(0.09, 0.09, 1.35, 32), steel, { pos: [0, -0.35, 0] }));
    g.add(mesh(rbox(0.36, 0.14, 0.1, 0.03), steel, { pos: [0.18, -0.85, 0] }));
    g.add(mesh(rbox(0.26, 0.12, 0.1, 0.03), steel, { pos: [0.14, -0.62, 0] }));
    g.add(mesh(torus(0.11, 0.04), metal(0xf2c14e, 0.2), { pos: [0, 0.22, 0], rot: [PI / 2, 0, 0] }));
    g.rotation.z = -PI / 4;
    return g;
  },

  double_loot: (r) => {
    const red = enamel(0xd62f4b, 0.25);
    const gold = metal(r.metal, 0.18);
    const g = group(mesh(rbox(1.2, 0.95, 1.2, 0.06), red, { pos: [0, -0.4, 0] }));
    g.add(mesh(rbox(1.32, 0.28, 1.32, 0.06), red, { pos: [0, 0.18, 0] }));
    g.add(mesh(rbox(0.2, 1.26, 1.24, 0.03), gold, { pos: [0, -0.28, 0] }));
    g.add(mesh(rbox(1.24, 1.26, 0.2, 0.03), gold, { pos: [0, -0.28, 0] }));
    [-1, 1].forEach(side => g.add(mesh(torus(0.26, 0.08, PI * 2, 16, 48), gold, { pos: [side * 0.24, 0.48, 0], rot: [0, side * 0.4, side * 0.6], scale: [1, 0.7, 1] })));
    g.add(mesh(sphere(0.12), gold, { pos: [0, 0.4, 0] }));
    [[0.85, 0.7], [-0.85, 0.55], [0.6, 1.05]].forEach(([x, y]) => { const s = spark(r.glow, 0.12); s.position.set(x, y, 0.2); g.add(s); });
    g.rotation.set(0.35, 0.6, 0);
    return g;
  },

  treasure_map: (r) => {
    const tex = parchmentTexture((ctx, n) => {
      ctx.strokeStyle = 'rgba(80,55,25,0.7)'; ctx.lineWidth = 8; ctx.setLineDash([22, 16]);
      ctx.beginPath(); ctx.moveTo(n * 0.12, n * 0.75); ctx.bezierCurveTo(n * 0.3, n * 0.2, n * 0.55, n * 0.85, n * 0.72, n * 0.38); ctx.stroke();
      ctx.setLineDash([]); ctx.strokeStyle = '#c62828'; ctx.lineWidth = 22; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(n * 0.66, n * 0.3); ctx.lineTo(n * 0.8, n * 0.46); ctx.moveTo(n * 0.8, n * 0.3); ctx.lineTo(n * 0.66, n * 0.46); ctx.stroke();
    });
    const sheet = new THREE.PlaneGeometry(1.6, 1.3, 32, 8);
    const pos = sheet.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setZ(i, Math.sin(pos.getX(i) * 2.2) * 0.06);
    sheet.computeVertexNormals();
    const g = group(mesh(sheet, new THREE.MeshPhysicalMaterial({ map: tex, roughness: 0.7, side: THREE.DoubleSide })));
    const paper = new THREE.MeshPhysicalMaterial({ color: 0xe0c28b, roughness: 0.7 });
    [-0.68, 0.68].forEach(y => {
      g.add(mesh(cyl(0.13, 0.13, 1.75, 40), paper, { pos: [0, y, 0.08], rot: [0, 0, PI / 2] }));
      [-0.92, 0.92].forEach(x => g.add(mesh(cyl(0.07, 0.07, 0.12, 24), metal(r.metal, 0.25), { pos: [x, y, 0.08], rot: [0, 0, PI / 2] })));
    });
    g.rotation.set(-0.35, 0.3, -0.1);
    return g;
  },
};

export const RARITIES = {
  shield: 'rare', invisibility: 'legendary', time_bomb: 'rare', wall: 'rare', sentinel: 'common',
  double_area: 'epic', steal_boost: 'epic', magnet: 'rare', bulldozer: 'epic', battering_ram: 'legendary',
  sabotage: 'epic', rally: 'legendary', head_start: 'rare', spy: 'common', nickname: 'common', reveal: 'common',
  revenge: 'epic', ambush: 'rare', bastion: 'rare', club_wall: 'legendary', radar: 'epic', double_or_nothing: 'epic',
  plunder: 'rare', explorer: 'epic', wide_trail: 'rare', streak_saver: 'common', compass: 'rare', tourist: 'epic',
  expedition: 'rare', dawn: 'common', cartographer: 'legendary', master_key: 'rare', double_loot: 'epic', treasure_map: 'common',
};
