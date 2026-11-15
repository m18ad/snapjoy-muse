import { useFrame } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { pushAlert } from "./alertState";
import { playerState } from "./playerState";
import { groundHeight } from "./terrain";
import { findFreeSpot } from "./unstick";
import { resolveCollision } from "./worldData";

// Wild horses grazing and wandering the meadow, using the real horse model and its own animations.
// The model's facing direction is worked out from its shape (the head end rises above the back), so
// it does not matter which way the file was authored. Add ?horses=0 to the game URL to switch off.

const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
const HORSES_ENABLED = params ? params.get("horses") !== "0" : false;
const HORSE_COUNT = 6;
// Characters are drawn at 2.0x (see npcRig.tsx); a horse stands about 1.2x as tall as a person.
const CHAR_SCALE = Number(params?.get("rigscale")) || 2.0;
const HORSE_HEIGHT = Number(params?.get("horseheight")) || 2.2 * CHAR_SCALE;
const WALK_SPEED = 3.6; // metres per second
const WALK_ANIM_REF = 3.6; // the speed at which the walk animation plays at normal rate
const SHOW_DIST = 260;
const ANIM_DIST = 140;

type Asset = {
  scene: THREE.Group;
  clips: THREE.AnimationClip[];
  /** Which way the head points in the file, as a unit vector on the ground plane. */
  dx: number;
  dz: number;
  height: number;
  cx: number;
  cz: number;
  minY: number;
};

function analyse(scene: THREE.Object3D) {
  scene.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  const meshes: THREE.Mesh[] = [];
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.geometry.attributes.position) meshes.push(m);
  });
  for (const m of meshes) {
    const pos = m.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      min.min(v);
      max.max(v);
    }
  }
  const sx = max.x - min.x;
  const sz = max.z - min.z;
  const alongX = sx > sz;
  const long = Math.max(alongX ? sx : sz, 1e-6);
  const start = alongX ? min.x : min.z;
  let lowTop = -Infinity;
  let highTop = -Infinity;
  for (const m of meshes) {
    const pos = m.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      const t = ((alongX ? v.x : v.z) - start) / long;
      if (t < 0.2) lowTop = Math.max(lowTop, v.y);
      else if (t > 0.8) highTop = Math.max(highTop, v.y);
    }
  }
  // The head and neck rise higher than the tail, so the higher end is the front.
  const sign = highTop >= lowTop ? 1 : -1;
  return {
    dx: alongX ? sign : 0,
    dz: alongX ? 0 : sign,
    height: Math.max(max.y - min.y, 1e-6),
    cx: (min.x + max.x) / 2,
    cz: (min.z + max.z) / 2,
    minY: min.y,
  };
}

let assetPromise: Promise<Asset | null> | null = null;
function loadHorse(): Promise<Asset | null> {
  if (!assetPromise) {
    assetPromise = new GLTFLoader()
      .loadAsync("/models/creatures/wild-horse.glb")
      .then((g) => ({ scene: g.scene, clips: g.animations, ...analyse(g.scene) }))
      .catch((e) => {
        pushAlert(`Horse model: could not load (${e instanceof Error ? e.message : String(e)})`, "warn", 15);
        return null;
      });
  }
  return assetPromise;
}

type Unit = {
  outer: THREE.Group;
  mixer: THREE.AnimationMixer | null;
  idle: THREE.AnimationAction | null;
  walk: THREE.AnimationAction | null;
  cur: THREE.AnimationAction | null;
  x: number;
  z: number;
  heading: number;
  hx: number;
  hz: number;
  tx: number;
  tz: number;
  moving: boolean;
  timer: number;
};

export function Horses() {
  const root = useRef<THREE.Group>(null);
  const units = useRef<Unit[]>([]);

  useEffect(() => {
    if (!HORSES_ENABLED) return;
    let cancelled = false;
    const made: Unit[] = [];

    loadHorse().then((asset) => {
      if (cancelled || !asset || !root.current) return;
      const idleClip =
        asset.clips.find((c) => /idle|stand/i.test(c.name)) ?? asset.clips.find((c) => /graze|eat/i.test(c.name)) ?? null;
      const walkClip =
        asset.clips.find((c) => /walk/i.test(c.name)) ?? asset.clips.find((c) => /trot|run|gallop|canter/i.test(c.name)) ?? null;
      pushAlert(
        `Horses ready (${asset.clips.length} animations: ${asset.clips.slice(0, 6).map((c) => c.name).join(", ") || "none"})`,
        "info",
        10,
      );

      const scale = HORSE_HEIGHT / asset.height;
      const cx = playerState.pos.x;
      const cz = playerState.pos.z;
      for (let i = 0; i < HORSE_COUNT; i++) {
        const ang = (i / HORSE_COUNT) * Math.PI * 2 + Math.random() * 0.8;
        const rad = 35 + Math.random() * 45;
        const spot = findFreeSpot(cx + Math.cos(ang) * rad, cz + Math.sin(ang) * rad);

        const model = cloneSkeleton(asset.scene);
        model.position.set(-asset.cx, -asset.minY, -asset.cz);
        model.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) {
            m.frustumCulled = false;
            m.castShadow = true;
            m.receiveShadow = true;
          }
        });
        const inner = new THREE.Group();
        inner.rotation.y = Math.atan2(-asset.dx, asset.dz); // turn the head to face +Z
        inner.add(model);
        const outer = new THREE.Group();
        outer.scale.setScalar(scale);
        outer.add(inner);
        root.current.add(outer);

        let mixer: THREE.AnimationMixer | null = null;
        let idle: THREE.AnimationAction | null = null;
        let walk: THREE.AnimationAction | null = null;
        if (idleClip || walkClip) {
          mixer = new THREE.AnimationMixer(model);
          if (idleClip) idle = mixer.clipAction(idleClip);
          if (walkClip) walk = mixer.clipAction(walkClip);
          const first = idle ?? walk;
          first?.play();
          if (first) first.time = Math.random() * first.getClip().duration;
        }
        made.push({
          outer,
          mixer,
          idle,
          walk,
          cur: idle ?? walk,
          x: spot.x,
          z: spot.z,
          heading: Math.random() * Math.PI * 2,
          hx: spot.x,
          hz: spot.z,
          tx: spot.x,
          tz: spot.z,
          moving: false,
          timer: Math.random() * 5,
        });
      }
      units.current = made;
    });

    return () => {
      cancelled = true;
      for (const u of made) {
        u.mixer?.stopAllAction();
        u.outer.removeFromParent();
      }
      units.current = [];
    };
  }, []);

  useFrame(({ camera }, dt) => {
    const step = Math.min(dt, 0.05);
    for (const u of units.current) {
      const d = Math.hypot(u.x - camera.position.x, u.z - camera.position.z);
      u.outer.visible = d < SHOW_DIST;
      if (d >= SHOW_DIST) continue;

      u.timer -= step;
      if (u.timer <= 0) {
        if (u.moving) {
          u.moving = false;
          u.timer = 3 + Math.random() * 5;
        } else {
          const a = Math.random() * Math.PI * 2;
          const r = 8 + Math.random() * 25;
          u.tx = u.hx + Math.cos(a) * r;
          u.tz = u.hz + Math.sin(a) * r;
          u.moving = true;
          u.timer = 6 + Math.random() * 8;
        }
      }

      let walking = false;
      if (u.moving) {
        const dx = u.tx - u.x;
        const dz = u.tz - u.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 1.5) {
          u.moving = false;
          u.timer = 2 + Math.random() * 4;
        } else {
          const want = Math.atan2(dx, dz);
          const diff = Math.atan2(Math.sin(want - u.heading), Math.cos(want - u.heading));
          u.heading += Math.max(-2 * step, Math.min(2 * step, diff));
          if (Math.abs(diff) < 0.9) {
            const nx = u.x + Math.sin(u.heading) * WALK_SPEED * step;
            const nz = u.z + Math.cos(u.heading) * WALK_SPEED * step;
            const res = resolveCollision(u.x, u.z, nx, nz, 1.6);
            if (res.x === u.x && res.z === u.z) {
              u.moving = false;
              u.timer = 1;
            } else {
              u.x = res.x;
              u.z = res.z;
              walking = true;
            }
          }
        }
      }
      u.outer.position.set(u.x, groundHeight(u.x, u.z), u.z);
      u.outer.rotation.y = u.heading;

      if (u.mixer && d < ANIM_DIST) {
        const next = walking ? u.walk ?? u.idle : u.idle ?? u.walk;
        if (next && next !== u.cur) {
          next.reset().fadeIn(0.3).play();
          u.cur?.fadeOut(0.3);
          u.cur = next;
        }
        if (u.cur && u.cur === u.walk) u.cur.timeScale = walking ? WALK_SPEED / WALK_ANIM_REF : 1;
        u.mixer.update(step);
      }
    }
  });

  return <group ref={root} />;
}
