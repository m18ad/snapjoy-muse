import { useMemo } from "react";
import * as THREE from "three";
import { groundHeight, TRAILS, TRAIL_NODES, type Pt } from "../terrain";
import { ROAD_W } from "./layout";
import { roadTexture } from "./roadTextures";

// The trails: a free-flowing network of sandy paths that curve with the land (see terrain.ts for the
// route). Each trail is a ribbon that follows the ground, and each headquarters has a sandy clearing.

function ribbon(points: Pt[], lift: number): THREE.BufferGeometry {
  const n = points.length;
  const half = ROAD_W / 2;
  const pos = new Float32Array(n * 2 * 3);
  const uv = new Float32Array(n * 2 * 2);
  const idx: number[] = [];
  let along = 0;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(n - 1, i + 1)];
    let tx = b.x - a.x;
    let tz = b.z - a.z;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    const nx = -tz, nz = tx;
    if (i > 0) along += Math.hypot(p.x - points[i - 1].x, p.z - points[i - 1].z);
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? -half : half;
      const x = p.x + nx * side;
      const z = p.z + nz * side;
      const k = i * 2 + s;
      pos[k * 3] = x;
      pos[k * 3 + 1] = groundHeight(x, z) + lift;
      pos[k * 3 + 2] = z;
      uv[k * 2] = s;
      uv[k * 2 + 1] = along / 16;
    }
    if (i < n - 1) {
      const k = i * 2;
      idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A round sandy clearing at each headquarters, where the trails meet. */
function clearings(lift: number): THREE.BufferGeometry {
  const seg = 24;
  const R = 7.5;
  const per = seg + 1;
  const pos = new Float32Array(TRAIL_NODES.length * per * 3);
  const idx: number[] = [];
  TRAIL_NODES.forEach((c, n) => {
    const base = n * per;
    pos[base * 3] = c.x;
    pos[base * 3 + 1] = groundHeight(c.x, c.z) + lift;
    pos[base * 3 + 2] = c.z;
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const x = c.x + Math.cos(a) * R;
      const z = c.z + Math.sin(a) * R;
      const k = base + 1 + i;
      pos[k * 3] = x;
      pos[k * 3 + 1] = groundHeight(x, z) + lift;
      pos[k * 3 + 2] = z;
      idx.push(base, base + 1 + i, base + 1 + ((i + 1) % seg));
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Layers sit a few centimetres above the terrain; each trail is lifted a hair differently so
// two trails crossing never flicker.
export function Roads() {
  const geos = useMemo(
    () => ({
      trails: TRAILS.map((t, i) => ribbon(t, 0.16 + (i % 6) * 0.012)),
      clearing: clearings(0.25),
    }),
    [],
  );
  const roadMat = useMemo(
    () => new THREE.MeshStandardMaterial({ map: roadTexture() ?? undefined, roughness: 1, side: THREE.DoubleSide }),
    [],
  );
  const clearingMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: "#e0d09c", roughness: 1, side: THREE.DoubleSide }),
    [],
  );
  return (
    <group>
      {geos.trails.map((g, i) => (
        <mesh key={i} geometry={g} material={roadMat} />
      ))}
      <mesh geometry={geos.clearing} material={clearingMat} />
    </group>
  );
}
