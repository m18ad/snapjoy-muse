import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { weather } from "./weatherState";

// Weather: a slow cycle of clear weather, morning mist, drizzle, rain and the odd storm.
// This component runs the cycle and draws the rain; the sky, light and fog (DayNight) and the swaying
// plants (Foliage) read the shared `weather` values. Force a state to test it with ?weather=rain,
// ?weather=storm, ?weather=mist, ?weather=drizzle or ?weather=clear on the address.

type Target = { rain: number; mist: number; wind: number };
const CLEAR: Target = { rain: 0, mist: 0, wind: 1 };
const MIST: Target = { rain: 0, mist: 0.85, wind: 0.6 };
const DRIZZLE: Target = { rain: 0.45, mist: 0.35, wind: 1.3 };
const RAIN: Target = { rain: 1, mist: 0.45, wind: 1.9 };
const STORM: Target = { rain: 1, mist: 0.6, wind: 2.8 };

const FORCED: Target | null = (() => {
  if (typeof window === "undefined") return null;
  const w = new URLSearchParams(window.location.search).get("weather");
  if (w === "rain") return RAIN;
  if (w === "storm") return STORM;
  if (w === "mist") return MIST;
  if (w === "drizzle") return DRIZZLE;
  if (w === "clear") return CLEAR;
  return null;
})();

function pickNext(): Target {
  const r = Math.random();
  if (r < 0.5) return CLEAR;
  if (r < 0.7) return MIST;
  if (r < 0.86) return DRIZZLE;
  if (r < 0.96) return RAIN;
  return STORM;
}

const STREAKS = 2200;

const VERT = `
attribute vec3 aSeed;
attribute float aEnd;
attribute float aOrder;
uniform float uTime;
uniform float uRain;
uniform float uWind;
uniform vec3 uCam;
varying float vAlpha;
float wrap(float v, float s) { return v - s * floor(v / s); }
void main() {
  float box = 70.0;
  float h = 40.0;
  float ox = wrap(aSeed.x * box - uCam.x, box) - box * 0.5;
  float oz = wrap(aSeed.z * box - uCam.z, box) - box * 0.5;
  float fall = wrap(aSeed.y * h - uTime * 22.0, h);
  vec3 pos = vec3(uCam.x + ox + uWind * (h - fall) * 0.12, uCam.y + fall - 14.0, uCam.z + oz);
  pos.y -= aEnd * 1.1;
  pos.x -= aEnd * 0.12 * uWind;
  vAlpha = step(aOrder, uRain) * (1.0 - aEnd * 0.7);
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
}
`;

const FRAG = `
uniform vec3 uColor;
varying float vAlpha;
void main() {
  if (vAlpha < 0.02) discard;
  gl_FragColor = vec4(uColor, vAlpha * 0.45);
}
`;

export function Weather() {
  const lines = useRef<THREE.LineSegments>(null!);
  const sched = useRef({ t: 0, next: FORCED ? 1e9 : 45, target: FORCED ?? CLEAR });

  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const n = STREAKS * 2;
    const seed = new Float32Array(n * 3);
    const end = new Float32Array(n);
    const order = new Float32Array(n);
    for (let i = 0; i < STREAKS; i++) {
      const sx = Math.random(), sy = Math.random(), sz = Math.random(), o = i / STREAKS;
      for (let e = 0; e < 2; e++) {
        const k = i * 2 + e;
        seed[k * 3] = sx; seed[k * 3 + 1] = sy; seed[k * 3 + 2] = sz;
        end[k] = e;
        order[k] = o;
      }
    }
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 3));
    g.setAttribute("aEnd", new THREE.BufferAttribute(end, 1));
    g.setAttribute("aOrder", new THREE.BufferAttribute(order, 1));
    return g;
  }, []);

  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: {
          uTime: { value: 0 },
          uRain: { value: 0 },
          uWind: { value: 1 },
          uCam: { value: new THREE.Vector3() },
          uColor: { value: new THREE.Color("#d4e6f5") },
        },
        transparent: true,
        depthWrite: false,
        fog: false,
      }),
    [],
  );

  useFrame(({ camera, clock }, dt) => {
    const s = sched.current;
    s.t += dt;
    if (s.t > s.next) {
      s.target = pickNext();
      s.next = s.t + 75 + Math.random() * 120;
    }
    const k = 1 - Math.exp(-Math.min(dt, 0.1) * 0.25);
    weather.rain += (s.target.rain - weather.rain) * k;
    weather.mist += (s.target.mist - weather.mist) * k;
    weather.wind += (s.target.wind - weather.wind) * k;

    mat.uniforms.uTime.value = clock.elapsedTime;
    mat.uniforms.uRain.value = weather.rain;
    mat.uniforms.uWind.value = weather.wind;
    mat.uniforms.uCam.value.copy(camera.position);
    if (lines.current) lines.current.visible = weather.rain > 0.02;
  });

  return <lineSegments ref={lines} geometry={geo} material={mat} frustumCulled={false} renderOrder={5} />;
}
