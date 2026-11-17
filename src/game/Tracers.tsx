import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";
import { TRACERS, TRACER_LIFETIME, MAX_TRACERS } from "./tracerState";
import { RELIC_PALETTE } from "./RelicVisuals";

// Shots are drawn as arrows that fly from the shooter to the target, with a faint trail behind them.
// (The game's rules still treat every shot as instant; this is only how it looks.)

const FWD = new THREE.Vector3(0, 0, 1);
const tmp = new THREE.Vector3();
const quat = new THREE.Quaternion();
const SLOTS = Array.from({ length: MAX_TRACERS }, (_, i) => i);
const ARROW_SCALE = 1.4;

export function Tracers() {
  const lines = useRef<(THREE.Group | null)[]>([]);
  const arrows = useRef<(THREE.Group | null)[]>([]);
  const glow = useRef<(THREE.MeshBasicMaterial | null)[]>([]);
  const core = useRef<(THREE.MeshBasicMaterial | null)[]>([]);
  const sparks = useRef<(THREE.Mesh | null)[]>([]);

  useFrame((_, dt) => {
    for (let i = TRACERS.length - 1; i >= 0; i--) {
      TRACERS[i].life -= dt;
      if (TRACERS[i].life <= 0) TRACERS.splice(i, 1);
    }
    for (let i = 0; i < MAX_TRACERS; i++) {
      const g = lines.current[i];
      const a = arrows.current[i];
      const s = sparks.current[i];
      if (!g || !a || !s) continue;
      const t = TRACERS[i];
      if (!t) {
        g.visible = false;
        a.visible = false;
        s.visible = false;
        continue;
      }
      const f = Math.max(0, t.life / TRACER_LIFETIME);
      quat.setFromUnitVectors(FWD, t.dir);

      // A faint trail along the whole path.
      g.visible = true;
      tmp.copy(t.start).addScaledVector(t.dir, t.len / 2);
      g.position.copy(tmp);
      g.quaternion.copy(quat);
      g.scale.set(1, 1, t.len);
      const gm = glow.current[i];
      const cm = core.current[i];
      if (gm) gm.opacity = f * 0.14;
      if (cm) cm.opacity = f * 0.3;

      // The arrow itself, flying from the start to the end of the path.
      const progress = 1 - f;
      a.visible = true;
      a.position.copy(t.start).addScaledVector(t.dir, t.len * progress);
      a.quaternion.copy(quat);
      a.scale.setScalar(ARROW_SCALE);

      if (t.hit) {
        s.visible = true;
        s.position.copy(t.start).addScaledVector(t.dir, t.len);
        s.scale.setScalar(0.12 + (1 - f) * 0.35);
      } else {
        s.visible = false;
      }
    }
  });

  return (
    <group>
      {SLOTS.map((i) => (
        <group key={i}>
          <group ref={(el) => { lines.current[i] = el; }} visible={false}>
            <mesh>
              <boxGeometry args={[0.06, 0.06, 1]} />
              <meshBasicMaterial ref={(m) => { glow.current[i] = m; }} color={RELIC_PALETTE.violet}
                transparent opacity={0} toneMapped={false} depthWrite={false} />
            </mesh>
            <mesh>
              <boxGeometry args={[0.022, 0.022, 1]} />
              <meshBasicMaterial ref={(m) => { core.current[i] = m; }} color={RELIC_PALETTE.rune}
                transparent opacity={0} toneMapped={false} depthWrite={false} />
            </mesh>
          </group>
          {/* An arrow: wooden shaft, steel head at the front (+Z), pale feathers at the back. */}
          <group ref={(el) => { arrows.current[i] = el; }} visible={false}>
            <mesh>
              <boxGeometry args={[0.05, 0.05, 1.5]} />
              <meshStandardMaterial color="#8a6a3a" roughness={0.9} />
            </mesh>
            <mesh position={[0, 0, 0.85]} rotation={[Math.PI / 2, 0, 0]}>
              <coneGeometry args={[0.1, 0.35, 6]} />
              <meshStandardMaterial color="#cfd3d8" metalness={0.6} roughness={0.4} />
            </mesh>
            <mesh position={[0, 0, -0.62]}>
              <boxGeometry args={[0.012, 0.24, 0.32]} />
              <meshStandardMaterial color="#e8e0c8" roughness={1} />
            </mesh>
            <mesh position={[0, 0, -0.62]}>
              <boxGeometry args={[0.24, 0.012, 0.32]} />
              <meshStandardMaterial color="#e8e0c8" roughness={1} />
            </mesh>
          </group>
          <mesh ref={(el) => { sparks.current[i] = el; }} visible={false}>
            <octahedronGeometry args={[1, 0]} />
            <meshBasicMaterial color="#f1e6ff" toneMapped={false} />
          </mesh>
        </group>
      ))}
    </group>
  );
}
