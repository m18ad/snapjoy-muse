import { useFrame } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { pushAlert } from "./alertState";
import { healPlayer, playerState } from "./playerState";
import { groundHeight } from "./terrain";

// THE HAVEN: a quiet clearing by a fire, a few steps from where you start. It is a place to rest, not
// to fight. Sit by the fire and say how you are feeling; you get a kind word back. You can write a few
// words about what you are carrying and light a lantern that keeps burning over the clearing, and you
// can read the lanterns other people have left. Resting here slowly heals you.
//
// For now your own lanterns are kept on this device only (they are still there next time you play).
// Lanterns shared between players need an online store, which can be added later.

const HAVEN_X = 64;
const HAVEN_Z = -80;
const NEAR = 13; // the "sit by the fire" button appears within this distance
const SAFE = 17; // resting heals you within this distance
const STORAGE_KEY = "forgotten.haven.lanterns.v1";
const MAX_OWN = 40;

// Words left in the Haven for everyone, so there is always something to read.
const KIND_WORDS: string[] = [
  "It is okay to not be okay today. Tomorrow does not need you to have it figured out.",
  "Pain is proof that you cared. That part of you is not broken.",
  "You have survived every hard day so far. That is a record worth respecting.",
  "Anger is often hurt wearing armor. You can put it down here.",
  "Shame lies. It says you are what happened to you. You are not.",
  "You do not have to heal on anyone else's schedule.",
  "Resting is not giving up.",
  "Someone you have not met yet is glad that you exist.",
  "The road bends. It does not end.",
  "Lighting a lantern in the dark is a small act of hope. You can do one today.",
  "You lost something that mattered. Of course it hurts. That is not weakness.",
  "Slow is still moving.",
];

const FEELINGS: { name: string; reply: string }[] = [
  { name: "Sad", reply: "Sadness is love with nowhere to go. Let it sit by the fire with you for a while. You do not have to be strong right now." },
  { name: "Angry", reply: "Anger is often hurt wearing armor. You can set the armor down here. Nobody is watching." },
  { name: "Ashamed", reply: "Shame says you are what happened to you. That is a lie it tells. You still have a place by this fire." },
  { name: "Anxious", reply: "Breathe in slowly, and out. The fire is steady. You only have to get through this minute." },
  { name: "Lonely", reply: "You are not the only one here. Every lantern around you was lit by someone who felt this too." },
  { name: "Numb", reply: "Feeling nothing is also a way of surviving. You do not have to force anything. Just sit and get warm." },
  { name: "Okay", reply: "Good. Then sit anyway. Joy deserves a place by the fire too." },
];

type Saved = { text: string; t: number };

function loadSaved(): Saved[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as Saved[];
    return Array.isArray(list) ? list.filter((s) => typeof s.text === "string").slice(-MAX_OWN) : [];
  } catch {
    return [];
  }
}

function saveAll(list: Saved[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(-MAX_OWN)));
  } catch {
    /* storage can be unavailable (private mode); the lantern still shows this session */
  }
}

function mk<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  css: Partial<CSSStyleDeclaration>,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e.style, css);
  if (text !== undefined) e.textContent = text;
  return e;
}

type Lantern = { group: THREE.Group; base: THREE.Vector3; phase: number };

const STONE = "#6b665c";
const WOOD = "#4a3321";

export function Haven() {
  const root = useRef<THREE.Group>(null);
  const lanternRoot = useRef<THREE.Group>(null);
  const flames = useRef<(THREE.Mesh | null)[]>([]);
  const fireLight = useRef<THREE.PointLight>(null);
  const lanterns = useRef<Lantern[]>([]);
  const ui = useRef<{ button: HTMLButtonElement } | null>(null);
  const uiTimer = useRef(0);
  const welcomed = useRef(false);
  const addLantern = useRef<(own: boolean) => void>(() => {});
  const y0 = useRef(0);

  useEffect(() => {
    y0.current = groundHeight(HAVEN_X, HAVEN_Z);
    const host = (document.querySelector(".game-viewport") as HTMLElement | null) ?? document.body;
    const fixed = host === document.body ? "fixed" : "absolute";

    // ---- Floating lanterns over the clearing ----
    const lamp = (own: boolean) => {
      const parent = lanternRoot.current;
      if (!parent) return;
      const g = new THREE.Group();
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(0.28, 10, 8),
        new THREE.MeshBasicMaterial({ color: own ? "#ffd27a" : "#c9a768", toneMapped: false, fog: false }),
      );
      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(0.9, 10, 8),
        new THREE.MeshBasicMaterial({
          color: "#ffb050",
          transparent: true,
          opacity: own ? 0.35 : 0.14,
          depthWrite: false,
          toneMapped: false,
          fog: false,
        }),
      );
      g.add(core, halo);
      const ang = Math.random() * Math.PI * 2;
      const rad = 6 + Math.random() * 6;
      const base = new THREE.Vector3(
        HAVEN_X + Math.cos(ang) * rad,
        y0.current + 3 + Math.random() * 3.5,
        HAVEN_Z + Math.sin(ang) * rad,
      );
      g.position.copy(base);
      parent.add(g);
      lanterns.current.push({ group: g, base, phase: Math.random() * 6.28 });
    };
    addLantern.current = lamp;
    for (let i = 0; i < 10; i++) lamp(false);
    for (let i = 0; i < loadSaved().length; i++) lamp(true);

    // ---- The panel ----
    const button = mk("button", {
      position: fixed,
      left: "50%",
      bottom: "205px",
      transform: "translateX(-50%)",
      zIndex: "200",
      padding: "14px 22px",
      borderRadius: "14px",
      border: "2px solid #ffb050",
      background: "rgba(40,22,10,0.92)",
      color: "#ffe2b0",
      font: "700 15px/1 system-ui, sans-serif",
      letterSpacing: "0.08em",
      display: "none",
      touchAction: "manipulation",
    }, "SIT BY THE FIRE");

    const panel = mk("div", {
      position: fixed,
      left: "50%",
      top: "50%",
      transform: "translate(-50%, -50%)",
      zIndex: "240",
      width: "min(440px, 88%)",
      maxHeight: "86%",
      overflowY: "auto",
      padding: "18px 18px 14px",
      borderRadius: "16px",
      border: "2px solid #ffb050",
      background: "rgba(26,16,8,0.95)",
      color: "#ffe9c8",
      font: "500 15px/1.45 system-ui, sans-serif",
      display: "none",
      boxSizing: "border-box",
    });
    // Touches and keys inside the panel must not move the character or fire the weapon.
    for (const ev of ["pointerdown", "pointerup", "pointermove", "touchstart", "touchmove", "touchend", "click", "keydown", "keyup"]) {
      panel.addEventListener(ev, (e) => e.stopPropagation());
    }
    button.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      checkIn();
    });
    host.appendChild(button);
    host.appendChild(panel);
    ui.current = { button };

    const btn = (label: string, onClick: () => void, primary = false) => {
      const b = mk("button", {
        padding: "10px 14px",
        margin: "6px 6px 0 0",
        borderRadius: "10px",
        border: primary ? "2px solid #ffb050" : "1px solid #8a6a40",
        background: primary ? "#5a3414" : "rgba(255,255,255,0.06)",
        color: "#ffe9c8",
        font: "600 14px/1 system-ui, sans-serif",
        touchAction: "manipulation",
      }, label);
      b.addEventListener("click", onClick);
      return b;
    };
    const para = (text: string, css: Partial<CSSStyleDeclaration> = {}) => mk("p", { margin: "10px 0", ...css }, text);
    const footer = () =>
      para(
        "If things feel too heavy, or you feel unsafe, please reach out to someone you trust. You can find a helpline in your country at findahelpline.com.",
        { fontSize: "12px", opacity: "0.7", marginTop: "14px" },
      );
    const open = (...nodes: HTMLElement[]) => {
      panel.replaceChildren(
        mk("div", { font: "700 18px/1.2 system-ui, sans-serif", color: "#ffcb7a", letterSpacing: "0.05em" }, "The Haven"),
        ...nodes,
        footer(),
      );
      panel.style.display = "block";
    };
    const close = () => {
      panel.style.display = "none";
    };

    const read = () => {
      const own = loadSaved();
      const pool = [...KIND_WORDS, ...own.map((o) => o.text)];
      const pick = pool[Math.floor(Math.random() * pool.length)];
      open(
        para("A lantern says:", { opacity: "0.8", marginBottom: "2px" }),
        para(`"${pick}"`, { fontSize: "17px", fontStyle: "italic", marginTop: "4px" }),
        btn("Read another", read, true),
        btn("Back", checkIn),
        btn("Close", close),
      );
    };

    const write = () => {
      const area = mk("textarea", {
        width: "100%",
        height: "84px",
        marginTop: "8px",
        padding: "10px",
        borderRadius: "10px",
        border: "1px solid #8a6a40",
        background: "rgba(0,0,0,0.35)",
        color: "#ffe9c8",
        font: "500 15px/1.4 system-ui, sans-serif",
        boxSizing: "border-box",
        resize: "none",
      });
      area.maxLength = 140;
      area.placeholder = "What are you carrying? A few words are enough.";
      open(
        para("Write what you are carrying. It will be lit as a lantern over the clearing, and it stays on this device."),
        area,
        btn(
          "Light my lantern",
          () => {
            const text = area.value.trim();
            if (!text) return;
            const list = loadSaved();
            list.push({ text, t: Date.now() });
            saveAll(list);
            addLantern.current(true);
            pushAlert("Your lantern is lit.", "info", 4);
            open(
              para("Your lantern is lit, and it will keep burning here."),
              para("Life moves on, and so will you. You do not have to carry all of it tonight.", { fontStyle: "italic" }),
              btn("Read a lantern", read, true),
              btn("Close", close),
            );
          },
          true,
        ),
        btn("Back", checkIn),
      );
    };

    const feeling = (f: { name: string; reply: string }) => {
      open(
        para(f.reply, { fontSize: "16px" }),
        btn("Write it down and light a lantern", write, true),
        btn("Read a lantern", read),
        btn("Back", checkIn),
        btn("Close", close),
      );
    };

    function checkIn() {
      const chips = FEELINGS.map((f) => btn(f.name, () => feeling(f)));
      open(
        para("You are safe here. Nothing can hurt you by this fire. Take as long as you need."),
        para("How are you feeling?", { fontWeight: "700", marginBottom: "2px" }),
        mk("div", {}, undefined),
        ...chips,
        btn("Just sit for a while", close),
      );
    }
    // The helpers above are used by the button handler, so keep them reachable.
    (panel as HTMLElement & { _checkIn?: () => void })._checkIn = checkIn;

    return () => {
      button.remove();
      panel.remove();
      ui.current = null;
      for (const l of lanterns.current) l.group.removeFromParent();
      lanterns.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useFrame(({ clock }, dt) => {
    const t = clock.elapsedTime;
    // The fire flickers.
    for (let i = 0; i < flames.current.length; i++) {
      const m = flames.current[i];
      if (!m) continue;
      const f = 1 + 0.12 * Math.sin(t * (7 + i * 3) + i) + 0.08 * Math.sin(t * (13 + i * 5));
      m.scale.set(1 + (f - 1) * 0.6, f, 1 + (f - 1) * 0.6);
    }
    if (fireLight.current) fireLight.current.intensity = 250 + 45 * Math.sin(t * 9) + 25 * Math.sin(t * 17);
    // The lanterns drift up and down.
    for (const l of lanterns.current) {
      l.group.position.set(
        l.base.x + Math.sin(t * 0.3 + l.phase) * 0.5,
        l.base.y + Math.sin(t * 0.8 + l.phase) * 0.35,
        l.base.z + Math.cos(t * 0.27 + l.phase) * 0.5,
      );
    }

    const d = Math.hypot(playerState.pos.x - HAVEN_X, playerState.pos.z - HAVEN_Z);
    // Resting by the fire slowly heals.
    if (d < SAFE) healPlayer(12 * Math.min(dt, 0.05));
    if (d < NEAR && !welcomed.current) {
      welcomed.current = true;
      pushAlert("The Haven. You are safe here. Rest by the fire.", "info", 5);
    }

    uiTimer.current -= dt;
    if (uiTimer.current > 0) return;
    uiTimer.current = 0.25;
    const el = ui.current;
    if (el) el.button.style.display = d < NEAR ? "block" : "none";
  });

  const y = groundHeight(HAVEN_X, HAVEN_Z);
  const stones = Array.from({ length: 12 }, (_, i) => {
    const a = (i / 12) * Math.PI * 2;
    return { x: Math.cos(a) * 2.3, z: Math.sin(a) * 2.3, s: 0.5 + ((i * 37) % 10) / 30 };
  });
  const benches = [0, 1, 2, 3].map((i) => {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    return { x: Math.cos(a) * 5.4, z: Math.sin(a) * 5.4, rot: -a + Math.PI / 2 };
  });
  const posts = [0, 1, 2, 3].map((i) => {
    const a = (i / 4) * Math.PI * 2;
    return { x: Math.cos(a) * 9, z: Math.sin(a) * 9 };
  });

  return (
    <group ref={root}>
      <group position={[HAVEN_X, y, HAVEN_Z]}>
        {/* A worn, trodden circle of earth round the fire. */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.06, 0]} receiveShadow>
          <circleGeometry args={[8, 32]} />
          <meshStandardMaterial color="#8a7a62" roughness={1} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} />
        </mesh>
        {stones.map((s, i) => (
          <mesh key={i} position={[s.x, 0.3, s.z]} scale={s.s} castShadow receiveShadow>
            <icosahedronGeometry args={[1, 0]} />
            <meshStandardMaterial color={STONE} roughness={1} flatShading />
          </mesh>
        ))}
        {/* Logs */}
        {[0, 1, 2].map((i) => (
          <mesh key={i} position={[0, 0.35, 0]} rotation={[Math.PI / 2 - 0.25, (i / 3) * Math.PI, 0]} castShadow>
            <cylinderGeometry args={[0.22, 0.22, 2.4, 8]} />
            <meshStandardMaterial color={WOOD} roughness={1} />
          </mesh>
        ))}
        {/* Flames */}
        {[
          { r: 0.9, h: 2.4, c: "#ff7a1a", o: 0.85 },
          { r: 0.6, h: 1.8, c: "#ffb62e", o: 0.9 },
          { r: 0.35, h: 1.2, c: "#fff1a8", o: 0.95 },
        ].map((f, i) => (
          <mesh
            key={i}
            ref={(m) => { flames.current[i] = m; }}
            position={[0, 0.5 + f.h / 2, 0]}
          >
            <coneGeometry args={[f.r, f.h, 8]} />
            <meshBasicMaterial color={f.c} transparent opacity={f.o} depthWrite={false} toneMapped={false} fog={false} />
          </mesh>
        ))}
        <pointLight ref={fireLight} color="#ff9a40" intensity={250} distance={34} decay={1.5} position={[0, 1.8, 0]} />
        {/* Log benches round the fire */}
        {benches.map((b, i) => (
          <group key={i} position={[b.x, 0, b.z]} rotation={[0, b.rot, 0]}>
            <mesh position={[0, 0.55, 0]} castShadow receiveShadow>
              <boxGeometry args={[3.4, 0.5, 1.0]} />
              <meshStandardMaterial color={WOOD} roughness={1} />
            </mesh>
            <mesh position={[-1.3, 0.25, 0]} castShadow>
              <boxGeometry args={[0.5, 0.5, 0.9]} />
              <meshStandardMaterial color={WOOD} roughness={1} />
            </mesh>
            <mesh position={[1.3, 0.25, 0]} castShadow>
              <boxGeometry args={[0.5, 0.5, 0.9]} />
              <meshStandardMaterial color={WOOD} roughness={1} />
            </mesh>
          </group>
        ))}
        {/* Lantern posts at the edge of the clearing, always lit */}
        {posts.map((p, i) => (
          <group key={i} position={[p.x, 0, p.z]}>
            <mesh position={[0, 2.6, 0]} castShadow>
              <cylinderGeometry args={[0.14, 0.18, 5.2, 8]} />
              <meshStandardMaterial color={WOOD} roughness={1} />
            </mesh>
            <mesh position={[0, 5.4, 0]}>
              <sphereGeometry args={[0.34, 10, 8]} />
              <meshBasicMaterial color="#ffd27a" toneMapped={false} fog={false} />
            </mesh>
            <mesh position={[0, 5.4, 0]}>
              <sphereGeometry args={[1.0, 10, 8]} />
              <meshBasicMaterial color="#ffb050" transparent opacity={0.22} depthWrite={false} toneMapped={false} fog={false} />
            </mesh>
          </group>
        ))}
      </group>
      {/* The lanterns floating over the clearing (added from code) */}
      <group ref={lanternRoot} />
    </group>
  );
}
