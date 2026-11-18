import { useMemo } from "react";
import * as THREE from "three";
import { BLOCK_SIZE, GRID, districtAt } from "../worldData";
import { autumnAt, groundHeight, roadDistance } from "../terrain";
import { hash01, themeOf } from "./palette";
import { ROAD_W } from "./layout";

// The ground of the whole world: one mesh, 8 m grid, painted with vertex colours and a soft detail
// texture. Four biomes, one per kingdom, blend smoothly into each other:
//   Kings = green meadow, Warriors = red-orange autumn, Outcasts = deep forest, Monsters = golden dry land.
// Mountains turn to bare rock on the high ground and steep slopes, and to snow (or ash) on the peaks,
// each kingdom with its own colours.

const STEP = 8;
const HALF = ((GRID * 2 + 2) * BLOCK_SIZE) / 2;
const N = (HALF * 2) / STEP;

// dark, middle, light of each biome
const BIOMES: [THREE.Color, THREE.Color, THREE.Color][] = [
  // Kings: a natural meadow green, less neon than before, with darker clumps and lighter dry tips.
  [new THREE.Color("#4f7a2e"), new THREE.Color("#6c9638"), new THREE.Color("#8aa842")],
  [new THREE.Color("#b0622a"), new THREE.Color("#c9832e"), new THREE.Color("#d9a23c")],
  [new THREE.Color("#3f7a30"), new THREE.Color("#4f8a34"), new THREE.Color("#6aa23c")],
  [new THREE.Color("#d6a85a"), new THREE.Color("#e0bc6a"), new THREE.Color("#ecc97c")],
];
// Bare rock and the peak colour of each kingdom's mountains.
const ROCK: THREE.Color[] = [
  new THREE.Color("#8a8576"), // Kings: grey stone
  new THREE.Color("#a24a36"), // Warriors: red rock
  new THREE.Color("#55604a"), // Outcasts: dark mossy stone
  new THREE.Color("#4a3d58"), // Monsters: dark violet stone
];
const PEAK: THREE.Color[] = [
  new THREE.Color("#f4f6f8"), // snow
  new THREE.Color("#e8b88a"), // sun-baked sandstone
  new THREE.Color("#eef2f0"), // snow
  new THREE.Color("#b9a9d6"), // pale ash
];
const AUTUMN = new THREE.Color("#d6a93a");
const SAND = new THREE.Color("#d9c88f");
// Broad patches of drier, yellower grass and of damp, darker ground break up the meadow.
const DRY_PATCH = new THREE.Color("#9a9a48");
const DAMP_PATCH = new THREE.Color("#3f6a2a");
const OFFSETS: [number, number][] = [[0, 0], [14, 0], [-14, 0], [0, 14], [0, -14]];

function smooth(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function detailTexture() {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const g = c.getContext("2d");
  if (g) {
    g.fillStyle = "#e9e9e9";
    g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 1400; i++) {
      const x = hash01(i, 1, 11) * 256;
      const y = hash01(i, 2, 12) * 256;
      const r = 3 + hash01(i, 3, 13) * 14;
      const v = 205 + Math.floor(hash01(i, 4, 14) * 50);
      g.fillStyle = `rgba(${v},${v},${v},0.28)`;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
    for (let i = 0; i < 2600; i++) {
      const x = hash01(i, 5, 15) * 256;
      const y = hash01(i, 6, 16) * 256;
      const v = 180 + Math.floor(hash01(i, 7, 17) * 70);
      g.fillStyle = `rgba(${v},${v},${v},0.5)`;
      g.fillRect(x, y, 2, 2 + hash01(i, 8, 18) * 3);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

function buildTerrain() {
  const side = N + 1;
  const pos = new Float32Array(side * side * 3);
  const col = new Float32Array(side * side * 3);
  const uv = new Float32Array(side * side * 2);
  const idx: number[] = [];
  const tmp = new THREE.Color();
  for (let i = 0; i < side; i++) {
    for (let j = 0; j < side; j++) {
      const x = -HALF + i * STEP;
      const z = -HALF + j * STEP;
      const k = i * side + j;
      const hv = groundHeight(x, z);
      pos[k * 3] = x;
      pos[k * 3 + 1] = hv;
      pos[k * 3 + 2] = z;
      uv[k * 2] = x / 9;
      uv[k * 2 + 1] = z / 9;

      // How steep is the ground here? Steep ground and high ground turn to bare rock.
      const sx = (groundHeight(x + STEP, z) - groundHeight(x - STEP, z)) / (2 * STEP);
      const sz = (groundHeight(x, z + STEP) - groundHeight(x, z - STEP)) / (2 * STEP);
      const slope = Math.hypot(sx, sz);
      const rockMix = Math.max(smooth(24, 44, hv), smooth(0.7, 1.1, slope));
      const peakMix = smooth(62, 82, hv);

      const n1 = hash01(Math.floor(x / 16), Math.floor(z / 16), 3);
      const n2 = hash01(Math.floor(x / 9), Math.floor(z / 9), 4);
      const n3 = hash01(Math.floor(x / 24), Math.floor(z / 24), 5);
      // Broad, slow variation (about 56 m patches) so the meadow is not one flat colour.
      const n4 = hash01(Math.floor(x / 56), Math.floor(z / 56), 6);
      let r = 0, g = 0, b = 0;
      for (const [dx, dz] of OFFSETS) {
        const kd = themeOf(districtAt(x + dx, z + dz)).id;
        const bm = BIOMES[kd];
        tmp.copy(bm[0]).lerp(bm[1], n1).lerp(bm[2], n3 * 0.6);
        if (kd === 0) {
          tmp.lerp(AUTUMN, autumnAt(x, z) * (n2 > 0.4 ? 0.5 : 0.3));
          if (n4 > 0.62) tmp.lerp(DRY_PATCH, (n4 - 0.62) * 1.5);
          else if (n4 < 0.3) tmp.lerp(DAMP_PATCH, (0.3 - n4) * 1.4);
        }
        if (rockMix > 0) tmp.lerp(ROCK[kd], rockMix * (0.85 + 0.15 * n2));
        if (peakMix > 0) tmp.lerp(PEAK[kd], peakMix);
        r += tmp.r; g += tmp.g; b += tmp.b;
      }
      tmp.setRGB(r / OFFSETS.length, g / OFFSETS.length, b / OFFSETS.length);
      const rd = roadDistance(x, z);
      tmp.lerp(SAND, 1 - smooth(ROAD_W / 2, ROAD_W / 2 + 5, rd));
      col[k * 3] = tmp.r; col[k * 3 + 1] = tmp.g; col[k * 3 + 2] = tmp.b;

      if (i < N && j < N) {
        const a = k, b2 = k + 1, e = k + side, f = k + side + 1;
        idx.push(a, b2, e, b2, f, e);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/**
 * The plains that stretch on beyond the edge of the map: a huge flat ring with a square hole where the
 * map is. (It used to be one big flat plane under the whole map, which poked through every valley and
 * looked like flat patches of water.)
 */
function buildOuterPlain() {
  const R = 4500;
  const shape = new THREE.Shape();
  shape.moveTo(-R, -R);
  shape.lineTo(R, -R);
  shape.lineTo(R, R);
  shape.lineTo(-R, R);
  shape.lineTo(-R, -R);
  const hole = new THREE.Path();
  const h = HALF - 1;
  hole.moveTo(-h, -h);
  hole.lineTo(-h, h);
  hole.lineTo(h, h);
  hole.lineTo(h, -h);
  hole.lineTo(-h, -h);
  shape.holes.push(hole);
  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

export function Terrain() {
  const geo = useMemo(() => buildTerrain(), []);
  const outer = useMemo(() => buildOuterPlain(), []);
  const tex = useMemo(() => detailTexture(), []);
  return (
    <group>
      <mesh geometry={geo} receiveShadow>
        <meshStandardMaterial vertexColors map={tex} roughness={1} />
      </mesh>
      {/* Green plains stretching on beyond the edge of the map (nothing under the map itself). */}
      <mesh geometry={outer} position={[0, -0.1, 0]}>
        <meshStandardMaterial color="#86a845" roughness={1} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}
