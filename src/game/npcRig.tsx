import { forwardRef, useEffect, useImperativeHandle, useRef, type RefObject } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { pushAlert } from "./alertState";
import { mountState } from "./mountState";
import type { CharacterRefs } from "./Character";

// A real, skinned human for NPCs and the player: a Quaternius modular outfit + head + hair on one
// shared skeleton, animated with the Universal Animation Library clips (idle / walk / run), crossfaded
// by how fast the character is actually moving. It is ON by default; add ?rignpc=0 to the game URL
// to switch it off. If anything fails to load or the skeleton does not match the animations, the old
// blocky character keeps being drawn and a message on screen says why.

const search = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;

export const RIG_ENABLED = search ? search.get("rignpc") !== "0" : false;

const MODEL_DIR = "/models/characters/";
const ANIM_DIR = "/models/animations/";
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

// ---- The component -----------------------------------------------------------------------
export type RigSyncOptions = {
  /** Raise the body above the ground (sitting on a horse). */
  lift?: number;
  /** Hold the idle pose whatever the speed (riding). */
  idle?: boolean;
};

export type RigHandle = {
  /** True once the real body is loaded and animating; the blocky one should then be hidden. */
  ready: () => boolean;
  /** Follow the blocky character's root (position, facing, visibility) and advance the animation. */
  sync: (root: THREE.Object3D, dt: number, hit: boolean, opt?: RigSyncOptions) => void;
};

type State = {
  built: Built;
  mixer: THREE.AnimationMixer;
  acts: Partial<Record<Act, THREE.AnimationAction>>;
  current: THREE.AnimationAction | null;
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
  const tune = useRef<RigTuning>(tuning ?? NPC_TUNING);
  tune.current = tuning ?? NPC_TUNING;

  useEffect(() => {
    let cancelled = false;
    let built: Built | null = null;
    let mixer: THREE.AnimationMixer | null = null;

    (async () => {
      try {
        const [b, clips] = await Promise.all([buildBody(npcId, color), loadClips()]);
        if (cancelled || !b) return;
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
        if (!acts.idle || !acts.walk) return;
        mixer = mx;
        acts.idle.play();
        group.current?.add(b.root);
        state.current = {
          built: b,
          mixer: mx,
          acts,
          current: acts.idle,
          speed: 0,
          lx: 0,
          lz: 0,
          hasLast: false,
          hit: false,
        };
        reportOk();
      } catch (e) {
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

/** Hides the blocky body's meshes, but not anything under `keep` (the weapon the player holds). */
function hideBlocky(node: THREE.Object3D, keep: Set<THREE.Object3D>) {
  for (const c of node.children) {
    if (keep.has(c)) continue;
    if ((c as THREE.Mesh).isMesh) c.visible = false;
    hideBlocky(c, keep);
  }
}

/**
 * Gives an existing blocky Character (the player) a real body. It follows the blocky character's
 * root every frame, so all the existing movement and aiming code keeps working unchanged. The held
 * weapon stays on the blocky right arm, which is hidden.
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
  const hidden = useRef(false);
  useFrame((_, dt) => {
    const r = target.current;
    const rg = rig.current;
    if (!r || !r.root || !rg) return;
    if (rg.ready() && !hidden.current) {
      hidden.current = true;
      if (r.body) {
        const keep = new Set<THREE.Object3D>();
        r.armR?.children.forEach((c) => {
          if (c.type === "Group") keep.add(c);
        });
        hideBlocky(r.body, keep);
      }
    }
    mountState.yaw = r.root.rotation.y;
    rg.sync(r.root, Math.min(dt, 0.05), false, mountState.mounted ? { lift: mountState.lift, idle: true } : undefined);
  });
  if (!RIG_ENABLED) return null;
  return <RiggedNpc ref={rig} npcId={npcId} color={color} tuning={tuning} />;
}
