import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { pushAlert } from "./alertState";
import { playerState } from "./playerState";
import { teleportState } from "./teleportState";
import { TUNNELS } from "./terrain";

// Tunnel doors cut into the mountains where the dead-end trails stop (see terrain.ts). Each door is a
// stone arch with a dark opening. Lanterns on the arch light up on their own when you come near, and
// go dark again when you leave. Walk into the opening and the screen fades: you come out of the
// paired tunnel on the other side of the world.

const LIGHT_RANGE = 30; // lanterns turn on within this distance (metres)
const DOOR_HALF_WIDTH = 3.3;
const COOLDOWN_MS = 2600;

const STONE = "#6c685e";
const DARK_STONE = "#4e4a44";
const LAMP_OFF = new THREE.Color("#3a2c1c");
const LAMP_ON = new THREE.Color("#ffc060");

type Local = { into: number; side: number };
function local(t: (typeof TUNNELS)[number], x: number, z: number): Local {
  const dx = x - t.x;
  const dz = z - t.z;
  return { into: -(dx * t.ox + dz * t.oz), side: dz * t.ox - dx * t.oz };
}

export function Tunnels() {
  const lamps = useRef<THREE.MeshBasicMaterial[][]>([]);
  const halos = useRef<THREE.MeshBasicMaterial[][]>([]);
  const lit = useRef<number[]>(TUNNELS.map(() => 0));
  const light = useRef<THREE.PointLight>(null);
  const overlay = useRef<HTMLDivElement | null>(null);
  const busy = useRef(false);
  const cooldownUntil = useRef(0);

  // A full-screen black layer used to fade out and back in while you pass through a tunnel.
  useEffect(() => {
    if (TUNNELS.length === 0) return;
    const host = (document.querySelector(".game-viewport") as HTMLElement | null) ?? document.body;
    const el = document.createElement("div");
    Object.assign(el.style, {
      position: host === document.body ? "fixed" : "absolute",
      inset: "0",
      background: "#000",
      opacity: "0",
      transition: "opacity 0.35s ease",
      pointerEvents: "none",
      zIndex: "180",
    } as Partial<CSSStyleDeclaration>);
    host.appendChild(el);
    overlay.current = el;
    return () => {
      el.remove();
      overlay.current = null;
    };
  }, []);

  const yaws = useMemo(() => TUNNELS.map((t) => Math.atan2(-t.ox, -t.oz)), []);

  function enter(i: number) {
    const from = TUNNELS[i];
    const to = TUNNELS[from.pair];
    if (!to) return;
    busy.current = true;
    if (overlay.current) overlay.current.style.opacity = "1";
    setTimeout(() => {
      // Come out in front of the other door, facing away from the mountain.
      teleportState.pending = {
        x: to.x + to.ox * 11,
        z: to.z + to.oz * 11,
        yaw: Math.atan2(-to.ox, -to.oz),
      };
      pushAlert("You pass through the tunnel...", "info", 3);
      setTimeout(() => {
        if (overlay.current) overlay.current.style.opacity = "0";
        busy.current = false;
        cooldownUntil.current = performance.now() + COOLDOWN_MS;
      }, 300);
    }, 400);
  }

  useFrame((_, dt) => {
    if (TUNNELS.length === 0) return;
    const px = playerState.pos.x;
    const pz = playerState.pos.z;
    let nearest = -1;
    let nearestLit = 0;

    for (let i = 0; i < TUNNELS.length; i++) {
      const t = TUNNELS[i];
      const d = Math.hypot(px - t.x, pz - t.z);
      // The lanterns light up when somebody comes near, and fade out when they leave.
      lit.current[i] += ((d < LIGHT_RANGE ? 1 : 0) - lit.current[i]) * Math.min(1, dt * 3);
      const l = lit.current[i];
      for (const m of lamps.current[i] ?? []) m.color.copy(LAMP_OFF).lerp(LAMP_ON, l);
      for (const m of halos.current[i] ?? []) m.opacity = 0.4 * l;
      if (l > nearestLit) {
        nearestLit = l;
        nearest = i;
      }

      // Walking into the dark opening takes you through.
      if (!busy.current && performance.now() > cooldownUntil.current && d < 12) {
        const loc = local(t, px, pz);
        if (loc.into > 0.8 && loc.into < 8 && Math.abs(loc.side) < DOOR_HALF_WIDTH && Math.abs(playerState.y - t.h) < 6) {
          enter(i);
        }
      }
    }

    // One real light is shared: it sits at the nearest lit tunnel.
    const pl = light.current;
    if (pl) {
      if (nearest >= 0) {
        const t = TUNNELS[nearest];
        pl.position.set(t.x + t.ox * 2.2, t.h + 6, t.z + t.oz * 2.2);
        pl.intensity = 520 * nearestLit;
      } else {
        pl.intensity = 0;
      }
    }
  });

  if (TUNNELS.length === 0) return null;
  return (
    <group>
      <pointLight ref={light} color="#ffb060" intensity={0} distance={48} decay={1.4} />
      {TUNNELS.map((t, i) => (
        <group key={i} position={[t.x, t.h, t.z]} rotation={[0, yaws[i], 0]}>
          {/* Stone arch: two pillars and a lintel. Local +z points into the mountain. */}
          <mesh position={[-4.4, 4.1, 2.2]} castShadow receiveShadow>
            <boxGeometry args={[1.8, 8.2, 2.6]} />
            <meshStandardMaterial color={STONE} roughness={1} />
          </mesh>
          <mesh position={[4.4, 4.1, 2.2]} castShadow receiveShadow>
            <boxGeometry args={[1.8, 8.2, 2.6]} />
            <meshStandardMaterial color={STONE} roughness={1} />
          </mesh>
          <mesh position={[0, 9.2, 2.2]} castShadow receiveShadow>
            <boxGeometry args={[11.2, 2.0, 3.0]} />
            <meshStandardMaterial color={STONE} roughness={1} />
          </mesh>
          <mesh position={[0, 10.6, 2.2]} castShadow>
            <boxGeometry args={[7, 1.0, 2.6]} />
            <meshStandardMaterial color={DARK_STONE} roughness={1} />
          </mesh>
          {/* The dark opening. */}
          <mesh position={[0, 4.1, 3.0]}>
            <boxGeometry args={[7.0, 8.2, 0.2]} />
            <meshBasicMaterial color="#020204" />
          </mesh>
          {/* Boulders heaped round the arch so it looks carved into the rock. */}
          {[[-6.2, 0.8, 2.6, 1.7], [6.4, 1.0, 2.4, 2.0], [-7.6, 1.4, 4.2, 2.4], [7.8, 1.2, 4.0, 2.2], [0, 11.6, 4.2, 2.6]].map(([x, y, z, s], k) => (
            <mesh key={k} position={[x, y, z]} scale={s} castShadow receiveShadow>
              <icosahedronGeometry args={[1, 0]} />
              <meshStandardMaterial color={DARK_STONE} roughness={1} flatShading />
            </mesh>
          ))}
          {/* Lanterns that light up when somebody comes near. */}
          {[-3.0, 3.0].map((x, k) => (
            <group key={k} position={[x, 6.6, 1.2]}>
              <mesh>
                <sphereGeometry args={[0.38, 10, 8]} />
                <meshBasicMaterial
                  ref={(m) => {
                    if (!m) return;
                    (lamps.current[i] ??= [])[k] = m;
                  }}
                  color="#3a2c1c"
                  toneMapped={false}
                />
              </mesh>
              <mesh>
                <sphereGeometry args={[1.1, 10, 8]} />
                <meshBasicMaterial
                  ref={(m) => {
                    if (!m) return;
                    (halos.current[i] ??= [])[k] = m;
                  }}
                  color="#ffb050"
                  transparent
                  opacity={0}
                  depthWrite={false}
                  toneMapped={false}
                />
              </mesh>
            </group>
          ))}
        </group>
      ))}
    </group>
  );
}
