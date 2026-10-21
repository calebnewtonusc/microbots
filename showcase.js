// The showcase beat from the film (clip 0:19 to 0:24): a box built as a
// lattice, one bot per cell edge. Hiro flicks one more bot in. The box keeps
// its shape, and a wave runs outward from where the bot lands; behind the
// front the whole lattice re-forms into a new repeating pattern (in the clip,
// small busy cells become larger clean hexagons).
// Adding a bot here is real: the lattice is re-solved for N + 1, so the cell
// size and every slot change, not just one.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { loadBotGeometry } from "./bot.js";
import { setupXR } from "./xr.js";

const params = new URLSearchParams(location.search);
let N = Math.max(
  2000,
  Math.min(60000, parseInt(params.get("n") || "22000", 10)),
);
const CAP = N + 500;
const BOX = { x: 3, w: 6.5, d: 4.5, h: 12 };
const FLOOR_Y = 0.06;
const BOT_LEN = 0.54; // geometry length; scaled per shape to the cell edge
// Front speed in units per second. Clip 0:22.0 to 0:23.2: the front crosses
// the visible face, about half the box, in roughly 1.2 s.
const WAVE_SPEED = 6;
const SETTLE = 0.45; // seconds each bot takes to hop to its new slot

const hash = (n) => {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
};
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ---------- lattices ----------
// Every pattern uses one edge length e, so a bot always spans one edge.
// Returns edge midpoints and unit directions over a u,v rectangle.
function edgesFrom(segs, U, V, e) {
  const seen = new Set(),
    out = [];
  const q = e * 0.05;
  for (const [x0, y0, x1, y1] of segs) {
    const mx = (x0 + x1) / 2,
      my = (y0 + y1) / 2;
    if (mx < 0 || mx > U || my < 0 || my > V) continue;
    const key = Math.round(mx / q) * 1000003 + Math.round(my / q);
    if (seen.has(key)) continue;
    seen.add(key);
    const l = Math.hypot(x1 - x0, y1 - y0) || 1;
    out.push({
      u: mx,
      v: my,
      du: (x1 - x0) / l,
      dv: (y1 - y0) / l,
      a: [x0, y0],
      b: [x1, y1],
    });
  }
  return out;
}
function hexSegs(U, V, e, phase, flat) {
  // Pointy-top hexagons; flat swaps the axes, which turns the cells 90 degrees.
  const [W, H] = flat ? [V, U] : [U, V];
  const dx = Math.sqrt(3) * e,
    dy = 1.5 * e;
  const segs = [];
  for (let r = -1; r * dy < H + e * 2; r++)
    for (let c = -1; c * dx < W + dx * 2; c++) {
      const cx = c * dx + (r & 1 ? dx / 2 : 0) + phase * dx,
        cy = r * dy;
      for (let i = 0; i < 6; i++) {
        const a0 = Math.PI / 6 + (i * Math.PI) / 3,
          a1 = a0 + Math.PI / 3;
        const s = [
          cx + e * Math.cos(a0),
          cy + e * Math.sin(a0),
          cx + e * Math.cos(a1),
          cy + e * Math.sin(a1),
        ];
        segs.push(flat ? [s[1], s[0], s[3], s[2]] : s);
      }
    }
  return segs;
}
function triSegs(U, V, e, phase) {
  const h = (Math.sqrt(3) / 2) * e,
    segs = [];
  for (let j = -1; j * h < V + e; j++)
    for (let i = -1; i * e < U + e * 2; i++) {
      const x = i * e + (j & 1 ? e / 2 : 0) + phase * e,
        y = j * h;
      segs.push(
        [x, y, x + e, y],
        [x, y, x + e / 2, y + h],
        [x, y, x - e / 2, y + h],
      );
    }
  return segs;
}
function diamondSegs(U, V, e, phase) {
  const d = e / Math.SQRT2,
    segs = [];
  for (let j = -1; j * d < V + e; j++)
    for (let i = -1; i * d < U + e; i++) {
      if ((i + j) & 1) continue;
      const x = i * d + phase * d * 2,
        y = j * d;
      segs.push([x, y, x + d, y + d], [x, y, x - d, y + d]);
    }
  return segs;
}
// The +1 cycle. A bundle lays several bots side by side on one edge: the same
// bots then cover fewer, larger cells with thicker lines, which is the
// fine-to-open change in the clip (0:22, small busy cells to big bold hexes).
const PATTERNS = [
  { name: "fine hex", shells: 3, bundle: 1, segs: (U, V, e, p) => hexSegs(U, V, e, p, false) },
  { name: "open hex", shells: 3, bundle: 3, segs: (U, V, e, p) => hexSegs(U, V, e, p, true) },
  { name: "triangles", shells: 3, bundle: 1, segs: triSegs },
  { name: "diamonds", shells: 3, bundle: 2, segs: diamondSegs },
];
function lattice(pat, U, V, e, phase) {
  const edges = edgesFrom(pat.segs(U, V, e, phase), U, V, e);
  if (pat.bundle === 1) return edges;
  const out = [];
  const gap = 0.085;
  for (const h of edges)
    for (let j = 0; j < pat.bundle; j++) {
      const o = (j - (pat.bundle - 1) / 2) * gap;
      out.push({ ...h, u: h.u - h.dv * o, v: h.v + h.du * o });
    }
  return out;
}

// Solves the edge length so a builder yields at least n slots, then trims the
// hidden inner layers first so the visible skin keeps every cell.
function solve(build, n) {
  let e = 0.3;
  let s = build(e);
  e *= Math.sqrt(s.length / n);
  for (let tries = 0; tries < 200; tries++) {
    s = build(e);
    if (s.length >= n) break;
    e *= 0.985;
  }
  s.sort((p, q) => q.inner - p.inner || p.r - q.r);
  return { slots: s.slice(s.length - n), e };
}

function boxBuild(e, pat) {
  const out = [];
  let id = 0;
  for (let sh = 0; sh < pat.shells; sh++) {
    const ins = sh * 0.24;
    const W = BOX.w - 2 * ins,
      D = BOX.d - 2 * ins,
      H = BOX.h - ins;
    const x0 = BOX.x - W / 2,
      z0 = -D / 2;
    const faces = [
      [W, H, (u, v) => [x0 + u, v, z0 + D], [1, 0, 0], [0, 1, 0]],
      [W, H, (u, v) => [x0 + W - u, v, z0], [-1, 0, 0], [0, 1, 0]],
      [D, H, (u, v) => [x0, v, z0 + u], [0, 0, 1], [0, 1, 0]],
      [D, H, (u, v) => [x0 + W, v, z0 + D - u], [0, 0, -1], [0, 1, 0]],
      [W, D, (u, v) => [x0 + u, H, z0 + v], [1, 0, 0], [0, 0, 1]],
    ];
    for (const [U, V, map, eu, ev] of faces) {
      for (const h of lattice(pat, U, V, e, sh * 0.37)) {
        const p = map(h.u, h.v);
        const dir = [
          eu[0] * h.du + ev[0] * h.dv,
          eu[1] * h.du + ev[1] * h.dv,
          eu[2] * h.du + ev[2] * h.dv,
        ];
        out.push({ p, dir, inner: sh, r: hash(id++) });
      }
    }
  }
  return out;
}

// The hand is built in 3D: a wrist and palm as boxes, and every finger as a
// chain of phalanx cylinders bending at the knuckles, with the lattice wrapped
// all the way around each one (clip 0:42, the hand has round fingers and a
// thumb that stands off the palm).
const HAND = { x: BOX.x, palmY: [4.2, 8.8], palmW: 5.2, palmD: 1.9, wristW: 3.0, wristD: 1.6 };
// Matched side by side against the clip at 0:40: fat fingers nearly touching,
// fanned, the pinky set lower, all rounded at the tip.
const FINGERS = [
  { x: -2.05, dy: -0.15, r: 0.74, segs: [1.7, 1.2, 0.9], spread: -0.2 },
  { x: -0.7, dy: 0.05, r: 0.8, segs: [1.9, 1.3, 1.0], spread: -0.06 },
  { x: 0.72, dy: 0, r: 0.78, segs: [1.8, 1.25, 0.95], spread: 0.07 },
  { x: 2.0, dy: -0.6, r: 0.68, segs: [1.4, 1.0, 0.75], spread: 0.24 },
];
const CURL = 0.16; // forward bend per knuckle, radians; guessed, tuned by eye against 0:42

function faceBox(out, pat, e, sh, cx, y0, cz, W, H, D, top, id) {
  const ins = sh * 0.22;
  W -= 2 * ins; D -= 2 * ins;
  const x0 = cx - W / 2, z0 = cz - D / 2;
  const faces = [
    [W, H, (u, v) => [x0 + u, y0 + v, z0 + D], [1, 0, 0], [0, 1, 0]],
    [W, H, (u, v) => [x0 + W - u, y0 + v, z0], [-1, 0, 0], [0, 1, 0]],
    [D, H, (u, v) => [x0, y0 + v, z0 + u], [0, 0, 1], [0, 1, 0]],
    [D, H, (u, v) => [x0 + W, y0 + v, z0 + D - u], [0, 0, -1], [0, 1, 0]],
  ];
  if (top) faces.push([W, D, (u, v) => [x0 + u, y0 + H, z0 + v], [1, 0, 0], [0, 0, 1]]);
  for (const [U, V, map, eu, ev] of faces)
    for (const h of lattice(pat, U, V, e, sh * 0.37)) {
      const dir = [eu[0] * h.du + ev[0] * h.dv, eu[1] * h.du + ev[1] * h.dv, eu[2] * h.du + ev[2] * h.dv];
      out.push({ p: map(h.u, h.v), dir, inner: sh, r: hash(id.n++) });
    }
}

// One phalanx: the lattice unrolled around a cylinder from a along axis for
// length L. A tip segment closes into a dome.
function wrapCylinder(out, pat, e, sh, a, axis, L, r0, tip, id, skip, rBase) {
  const r = Math.max(0.15, r0 - sh * 0.2);
  const rb = rBase ? Math.max(0.15, rBase - sh * 0.2) : r;
  const ax = new THREE.Vector3(...axis).normalize();
  const n1 = new THREE.Vector3().crossVectors(ax, new THREE.Vector3(0, 0, 1));
  if (n1.lengthSq() < 1e-4) n1.set(1, 0, 0);
  n1.normalize();
  const n2 = new THREE.Vector3().crossVectors(ax, n1).normalize();
  const C = 2 * Math.PI * r, V = L + (tip ? r : 0);
  for (const h of lattice(pat, C, V, e, sh * 0.29)) {
    const th = h.u / r;
    let rad = h.v < L ? rb + (r - rb) * (h.v / L) : r, v = h.v;
    if (v > L) {
      const k = Math.min(1, (v - L) / r);
      rad = r * Math.sqrt(Math.max(0, 1 - k * k));
      v = L + r * Math.sin((k * Math.PI) / 2);
    }
    const c = Math.cos(th), sn = Math.sin(th);
    const p = [
      a[0] + ax.x * v + (n1.x * c + n2.x * sn) * rad,
      a[1] + ax.y * v + (n1.y * c + n2.y * sn) * rad,
      a[2] + ax.z * v + (n1.z * c + n2.z * sn) * rad,
    ];
    if (skip && skip(p)) continue;
    const tan = [-n1.x * sn + n2.x * c, -n1.y * sn + n2.y * c, -n1.z * sn + n2.z * c];
    const dir = [tan[0] * h.du + ax.x * h.dv, tan[1] * h.du + ax.y * h.dv, tan[2] * h.du + ax.z * h.dv];
    out.push({ p, dir, inner: sh, r: hash(id.n++) });
  }
}

function fingerChain(out, pat, e, sh, base, r, segs, dir0, curl, id, skip, rBase) {
  let p = base.slice();
  let d = new THREE.Vector3(...dir0).normalize();
  const bendAxis = new THREE.Vector3(1, 0, 0);
  segs.forEach((L, n) => {
    wrapCylinder(out, pat, e, sh, p, [d.x, d.y, d.z], L, r * (1 - n * 0.08), n === segs.length - 1, id, skip, n === 0 ? rBase : 0);
    p = [p[0] + d.x * L, p[1] + d.y * L, p[2] + d.z * L];
    d.applyAxisAngle(bendAxis, -curl);
  });
}

// Wrist into palm as one tube with an elliptical cross-section that flares
// from wrist width to palm width, so there is no box anywhere on the hand.
function handProfile(y) {
  const f = clamp((y - 2.4) / 2.6, 0, 1), k = f * f * (3 - 2 * f);
  // The wrist flares into the base like the film's, a trumpet, not a post.
  const flare = 1.1 * Math.exp(-y * 1.6);
  const a = 1.6 + (2.85 - 1.6) * k + flare, b = 0.85 + (1.05 - 0.85) * k + flare * 0.7;
  // Round the top over into the knuckles so no seam shows.
  const t = clamp((y - (HAND.palmY[1] - 0.7)) / 0.7, 0, 1);
  const dome = Math.sqrt(Math.max(0.05, 1 - t * t * 0.75));
  return [a * dome, b * dome];
}
function ellipseTable(a, b) {
  const n = 96, cum = [0];
  let prev = [a, 0];
  for (let i = 1; i <= n; i++) {
    const t = (i / n) * Math.PI * 2, q = [a * Math.cos(t), b * Math.sin(t)];
    cum.push(cum[i - 1] + Math.hypot(q[0] - prev[0], q[1] - prev[1]));
    prev = q;
  }
  return cum;
}
function angleAt(cum, frac) {
  const target = frac * cum[cum.length - 1];
  let i = 1;
  while (i < cum.length - 1 && cum[i] < target) i++;
  const f = (target - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
  return ((i - 1 + f) / (cum.length - 1)) * Math.PI * 2;
}
function wrapTube(out, pat, e, sh, y0, y1, id) {
  const ins = sh * 0.2;
  const [am, bm] = handProfile((y0 + y1) / 2);
  const U = 2 * Math.PI * Math.sqrt((am * am + bm * bm) / 2);
  const tables = new Map();
  for (const h of lattice(pat, U, y1 - y0, e, sh * 0.37)) {
    const y = y0 + h.v;
    const [a, b] = handProfile(y).map((v) => Math.max(0.2, v - ins));
    const key = Math.round(y * 10);
    if (!tables.has(key)) tables.set(key, ellipseTable(a, b));
    const t = angleAt(tables.get(key), h.u / U);
    const c = Math.cos(t), sn = Math.sin(t);
    const tan = [-a * sn, 0, b * c], tl = Math.hypot(tan[0], tan[2]) || 1;
    const dir = [(tan[0] / tl) * h.du, h.dv, (tan[2] / tl) * h.du];
    out.push({ p: [HAND.x + a * c, y, b * sn], dir, inner: sh, r: hash(id.n++) });
  }
}
// The flat top between the knuckles, clipped to the palm's ellipse.
function capTop(out, pat, e, sh, y, id) {
  const [a, b] = handProfile(y).map((v) => Math.max(0.2, v - sh * 0.2));
  for (const h of lattice(pat, 2 * a, 2 * b, e, sh * 0.31)) {
    const x = h.u - a, z = h.v - b;
    if ((x * x) / (a * a) + (z * z) / (b * b) > 0.92) continue;
    out.push({ p: [HAND.x + x, y, z], dir: [h.du, 0, h.dv], inner: sh, r: hash(id.n++) });
  }
}

function handBuild(e, pat) {
  const out = [];
  const id = { n: 0 };
  const py1 = HAND.palmY[1];
  const inPalm = (p) => {
    const [a, b] = handProfile(p[1]);
    const x = p[0] - HAND.x;
    return p[1] < py1 - 0.1 && (x * x) / (a * a) + (p[2] * p[2]) / (b * b) < 0.8;
  };
  for (let sh = 0; sh < pat.shells; sh++) {
    wrapTube(out, pat, e, sh, 0, py1, id);
    capTop(out, pat, e, sh, py1 - 0.02, id);
    // The stepped base the film hand stands on.
    faceBox(out, pat, e, sh, HAND.x, 0, 0, 5.2, 0.75, 3.4, true, id);
    for (const f of FINGERS) {
      const base = [HAND.x + f.x, py1 - 0.55 + f.dy, 0];
      fingerChain(out, pat, e, sh, base, f.r, f.segs, [Math.sin(f.spread), Math.cos(f.spread), 0], CURL, id, inPalm);
    }
    // Thumb: thick, starting low by the wrist with a wide webbed base, angled up and out.
    fingerChain(out, pat, e, sh, [HAND.x + 1.7, HAND.palmY[0] + 0.5, 0.2], 0.8, [2.0, 1.5], [0.72, 0.68, 0.12], 0.18, id, inPalm, 1.15);
  }
  return out;
}

// The sheet the box assembles out of at the start of the clip.
function floorBuild(e, n) {
  const R = Math.sqrt(0.6 * n * e * e) + 4;
  const out = [];
  for (let l = 0; l < 2; l++) {
    for (const h of lattice(PATTERNS[0], 2 * R, 2 * R, e, l * 0.5)) {
      const x = BOX.x - R + h.u,
        z = -R + h.v;
      const th = Math.atan2(z, x - BOX.x);
      const r =
        Math.hypot(x - BOX.x, z) *
        (1 + 0.1 * Math.sin(3 * th) + 0.05 * Math.sin(7 * th + 1));
      out.push({
        p: [x, FLOOR_Y + l * 0.13, z],
        dir: [h.du, 0, h.dv],
        inner: 0,
        r,
      });
    }
  }
  out.sort((a, b) => a.r - b.r);
  return out.slice(0, n);
}

function toArrays(slots) {
  const pos = new Float32Array(slots.length * 3),
    dir = new Float32Array(slots.length * 3);
  slots.forEach((s, i) => {
    pos.set(s.p, i * 3);
    dir.set(s.dir, i * 3);
  });
  return { pos, dir };
}

// Re-solving 22k slots takes long enough to stall a frame, so results are
// cached and the next N + 1 shape is solved while the scene sits idle.
const shapeCache = new Map();
function shapeFor(name, n, patIdx) {
  const key = `${name}:${n}:${patIdx}`;
  if (!shapeCache.has(key)) shapeCache.set(key, solveShape(name, n, patIdx));
  for (const k of shapeCache.keys())
    if (+k.split(":")[1] < n - 1) shapeCache.delete(k);
  return shapeCache.get(key);
}
function solveShape(name, n, patIdx) {
  const pat = PATTERNS[patIdx % PATTERNS.length];
  if (name === "floor") {
    const { e } = solve((e) => boxBuild(e, PATTERNS[0]), n);
    return { ...toArrays(floorBuild(e, n)), e, name, patIdx };
  }
  const build = name === "hand" ? handBuild : boxBuild;
  const { slots, e } = solve((e) => build(e, pat), n);
  return { ...toArrays(slots), e, name, patIdx };
}

// ---------- coherent pairing (recursive equal-count bisection) ----------
// Same box to same box, so pairing by normalized position keeps every move
// local: a bot hops to a slot near where it already sits.
function matchSets(A, B, n, keyA, keyB) {
  const norm = (P, key) => {
    const v = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const k = key ? key(P, i) : [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
      v[i * 3] = k[0];
      v[i * 3 + 1] = k[1];
      v[i * 3 + 2] = k[2];
    }
    const mn = [Infinity, Infinity, Infinity],
      mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++)
      for (let a = 0; a < 3; a++) {
        mn[a] = Math.min(mn[a], v[i * 3 + a]);
        mx[a] = Math.max(mx[a], v[i * 3 + a]);
      }
    for (let i = 0; i < n; i++)
      for (let a = 0; a < 3; a++)
        v[i * 3 + a] = (v[i * 3 + a] - mn[a]) / (mx[a] - mn[a] + 1e-6);
    return v;
  };
  const a = norm(A, keyA),
    b = norm(B, keyB);
  const ia = new Int32Array(n).map((_, i) => i),
    ib = new Int32Array(n).map((_, i) => i);
  const assign = new Int32Array(n);
  const AX = [1, 0, 2];
  const rec = (lo, hi, depth) => {
    const len = hi - lo;
    if (len <= 0) return;
    if (len === 1) {
      assign[ia[lo]] = ib[lo];
      return;
    }
    const ax = AX[depth % 3];
    ia.subarray(lo, hi).sort((x, y) => a[x * 3 + ax] - a[y * 3 + ax]);
    ib.subarray(lo, hi).sort((x, y) => b[x * 3 + ax] - b[y * 3 + ax]);
    const mid = lo + (len >> 1);
    rec(lo, mid, depth + 1);
    rec(mid, hi, depth + 1);
  };
  rec(0, n, 0);
  return assign;
}
const sheetKey = (P, i) => {
  const x = P[i * 3] - BOX.x,
    z = P[i * 3 + 2];
  const r = Math.hypot(x, z),
    th = Math.atan2(z, x);
  return [Math.cos(th) * 3, r, Math.sin(th) * 3];
};

// ---------- scene: the dark stage at the expo ----------

const canvas = document.getElementById("stage");
// ?shots keeps the drawing buffer so frames can be read back for checking.
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: params.has("shots") });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const BG = 0x150e0d;
const scene = new THREE.Scene();
scene.background = new THREE.Color(BG);
scene.fog = new THREE.Fog(BG, 30, 70);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(
  34,
  innerWidth / innerHeight,
  0.1,
  300,
);
camera.position.set(-4, 4.5, 31);
const controls = new OrbitControls(camera, canvas);
controls.target.set(-0.5, 5.5, 0);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.495;
controls.minDistance = 4;
controls.maxDistance = 70;

const wall = new THREE.Mesh(
  new THREE.PlaneGeometry(80, 30),
  new THREE.MeshStandardMaterial({ color: 0x3a2320, roughness: 0.8 }),
);
wall.position.set(0, 12, -14);
scene.add(wall);
const stage = new THREE.Mesh(
  new THREE.CylinderGeometry(22, 22, 1.2, 96),
  new THREE.MeshStandardMaterial({
    color: 0x1d191a,
    roughness: 0.55,
    metalness: 0.1,
  }),
);
stage.position.set(0, -0.6, 0);
stage.receiveShadow = true;
scene.add(stage);

scene.add(new THREE.HemisphereLight(0x6a5a66, 0x120a0a, 0.5));
// Pink-white follow spot on Hiro's mark, as in the clip.
const spot = new THREE.SpotLight(0xffd8ef, 220, 40, 0.32, 0.6, 1.6);
spot.position.set(-6, 22, 8);
spot.target.position.set(-6, 0, 2);
scene.add(spot, spot.target);
const key = new THREE.SpotLight(0xdfe6ff, 520, 60, 0.45, 0.5, 1.4);
key.position.set(10, 26, 16);
key.target.position.set(BOX.x, 5, 0);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.bias = -0.0004;
scene.add(key, key.target);
const rim = new THREE.DirectionalLight(0x8aa6ff, 1.2);
rim.position.set(-10, 8, -14);
scene.add(rim);

const HIRO = new THREE.Vector3(-6, 3.4, 2);

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
const geo = await loadBotGeometry(BOT_LEN, botGeometry);
const ig = new THREE.InstancedBufferGeometry();
ig.index = geo.index;
ig.setAttribute("position", geo.getAttribute("position"));
ig.setAttribute("normal", geo.getAttribute("normal"));
const attr = (size) =>
  new THREE.InstancedBufferAttribute(
    new Float32Array(CAP * size),
    size,
  ).setUsage(THREE.DynamicDrawUsage);
const aA = attr(3),
  aB = attr(3),
  aDA = attr(3),
  aDB = attr(3),
  aT = attr(3);
for (const [k, v] of Object.entries({ aA, aB, aDA, aDB, aT }))
  ig.setAttribute(k, v);
ig.instanceCount = N;

const U = {
  uT: { value: 0 },
  uDirect: { value: 0 },
  uScaleA: { value: 1 },
  uScaleB: { value: 1 },
  // Bigger cells stretch a bot along its edge only; it keeps the fine lattice's
  // thickness, or open patterns fill in solid.
  uThick: { value: 0.55 },
  uCenter: { value: new THREE.Vector3(BOX.x, 0, 0) },
};
const GLSL = /* glsl */ `
  uniform float uT, uDirect, uScaleA, uScaleB, uThick;
  uniform vec3 uCenter;
  attribute vec3 aA, aB, aDA, aDB, aT;
  float easeIO(float t) { return t < 0.5 ? 4.0 * t * t * t : 1.0 - pow(-2.0 * t + 2.0, 3.0) / 2.0; }
  void botPlace(out mat3 frame, out vec3 pos, out float scl) {
    float e = clamp((uT - aT.x) / aT.y, 0.0, 1.0);
    float k = easeIO(e);
    vec3 axis;
    if (uDirect > 0.5) {
      // Wave hop: the bot lifts off the surface as the front passes, spins to
      // its new edge, and lands, so the front reads as a raised ripple.
      pos = mix(aA, aB, k);
      vec3 out_ = pos - uCenter; out_.y = 0.0;
      out_ = length(out_) > 1e-4 ? normalize(out_) : vec3(0.0, 0.0, 1.0);
      if (pos.y > ${(BOX.h - 0.6).toFixed(2)}) out_ = vec3(0.0, 1.0, 0.0);
      pos += out_ * sin(k * 3.14159) * 0.45;
      axis = normalize(mix(aDA, aDB, k) + 1e-4);
      float spin = sin(k * 3.14159) * 1.2 * (aT.z - 0.5);
      vec3 side = normalize(cross(axis, out_) + 1e-4);
      axis = normalize(axis * cos(spin) + side * sin(spin));
    } else {
      // Slide in along the stage and up the wall: bots stay on surfaces.
      vec3 M = aA.y > aB.y ? vec3(aA.x, ${FLOOR_Y.toFixed(3)}, aA.z) : vec3(aB.x, ${FLOOR_Y.toFixed(3)}, aB.z);
      float d1 = length(M - aA), d2 = length(aB - M);
      float s = k * (d1 + d2);
      vec3 seg;
      if (s < d1) { pos = mix(aA, M, s / max(d1, 1e-4)); seg = M - aA; }
      else { pos = mix(M, aB, (s - d1) / max(d2, 1e-4)); seg = aB - M; }
      vec3 mv = length(seg) > 1e-4 ? normalize(seg) : aDB;
      axis = e < 0.15 ? normalize(mix(aDA, mv, e / 0.15)) : e > 0.85 ? normalize(mix(mv, aDB, (e - 0.85) / 0.15)) : mv;
      if (aT.z < 0.33 && e > 0.0 && e < 1.0) {
        float ang = k * 6.2831 * 2.0;
        vec3 side = normalize(cross(axis, abs(axis.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
        axis = normalize(axis * cos(ang) + cross(side, axis) * sin(ang));
        pos.y += abs(sin(ang)) * 0.12;
      }
    }
    vec3 up = abs(axis.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 bz = normalize(cross(axis, up));
    vec3 by = cross(bz, axis);
    frame = mat3(axis, by, bz);
    scl = mix(uScaleA, uScaleB, k);
  }
`;
function patch(shader, withNormal) {
  Object.assign(shader.uniforms, U);
  shader.vertexShader = shader.vertexShader.replace(
    "#include <common>",
    "#include <common>\n" + GLSL,
  );
  const place =
    "mat3 botFrame; vec3 botPos; float botScl; botPlace(botFrame, botPos, botScl);";
  if (withNormal) {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <beginnormal_vertex>",
        place +
          "\nvec3 objectNormal = botFrame * normal;\n#ifdef USE_TANGENT\nvec3 objectTangent = vec3( tangent.xyz );\n#endif",
      )
      .replace(
        "#include <begin_vertex>",
        "vec3 transformed = botFrame * (position * vec3(botScl, uThick, uThick)) + botPos;",
      );
  } else {
    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      place + "\nvec3 transformed = botFrame * (position * vec3(botScl, uThick, uThick)) + botPos;",
    );
  }
}
// Blue-gray gunmetal, which is how the lattice reads under the stage key light.
const material = new THREE.MeshStandardMaterial({
  color: 0x4a5566,
  metalness: 0.9,
  roughness: 0.32,
  envMapIntensity: 0.45,
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

const flickBot = new THREE.Mesh(
  geo,
  new THREE.MeshStandardMaterial({
    color: 0x9aa3ad,
    metalness: 0.95,
    roughness: 0.2,
  }),
);
flickBot.visible = false;
flickBot.scale.setScalar(2.2);
scene.add(flickBot);


// ---------- the beat ----------

let current = null;
let busy = false;
let tStart = 0,
  tEnd = 0,
  waveT = -1;
const queue = [];
const clock = new THREE.Clock();
const countEl = document.getElementById("count");
const statusEl = document.getElementById("status");
const setStatus = (t) => {
  statusEl.textContent = t;
};

function transition(from, to, opts) {
  const n = to.pos.length / 3;
  const assign = matchSets(
    from.pos,
    to.pos,
    n,
    from.name === "floor" ? sheetKey : null,
    to.name === "floor" ? sheetKey : null,
  );
  const A = aA.array,
    B = aB.array,
    DA = aDA.array,
    DB = aDB.array,
    T = aT.array;
  let maxEnd = 0;
  const impact = opts.impact;
  for (let i = 0; i < n; i++) {
    const s = assign[i];
    A.set(from.pos.subarray(i * 3, i * 3 + 3), i * 3);
    DA.set(from.dir.subarray(i * 3, i * 3 + 3), i * 3);
    B.set(to.pos.subarray(s * 3, s * 3 + 3), i * 3);
    DB.set(to.dir.subarray(s * 3, s * 3 + 3), i * 3);
    const by = B[i * 3 + 1];
    const dist = Math.hypot(
      B[i * 3] - A[i * 3],
      by - A[i * 3 + 1],
      B[i * 3 + 2] - A[i * 3 + 2],
    );
    const r = hash(i * 1.37 + tStart);
    let delay, dur;
    if (opts.kind === "wave") {
      // Distance from the landing point sets when the front reaches a bot.
      const di = Math.hypot(
        A[i * 3] - impact.x,
        A[i * 3 + 1] - impact.y,
        A[i * 3 + 2] - impact.z,
      );
      delay = di / WAVE_SPEED + r * 0.06; // distance from impact; measured: clip 0:22 front crosses half the box in ~1.2 s
      dur = SETTLE + Math.min(dist, 2) * 0.1;
    } else if (opts.kind === "grow") {
      delay = (by / BOX.h) * 1.9 + r * 0.45; // by height; clip 0:17 sheet to box takes about 2 s
      dur = 0.6 + dist / 16;
    } else {
      delay = (1 - by / BOX.h) * 0.6 + r * 0.25; // by height; clip 0:41 box to hand takes about 1.5 s
      dur = 1.1 + dist / 18;
    }
    T[i * 3] = delay;
    T[i * 3 + 1] = dur;
    T[i * 3 + 2] = hash(i * 7.77);
    maxEnd = Math.max(maxEnd, delay + dur);
  }
  for (const a of [aA, aB, aDA, aDB, aT]) a.needsUpdate = true;
  ig.instanceCount = n;
  U.uDirect.value = opts.kind === "grow" ? 0 : 1;
  U.uScaleA.value = from.e / BOT_LEN;
  U.uScaleB.value = to.e / BOT_LEN;
  U.uT.value = 0;
  tStart = clock.elapsedTime;
  tEnd = tStart + maxEnd;
  current = to;
}

function run(steps) {
  queue.push(...steps);
  if (!busy) next();
}
let pendingAdds = 0;
function next() {
  const step = queue.shift();
  if (!step) {
    busy = false;
    setStatus(PATTERNS[current.patIdx % PATTERNS.length].name);
    if (pendingAdds > 0) {
      pendingAdds--;
      addOne();
    } else setTimeout(prewarm, 60);
    return;
  }
  busy = true;
  step();
}

let patIdx = 0;
let shapeName = "box";
function prewarm() {
  if (!busy) shapeFor(shapeName, N + 1, patIdx + 1);
}

function intro() {
  const floor = shapeFor("floor", N, 0);
  U.uThick.value = floor.e / BOT_LEN;
  current = floor;
  countEl.textContent = N.toLocaleString();
  run([
    () => {
      setStatus("assembling");
      transition(floor, shapeFor("box", N, 0), { kind: "grow" });
    },
  ]);
}

// A press during a beat is kept and played next, never dropped.
function addOne() {
  if (busy) {
    pendingAdds++;
    setStatus("+1 queued");
    return;
  }
  run([
    () => {
      setStatus("+1");
      flick();
    },
    () => {
      // The new bot joins at the landing point, and the lattice re-solves for N + 1.
      const old = current;
      N += 1;
      patIdx += 1;
      countEl.textContent = N.toLocaleString();
      const pos = new Float32Array(N * 3),
        dir = new Float32Array(N * 3);
      pos.set(old.pos);
      dir.set(old.dir);
      pos.set([impactPoint.x, impactPoint.y, impactPoint.z], (N - 1) * 3);
      dir.set([0, 1, 0], (N - 1) * 3);
      const from = { pos, dir, e: old.e, name: old.name, patIdx: old.patIdx };
      const to = shapeFor(shapeName, N, patIdx);
      setStatus(PATTERNS[patIdx % PATTERNS.length].name);
      transition(from, to, { kind: "wave", impact: impactPoint });
      waveT = 0;
    },
  ]);
}

function morph() {
  if (busy) return;
  shapeName = shapeName === "box" ? "hand" : "box";
  run([
    () => {
      setStatus("morphing");
      transition(current, shapeFor(shapeName, N, patIdx), { kind: "morph" });
    },
  ]);
}

// Flick arc from Hiro's mark to a point on the front face.
const impactPoint = new THREE.Vector3();
let flickT = -1;
function flick() {
  if (shapeName === "box")
    impactPoint.set(
      BOX.x - BOX.w / 2 + 1 + Math.random() * (BOX.w - 2),
      3 + Math.random() * 6,
      BOX.d / 2,
    );
  else impactPoint.set(BOX.x - 1 + Math.random() * 2, 4 + Math.random() * 3, 1);
  flickT = 0;
  flickBot.visible = true;
}
function stepFlick(dt) {
  if (flickT < 0) return;
  flickT += dt / 0.6;
  const t = Math.min(flickT, 1);
  flickBot.position.lerpVectors(HIRO, impactPoint, t);
  flickBot.position.y += Math.sin(t * Math.PI) * 3;
  flickBot.rotation.set(t * 14, t * 9, t * 4);
  if (flickT >= 1) {
    flickT = -1;
    flickBot.visible = false;
    next();
  }
}

// ---------- input ----------
document.getElementById("add").addEventListener("click", addOne);
document.getElementById("morph").addEventListener("click", morph);
addEventListener("keydown", (ev) => {
  if (ev.code === "Space") {
    ev.preventDefault();
    addOne();
  } else if (ev.key === "m" || ev.key === "M") morph();
  else if (ev.key === "h" || ev.key === "H")
    document.getElementById("ui").classList.toggle("opacity-0");
});
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

intro();

function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const time = clock.elapsedTime;
  U.uT.value = time - tStart;
  stepFlick(dt);
  if (busy && flickT < 0 && time > tEnd + 0.15) {
    tEnd = Infinity;
    next();
  }
  if (!renderer.xr.isPresenting) controls.update();
  renderer.render(scene, camera);
}

// Right hand pinch flicks one more bot in, left hand pinch morphs box and hand.
await setupXR({
  renderer,
  scene,
  camera,
  standAt: [-0.5, 0, 16],
  onPinch: (handedness) => (handedness === "left" ? morph() : addOne()),
});
renderer.setAnimationLoop(frame);
