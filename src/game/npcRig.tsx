import { forwardRef, useEffect, useImperativeHandle, useRef, type RefObject } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { pushAlert } from "./alertState";
import { input } from "./input";
import { mountState } from "./mountState";
import { weaponState, type WeaponId } from "./weaponState";
import type { CharacterRefs } from "./Character";

// A real, skinned human for NPCs and the player: a Quaternius modular outfit + head + hair on one
// shared skeleton, animated with the Universal Animation Library clips (idle / walk / run), crossfaded
// by how fast the character is actually moving. It is ON by default; add ?rignpc=0 to the game URL
// to switch it off.
//
// The old blocky character is hidden from the very first frame, so it never shows up before the real
// one. It only comes back if the real one fails to load or does not match the animations, and a
// message on screen says why.
//
// The player also carries the real medieval weapon models (see WEAPON_SPECS below), held in the
// right hand.

const search = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;

export const RIG_ENABLED = search ? search.get("rignpc") !== "0" : false;

const MODEL_DIR = "/models/characters/";
const ANIM_DIR = "/models/animations/";
const WEAPON_DIR = "/models/weapons/";
const ANIM_FILES = ["ual1-a", "ual1-b", "ual2-a", "ual2-b"];
// How big the real body is drawn. The world is built on a large scale (trees 13-24 m), so the
// characters are drawn bigger than life-size. Try ?rigscale=1.8 in the URL to compare sizes.
const RIG_SCALE = Number(search?.get("rigscale")) || 2.0;

let reported = false;
/** Logs the reason and shows it on screen, so it can be read on a phone without a console. */
function report(msg: string) {
  console.warn("[npcRig]", msg);
  if (reported) return;
  reported = true;
  pushAlert(`Character model: ${msg}`, "warn", 20);
}

let okShown = false;
function reportOk() {
  if (okShown) return;
  okShown = true;
  pushAlert("Real character models loaded", "info", 6);
}

/** How movement speed (metres per second) maps to idle / walk / run and the animation speed. */
export type RigTuning = {
  idleBelow: number;
  runAt: number;
  walkRef: number;
  runRef: number;
  maxScale: number;
  teleport: number;
};
const NPC_TUNING: RigTuning = { idleBelow: 0.35, runAt: 2.6, walkRef: 1.5, runRef: 4.2, maxScale: 1.5, teleport: 14 };
export const PLAYER_TUNING: RigTuning = { idleBelow: 0.5, runAt: 10, walkRef: 4.5, runRef: 9, maxScale: 2, teleport: 40 };

type Role = "cloth" | "skin" | "hair";
type Act = "idle" | "walk" | "run";

type Variant = { parts: { file: string; role: Role }[]; skin: string; hair: string };

const SKIN_LIGHT = "#e3b393";
const SKIN_DARK = "#8a5a3c";
const HAIRS = ["#2b1d14", "#5a3a1e", "#a8782e", "#1a1a1a", "#7a7a7a"];

const MALE_HAIR = ["hair-buzzed", "hair-simpleparted", "hair-beard"];
const FEMALE_HAIR = ["hair-long", "hair-buns", "hair-buzzedfemale"];

function variantFor(id: number): Variant {
  const h = (id * 2654435761) >>> 0;
  const female = (h & 1) === 1;
  const dark = ((h >>> 4) & 3) === 0;
  const sex = female ? "female" : "male";
  const hairList = female ? FEMALE_HAIR : MALE_HAIR;
  return {
    parts: [
      { file: `${sex}-ranger-outfit`, role: "cloth" },
      { file: `head-${sex}-${dark ? "dark" : "light"}`, role: "skin" },
      { file: hairList[(h >>> 8) % hairList.length], role: "hair" },
    ],
    skin: dark ? SKIN_DARK : SKIN_LIGHT,
    hair: HAIRS[(h >>> 12) % HAIRS.length],
  };
}

// ---- Loading (cached, shared by every character) -------------------------------------------
const gltfCache = new Map<string, Promise<GLTF>>();
function loadGltf(url: string): Promise<GLTF> {
  let p = gltfCache.get(url);
  if (!p) {
    p = new GLTFLoader().loadAsync(url);
    gltfCache.set(url, p);
  }
  return p;
}

type ClipSet = Partial<Record<Act, THREE.AnimationClip>>;
const PREFERRED: Record<Act, string[]> = {
  idle: ["idle_loop", "idle"],
  walk: ["walk_loop", "walk_fwd_loop", "walk"],
  run: ["jog_fwd_loop", "run_loop", "jog_loop", "sprint_loop", "run"],
};
const LOOSE: Record<Act, RegExp> = { idle: /idle/i, walk: /walk/i, run: /jog|run/i };

let clipPromise: Promise<ClipSet> | null = null;
function loadClips(): Promise<ClipSet> {
  if (clipPromise) return clipPromise;
  clipPromise = (async () => {
    const all: THREE.AnimationClip[] = [];
    const acts: Act[] = ["idle", "walk", "run"];
    const found: ClipSet = {};
    const pick = () => {
      for (const act of acts) {
        if (found[act]) continue;
        for (const want of PREFERRED[act]) {
          const c = all.find((x) => x.name.toLowerCase() === want);
          if (c) { found[act] = c; break; }
        }
      }
    };
    for (const f of ANIM_FILES) {
      try {
        const g = await loadGltf(`${ANIM_DIR}${f}.glb`);
        all.push(...g.animations);
      } catch (e) {
        console.warn("[npcRig] could not load animation file", f, e);
      }
      pick();
      if (found.idle && found.walk && found.run) break;
    }
    for (const act of acts) {
      if (!found[act]) {
        const c = all.find((x) => LOOSE[act].test(x.name));
        if (c) found[act] = c;
      }
    }
    console.info("[npcRig] animation clips available:", all.map((c) => c.name).join(", "));
    console.info("[npcRig] using:", Object.fromEntries(Object.entries(found).map(([k, v]) => [k, v?.name])));
    if (!found.idle || !found.walk) {
      report(`no idle/walk animation found (${all.length} clips: ${all.slice(0, 6).map((c) => c.name).join(", ")})`);
    }
    return found;
  })();
  return clipPromise;
}

function clipFits(clip: THREE.AnimationClip, bones: Set<string>) {
  let hit = 0;
  for (const t of clip.tracks) if (bones.has(t.name.split(".")[0])) hit++;
  return clip.tracks.length > 0 && hit / clip.tracks.length >= 0.8;
}

// ---- Building one body -------------------------------------------------------------------
type Tint = { mat: THREE.MeshStandardMaterial; base: THREE.Color };
type Built = { root: THREE.Object3D; tints: Tint[]; materials: THREE.Material[] };

/** Re-binds every skinned mesh of `part` onto the bones of `base`, so one skeleton drives them all. */
function attachPart(base: THREE.Object3D, bones: Map<string, THREE.Bone>, part: THREE.Object3D, role: Role): boolean {
  const meshes: THREE.SkinnedMesh[] = [];
  part.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh);
  });
  if (meshes.length === 0) return false;
  for (const m of meshes) {
    const mapped = m.skeleton.bones.map((b) => bones.get(b.name));
    if (mapped.some((b) => !b)) return false;
  }
  for (const m of meshes) {
    const mapped = m.skeleton.bones.map((b) => bones.get(b.name)) as THREE.Bone[];
    const skeleton = new THREE.Skeleton(mapped, m.skeleton.boneInverses);
    m.removeFromParent();
    m.userData.rigRole = role;
    base.add(m);
    m.bind(skeleton, m.bindMatrix);
  }
  return true;
}

function tintFor(role: Role, v: Variant, color: string): THREE.Color {
  if (role === "skin") return new THREE.Color(v.skin);
  if (role === "hair") return new THREE.Color(v.hair);
  // Clothes take the kingdom's colour, softened so they do not look like plastic.
  return new THREE.Color(color).lerp(new THREE.Color("#8a8070"), 0.35);
}

async function buildBody(npcId: number, color: string): Promise<Built | null> {
  const v = variantFor(npcId);
  const gltfs = await Promise.all(v.parts.map((p) => loadGltf(`${MODEL_DIR}${p.file}.glb`)));
  const root = cloneSkeleton(gltfs[0].scene);
  const bones = new Map<string, THREE.Bone>();
  root.traverse((o) => {
    if ((o as THREE.Bone).isBone) bones.set(o.name, o as THREE.Bone);
  });
  if (bones.size === 0) {
    report(`${v.parts[0].file} has no skeleton`);
    return null;
  }
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) o.userData.rigRole = "cloth";
  });
  for (let i = 1; i < v.parts.length; i++) {
    const ok = attachPart(root, bones, cloneSkeleton(gltfs[i].scene), v.parts[i].role);
    if (!ok) console.warn("[npcRig] part does not fit the skeleton, skipped:", v.parts[i].file);
  }

  const tints: Tint[] = [];
  const materials: THREE.Material[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.frustumCulled = false;
    const role = (m.userData.rigRole as Role | undefined) ?? "cloth";
    const list = Array.isArray(m.material) ? m.material : [m.material];
    const cloned = list.map((src) => {
      const mat = src.clone();
      materials.push(mat);
      const std = mat as THREE.MeshStandardMaterial;
      if (std.color) {
        // The model textures are flat grey placeholders for now: paint them. Real textures are kept.
        const img = std.map?.image as { width?: number } | undefined | null;
        const placeholder = !std.map || (img?.width ?? 99) <= 8;
        if (placeholder) {
          std.color.copy(tintFor(role, v, color));
          std.roughness = 0.9;
          std.metalness = 0;
        }
        if (role === "cloth") tints.push({ mat: std, base: std.color.clone() });
      }
      return mat;
    });
    m.material = Array.isArray(m.material) ? cloned : cloned[0];
  });
  return { root, tints, materials };
}

/** The right hand bone, by name (the names vary between rigs, so this is a best guess). */
function findHand(root: THREE.Object3D): THREE.Object3D | null {
  const exact = /^(hand[_.]?r|r[_.]?hand|righthand|hand[_.]?right|mixamorig:?righthand|mixamorighand[_.]?right)$/i;
  const loose = /hand/i;
  const side = /(right|[_.]r$|^r[_.]|[_.]r[_.]|r$)/i;
  const finger = /(thumb|index|middle|ring|pinky|finger|metacarpal)/i;
  let exactHit: THREE.Object3D | null = null;
  let looseHit: THREE.Object3D | null = null;
  root.traverse((o) => {
    if (!(o as THREE.Bone).isBone) return;
    if (!exactHit && exact.test(o.name)) exactHit = o;
    if (!looseHit && loose.test(o.name) && side.test(o.name) && !finger.test(o.name)) looseHit = o;
  });
  return exactHit ?? looseHit;
}

// ---- Real weapon models ------------------------------------------------------------------
// This game is medieval, so its weapons are shown as medieval weapons: the game's weapon slots keep
// their rules (damage, range, ammo) and just look like a crossbow, a bow, a lance, a sword.
// Weapons not listed here (the grenade and the tank cannon) keep their old look.
//   length: size in metres (before the character scale).
//   frontIsWide: the front end of the model is its wide end (a crossbow's limbs), not its thin tip.
//   up: the model is held standing up (a bow, a staff), not pointing forward.
//   pitch: tilts the tip upward, in radians.
//   swing: swings back and forth while firing (a sword).
//   flip: turns the model upside down about its length (if it came out the wrong way up).
type WeaponSpec = {
  file: string;
  length: number;
  frontIsWide?: boolean;
  up?: boolean;
  pitch?: number;
  swing?: boolean;
  flip?: boolean;
};
const WEAPON_SPECS: Partial<Record<WeaponId, WeaponSpec>> = {
  pistol: { file: "crossbow", length: 0.75, frontIsWide: true, flip: true },
  smg: { file: "wooden-bow", length: 1.1, up: true },
  rifle: { file: "staff", length: 1.7, up: true },
  shotgun: { file: "katana-sword", length: 1.0, pitch: 0.7, swing: true },
  sniper: { file: "wooden-bow", length: 1.45, up: true },
};

const failedWeapons = new Set<string>();
function weaponFailed(file: string, why: string) {
  console.warn("[npcRig] weapon", file, why);
  if (failedWeapons.has(file)) return;
  failedWeapons.add(file);
  pushAlert(`Weapon model ${file}: ${why}`, "warn", 15);
}

/**
 * Turns a weapon model of unknown orientation into one that points forward (+Z) (or stands up, for a
 * bow or staff), scaled to `length`, with its origin where a hand would hold it.
 * The long axis is the weapon's length; the thinner end is the tip (the wider end for a crossbow);
 * the heavier side is the underside.
 */
function buildWeapon(src: THREE.Object3D, spec: WeaponSpec): THREE.Object3D {
  const scene = src.clone(true);
  scene.updateMatrixWorld(true);

  const pts: THREE.Vector3[] = [];
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry.attributes.position) return;
    const pos = m.geometry.attributes.position;
    const stride = Math.max(1, Math.floor(pos.count / 4000));
    for (let i = 0; i < pos.count; i += stride) {
      pts.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld));
    }
  });
  if (pts.length === 0) return scene;

  const box = new THREE.Box3().setFromPoints(pts);
  const size = box.getSize(new THREE.Vector3());
  const axis = size.x >= size.y && size.x >= size.z ? 0 : size.y >= size.z ? 1 : 2;
  const other: [number, number] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
  const lo = box.min.getComponent(axis);
  const len = Math.max(size.getComponent(axis), 1e-6);

  // How big is the cross-section at each end of the long axis?
  const ends = [
    { min: [Infinity, Infinity], max: [-Infinity, -Infinity] },
    { min: [Infinity, Infinity], max: [-Infinity, -Infinity] },
  ];
  for (const p of pts) {
    const t = (p.getComponent(axis) - lo) / len;
    const e = t < 0.2 ? ends[0] : t > 0.8 ? ends[1] : null;
    if (!e) continue;
    for (let k = 0; k < 2; k++) {
      const v = p.getComponent(other[k]);
      e.min[k] = Math.min(e.min[k], v);
      e.max[k] = Math.max(e.max[k], v);
    }
  }
  const area = (e: (typeof ends)[number]) => Math.max(0, e.max[0] - e.min[0]) * Math.max(0, e.max[1] - e.min[1]);
  const highIsThinner = area(ends[1]) < area(ends[0]);
  const frontIsHigh = spec.up ? true : spec.frontIsWide ? !highIsThinner : highIsThinner;

  const dir = new THREE.Vector3();
  dir.setComponent(axis, frontIsHigh ? 1 : -1);
  const target = spec.up ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  let q = new THREE.Quaternion().setFromUnitVectors(dir, target);

  // Roll about the long axis so the heavier side (grip, stock) ends up underneath.
  if (!spec.up) {
    const centre = box.getCenter(new THREE.Vector3()).applyQuaternion(q);
    const mean = new THREE.Vector3();
    for (const p of pts) mean.add(p.clone().applyQuaternion(q));
    mean.divideScalar(pts.length).sub(centre);
    if (Math.hypot(mean.x, mean.y) > len * 0.005) {
      const roll = -Math.PI / 2 - Math.atan2(mean.y, mean.x);
      q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll).multiply(q);
    }
    if (spec.flip) {
      q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI).multiply(q);
    }
  }

  const rotated = new THREE.Box3();
  for (const p of pts) rotated.expandByPoint(p.clone().applyQuaternion(q));
  const rsize = rotated.getSize(new THREE.Vector3());
  const rc = rotated.getCenter(new THREE.Vector3());
  const along = spec.up ? rsize.y : rsize.z;

  const turned = new THREE.Group();
  turned.quaternion.copy(q);
  turned.add(scene);
  // The hand holds it a little behind the middle (or at the middle, for a bow or staff).
  const grip = spec.up ? rc : new THREE.Vector3(rc.x, rc.y, rotated.min.z + 0.3 * rsize.z);
  turned.position.set(-grip.x, -grip.y, -grip.z);
  const holder = new THREE.Group();
  holder.add(turned);
  holder.scale.setScalar(spec.length / Math.max(along, 1e-6));
  const outer = new THREE.Group();
  outer.add(holder);
  return outer;
}

// ---- The component -----------------------------------------------------------------------
export type RigSyncOptions = {
  /** Raise the body above the ground (sitting on a horse). */
  lift?: number;
  /** Hold the idle pose whatever the speed (riding). */
  idle?: boolean;
};

export type RigHandle = {
  /** True once the real body is loaded and animating. */
  ready: () => boolean;
  /** True if the real body could not be used, so the old blocky one should be shown instead. */
  failed: () => boolean;
  /** Follow the blocky character's root (position, facing, visibility) and advance the animation. */
  sync: (root: THREE.Object3D, dt: number, hit: boolean, opt?: RigSyncOptions) => void;
  /** World position of the right hand, if the hand bone can be found. */
  hand: (out: THREE.Vector3) => boolean;
};

type State = {
  built: Built;
  mixer: THREE.AnimationMixer;
  acts: Partial<Record<Act, THREE.AnimationAction>>;
  current: THREE.AnimationAction | null;
  hand: THREE.Object3D | null | undefined;
  speed: number;
  lx: number;
  lz: number;
  hasLast: boolean;
  hit: boolean;
};

const FLASH = new THREE.Color("#ff3b3b");

export const RiggedNpc = forwardRef<RigHandle, { npcId: number; color: string; tuning?: RigTuning }>(function RiggedNpc(
  { npcId, color, tuning },
  ref,
) {
  const group = useRef<THREE.Group>(null);
  const state = useRef<State | null>(null);
  const failed = useRef(false);
  const tune = useRef<RigTuning>(tuning ?? NPC_TUNING);
  tune.current = tuning ?? NPC_TUNING;

  useEffect(() => {
    let cancelled = false;
    let built: Built | null = null;
    let mixer: THREE.AnimationMixer | null = null;
    failed.current = false;

    (async () => {
      try {
        const [b, clips] = await Promise.all([buildBody(npcId, color), loadClips()]);
        if (cancelled) return;
        if (!b) {
          failed.current = true;
          return;
        }
        built = b;
        const names = new Set<string>();
        b.root.traverse((o) => {
          if ((o as THREE.Bone).isBone) names.add(o.name);
        });
        const acts: Partial<Record<Act, THREE.AnimationAction>> = {};
        const mx = new THREE.AnimationMixer(b.root);
        for (const act of ["idle", "walk", "run"] as const) {
          const clip = clips[act];
          if (!clip) continue;
          if (clipFits(clip, names)) acts[act] = mx.clipAction(clip);
          else {
            report(
              `animation "${clip.name}" does not match the skeleton (track ${clip.tracks[0]?.name ?? "?"} vs bone ${[...names][1] ?? "?"})`,
            );
          }
        }
        if (!acts.idle || !acts.walk) {
          failed.current = true;
          return;
        }
        mixer = mx;
        acts.idle.play();
        group.current?.add(b.root);
        state.current = {
          built: b,
          mixer: mx,
          acts,
          current: acts.idle,
          hand: undefined,
          speed: 0,
          lx: 0,
          lz: 0,
          hasLast: false,
          hit: false,
        };
        reportOk();
      } catch (e) {
        failed.current = true;
        report(`could not build a character body (${e instanceof Error ? e.message : String(e)})`);
      }
    })();

    return () => {
      cancelled = true;
      state.current = null;
      if (mixer) mixer.stopAllAction();
      if (built) {
        built.root.removeFromParent();
        built.materials.forEach((m) => m.dispose());
      }
    };
  }, [npcId, color]);

  useImperativeHandle(
    ref,
    () => ({
      ready: () => state.current !== null,
      failed: () => failed.current,
      hand: (out) => {
        const s = state.current;
        const g = group.current;
        if (!s || !g) return false;
        if (s.hand === undefined) {
          s.hand = findHand(s.built.root);
          if (!s.hand) console.warn("[npcRig] could not find the right hand bone");
        }
        if (!s.hand) return false;
        g.updateMatrixWorld(true);
        s.hand.getWorldPosition(out);
        return true;
      },
      sync: (root, dt, hit, opt) => {
        const g = group.current;
        const s = state.current;
        if (!g) return;
        if (!s) {
          g.visible = false;
          return;
        }
        g.visible = root.visible;
        if (!root.visible) {
          s.hasLast = false;
          return;
        }
        g.position.copy(root.position);
        if (opt?.lift) g.position.y += opt.lift;
        g.rotation.y = root.rotation.y;
        const t = tune.current;

        // How fast is it really moving? That picks idle / walk / run.
        const step = Math.max(dt, 0.001);
        if (s.hasLast) {
          let v = Math.hypot(root.position.x - s.lx, root.position.z - s.lz) / step;
          if (v > t.teleport) v = 0; // a jump (respawn, level-of-detail switch), not real movement
          s.speed += (v - s.speed) * Math.min(1, step * 8);
        }
        s.lx = root.position.x;
        s.lz = root.position.z;
        s.hasLast = true;

        const next: Act = opt?.idle ? "idle" : s.speed < t.idleBelow ? "idle" : s.speed < t.runAt ? "walk" : "run";
        const target = s.acts[next] ?? s.acts.walk ?? s.acts.idle;
        if (target && target !== s.current) {
          target.reset().fadeIn(0.2).play();
          s.current?.fadeOut(0.2);
          s.current = target;
        }
        if (s.current) {
          s.current.timeScale = opt?.idle
            ? 1
            : next === "walk"
              ? Math.min(t.maxScale, Math.max(0.6, s.speed / t.walkRef))
              : next === "run"
                ? Math.min(t.maxScale, Math.max(0.7, s.speed / t.runRef))
                : 1;
        }
        s.mixer.update(dt);

        if (hit !== s.hit) {
          s.hit = hit;
          for (const tint of s.built.tints) tint.mat.color.copy(hit ? FLASH : tint.base);
        }
      },
    }),
    [],
  );

  return <group ref={group} visible={false} scale={RIG_SCALE} />;
});

/** Hides the blocky body's meshes (remembering which), but not anything under `keep` (the held weapon). */
function hideBlocky(node: THREE.Object3D, keep: Set<THREE.Object3D>, hidden: THREE.Object3D[]) {
  for (const c of node.children) {
    if (keep.has(c)) continue;
    if ((c as THREE.Mesh).isMesh && c.visible) {
      c.visible = false;
      hidden.push(c);
    }
    hideBlocky(c, keep, hidden);
  }
}

/**
 * Gives an existing blocky Character (the player) a real body. It follows the blocky character's
 * root every frame, so all the existing movement and aiming code keeps working unchanged. The blocky
 * body is hidden at once, and only comes back if the real one cannot be used. The player also holds
 * the real medieval weapon for the current weapon slot in the right hand.
 */
export function RigFollow({
  target,
  npcId,
  color,
  tuning,
}: {
  target: RefObject<CharacterRefs>;
  npcId: number;
  color: string;
  tuning?: RigTuning;
}) {
  const rig = useRef<RigHandle>(null);
  const phase = useRef<"start" | "hidden" | "failed">("start");
  const hiddenMeshes = useRef<THREE.Object3D[]>([]);
  const oldWeapon = useRef<THREE.Object3D[]>([]);
  const weaponHolder = useRef<THREE.Group>(null);
  const weapons = useRef(new Map<WeaponId, THREE.Object3D | "loading" | "failed">());
  const oldShown = useRef(true);
  const handPos = useRef(new THREE.Vector3());

  useFrame((_, dt) => {
    const r = target.current;
    const rg = rig.current;
    if (!r || !r.root || !rg) return;
    if (phase.current === "start") {
      phase.current = "hidden";
      if (r.body) {
        const keep = new Set<THREE.Object3D>();
        r.armR?.children.forEach((c) => {
          if (c.type === "Group") keep.add(c);
        });
        oldWeapon.current = [...keep];
        hideBlocky(r.body, keep, hiddenMeshes.current);
      }
    }
    if (phase.current === "hidden" && rg.failed()) {
      // The real body could not be used: bring the blocky one back.
      phase.current = "failed";
      for (const m of hiddenMeshes.current) m.visible = true;
      hiddenMeshes.current = [];
      for (const o of oldWeapon.current) o.visible = true;
      if (weaponHolder.current) weaponHolder.current.visible = false;
    }
    if (phase.current === "failed") return;
    mountState.yaw = r.root.rotation.y;
    rg.sync(r.root, Math.min(dt, 0.05), false, mountState.mounted ? { lift: mountState.lift, idle: true } : undefined);

    // ---- The real weapon model ----
    const holder = weaponHolder.current;
    if (!holder) return;
    const id = weaponState.current;
    const spec = WEAPON_SPECS[id];
    let active: THREE.Object3D | null = null;
    if (rg.ready() && spec) {
      const entry = weapons.current.get(id);
      if (entry === undefined) {
        weapons.current.set(id, "loading");
        loadGltf(`${WEAPON_DIR}${spec.file}.glb`)
          .then((g) => {
            try {
              const obj = buildWeapon(g.scene, spec);
              obj.visible = false;
              holder.add(obj);
              weapons.current.set(id, obj);
            } catch (e) {
              weapons.current.set(id, "failed");
              weaponFailed(spec.file, e instanceof Error ? e.message : String(e));
            }
          })
          .catch((e) => {
            weapons.current.set(id, "failed");
            weaponFailed(spec.file, e instanceof Error ? e.message : String(e));
          });
      } else if (typeof entry !== "string") {
        active = entry;
      }
    }
    weapons.current.forEach((e) => {
      if (typeof e !== "string") e.visible = e === active;
    });
    holder.visible = active !== null && r.root.visible;
    // The old procedural weapon only shows while there is no real model to replace it.
    const showOld = active === null;
    if (showOld !== oldShown.current) {
      oldShown.current = showOld;
      for (const o of oldWeapon.current) o.visible = showOld;
    }
    if (active && spec) {
      const yaw = r.root.rotation.y;
      const aiming = input.aim || input.fire;
      const lift = mountState.mounted ? mountState.lift : 0;
      const S = RIG_SCALE;
      // Held in the right hand when the hand bone is found; otherwise carried at the right hip.
      if (rg.hand(handPos.current)) {
        holder.position.copy(handPos.current);
      } else {
        holder.position.set(
          r.root.position.x + (-Math.cos(yaw) * 0.3 + Math.sin(yaw) * 0.35) * S,
          r.root.position.y + lift + 1.08 * S,
          r.root.position.z + (Math.sin(yaw) * 0.3 + Math.cos(yaw) * 0.35) * S,
        );
      }
      if (aiming) {
        // Raise it and bring it forward so it is ready to use.
        holder.position.x += Math.sin(yaw) * 0.3 * S;
        holder.position.z += Math.cos(yaw) * 0.3 * S;
        holder.position.y += 0.2 * S;
      }
      const swing = spec.swing && input.fire ? Math.sin(performance.now() * 0.018) * 0.9 : 0;
      holder.rotation.order = "YXZ";
      holder.rotation.set(-((spec.pitch ?? 0) + (aiming && !spec.swing ? 0.1 : 0) + swing), yaw, 0);
      holder.scale.setScalar(S);
    }
  });
  if (!RIG_ENABLED) return null;
  return (
    <>
      <RiggedNpc ref={rig} npcId={npcId} color={color} tuning={tuning} />
      <group ref={weaponHolder} visible={false} />
    </>
  );
}
