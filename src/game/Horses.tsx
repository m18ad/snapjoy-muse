import { useFrame } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { pushAlert } from "./alertState";
import { carPilot } from "./carState";
import { mountState } from "./mountState";
import { playerState } from "./playerState";
import { groundHeight } from "./terrain";
import { findFreeSpot } from "./unstick";
import { pilotState } from "./vehicleState";
import { resolveCollision } from "./worldData";

// Horses: the real horse model with its own animations. They wander the meadow near you, and you
// can ride one. Each horse has a tall golden beam above it so it is easy to spot from far away. Walk
// up to a horse and tap MOUNT HORSE (or press H). A label at the bottom of the screen points to the
// nearest horse. Horses that are left far behind come back near you. ?horses=0 switches them off.

const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
const HORSES_ENABLED = params ? params.get("horses") !== "0" : false;
const HORSE_COUNT = 6;
// Characters are drawn at 2.0x (see npcRig.tsx); a horse stands about 1.2x as tall as a person.
const CHAR_SCALE = Number(params?.get("rigscale")) || 2.0;
const HORSE_HEIGHT = Number(params?.get("horseheight")) || 2.2 * CHAR_SCALE;
const WALK_SPEED = 3.6; // wandering speed (metres per second)
const WALK_ANIM_REF = 3.6; // the speed at which the walk animation plays at normal rate
const RUN_ANIM_REF = 14; // the speed at which the run animation plays at normal rate
const SHOW_DIST = 260;
const ANIM_DIST = 140;
const BEAM_DIST = 700;
const BEAM_HEIGHT = 40;
const MOUNT_RADIUS = 9;
const RIDE_SPEED_MULT = 1.8;
const COME_BACK_DIST = 110; // a horse further than this from you is brought back near you
// Where the rider sits: the saddle is a bit over half the horse's height, and a rider's hips are
// about half of their own height above their feet.
const RIDER_LIFT = Math.max(0, 0.58 * HORSE_HEIGHT - 0.9 * CHAR_SCALE);

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
  beam: THREE.Mesh;
  mixer: THREE.AnimationMixer | null;
  idle: THREE.AnimationAction | null;
  walk: THREE.AnimationAction | null;
  run: THREE.AnimationAction | null;
  cur: THREE.AnimationAction | null;
  x: number;
  z: number;
  lx: number;
  lz: number;
  speed: number;
  heading: number;
  hx: number;
  hz: number;
  tx: number;
  tz: number;
  moving: boolean;
  timer: number;
};

const ARROWS = ["\u2191", "\u2197", "\u2192", "\u2198", "\u2193", "\u2199", "\u2190", "\u2196"];

export function Horses() {
  const root = useRef<THREE.Group>(null);
  const units = useRef<Unit[]>([]);
  const ridden = useRef<Unit | null>(null);
  const ui = useRef<{ button: HTMLButtonElement; label: HTMLDivElement } | null>(null);
  const uiTimer = useRef(0);
  const tmpDir = useRef(new THREE.Vector3());

  function nearestHorse(): { unit: Unit; dist: number } | null {
    let best: Unit | null = null;
    let bestD = Infinity;
    for (const u of units.current) {
      if (u === ridden.current) continue;
      const d = Math.hypot(u.x - playerState.pos.x, u.z - playerState.pos.z);
      if (d < bestD) { bestD = d; best = u; }
    }
    return best ? { unit: best, dist: bestD } : null;
  }

  /** Puts a horse on free ground a short walk from the player. */
  function bringNear(u: Unit) {
    const ang = Math.random() * Math.PI * 2;
    const rad = 22 + Math.random() * 20;
    const spot = findFreeSpot(playerState.pos.x + Math.cos(ang) * rad, playerState.pos.z + Math.sin(ang) * rad);
    u.x = spot.x;
    u.z = spot.z;
    u.lx = spot.x;
    u.lz = spot.z;
    u.hx = spot.x;
    u.hz = spot.z;
    u.tx = spot.x;
    u.tz = spot.z;
    u.moving = false;
    u.timer = 2 + Math.random() * 3;
  }

  function mount(u: Unit) {
    ridden.current = u;
    u.moving = false;
    mountState.mounted = true;
    mountState.lift = RIDER_LIFT;
    mountState.camUp = RIDER_LIFT + 0.8;
    mountState.camBack = HORSE_HEIGHT * 0.7;
    mountState.speedMult = RIDE_SPEED_MULT;
    pushAlert("On horseback. Tap DISMOUNT (or press H) to get off.", "info", 4);
  }

  function dismount() {
    const u = ridden.current;
    ridden.current = null;
    mountState.mounted = false;
    mountState.lift = 0;
    mountState.camUp = 0;
    mountState.camBack = 0;
    mountState.speedMult = 1;
    if (u) {
      u.x = playerState.pos.x + Math.cos(u.heading) * 4;
      u.z = playerState.pos.z - Math.sin(u.heading) * 4;
      u.hx = u.x;
      u.hz = u.z;
      u.timer = 3;
    }
  }

  function toggle() {
    if (ridden.current) {
      dismount();
      return;
    }
    if (pilotState.piloting || carPilot.driving) return;
    const n = nearestHorse();
    if (n && n.dist < MOUNT_RADIUS) mount(n.unit);
  }

  useEffect(() => {
    if (!HORSES_ENABLED) return;
    let cancelled = false;
    const made: Unit[] = [];

    // ---- On-screen controls: a Mount / Dismount button and a label that points to the nearest horse.
    // They live inside the game's own screen element so they are drawn above the game.
    const host = (document.querySelector(".game-viewport") as HTMLElement | null) ?? document.body;
    const button = document.createElement("button");
    Object.assign(button.style, {
      position: host === document.body ? "fixed" : "absolute",
      left: "50%",
      bottom: "88px",
      transform: "translateX(-50%)",
      zIndex: "200",
      padding: "14px 22px",
      borderRadius: "14px",
      border: "2px solid #d8ac52",
      background: "rgba(20,16,10,0.9)",
      color: "#f3e3b0",
      font: "700 15px/1 system-ui, sans-serif",
      letterSpacing: "0.08em",
      display: "none",
      touchAction: "manipulation",
    } as Partial<CSSStyleDeclaration>);
    const stop = (e: Event) => e.stopPropagation();
    button.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggle();
    });
    button.addEventListener("pointerup", stop);
    button.addEventListener("pointermove", stop);
    const label = document.createElement("div");
    Object.assign(label.style, {
      position: host === document.body ? "fixed" : "absolute",
      left: "50%",
      bottom: "150px",
      transform: "translateX(-50%)",
      zIndex: "200",
      padding: "8px 14px",
      borderRadius: "10px",
      background: "rgba(20,16,10,0.78)",
      color: "#f3e3b0",
      font: "700 14px/1.2 system-ui, sans-serif",
      pointerEvents: "none",
      display: "block",
      whiteSpace: "nowrap",
    } as Partial<CSSStyleDeclaration>);
    label.textContent = "Looking for horses...";
    host.appendChild(button);
    host.appendChild(label);
    ui.current = { button, label };
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "KeyH" && !e.repeat) toggle();
    };
    window.addEventListener("keydown", onKey);

    loadHorse().then((asset) => {
      if (cancelled || !asset || !root.current) return;
      const idleClip =
        asset.clips.find((c) => /idle|stand/i.test(c.name)) ?? asset.clips.find((c) => /graze|eat/i.test(c.name)) ?? null;
      const walkClip =
        asset.clips.find((c) => /walk/i.test(c.name)) ?? asset.clips.find((c) => /trot|run|gallop|canter/i.test(c.name)) ?? null;
      const runClip = asset.clips.find((c) => /gallop|run|canter/i.test(c.name) && c !== walkClip) ?? null;
      pushAlert(
        `Horses ready (${asset.clips.length} animations: ${asset.clips.slice(0, 6).map((c) => c.name).join(", ") || "none"})`,
        "info",
        10,
      );

      const scale = HORSE_HEIGHT / asset.height;
      const beamGeo = new THREE.CylinderGeometry(0.35, 0.35, BEAM_HEIGHT, 8, 1, true);
      beamGeo.translate(0, BEAM_HEIGHT / 2, 0);
      for (let i = 0; i < HORSE_COUNT; i++) {
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

        // A tall golden beam so the horse can be spotted from far away.
        const beam = new THREE.Mesh(
          beamGeo,
          new THREE.MeshBasicMaterial({
            color: "#ffd36a",
            transparent: true,
            opacity: 0.55,
            depthWrite: false,
            side: THREE.DoubleSide,
            fog: false,
            toneMapped: false,
          }),
        );
        beam.frustumCulled = false;
        root.current.add(beam);

        let mixer: THREE.AnimationMixer | null = null;
        let idle: THREE.AnimationAction | null = null;
        let walk: THREE.AnimationAction | null = null;
        let run: THREE.AnimationAction | null = null;
        if (idleClip || walkClip) {
          mixer = new THREE.AnimationMixer(model);
          if (idleClip) idle = mixer.clipAction(idleClip);
          if (walkClip) walk = mixer.clipAction(walkClip);
          if (runClip) run = mixer.clipAction(runClip);
          const first = idle ?? walk;
          first?.play();
          if (first) first.time = Math.random() * first.getClip().duration;
        }
        const unit: Unit = {
          outer,
          beam,
          mixer,
          idle,
          walk,
          run,
          cur: idle ?? walk,
          x: 0,
          z: 0,
          lx: 0,
          lz: 0,
          speed: 0,
          heading: Math.random() * Math.PI * 2,
          hx: 0,
          hz: 0,
          tx: 0,
          tz: 0,
          moving: false,
          timer: Math.random() * 5,
        };
        // Start on free ground close to the player, spread around them.
        const ang = (i / HORSE_COUNT) * Math.PI * 2 + Math.random() * 0.8;
        const rad = 16 + Math.random() * 26;
        const spot = findFreeSpot(playerState.pos.x + Math.cos(ang) * rad, playerState.pos.z + Math.sin(ang) * rad);
        unit.x = unit.lx = unit.hx = unit.tx = spot.x;
        unit.z = unit.lz = unit.hz = unit.tz = spot.z;
        made.push(unit);
      }
      units.current = made;
    });

    return () => {
      cancelled = true;
      if (ridden.current) dismount();
      window.removeEventListener("keydown", onKey);
      button.remove();
      label.remove();
      ui.current = null;
      for (const u of made) {
        u.mixer?.stopAllAction();
        u.outer.removeFromParent();
        u.beam.removeFromParent();
        (u.beam.material as THREE.Material).dispose();
      }
      units.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useFrame(({ camera }, dt) => {
    const step = Math.min(dt, 0.05);
    const mounted = ridden.current;

    for (const u of units.current) {
      const carried = u === mounted;
      const d = Math.hypot(u.x - camera.position.x, u.z - camera.position.z);

      // The beam shows from far away, but not on the horse you are riding.
      u.beam.visible = !carried && d < BEAM_DIST;
      if (u.beam.visible) u.beam.position.set(u.x, groundHeight(u.x, u.z), u.z);

      u.outer.visible = carried || d < SHOW_DIST;
      if (!carried && d >= SHOW_DIST) continue;

      let walking = false;
      if (carried) {
        // The horse goes wherever the player goes, facing the way the rider faces.
        u.x = playerState.pos.x;
        u.z = playerState.pos.z;
        u.heading = mountState.yaw;
        u.outer.position.set(u.x, playerState.y, u.z);
        u.outer.rotation.y = u.heading;
        const v = Math.hypot(u.x - u.lx, u.z - u.lz) / Math.max(step, 0.001);
        u.speed += ((v > 60 ? 0 : v) - u.speed) * Math.min(1, step * 8);
      } else {
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
        u.speed = walking ? WALK_SPEED : 0;
      }
      u.lx = u.x;
      u.lz = u.z;

      if (u.mixer && d < ANIM_DIST) {
        // Idle when still, walk when strolling, run (or a fast walk) when ridden hard.
        const fast = u.speed > 9;
        const moving = u.speed > 0.6;
        const next = !moving ? u.idle ?? u.walk : fast ? u.run ?? u.walk ?? u.idle : u.walk ?? u.idle;
        if (next && next !== u.cur) {
          next.reset().fadeIn(0.3).play();
          u.cur?.fadeOut(0.3);
          u.cur = next;
        }
        if (u.cur === u.walk && moving) {
          u.cur.timeScale = THREE.MathUtils.clamp(u.speed / WALK_ANIM_REF, 0.5, 2.5);
        } else if (u.cur === u.run && moving) {
          u.cur.timeScale = THREE.MathUtils.clamp(u.speed / RUN_ANIM_REF, 0.6, 2);
        } else if (u.cur) {
          u.cur.timeScale = 1;
        }
        u.mixer.update(step);
      }
    }

    // ---- Buttons and the "where are the horses" label (a few times a second) ----
    uiTimer.current -= step;
    const el = ui.current;
    if (!el || uiTimer.current > 0) return;
    uiTimer.current = 0.2;
    const busy = pilotState.piloting || carPilot.driving;
    if (mounted) {
      el.button.textContent = "DISMOUNT";
      el.button.style.display = "block";
      el.label.style.display = "none";
      return;
    }
    let n = busy ? null : nearestHorse();
    // Horses that were left far behind come back near the player, so there is always one to find.
    if (n && n.dist > COME_BACK_DIST) {
      bringNear(n.unit);
      n = nearestHorse();
    }
    if (!n) {
      el.button.style.display = "none";
      el.label.style.display = units.current.length === 0 && !busy ? "block" : "none";
      return;
    }
    if (n.dist < MOUNT_RADIUS) {
      el.button.textContent = "MOUNT HORSE";
      el.button.style.display = "block";
      el.label.style.display = "none";
    } else {
      el.button.style.display = "none";
      // Which way is it, relative to where the camera is looking?
      const f = tmpDir.current;
      camera.getWorldDirection(f);
      const tx = n.unit.x - playerState.pos.x;
      const tz = n.unit.z - playerState.pos.z;
      const ahead = f.x * tx + f.z * tz;
      const rightOf = -f.z * tx + f.x * tz;
      const ang = Math.atan2(rightOf, ahead);
      const arrow = ARROWS[(Math.round(ang / (Math.PI / 4)) + 8) % 8];
      el.label.textContent = `Nearest horse: ${Math.round(n.dist)} m ${arrow}  (follow the golden beam)`;
      el.label.style.display = "block";
    }
  });

  return <group ref={root} />;
}
