import { makeCottages } from "./medieval/houseKit";

// Rolling hills for the whole map. Plain maths (no three.js), so the world, the player, the
// villagers and the renderer all agree on how high the ground is at any point.

const BLOCK = 64;
const GRID = 8;

function smoothstep(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** True for every block of the map (the name is historic: it used to mean just the Kings' village). */
export function isVillageBlock(gx: number, gz: number): boolean {
  return Math.abs(gx) <= GRID && Math.abs(gz) <= GRID;
}

// Level ground around every headquarters and hospital, so spawns, vaults and shops sit flat.
const HQ: [number, number][] = [
  [1, -1], [-5, 1], [5, 5], [4, -2], [0, 4], [0, -5], [-2, 1], [6, -7], [-6, -7], [7, 1], [-7, 1], [-3, 7], [3, 7],
];
const HOSPITAL: [number, number][] = [
  [2, -2], [-5, -1], [6, 6], [5, -3], [1, 5], [1, -5], [-1, 2], [6, -8], [-6, -8], [8, 1], [-8, 1], [-3, 8], [3, 8],
];
const FLAT = [
  ...HQ.map(([gx, gz]) => ({ x: gx * BLOCK, z: gz * BLOCK, r0: 30, r1: 62 })),
  ...HOSPITAL.map(([gx, gz]) => ({ x: gx * BLOCK, z: gz * BLOCK, r0: 22, r1: 48 })),
];
const NO_COTTAGES = new Set(["1,-1", "2,-2", "1,0"]);

function hills(x: number, z: number) {
  return (
    1.5 * (
      3.0 * Math.sin(x * 0.021 + 1.1) * Math.cos(z * 0.017 + 0.4) +
      1.6 * Math.sin((x + z) * 0.033 + 2.0) +
      0.8 * Math.sin(x * 0.057 - z * 0.049 + 0.7)
    ) +
    4.0 * Math.sin(x * 0.009 + 0.3) * Math.cos(z * 0.008 - 0.9) - // broad swells
    z * 0.006 // an overall fall toward +z: the land runs downhill
  );
}

// ---- Mountains ---------------------------------------------------------------------------
// Every kingdom has its own mountains, so each one has a skyline of its own:
//   Kings (centre and east): broad, gentle green highlands.
//   Warriors (west): red, craggy peaks.
//   Outcasts (south): tall, dark, wooded peaks.
//   Monsters (north, and the far east): sharp, dark spires.
// A ring of mountains also runs round the edge of the map, with a gap at every headquarters. The
// trails cut through them as passes. All numbers are fixed, so it is the same on every phone.

type Peak = { x: number; z: number; r: number; h: number; sharp: number };

const SIGNATURE_PEAKS: Peak[] = [
  // The Kings
  { x: 200, z: 70, r: 115, h: 46, sharp: 0 },
  { x: -70, z: -200, r: 105, h: 42, sharp: 0 },
  // The Warriors
  { x: -330, z: -130, r: 85, h: 88, sharp: 0.35 },
  { x: -370, z: 220, r: 90, h: 96, sharp: 0.35 },
  { x: -250, z: 330, r: 80, h: 80, sharp: 0.35 },
  // The Outcasts
  { x: -70, z: 340, r: 95, h: 92, sharp: 0.1 },
  { x: 110, z: 340, r: 95, h: 88, sharp: 0.1 },
  // The Monsters
  { x: -100, z: -380, r: 80, h: 112, sharp: 0.7 },
  { x: 100, z: -340, r: 75, h: 104, sharp: 0.7 },
  { x: -300, z: -330, r: 75, h: 96, sharp: 0.7 },
  { x: 400, z: 220, r: 80, h: 92, sharp: 0.7 },
];

function buildPeaks(): Peak[] {
  const list = [...SIGNATURE_PEAKS];
  const r = lcg(424242);
  const RIM = 470;
  for (let t = -450; t <= 450; t += 90) {
    const spots: [number, number][] = [[t, -RIM], [t, RIM], [-RIM, t], [RIM, t]];
    for (const [x, z] of spots) {
      const px = x + (r() - 0.5) * 40;
      const pz = z + (r() - 0.5) * 40;
      const rr = 70 + r() * 25;
      const hh = 55 + r() * 35;
      const sharp = r() * 0.5;
      // Keep a gap at every headquarters, so the way in stays open.
      if (HQ.some(([gx, gz]) => Math.hypot(px - gx * BLOCK, pz - gz * BLOCK) < 110)) continue;
      list.push({ x: px, z: pz, r: rr, h: hh, sharp });
    }
  }
  return list;
}

const PEAKS: Peak[] = buildPeaks();

/** Height added by the mountains at (x, z): 0 on the plains, up to ~120 m on the highest peaks. */
function mountains(x: number, z: number): number {
  let sum = 0;
  for (const p of PEAKS) {
    const dx = x - p.x;
    const dz = z - p.z;
    const lim = p.r * 2.6;
    if (dx > lim || dx < -lim || dz > lim || dz < -lim) continue;
    const d = Math.hypot(dx, dz) / p.r;
    if (d > 2.6) continue;
    sum += p.h * Math.exp(-Math.pow(d, 2 - 1.2 * p.sharp));
  }
  if (sum < 1) return sum;
  sum = Math.min(sum, 120);
  // Craggy detail, and a gap where a trail crosses so the trails pass through the mountains.
  const crag = 1 + 0.16 * Math.sin(x * 0.11 + z * 0.07) * Math.sin(z * 0.09 - x * 0.05);
  const clear = smoothstep(6, 30, roadDistance(x, z));
  return sum * crag * clear;
}

/** 0 at the map edge, 1 well inside it. */
function edgeMask(x: number, z: number) {
  const gx = Math.round(x / BLOCK);
  const gz = Math.round(z / BLOCK);
  if (!isVillageBlock(gx, gz)) return 0;
  const lx = x - gx * BLOCK;
  const lz = z - gz * BLOCK;
  let d = 32;
  if (!isVillageBlock(gx + 1, gz)) d = Math.min(d, 32 - lx);
  if (!isVillageBlock(gx - 1, gz)) d = Math.min(d, 32 + lx);
  if (!isVillageBlock(gx, gz + 1)) d = Math.min(d, 32 - lz);
  if (!isVillageBlock(gx, gz - 1)) d = Math.min(d, 32 + lz);
  return smoothstep(0, 32, d);
}

function baseHeight(x: number, z: number) {
  let m = edgeMask(x, z);
  if (m <= 0) return 0;
  for (const f of FLAT) m *= smoothstep(f.r0, f.r1, Math.hypot(x - f.x, z - f.z));
  return m * (hills(x, z) + mountains(x, z));
}

type Pad = { x: number; z: number; w: number; d: number; level: number };
const padCache = new Map<string, Pad[]>();

/** Each cottage stands on its own level terrace (none while the village buildings are off). */
function padsOf(gx: number, gz: number): Pad[] {
  const key = `${gx},${gz}`;
  let p = padCache.get(key);
  if (p) return p;
  p = [];
  if (isVillageBlock(gx, gz) && !NO_COTTAGES.has(key)) {
    for (const c of makeCottages(gx, gz, gx * BLOCK, gz * BLOCK)) {
      p.push({ x: c.x, z: c.z, w: c.w, d: c.d, level: baseHeight(c.x, c.z) });
    }
  }
  padCache.set(key, p);
  return p;
}

/** Height of the ground at (x, z) in metres. */
export function groundHeight(x: number, z: number): number {
  const gx = Math.round(x / BLOCK);
  const gz = Math.round(z / BLOCK);
  if (!isVillageBlock(gx, gz)) return 0;
  let h = baseHeight(x, z);
  for (const p of padsOf(gx, gz)) {
    const dx = Math.max(Math.abs(x - p.x) - p.w / 2, 0);
    const dz = Math.max(Math.abs(z - p.z) - p.d / 2, 0);
    const m = 1 - smoothstep(2.5, 9, Math.hypot(dx, dz));
    if (m > 0) h += (p.level - h) * m;
  }
  return h;
}

// ---- Old grid lanes (kept only so older code that imports them still compiles) -------------
const LINES: number[] = Array.from({ length: GRID * 2 + 2 }, (_, i) => (i - GRID - 0.5) * BLOCK);
const WIND = 5;

function wave(line: number, t: number, salt: number) {
  return 0.65 * Math.sin(t * 0.026 + line * 0.83 + salt) + 0.35 * Math.sin(t * 0.061 + line * 1.9 + salt * 2);
}

/** x of the old grid lane that runs along z, at height z. */
export function roadX(line: number, z: number): number {
  return line + WIND * edgeMask(line, z) * wave(line, z, 0);
}

/** z of the old grid lane that runs along x, at position x. */
export function roadZ(line: number, x: number): number {
  return line + WIND * edgeMask(x, line) * wave(line, x, 1.3);
}

/** Where the old grid lanes met. */
export function junctionAt(X: number, Z: number): { x: number; z: number } {
  let x = X;
  let z = Z;
  for (let k = 0; k < 4; k++) {
    x = roadX(X, z);
    z = roadZ(Z, x);
  }
  return { x, z };
}

void LINES;

// ---- The trail network -------------------------------------------------------------------
// Free-flowing trails join the headquarters of every kingdom: a spanning network (so everywhere is
// reachable), a few extra loops, and dead-end side branches. Every trail curves, so the route never
// follows a grid. All of it is generated from fixed numbers, so it is the same on every phone.

export type Pt = { x: number; z: number };

function lcg(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/** Where the trails meet: one sandy clearing at every headquarters. */
export const TRAIL_NODES: Pt[] = HQ.map(([gx, gz]) => ({ x: gx * BLOCK, z: gz * BLOCK }));

const LIMIT = 520;
const clampPt = (p: Pt): Pt => ({
  x: Math.max(-LIMIT, Math.min(LIMIT, p.x)),
  z: Math.max(-LIMIT, Math.min(LIMIT, p.z)),
});

function bezier(a: Pt, b: Pt, c: Pt, d: Pt, t: number): Pt {
  const u = 1 - t;
  const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
  return { x: w0 * a.x + w1 * b.x + w2 * c.x + w3 * d.x, z: w0 * a.z + w1 * b.z + w2 * c.z + w3 * d.z };
}

function makeTrail(a: Pt, b: Pt, r: () => number, bend: number): Pt[] {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const L = Math.hypot(dx, dz) || 1;
  const nx = -dz / L;
  const nz = dx / L;
  const s1 = r() * 2 - 1;
  const s2 = r() * 2 - 1;
  const p1 = { x: a.x + dx * 0.33 + nx * L * bend * s1, z: a.z + dz * 0.33 + nz * L * bend * s1 };
  const p2 = { x: a.x + dx * 0.66 + nx * L * bend * s2, z: a.z + dz * 0.66 + nz * L * bend * s2 };
  const n = Math.max(4, Math.round(L / 5));
  const phase = r() * 6;
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = bezier(a, p1, p2, b, t);
    // A little extra meander, fading out at both ends so the trail meets its clearing cleanly.
    const wob = Math.sin(i * 0.8 + phase) * 1.6 * Math.sin(t * Math.PI);
    pts.push(clampPt({ x: p.x + nx * wob, z: p.z + nz * wob }));
  }
  return pts;
}

function buildTrails(): Pt[][] {
  const r = lcg(777001);
  const n = TRAIL_NODES.length;
  const dist = (i: number, j: number) => Math.hypot(TRAIL_NODES[i].x - TRAIL_NODES[j].x, TRAIL_NODES[i].z - TRAIL_NODES[j].z);

  // Shortest-links spanning tree (Prim), so every headquarters is reachable.
  const inTree = new Array<boolean>(n).fill(false);
  inTree[0] = true;
  const edges: [number, number][] = [];
  for (let k = 1; k < n; k++) {
    let best = Infinity, bi = -1, bj = -1;
    for (let i = 0; i < n; i++) {
      if (!inTree[i]) continue;
      for (let j = 0; j < n; j++) {
        if (inTree[j]) continue;
        const d = dist(i, j);
        if (d < best) { best = d; bi = i; bj = j; }
      }
    }
    edges.push([bi, bj]);
    inTree[bj] = true;
  }
  // Extra loops: each headquarters also links to its nearest neighbour it is not yet joined to.
  const has = (a: number, b: number) => edges.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  for (let i = 0; i < n; i++) {
    let best = Infinity, bj = -1;
    for (let j = 0; j < n; j++) {
      if (j === i || has(i, j)) continue;
      const d = dist(i, j);
      if (d < best) { best = d; bj = j; }
    }
    if (bj >= 0 && best < 330 && r() < 0.6) edges.push([i, bj]);
  }

  const trails: Pt[][] = [];
  for (const [i, j] of edges) trails.push(makeTrail(TRAIL_NODES[i], TRAIL_NODES[j], r, 0.2));

  // Dead-end side branches that wander off the main trails.
  const mains = trails.length;
  for (let k = 0; k < mains; k++) {
    const main = trails[k];
    for (let b = 0; b < 2; b++) {
      const idx = Math.floor(main.length * (0.25 + 0.5 * r()));
      const p = main[idx];
      const q = main[Math.min(main.length - 1, idx + 1)];
      const ang = Math.atan2(q.z - p.z, q.x - p.x) + (r() < 0.5 ? -1 : 1) * (0.7 + 0.6 * r());
      const len = 60 + r() * 80;
      const end = { x: p.x + Math.cos(ang) * len, z: p.z + Math.sin(ang) * len };
      if (Math.abs(end.x) > LIMIT - 20 || Math.abs(end.z) > LIMIT - 20) continue;
      trails.push(makeTrail(p, end, r, 0.3));
    }
  }
  return trails;
}

export const TRAILS: Pt[][] = buildTrails();

// A coarse index so "how far is the nearest trail?" is fast.
const CELL = 24;
const cellKey = (ix: number, iz: number) => (ix + 400) * 1000 + (iz + 400);
const SEG_INDEX = new Map<number, number[]>();
const SEGS: number[] = []; // x0, z0, x1, z1 ...
(() => {
  for (const t of TRAILS) {
    for (let i = 0; i + 1 < t.length; i++) {
      const a = t[i], b = t[i + 1];
      const id = SEGS.length / 4;
      SEGS.push(a.x, a.z, b.x, b.z);
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / (CELL / 2)));
      for (let s = 0; s <= steps; s++) {
        const x = a.x + ((b.x - a.x) * s) / steps;
        const z = a.z + ((b.z - a.z) * s) / steps;
        const key = cellKey(Math.floor(x / CELL), Math.floor(z / CELL));
        const list = SEG_INDEX.get(key);
        if (list) { if (list[list.length - 1] !== id) list.push(id); } else SEG_INDEX.set(key, [id]);
      }
    }
  }
})();

/** Sideways distance from (x, z) to the nearest trail centre line (Infinity if none is near). */
export function roadDistance(x: number, z: number): number {
  const cx = Math.floor(x / CELL);
  const cz = Math.floor(z / CELL);
  let best = Infinity;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const list = SEG_INDEX.get(cellKey(cx + dx, cz + dz));
      if (!list) continue;
      for (const id of list) {
        const k = id * 4;
        const x0 = SEGS[k], z0 = SEGS[k + 1], x1 = SEGS[k + 2], z1 = SEGS[k + 3];
        const vx = x1 - x0, vz = z1 - z0;
        const len2 = vx * vx + vz * vz || 1;
        const t = Math.max(0, Math.min(1, ((x - x0) * vx + (z - z0) * vz) / len2));
        const d = Math.hypot(x - (x0 + vx * t), z - (z0 + vz * t));
        if (d < best) best = d;
      }
    }
  }
  return best;
}

// ---- Woods and autumn --------------------------------------------------------------------

/** 0..1: how thickly wooded the land is here (clumps of forest between open meadow). Thins out up the mountains. */
export function forestAt(x: number, z: number): number {
  const f = 0.5 + 0.28 * Math.sin(x * 0.013 + 1.0) + 0.22 * Math.cos(z * 0.011 - 0.5) + 0.18 * Math.sin((x + z) * 0.02);
  return smoothstep(0.35, 0.75, f) * (1 - smoothstep(50, 90, mountains(x, z)));
}

/** 0..1: patches of hillside that have turned autumn orange. */
export function autumnAt(x: number, z: number): number {
  const f = 0.5 + 0.35 * Math.sin(x * 0.0075 + 2.1) * Math.cos(z * 0.0069 - 0.8) + 0.2 * Math.sin((x - z) * 0.012);
  return smoothstep(0.55, 0.8, f);
}
