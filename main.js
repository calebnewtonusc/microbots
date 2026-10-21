// Hiro's microbots, v2, matched to film stills (SideFX case study frames).
// A bot is a tiny double-pointed spindle. Bots never form solid blobs: they
// form flat ridged ribbons a few bots wide that run on 45 degree circuit paths,
// and every structure is a bundle of those ribbons rising out of a tangle of
// them on the ground. Bots crawl along their ribbon like a conveyor, and only
// the outer lanes flip. All bot placement runs in the vertex shader; the CPU
// only rebuilds ribbon center lines.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { loadBotGeometry } from "./bot.js";
import { setupXR } from "./xr.js";

const params = new URLSearchParams(location.search);
const STR = clampInt(params.get("strands"), 80, 16, 160); // ribbons
const ALONG = clampInt(params.get("along"), 120, 40, 400); // bots end to end along a ribbon
const LANES = 5; // parallel curves in one bundle
const LAYERS = 2; // bottom stays still, top flips over it (paper, fig. 2)
const MAXS = 256; // center line samples per ribbon
const DS = 0.25; // sample spacing, so a ribbon tops out at 64 units
const FLOW = 1.6; // conveyor crawl, units per second
const N = STR * ALONG * LANES * LAYERS;
const BOT_LEN = 0.54;

function clampInt(v, d, lo, hi) {
  const n = parseInt(v ?? "", 10);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
}
const hash = (n) => {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
};
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len3 = (a) => Math.hypot(a[0], a[1], a[2]);
const norm3 = (a) => {
  const l = len3(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// ---------- circuit-board conversion ----------
// Axis moves and in-plane diagonals only: every turn is 45 or 90 degrees,
// never the 54.7 degree 3D diagonal, which reads as organic.
const DIRS = [];
for (let x = -1; x <= 1; x++)
  for (let y = -1; y <= 1; y++)
    for (let z = -1; z <= 1; z++) {
      const nz = (x !== 0) + (y !== 0) + (z !== 0);
      if (nz === 1 || nz === 2) DIRS.push(norm3([x, y, z]));
    }

// Walks a smooth guide in fixed steps snapped to DIRS. Hysteresis keeps the
// current heading until the guide pulls more than ~35 degrees away, which gives
// long straight runs between turns instead of constant jitter (Disney's tool
// exposed the same knob as how far output may deviate from input).
function circuit(guide, step = 0.9, hyst = 0.82) {
  let cur = guide[0].slice();
  const out = [cur.slice()];
  let dir = null;
  for (let n = 1; n < guide.length; n++) {
    const q = guide[n];
    let g = 0;
    while (len3(sub(q, cur)) > step && g++ < 400) {
      const d = norm3(sub(q, cur));
      if (!dir || dot3(dir, d) < hyst) {
        let best = DIRS[0],
          bd = -2;
        for (const D of DIRS) {
          const v = dot3(D, d);
          if (v > bd) {
            bd = v;
            best = D;
          }
        }
        dir = best;
      }
      cur = [
        cur[0] + dir[0] * step,
        cur[1] + dir[1] * step,
        cur[2] + dir[2] * step,
      ];
      cur[1] = Math.max(cur[1], 0.12);
      out.push(cur.slice());
    }
  }
  return out;
}

function smooth(points, n = 48) {
  const c = new THREE.CatmullRomCurve3(
    points.map((p) => new THREE.Vector3(...p)),
    false,
    "centripetal",
  );
  return c.getPoints(n).map((v) => [v.x, v.y, v.z]);
}

// ---------- ribbon storage, read by the vertex shader ----------

const ribbonData = new Float32Array(MAXS * STR * 2 * 4);
const ribbonTex = new THREE.DataTexture(
  ribbonData,
  MAXS,
  STR * 2,
  THREE.RGBAFormat,
  THREE.FloatType,
);
ribbonTex.needsUpdate = true;
const uGrow = { value: new Float32Array(STR) };
const uLen = { value: new Float32Array(STR) };
const uTime = { value: 0 };
const UP = [0, 1, 0];

function writeRibbon(k, poly, face) {
  // Resample to even arc length so the shader can index by distance.
  const samples = [poly[0]];
  let carry = 0;
  for (let i = 1; i < poly.length && samples.length < MAXS; i++) {
    const a = poly[i - 1],
      b = poly[i];
    const seg = len3(sub(b, a));
    if (seg < 1e-6) continue;
    let t = DS - carry;
    while (t <= seg && samples.length < MAXS) {
      const f = t / seg;
      samples.push([
        a[0] + (b[0] - a[0]) * f,
        a[1] + (b[1] - a[1]) * f,
        a[2] + (b[2] - a[2]) * f,
      ]);
      t += DS;
    }
    carry = seg - (t - DS);
  }
  const n = samples.length;
  let prevN = null;
  for (let i = 0; i < MAXS; i++) {
    const c = Math.min(i, n - 1);
    const p = samples[c];
    const a = samples[Math.max(0, c - 1)],
      b = samples[Math.min(n - 1, c + 1)];
    const T = norm3(sub(b, a));
    // Flat on the ground, facing outward when climbing.
    const fv = face(p);
    const w = Math.abs(T[1]);
    const F = norm3([
      UP[0] * (1 - w) + fv[0] * w,
      UP[1] * (1 - w) + fv[1] * w,
      UP[2] * (1 - w) + fv[2] * w,
    ]);
    let Nn = sub(
      F,
      T.map((v) => v * dot3(F, T)),
    );
    if (len3(Nn) < 0.2) Nn = prevN || [1, 0, 0];
    Nn = norm3(Nn);
    if (prevN && dot3(prevN, Nn) < 0) Nn = Nn.map((v) => -v);
    prevN = Nn;
    const o = (k * 2 * MAXS + i) * 4,
      on = ((k * 2 + 1) * MAXS + i) * 4;
    ribbonData[o] = p[0];
    ribbonData[o + 1] = p[1];
    ribbonData[o + 2] = p[2];
    ribbonData[on] = Nn[0];
    ribbonData[on + 1] = Nn[1];
    ribbonData[on + 2] = Nn[2];
  }
  uLen.value[k] = (n - 1) * DS;
  ribbonTex.needsUpdate = true;
}

// ---------- shapes as ribbon guides ----------
// Every ribbon has a fixed root out in the swarm pool. A shape only says where
// its ribbons go after they leave the ground; the run from root to base is
// part of each guide, and those runs are what build the tangle on the floor.

const roots = Array.from({ length: STR }, (_, k) => {
  const a = (k / STR) * Math.PI * 2 + hash(k) * 0.3;
  const r = 9 + hash(k * 3.3) * 6;
  return [Math.cos(a) * r, 0.12 + (k % 3) * 0.16, Math.sin(a) * r];
});
const groundY = (k) => 0.12 + (k % 3) * 0.16;
const radial = (p) => {
  const l = Math.hypot(p[0], p[2]);
  return l < 1e-3 ? [0, 0, 1] : [p[0] / l, 0, p[2] / l];
};
const facing = () => [0, 0, 1];

function poolGuide(k) {
  const pts = [roots[k]];
  let a = hash(k * 7.7) * Math.PI * 2;
  let p = roots[k];
  for (let n = 0; n < 6; n++) {
    a += (hash(k * 13 + n) - 0.5) * 2.2;
    let q = [
      p[0] + Math.cos(a) * 5,
      groundY(k) + (hash(k + n * 5.1) < 0.25 ? 0.5 : 0),
      p[2] + Math.sin(a) * 5,
    ];
    const r = Math.hypot(q[0], q[2]);
    if (r > 15) {
      q = [q[0] * (12 / r), q[1], q[2] * (12 / r)];
      a += Math.PI * 0.6;
    }
    pts.push(q);
    p = q;
  }
  return { pts: smooth(pts, 40), face: radial };
}

// The run from root to base climbs up and over its neighbors in humps, which
// stacks the ground into the tangle under Yokai instead of flat spokes.
function approach(k, base, n = 4) {
  const r0 = roots[k];
  const pts = [r0];
  for (let i = 1; i <= n; i++) {
    const f = i / (n + 1);
    const side = (hash(k * 3.1 + i) - 0.5) * 3.5;
    const dx = base[0] - r0[0], dz = base[2] - r0[2];
    const l = Math.hypot(dx, dz) || 1;
    const hump = hash(k * 1.9 + i * 7.3) < 0.55 ? 0.8 + hash(k + i) * 3.2 * (1 - f * 0.5) : 0;
    pts.push([r0[0] + dx * f - (dz / l) * side, groundY(k) + hump, r0[2] + dz * f + (dx / l) * side]);
  }
  return pts;
}

function towerGuide(k) {
  const a0 = Math.atan2(roots[k][2], roots[k][0]);
  const rr = 0.35 + 0.65 * hash(k * 5.9);
  const pts = approach(k, [Math.cos(a0) * 4.5, 0, Math.sin(a0) * 4.5]);
  const key = [
    [4.5, 0.2],
    [2.2, 1.2],
    [1.4 * rr, 4],
    [1.1 * rr, 8],
    [1.3 * rr, 12],
    [1.6 * rr + 0.4, 15.5],
    [3.2 * rr + 0.5, 17.5],
  ];
  for (const [r, y] of key) {
    const a = a0 + y * 0.09;
    pts.push([Math.cos(a) * r, y, Math.sin(a) * r]);
  }
  return { pts: smooth(pts, 50), face: radial };
}

const FINGER_TIPS = [
  [-2.5, 15.6, -0.6],
  [-0.85, 17, -0.2],
  [0.85, 16.6, 0.2],
  [2.5, 15, 0.6],
  [5.2, 10.6, 0.4],
];
function handGuide(k) {
  const finger = k % 5;
  const j = Math.floor(k / 5);
  const off = (hash(k * 2.3) - 0.5) * 1.1,
    oz = (hash(k * 4.1) - 0.5) * 1.1;
  const tip = FINGER_TIPS[finger];
  const pts = [
    ...approach(k, [off * 1.5, 0, 1.5 + oz], 3),
    [off * 1.5, groundY(k), 1.5 + oz],
    [off, 2, oz],
    [off, 6, oz],
  ];
  if (finger === 4)
    pts.push(
      [2.4 + off * 0.4, 7.4, oz],
      [tip[0] - 1.2, tip[1] - 1.4, tip[2] + oz * 0.6],
    );
  else
    pts.push(
      [tip[0] * 0.75 + off * 0.5, 9.6, oz],
      [tip[0] + off * 0.35, 11.6, tip[2] + oz * 0.6],
    );
  pts.push([tip[0] + off * 0.25, tip[1] - (j % 3) * 0.3, tip[2] + oz * 0.5]);
  return { pts: smooth(pts, 50), face: facing };
}

function waveGuide(k) {
  const z = ((k + 0.5) / STR - 0.5) * 13;
  const r = 5.2 + hash(k * 6.1) * 1.4;
  const end = Math.PI * 1.18 - Math.abs(z) * 0.05;
  const pts = [...approach(k, [-8, 0, z * 0.8], 3), [-8, groundY(k), z * 0.8], [-1.5, groundY(k), z]];
  for (let n = 0; n <= 10; n++) {
    const a = -Math.PI / 2 + (n / 10) * (end + Math.PI / 2);
    pts.push([1 + Math.cos(a) * r, 6.4 + Math.sin(a) * r, z]);
  }
  return { pts: smooth(pts, 60), face: facing };
}

const SHAPES = {
  pile: { guide: poolGuide },
  tower: { guide: towerGuide },
  hand: { guide: handGuide },
  wave: { guide: waveGuide },
};

// ---------- tentacles ----------
const TENT = 5;
const pointer = { target: new THREE.Vector3(8, 10, 4), last: -10 };
const _bz = new THREE.Vector3(),
  _t = new THREE.Vector3(),
  _n1 = new THREE.Vector3(),
  _n2 = new THREE.Vector3();
const V_UP = new THREE.Vector3(0, 1, 0);
function tentacleGuide(k, time) {
  const t = k % TENT;
  const th = (t / TENT) * Math.PI * 2 + 0.5;
  const B = new THREE.Vector3(Math.cos(th) * 3.5, 0.3, Math.sin(th) * 3.5);
  const P = pointer.target;
  const T = new THREE.Vector3(
    P.x + Math.cos(th) * 2.6,
    P.y + 0.8 * Math.sin(th * 2 + time * 0.9),
    P.z + Math.sin(th) * 2.6,
  );
  const C = new THREE.Vector3(B.x * 1.8, Math.max(6, T.y * 0.8 + 4), B.z * 1.8);
  const curve = new THREE.QuadraticBezierCurve3(B, C, T);
  const phi = hash(k * 3.7) * Math.PI * 2,
    rho = 0.25 + 0.75 * hash(k * 8.3);
  const pts = [roots[k], [B.x * 1.6, groundY(k), B.z * 1.6]];
  for (let n = 0; n <= 24; n++) {
    const u = n / 24;
    curve.getPoint(u, _bz);
    curve.getTangent(u, _t);
    _n1.crossVectors(_t, V_UP);
    if (_n1.lengthSq() < 1e-4) _n1.set(1, 0, 0);
    _n1.normalize();
    _n2.crossVectors(_t, _n1);
    const R = (1.7 * (1 - u) + 0.35) * rho;
    pts.push([
      _bz.x + (_n1.x * Math.cos(phi) + _n2.x * Math.sin(phi)) * R,
      _bz.y + (_n1.y * Math.cos(phi) + _n2.y * Math.sin(phi)) * R,
      _bz.z + (_n1.z * Math.cos(phi) + _n2.z * Math.sin(phi)) * R,
    ]);
  }
  return { pts, face: radial };
}

// ---------- scene ----------

const canvas = document.getElementById("stage");
// ?shots keeps the drawing buffer so frames can be read back for checking.
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: params.has("shots") });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

// Daylight, like the San Fransokyo shots: the black swarm only reads against light.
const SKY = 0xb7c6d8;
const scene = new THREE.Scene();
scene.background = new THREE.Color(SKY);
scene.fog = new THREE.Fog(SKY, 60, 160);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(
  36,
  innerWidth / innerHeight,
  0.1,
  500,
);
camera.position.set(4, 7, 38);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 7.5, 0);
controls.enableDamping = true;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.3;
controls.maxPolarAngle = Math.PI * 0.495;
controls.minDistance = 6;
controls.maxDistance = 110;

scene.add(new THREE.HemisphereLight(0xe4eef8, 0x7d838b, 1.3));
const sun = new THREE.DirectionalLight(0xfff3e2, 3.2);
sun.position.set(22, 40, 18);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, {
  left: -30,
  right: 30,
  top: 30,
  bottom: -30,
  near: 1,
  far: 120,
});
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun);

const floor = new THREE.Mesh(
  new THREE.CircleGeometry(220, 64),
  new THREE.MeshStandardMaterial({
    color: 0xc8ccd1,
    roughness: 0.92,
    metalness: 0,
  }),
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

// One bot, from the close-up of it in Hiro's fingers: two cones tip to tip
// with a ring at the waist. Long axis is local x.
function botGeometry() {
  const a = new THREE.ConeGeometry(0.075, 0.25, 6);
  a.translate(0, 0.155, 0);
  const b = new THREE.ConeGeometry(0.075, 0.25, 6);
  b.rotateZ(Math.PI);
  b.translate(0, -0.155, 0);
  const ring = new THREE.CylinderGeometry(0.08, 0.08, 0.06, 6);
  const g = mergeGeometries([a, b, ring]);
  g.rotateZ(-Math.PI / 2);
  return g;
}

const geo = await loadBotGeometry(BOT_LEN, botGeometry, "xlo");
const aBot = new Float32Array(N * 4);
const aRand = new Float32Array(N);
{
  let i = 0;
  for (let k = 0; k < STR; k++)
    for (let s = 0; s < ALONG; s++)
      for (let l = 0; l < LANES; l++)
        for (let y = 0; y < LAYERS; y++) {
          aBot[i * 4] = k;
          aBot[i * 4 + 1] = s / ALONG;
          aBot[i * 4 + 2] = l - (LANES - 1) / 2;
          aBot[i * 4 + 3] = y;
          aRand[i] = hash(i * 1.37);
          i++;
        }
}
const ig = new THREE.InstancedBufferGeometry();
ig.index = geo.index;
ig.setAttribute("position", geo.getAttribute("position"));
ig.setAttribute("normal", geo.getAttribute("normal"));
ig.setAttribute("aBot", new THREE.InstancedBufferAttribute(aBot, 4));
ig.setAttribute("aRand", new THREE.InstancedBufferAttribute(aRand, 1));
ig.instanceCount = N;

const BOT_GLSL = /* glsl */ `
  #define STR ${STR}
  #define MAXS ${MAXS}
  uniform sampler2D uRibbon;
  uniform float uGrow[STR];
  uniform float uLen[STR];
  uniform float uTime;
  attribute vec4 aBot;
  attribute float aRand;
  float h1(float x) { return fract(sin(x * 12.9898 + 78.233) * 43758.5453); }
  void botPlace(out mat3 frame, out vec3 pos) {
    int k = int(aBot.x + 0.5);
    float L = max(uGrow[k], 1e-3);
    float Lt = max(uLen[k], 1.0);
    float lane = aBot.z;
    float s0 = aBot.y * L;
    // Interior bots slide along the bundle like a conveyor.
    float s = mod(s0 + uTime * ${FLOW.toFixed(3)}, L), theta = 0.0, lift = 0.0;
    // Flipping, after Byun et al. 2015 fig. 2: bots lie along the bundle; the
    // bottom layer is static, and each top bot lifts its back end, passes over
    // the top pivoting on its front tip, and puts down one bot length ahead.
    // History independent: the pose is a function of time step alone.
    // Only the bundle's outer lanes walk; the rest slide, which SideFX says
    // Disney did because walking everything read as noise.
    float edgeLane = ${((LANES - 1) / 2).toFixed(1)};
    if (aBot.w > 0.5 && abs(lane) > edgeLane - 0.5) {
      float ph = uTime * 1.1 - aBot.y * ${ALONG.toFixed(1)} * 0.08 + lane * 0.21 + aRand * 0.3;
      float c = floor(ph), f = fract(ph);
      theta = smoothstep(0.0, 0.3, f) * 3.14159;
      float hl = ${(BOT_LEN / 2).toFixed(3)};
      s = mod(s0 + c * ${BOT_LEN.toFixed(3)} + hl - cos(theta) * hl, L);
      lift = sin(theta) * hl;
    }
    float fi = s / ${DS.toFixed(3)};
    int i0 = min(int(floor(fi)), MAXS - 2);
    float f = fi - float(i0);
    vec3 p0 = texelFetch(uRibbon, ivec2(i0, k * 2), 0).xyz;
    vec3 p1 = texelFetch(uRibbon, ivec2(i0 + 1, k * 2), 0).xyz;
    vec3 n0 = texelFetch(uRibbon, ivec2(i0, k * 2 + 1), 0).xyz;
    vec3 n1 = texelFetch(uRibbon, ivec2(i0 + 1, k * 2 + 1), 0).xyz;
    vec3 P = mix(p0, p1, f);
    vec3 d = p1 - p0;
    vec3 T = dot(d, d) > 1e-8 ? normalize(d) : vec3(1.0, 0.0, 0.0);
    vec3 Nn = mix(n0, n1, f);
    Nn = normalize(Nn - T * dot(Nn, T) + 1e-5);
    vec3 B = cross(T, Nn);
    // History-dependent bundle, after the paper's circuit board generator:
    // lane i is lane i - 1 extruded one spacing outward, so a 45 degree jog
    // born in one lane carries into every lane extruded after it.
    float W = 0.2;
    float off = lane * W;
    float kk = float(k);
    for (int j = 0; j < 4; j++) {
      float fj = float(j);
      float born = floor(h1(kk * 3.1 + fj) * ${LANES.toFixed(1)}) - ${((LANES - 1) / 2).toFixed(1)};
      float side = born >= 0.0 ? 1.0 : -1.0;
      if (lane * side < born * side) continue;
      float js = h1(kk * 7.3 + fj * 1.7) * Lt * 0.8;
      float jl = 1.5 + h1(kk * 5.9 + fj) * 5.0;
      float jw = W * (1.0 + floor(h1(kk + fj * 9.1) * 2.0));
      // Out and back, both at 45 degrees: the ramp is as long as the jog is wide.
      off += side * jw * (clamp((s - js) / jw, 0.0, 1.0) - clamp((s - js - jl) / jw, 0.0, 1.0));
    }
    vec3 ax = cos(theta) * T + sin(theta) * Nn;
    vec3 up = -sin(theta) * T + cos(theta) * Nn;
    frame = mat3(ax, up, B);
    pos = P + B * off + Nn * (aBot.w * 0.13 + 0.07 + lift);
    // A ribbon pulled back into its root heaps up as a small pile.
    float heap = 1.0 - smoothstep(0.0, 4.0, uGrow[k]);
    float a = aRand * 6.2831 + aBot.y * 40.0;
    pos += vec3(cos(a), 0.0, sin(a)) * heap * (0.4 + 1.2 * fract(aRand * 7.0));
  }
`;

function patch(shader, withNormal) {
  shader.uniforms.uRibbon = { value: ribbonTex };
  shader.uniforms.uGrow = uGrow;
  shader.uniforms.uLen = uLen;
  shader.uniforms.uTime = uTime;
  shader.vertexShader = shader.vertexShader.replace(
    "#include <common>",
    "#include <common>\n" + BOT_GLSL,
  );
  if (withNormal) {
    shader.vertexShader = shader.vertexShader.replace(
      "#include <beginnormal_vertex>",
      "mat3 botFrame; vec3 botPos; botPlace(botFrame, botPos);\nvec3 objectNormal = botFrame * normal;\n#ifdef USE_TANGENT\nvec3 objectTangent = vec3( tangent.xyz );\n#endif",
    );
    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      "vec3 transformed = botFrame * position + botPos;",
    );
  } else {
    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      "mat3 botFrame; vec3 botPos; botPlace(botFrame, botPos);\nvec3 transformed = botFrame * position + botPos;",
    );
  }
}

const material = new THREE.MeshStandardMaterial({
  color: 0x2b2e34,
  metalness: 0.8,
  roughness: 0.28,
  envMapIntensity: 2.2,
});
material.onBeforeCompile = (s) => patch(s, true);
const depthMat = new THREE.MeshDepthMaterial({
  depthPacking: THREE.RGBADepthPacking,
});
depthMat.onBeforeCompile = (s) => patch(s, false);
const swarm = new THREE.Mesh(ig, material);
swarm.customDepthMaterial = depthMat;
swarm.castShadow = true;
swarm.receiveShadow = true;
swarm.frustumCulled = false;
scene.add(swarm);

// ---------- ribbon state machine ----------
// Changing shape pulls every ribbon back into its root, then regrows it along
// the new guide, staggered, so structures dissolve into the pool and rebuild.

const clock = new THREE.Clock();
const phase = new Array(STR).fill("hold");
const wait = new Float32Array(STR);
const pending = new Array(STR).fill(null);
let mode = "pile";

for (let k = 0; k < STR; k++) {
  const g = poolGuide(k);
  writeRibbon(k, circuit(g.pts), g.face);
  uGrow.value[k] = uLen.value[k];
}

function select(name) {
  mode = name;
  for (let k = 0; k < STR; k++) {
    phase[k] = "retract";
    wait[k] = hash(k * 9.1 + clock.elapsedTime) * 0.5;
    pending[k] = name === "tentacle" ? null : SHAPES[name].guide(k);
  }
  setActive(name);
}

function stepRibbons(dt, time) {
  for (let k = 0; k < STR; k++) {
    if (phase[k] === "hold") continue;
    if (wait[k] > 0) {
      wait[k] -= dt;
      continue;
    }
    if (phase[k] === "retract") {
      uGrow.value[k] -= 45 * dt;
      if (uGrow.value[k] <= 0) {
        uGrow.value[k] = 0;
        phase[k] = mode === "tentacle" ? "live" : "grow";
        wait[k] = hash(k * 4.4 + time) * 0.9;
        if (pending[k])
          writeRibbon(k, circuit(pending[k].pts), pending[k].face);
      }
    } else if (phase[k] === "live") {
      const g = tentacleGuide(k, time);
      writeRibbon(k, circuit(g.pts, 0.9, 0.9), g.face);
      uGrow.value[k] = Math.min(uLen.value[k], uGrow.value[k] + 20 * dt);
    } else if (phase[k] === "grow") {
      uGrow.value[k] = Math.min(uLen.value[k], uGrow.value[k] + 20 * dt);
      if (uGrow.value[k] >= uLen.value[k]) phase[k] = "hold";
    }
  }
}

// ---------- pointer ----------

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const plane = new THREE.Plane();
const fwd = new THREE.Vector3(),
  hit = new THREE.Vector3(),
  mid = new THREE.Vector3(0, 8, 0);
canvas.addEventListener("pointermove", (ev) => {
  ndc.set(
    (ev.clientX / innerWidth) * 2 - 1,
    -(ev.clientY / innerHeight) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, camera);
  camera.getWorldDirection(fwd);
  fwd.y = 0;
  fwd.normalize().negate();
  plane.setFromNormalAndCoplanarPoint(fwd, mid);
  if (raycaster.ray.intersectPlane(plane, hit)) {
    hit.y = clamp(hit.y, 2, 20);
    const h = Math.hypot(hit.x, hit.z);
    if (h > 18) {
      hit.x *= 18 / h;
      hit.z *= 18 / h;
    }
    pointer.target.copy(hit);
    pointer.last = clock.elapsedTime;
  }
});

// ---------- UI ----------

const MODES = [
  ["pile", "Swarm"],
  ["tower", "Tower"],
  ["hand", "Hand"],
  ["wave", "Wave"],
  ["tentacle", "Tentacles"],
];
const modesEl = document.getElementById("modes");
const buttons = {};
let auto = params.get("auto") !== "0";
MODES.forEach(([id, label], n) => {
  const b = document.createElement("button");
  b.type = "button";
  b.className =
    "rounded-xl px-3 py-2 text-sm text-neutral-700 transition-colors duration-150 hover:bg-black/10 hover:text-neutral-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-black/40 active:scale-[0.97] sm:px-4";
  const num = document.createElement("span");
  num.className = "mr-1.5 text-neutral-400";
  num.textContent = String(n + 1);
  b.append(num, label);
  b.addEventListener("click", () => {
    auto = false;
    select(id);
  });
  modesEl.appendChild(b);
  buttons[id] = b;
});
function setActive(id) {
  for (const [k, b] of Object.entries(buttons)) {
    b.classList.toggle("bg-black/10", k === id);
    b.classList.toggle("text-neutral-950", k === id);
  }
}

const AUTO_ORDER = ["tower", "hand", "wave", "tentacle", "pile"];
let autoIdx = 0,
  nextAuto = 1.5;
addEventListener("keydown", (ev) => {
  const n = parseInt(ev.key, 10);
  if (n >= 1 && n <= MODES.length) {
    auto = false;
    select(MODES[n - 1][0]);
  } else if (ev.key === "a" || ev.key === "A") {
    auto = !auto;
    nextAuto = clock.elapsedTime + 0.3;
  } else if (ev.key === "h" || ev.key === "H")
    document.getElementById("ui").classList.toggle("opacity-0");
});
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------- frame ----------

const statsEl = document.getElementById("stats");
let frames = 0,
  fpsT = 0;
setActive("pile");

function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const time = clock.elapsedTime;
  uTime.value = time;

  if (auto && time > nextAuto) {
    select(AUTO_ORDER[autoIdx++ % AUTO_ORDER.length]);
    nextAuto = time + 8;
  }
  if (mode === "tentacle" && time - pointer.last > 2.5) {
    pointer.target.set(
      Math.sin(time * 0.4) * 10,
      10 + Math.sin(time * 0.7) * 3,
      Math.cos(time * 0.3) * 6,
    );
  }
  stepRibbons(dt, time);

  xr.update();
  if (!renderer.xr.isPresenting) controls.update();
  renderer.render(scene, camera);

  frames++;
  fpsT += dt;
  if (fpsT > 0.5) {
    statsEl.textContent = `${N.toLocaleString()} bots, ${Math.round(frames / fpsT)} fps`;
    frames = 0;
    fpsT = 0;
  }
}

// Pinch moves to the next shape. In tentacle mode they chase the nearest
// index fingertip, with the same bounds the cursor gets.
const xr = await setupXR({
  renderer,
  scene,
  camera,
  standAt: [0, 0, 20],
  onPinch: () => {
    auto = false;
    const at = AUTO_ORDER.indexOf(mode);
    select(AUTO_ORDER[(at + 1) % AUTO_ORDER.length]);
  },
  onTips: (tips) => {
    const t = tips[0];
    pointer.target.set(t.x, clamp(t.y, 2, 20), t.z);
    const h = Math.hypot(t.x, t.z);
    if (h > 18) {
      pointer.target.x *= 18 / h;
      pointer.target.z *= 18 / h;
    }
    pointer.last = clock.elapsedTime;
  },
  onStart: () => (controls.autoRotate = false),
  onEnd: () => (controls.autoRotate = true),
});
renderer.setAnimationLoop(frame);
