// Hiro's microbots, after Disney's own method (SideFX case study, Henrik Falt):
// no flocking or fluid sim. Shapes are lattices, bots travel on 45 degree
// circuit-board paths, interior bots slide, and only bots on the visible edge
// run the flip walk cycle ("mechanical crowd surfing").
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const params = new URLSearchParams(location.search);
const N = Math.max(
  500,
  Math.min(20000, parseInt(params.get("n") || "6000", 10)),
);
// Lattice spacing. Bots are 0.9 long, so neighbors overlap and the mass reads as
// interlocked links instead of loose particles. Guessed, tune by eye.
const CELL = 0.6;
const MAX_HEIGHT = 18;
const FOOT = 0.38; // geometry origin to foot bottom
const TENTACLES = 5;

const hash = (n) => {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
};
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const easeInOut = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

function capsuleDist(x, y, z, a, b, r) {
  const pax = x - a[0],
    pay = y - a[1],
    paz = z - a[2];
  const bax = b[0] - a[0],
    bay = b[1] - a[1],
    baz = b[2] - a[2];
  const h = clamp(
    (pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz),
    0,
    1,
  );
  return Math.hypot(pax - bax * h, pay - bay * h, paz - baz * h) - r;
}

// ---------- shapes, normalized so height is about 1 ----------

const FINGERS = [
  [-0.165, 0.24, -0.06],
  [-0.055, 0.29, -0.02],
  [0.055, 0.27, 0.02],
  [0.165, 0.2, 0.06],
];

const SHAPES = {
  pile: {
    label: "Swarm",
    fill: true,
    bbox: [
      [-1.1, 0, -1.1],
      [1.1, 0.42, 1.1],
    ],
    inside(x, y, z) {
      const r2 = x * x + z * z;
      if (r2 > 1) return false;
      return (
        y <
        0.36 * Math.pow(1 - r2, 1.5) +
          0.025 * Math.sin(x * 7) * Math.cos(z * 6) +
          0.01
      );
    },
  },
  tower: {
    label: "Tower",
    bbox: [
      [-0.4, 0, -0.4],
      [0.4, 1, 0.4],
    ],
    inside(x, y, z) {
      if (y > 1) return false;
      const a = y * 2.4,
        c = Math.cos(a),
        s = Math.sin(a);
      const u = x * c - z * s,
        v = x * s + z * c;
      const r = 0.14 + 0.22 * Math.exp(-y * 9) + (y > 0.9 ? 0.05 : 0);
      return Math.max(Math.abs(u), Math.abs(v)) < r;
    },
  },
  hand: {
    label: "Hand",
    bbox: [
      [-0.45, 0, -0.15],
      [0.45, 1, 0.15],
    ],
    inside(x, y, z) {
      if (Math.abs(x) < 0.09 && Math.abs(z) < 0.08 && y < 0.42) return true;
      if (Math.abs(x) < 0.21 && Math.abs(z) < 0.09 && y > 0.38 && y < 0.68)
        return true;
      for (const [fx, len, spread] of FINGERS) {
        if (
          capsuleDist(
            x,
            y,
            z,
            [fx, 0.64, 0],
            [fx + spread, 0.64 + len, 0],
            0.04,
          ) < 0
        )
          return true;
      }
      return (
        capsuleDist(x, y, z, [0.2, 0.44, 0], [0.36, 0.6, 0.02], 0.045) < 0
      );
    },
  },
  sphere: {
    label: "Orb",
    bbox: [
      [-0.4, 0, -0.4],
      [0.4, 1, 0.4],
    ],
    inside(x, y, z) {
      if (Math.hypot(x, y - 0.64, z) < 0.31) return true;
      return Math.hypot(x, z) < 0.07 + 0.14 * Math.exp(-y * 10) && y < 0.4;
    },
  },
  wave: {
    label: "Wave",
    bbox: [
      [-0.85, 0, -0.6],
      [0.6, 0.9, 0.6],
    ],
    inside(x, y, z) {
      if (Math.abs(z) > 0.55) return false;
      if (y < 0.07 && x > -0.75 && x < 0.4) return true;
      const dx = x - 0.05,
        dy = y - 0.45;
      let ang = Math.atan2(dy, dx);
      if (ang < -Math.PI / 2) ang += Math.PI * 2;
      const end = Math.PI + 0.55 - Math.abs(z) * 1.3;
      if (ang > end) return false;
      const frac = (ang + Math.PI / 2) / (end + Math.PI / 2);
      const t = 0.15 * (1 - frac * 0.65);
      const d = Math.hypot(dx, dy);
      return d < 0.42 && d > 0.42 - t;
    },
  },
};

// ---------- voxelize a shape into exactly `count` lattice slots ----------

const key = (i, j, k) => (i + 1000) * 4e6 + j * 2000 + (k + 1000);
const NB = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

function voxelize(shape, count) {
  const [lo, hi] = shape.bbox;
  const scan = (s, collect) => {
    const out = [];
    let n = 0;
    const i0 = Math.floor((lo[0] * s) / CELL),
      i1 = Math.ceil((hi[0] * s) / CELL);
    const k0 = Math.floor((lo[2] * s) / CELL),
      k1 = Math.ceil((hi[2] * s) / CELL);
    const j1 = Math.ceil((hi[1] * s) / CELL);
    for (let i = i0; i <= i1; i++)
      for (let j = 0; j <= j1; j++)
        for (let k = k0; k <= k1; k++) {
          if (
            shape.inside((i * CELL) / s, ((j + 0.5) * CELL) / s, (k * CELL) / s)
          ) {
            n++;
            if (collect) out.push([i, j, k]);
          }
        }
    return collect ? out : n;
  };

  let s = 10;
  s *= Math.cbrt(count / Math.max(1, scan(s)));
  s *= Math.cbrt(count / Math.max(1, scan(s)));
  if (!shape.fill) s = Math.min(s, MAX_HEIGHT / hi[1]);
  let cells = scan(s, true);

  const set = new Map();
  for (const c of cells) set.set(key(c[0], c[1], c[2]), c);
  for (const c of cells) {
    let nb = 0;
    for (const d of NB) {
      const j = c[1] + d[1];
      if (j < 0 || set.has(key(c[0] + d[0], j, c[2] + d[2]))) nb++;
    }
    c.edge = nb < 6;
  }

  if (cells.length > count) {
    // Surplus comes out of the hidden interior first, so the silhouette survives.
    const order = cells
      .map((c, i) => [c.edge ? 1 + hash(i) : hash(i * 7.1), c])
      .sort((a, b) => a[0] - b[0]);
    cells = order.slice(cells.length - count).map((o) => o[1]);
  } else if (cells.length < count) {
    // Deficit pools around the base as a two-layer lake, the "lava" the shape rises out of.
    let cx = 0,
      cz = 0,
      nf = 0;
    for (const c of cells)
      if (c[1] === 0) {
        cx += c[0];
        cz += c[2];
        nf++;
      }
    if (nf) {
      cx = Math.round(cx / nf);
      cz = Math.round(cz / nf);
    }
    const need = count - cells.length;
    const R = Math.ceil(
      Math.sqrt(need / 2 / Math.PI) * 1.7 + ((hi[0] - lo[0]) * s) / CELL,
    );
    const cand = [];
    for (let i = -R; i <= R; i++)
      for (let k = -R; k <= R; k++) {
        if (set.has(key(cx + i, 0, cz + k))) continue;
        const th = Math.atan2(k, i);
        const r =
          Math.hypot(i, k) *
          (1 + 0.12 * Math.sin(3 * th + 1) + 0.06 * Math.sin(7 * th + 2));
        cand.push([r, cx + i, cz + k]);
      }
    cand.sort((a, b) => a[0] - b[0]);
    for (const [, i, k] of cand) {
      if (cells.length >= count) break;
      const low = [i, 0, k];
      low.edge = false;
      cells.push(low);
      if (cells.length >= count) {
        low.edge = true;
        break;
      }
      const top = [i, 1, k];
      top.edge = true;
      cells.push(top);
    }
  }

  const pos = new Float32Array(count * 3);
  const edge = new Uint8Array(count);
  const yaw = new Float32Array(count);
  const hNorm = new Float32Array(count);
  let maxY = 1;
  for (const c of cells) maxY = Math.max(maxY, c[1]);
  cells.forEach((c, n) => {
    pos[n * 3] = c[0] * CELL;
    pos[n * 3 + 1] = c[1] * CELL + FOOT;
    pos[n * 3 + 2] = c[2] * CELL;
    edge[n] = c.edge ? 1 : 0;
    // Jitter breaks the perfect grid, which otherwise reads as a carpet, not a swarm.
    yaw[n] = (c[1] % 2) * (Math.PI / 2) + (hash(n * 9.7 + c[0]) - 0.5) * 0.7;
    pos[n * 3] += (hash(n * 3.9) - 0.5) * 0.12;
    pos[n * 3 + 2] += (hash(n * 5.1) - 0.5) * 0.12;
    hNorm[n] = c[1] / maxY;
  });
  return { pos, edge, yaw, hNorm, count };
}

// ---------- coherent assignment: recursive equal-count bisection ----------
// Both sets are normalized to their own bounds and split identically, so the
// bottom-left of the old shape feeds the bottom-left of the new one.

function matchSets(A, B, n) {
  const norm = (P) => {
    const mn = [Infinity, Infinity, Infinity],
      mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++)
      for (let a = 0; a < 3; a++) {
        const v = P[i * 3 + a];
        if (v < mn[a]) mn[a] = v;
        if (v > mx[a]) mx[a] = v;
      }
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++)
      for (let a = 0; a < 3; a++)
        out[i * 3 + a] = (P[i * 3 + a] - mn[a]) / (mx[a] - mn[a] + 1e-6);
    return out;
  };
  const a = norm(A),
    b = norm(B);
  const ia = new Int32Array(n).map((_, i) => i);
  const ib = new Int32Array(n).map((_, i) => i);
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

// ---------- scene ----------

const canvas = document.getElementById("stage");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const BG = 0x0a0b0d;
scene.background = new THREE.Color(BG);
scene.fog = new THREE.Fog(BG, 45, 120);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(
  38,
  innerWidth / innerHeight,
  0.1,
  400,
);
camera.position.set(0, 15, 40);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 6.5, 0);
controls.enableDamping = true;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.35;
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 10;
controls.maxDistance = 90;

scene.add(new THREE.HemisphereLight(0x8899aa, 0x050505, 0.35));
const key1 = new THREE.DirectionalLight(0xffe6cc, 2.4);
key1.position.set(16, 30, 14);
key1.castShadow = true;
key1.shadow.mapSize.set(2048, 2048);
Object.assign(key1.shadow.camera, {
  left: -28,
  right: 28,
  top: 28,
  bottom: -28,
  near: 1,
  far: 90,
});
key1.shadow.bias = -0.0005;
scene.add(key1);
const rim = new THREE.DirectionalLight(0x7fb3ff, 1.6);
rim.position.set(-14, 10, -22);
scene.add(rim);

const floor = new THREE.Mesh(
  new THREE.CircleGeometry(160, 64),
  new THREE.MeshStandardMaterial({
    color: 0x0e1013,
    roughness: 0.85,
    metalness: 0.1,
  }),
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

// One bot: a capsule body with a magnetic leg at each end, after Hiro's design.
function botGeometry() {
  const body = new THREE.CapsuleGeometry(0.17, 0.52, 3, 8);
  body.rotateZ(Math.PI / 2);
  body.translate(0, 0.1, 0);
  const parts = [body];
  for (const sx of [-1, 1]) {
    const leg = new THREE.BoxGeometry(0.1, 0.32, 0.24);
    leg.rotateZ(sx * 0.25);
    leg.translate(sx * 0.4, -0.15, 0);
    const foot = new THREE.CylinderGeometry(0.12, 0.12, 0.06, 10);
    foot.translate(sx * 0.44, -FOOT + 0.03, 0);
    parts.push(leg, foot);
  }
  return mergeGeometries(parts);
}

const material = new THREE.MeshStandardMaterial({
  color: 0x15161a,
  metalness: 0.55,
  roughness: 0.3,
  envMapIntensity: 1.1,
});
const mesh = new THREE.InstancedMesh(botGeometry(), material, N);
mesh.castShadow = true;
mesh.receiveShadow = true;
mesh.frustumCulled = false;
const tint = new THREE.Color();
for (let i = 0; i < N; i++)
  mesh.setColorAt(i, tint.setScalar(0.85 + hash(i * 3.3) * 0.3));
scene.add(mesh);

// ---------- bot state ----------

const pos = new Float32Array(N * 3);
const qCur = new Float32Array(N * 4);
const qFrom = new Float32Array(N * 4);
const flipAcc = new Float32Array(N);
const MAXP = 10;
const path = new Float32Array(N * MAXP * 3);
const cum = new Float32Array(N * MAXP);
const npts = new Uint8Array(N);
const delay = new Float32Array(N);
const dur = new Float32Array(N);
const nFlips = new Uint8Array(N);
let slotOf = new Int32Array(N);

const shapes = {};
for (const name of Object.keys(SHAPES))
  shapes[name] = voxelize(SHAPES[name], N);
const baseCount = Math.round(N * 0.68);
// Tentacles grow out of a low, flat lake so the reach reads against the floor.
const LAKE = {
  fill: true,
  bbox: [
    [-1.1, 0, -1.1],
    [1.1, 0.2, 1.1],
  ],
  inside: (x, y, z) => {
    const r2 = x * x + z * z;
    return r2 < 1 && y < 0.1 * (1 - r2) + 0.01;
  },
};
const tentBase = voxelize(LAKE, baseCount);

let mode = "shape";
let current = "pile";
let tStart = 0;

const _q = new THREE.Quaternion(),
  _q2 = new THREE.Quaternion(),
  _qf = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4(),
  _p = new THREE.Vector3(),
  _s = new THREE.Vector3(1.15, 1.15, 1.15);
const Z = new THREE.Vector3(0, 0, 1);

const readQ = (arr, i, q) =>
  q.set(arr[i * 4], arr[i * 4 + 1], arr[i * 4 + 2], arr[i * 4 + 3]);
const writeQ = (arr, i, q) => {
  arr[i * 4] = q.x;
  arr[i * 4 + 1] = q.y;
  arr[i * 4 + 2] = q.z;
  arr[i * 4 + 3] = q.w;
};
const dirQuat = (dx, dy, dz, q) =>
  q.setFromEuler(
    _e.set(0, Math.atan2(-dz, dx), Math.atan2(dy, Math.hypot(dx, dz)), "YZX"),
  );
const yawQuat = (yaw, q) => q.setFromEuler(_e.set(0, yaw, 0, "YZX"));

{
  const S = shapes.pile;
  pos.set(S.pos);
  for (let i = 0; i < N; i++) {
    slotOf[i] = i;
    writeQ(qCur, i, yawQuat(S.yaw[i], _q));
    delay[i] = 0;
    dur[i] = 0.001;
    npts[i] = 1;
    path.set(S.pos.subarray(i * 3, i * 3 + 3), i * MAXP * 3);
  }
}

function chamfer(pts) {
  // Bevel every corner into a 45 degree piece; 90 degree turns read as mechanical.
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1],
      p = pts[i],
      b = pts[i + 1];
    const din = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    const dout = [b[0] - p[0], b[1] - p[1], b[2] - p[2]];
    const lin = Math.hypot(...din),
      lout = Math.hypot(...dout);
    const k = Math.min(0.9, lin * 0.45, lout * 0.45);
    out.push([
      p[0] - (din[0] / lin) * k,
      p[1] - (din[1] / lin) * k,
      p[2] - (din[2] / lin) * k,
    ]);
    out.push([
      p[0] + (dout[0] / lout) * k,
      p[1] + (dout[1] / lout) * k,
      p[2] + (dout[2] / lout) * k,
    ]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function circuitPath(i, A, B) {
  // Bots near each other share a route pattern, so they travel in bundles.
  const bundle = hash(
    Math.floor(A[0] / 3) * 13.7 +
      Math.floor(A[2] / 3) * 7.3 +
      Math.floor(A[1] / 3) * 3.1,
  );
  const diagFirst = bundle < 0.5;
  const dx = B[0] - A[0],
    dz = B[2] - A[2];
  const hor = Math.hypot(dx, dz);
  const sx = Math.sign(dx),
    sz = Math.sign(dz);
  const m = Math.min(Math.abs(dx), Math.abs(dz));
  let pts;
  if (hor < 3) {
    const y = B[1];
    pts = [
      A,
      [A[0], y, A[2]],
      diagFirst
        ? [A[0] + sx * m, y, A[2] + sz * m]
        : [B[0] - sx * m, y, B[2] - sz * m],
      B,
    ];
  } else {
    // Long trips drop to a lane on the floor and flow there, the lava rig move.
    const lane = FOOT + CELL * Math.floor(bundle * 3);
    pts = [
      A,
      [A[0], lane, A[2]],
      diagFirst
        ? [A[0] + sx * m, lane, A[2] + sz * m]
        : [B[0] - sx * m, lane, B[2] - sz * m],
      [B[0], lane, B[2]],
      B,
    ];
  }
  const clean = [pts[0]];
  for (const p of pts.slice(1)) {
    const q = clean[clean.length - 1];
    if (Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) > 1e-3) clean.push(p);
  }
  const fin = chamfer(clean).slice(0, MAXP);
  npts[i] = fin.length;
  let L = 0;
  fin.forEach((p, n) => {
    path.set(p, (i * MAXP + n) * 3);
    if (n > 0) {
      const q = fin[n - 1];
      L += Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    }
    cum[i * MAXP + n] = L;
  });
  return { L, bundle };
}

function goToShape(name) {
  const S = shapes[name];
  if (!S) return;
  mode = "shape";
  current = name;
  const assign = matchSets(pos, S.pos, N);
  for (let i = 0; i < N; i++) {
    const s = assign[i];
    slotOf[i] = s;
    const A = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
    const B = [S.pos[s * 3], S.pos[s * 3 + 1], S.pos[s * 3 + 2]];
    const { L, bundle } = circuitPath(i, A, B);
    // Grows from the ground up: low slots fill first, so the structure builds.
    delay[i] = 1.0 * S.hNorm[s] + 0.3 * bundle;
    dur[i] = clamp(0.7 + L / 15, 0.7, 3.0);
    const flipper = (S.edge[s] && hash(i * 1.7) < 0.75) || hash(i * 5.3) < 0.06;
    nFlips[i] = flipper ? Math.max(1, Math.round(L / 2.2)) : 0;
    qFrom.set(qCur.subarray(i * 4, i * 4 + 4), i * 4);
    flipAcc[i] = 0;
  }
  tStart = clock.elapsedTime;
  setActive(name);
}

// ---------- tentacles ----------

const tentParam = new Float32Array((N - baseCount) * 4); // tid, u, angle, radial
{
  const nT = N - baseCount;
  for (let s = 0; s < nT; s++) {
    let u = 0;
    for (let tries = 0; tries < 30; tries++) {
      u = hash(s * 1.37 + tries * 91.1);
      const r = 1 - 0.78 * u;
      if (hash(s * 2.71 + tries * 17.3) < r * r) break;
    }
    tentParam[s * 4] = s % TENTACLES;
    tentParam[s * 4 + 1] = u;
    tentParam[s * 4 + 2] = hash(s * 4.13) * Math.PI * 2;
    tentParam[s * 4 + 3] = Math.pow(hash(s * 6.07), 0.35);
  }
}
const pointer = { target: new THREE.Vector3(8, 10, 4), last: -10 };
const tentPaths = Array.from({ length: TENTACLES }, () => ({
  pts: [],
  cum: [],
}));

function snap26(d) {
  const m = Math.max(Math.abs(d[0]), Math.abs(d[1]), Math.abs(d[2])) || 1;
  const c = d.map((v) => (Math.abs(v) > 0.38 * m ? Math.sign(v) : 0));
  const l = Math.hypot(...c) || 1;
  return c.map((v) => v / l);
}

function buildTentacles(time) {
  const P = pointer.target;
  for (let t = 0; t < TENTACLES; t++) {
    const th = (t / TENTACLES) * Math.PI * 2 + 0.4;
    const B = [Math.cos(th) * 3.2, 1.2, Math.sin(th) * 3.2];
    const T = [
      P.x + Math.cos(th) * 3.6,
      P.y + 0.9 * Math.sin(th * 2 + time * 0.8),
      P.z + Math.sin(th) * 3.6,
    ];
    const C = [B[0] * 1.6, Math.max(B[1] + 5, T[1] * 0.85 + 4), B[2] * 1.6];
    const samples = [];
    for (let n = 1; n <= 40; n++) {
      const u = n / 40,
        v = 1 - u;
      samples.push(
        [0, 1, 2].map((a) => v * v * B[a] + 2 * v * u * C[a] + u * u * T[a]),
      );
    }
    // Walk the smooth curve in fixed steps, snapping each step to the 26
    // lattice directions: the circuit-board conversion, done live.
    const L = 1.2;
    let cur = B.slice();
    const pts = [cur.slice()];
    for (const q of samples) {
      let guard = 0;
      while (
        Math.hypot(q[0] - cur[0], q[1] - cur[1], q[2] - cur[2]) > L &&
        guard++ < 20
      ) {
        const d = snap26([q[0] - cur[0], q[1] - cur[1], q[2] - cur[2]]);
        cur = [cur[0] + d[0] * L, cur[1] + d[1] * L, cur[2] + d[2] * L];
        pts.push(cur.slice());
      }
    }
    const c = [0];
    for (let n = 1; n < pts.length; n++) {
      const a = pts[n - 1],
        b = pts[n];
      c.push(c[n - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
    }
    tentPaths[t].pts = pts;
    tentPaths[t].cum = c;
  }
}

const _t = new THREE.Vector3(),
  _n1 = new THREE.Vector3(),
  _n2 = new THREE.Vector3(),
  UP = new THREE.Vector3(0, 1, 0);
function tentacleSlot(s, out) {
  const nT = N - baseCount;
  if (s >= nT) {
    const b = s - nT;
    out[0] = tentBase.pos[b * 3];
    out[1] = tentBase.pos[b * 3 + 1];
    out[2] = tentBase.pos[b * 3 + 2];
    return tentBase.edge[b] === 1;
  }
  const tp = tentPaths[tentParam[s * 4]];
  const u = tentParam[s * 4 + 1],
    ang = tentParam[s * 4 + 2],
    rad = tentParam[s * 4 + 3];
  const total = tp.cum[tp.cum.length - 1] || 1;
  const d = u * total;
  let n = 1;
  while (n < tp.cum.length - 1 && tp.cum[n] < d) n++;
  const a = tp.pts[n - 1],
    b = tp.pts[Math.min(n, tp.pts.length - 1)];
  const seg = tp.cum[n] - tp.cum[n - 1] || 1;
  const f = clamp((d - tp.cum[n - 1]) / seg, 0, 1);
  _t.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
  _n1.crossVectors(_t, UP);
  if (_n1.lengthSq() < 1e-4) _n1.set(1, 0, 0);
  _n1.normalize();
  _n2.crossVectors(_t, _n1);
  const r = (1.5 * Math.pow(1 - u, 0.9) + 0.35) * rad;
  const ca = Math.cos(ang) * r,
    sa = Math.sin(ang) * r;
  const x = a[0] + (b[0] - a[0]) * f + _n1.x * ca + _n2.x * sa;
  const y = a[1] + (b[1] - a[1]) * f + _n1.y * ca + _n2.y * sa;
  const z = a[2] + (b[2] - a[2]) * f + _n1.z * ca + _n2.z * sa;
  out[0] = Math.round(x / CELL) * CELL;
  out[1] = Math.max(FOOT, Math.round((y - FOOT) / CELL) * CELL + FOOT);
  out[2] = Math.round(z / CELL) * CELL;
  return rad > 0.78;
}

function goTentacles() {
  mode = "tentacle";
  current = "tentacle";
  buildTentacles(clock.elapsedTime);
  const T = new Float32Array(N * 3);
  const o = [0, 0, 0];
  for (let s = 0; s < N; s++) {
    tentacleSlot(s, o);
    T.set(o, s * 3);
  }
  slotOf = matchSets(pos, T, N);
  setActive("tentacle");
}

// ---------- pointer ----------

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const plane = new THREE.Plane();
canvas.addEventListener("pointermove", (ev) => {
  ndc.set(
    (ev.clientX / innerWidth) * 2 - 1,
    -(ev.clientY / innerHeight) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, camera);
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  fwd.y = 0;
  fwd.normalize().negate();
  plane.setFromNormalAndCoplanarPoint(fwd, new THREE.Vector3(0, 8, 0));
  const hit = new THREE.Vector3();
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
  ["sphere", "Orb"],
  ["wave", "Wave"],
  ["tentacle", "Tentacles"],
];
const modesEl = document.getElementById("modes");
const buttons = {};
MODES.forEach(([id, label], n) => {
  const b = document.createElement("button");
  b.type = "button";
  b.className =
    "rounded-xl px-3 py-2 text-sm text-neutral-400 transition-colors duration-150 hover:bg-white/10 hover:text-neutral-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/40 active:scale-[0.97] sm:px-4";
  b.innerHTML = `<span class="mr-1.5 text-neutral-600">${n + 1}</span>${label}`;
  b.addEventListener("click", () => {
    auto = false;
    select(id);
  });
  modesEl.appendChild(b);
  buttons[id] = b;
});
function setActive(id) {
  for (const [k, b] of Object.entries(buttons)) {
    b.classList.toggle("bg-white/10", k === id);
    b.classList.toggle("text-neutral-100", k === id);
  }
}
const select = (id) => (id === "tentacle" ? goTentacles() : goToShape(id));

let auto = params.get("auto") !== "0";
const AUTO_ORDER = ["tower", "hand", "sphere", "wave", "pile"];
let autoIdx = 0,
  nextAuto = 1.2;
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
  else if (ev.key === "t" || ev.key === "T") {
    auto = false;
    goTentacles();
  }
});
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------- frame ----------

const clock = new THREE.Clock();
const statsEl = document.getElementById("stats");
let frames = 0,
  fpsT = 0,
  fps = 0;
const tgt = [0, 0, 0];
setActive("pile");

function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const time = clock.elapsedTime;

  if (auto && time > nextAuto) {
    goToShape(AUTO_ORDER[autoIdx++ % AUTO_ORDER.length]);
    nextAuto = time + 6.5;
  }

  if (mode === "tentacle") {
    if (time - pointer.last > 2.5) {
      pointer.target.set(
        Math.sin(time * 0.4) * 10,
        10 + Math.sin(time * 0.7) * 3,
        Math.cos(time * 0.3) * 5,
      );
    }
    buildTentacles(time);
  }

  for (let i = 0; i < N; i++) {
    const i3 = i * 3;
    let x,
      y,
      z,
      flip = 0;
    if (mode === "shape") {
      const S = shapes[current];
      const s = slotOf[i];
      const e = clamp((time - tStart - delay[i]) / dur[i], 0, 1);
      const restYaw = S.yaw[s];
      if (e >= 1) {
        x = S.pos[s * 3];
        y = S.pos[s * 3 + 1];
        z = S.pos[s * 3 + 2];
        yawQuat(restYaw, _q);
        if (S.edge[s]) {
          // Idle ripple on the surface so a finished shape still reads as alive.
          const w = Math.sin(
            time * 1.8 - Math.hypot(x, z) * 0.35 - y * 0.4 + hash(i) * 0.6,
          );
          flip = Math.pow(Math.max(0, w), 10) * 0.6;
        }
      } else {
        const base = i * MAXP;
        const d = easeInOut(e) * cum[base + npts[i] - 1];
        let n = 1;
        while (n < npts[i] - 1 && cum[base + n] < d) n++;
        const a = (base + n - 1) * 3,
          b = (base + Math.min(n, npts[i] - 1)) * 3;
        const seg = cum[base + n] - cum[base + n - 1];
        const f = seg > 1e-5 ? clamp((d - cum[base + n - 1]) / seg, 0, 1) : 1;
        const dx = path[b] - path[a],
          dy = path[b + 1] - path[a + 1],
          dz = path[b + 2] - path[a + 2];
        x = path[a] + dx * f;
        y = path[a + 1] + dy * f;
        z = path[a + 2] + dz * f;
        if (e <= 0) readQ(qFrom, i, _q);
        else {
          readQ(qFrom, i, _q);
          if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 1e-4) {
            dirQuat(dx, dy, dz, _q2);
            _q.slerp(_q2, smoothstep(0, 0.12, e));
          }
          _q.slerp(yawQuat(restYaw, _q2), smoothstep(0.85, 1, e));
        }
        if (nFlips[i]) {
          flip = Math.PI * 2 * nFlips[i] * easeInOut(e);
          y += Math.abs(Math.sin(flip)) * 0.25;
        }
      }
      writeQ(qCur, i, _q);
    } else {
      const edge = tentacleSlot(slotOf[i], tgt);
      const isTent = slotOf[i] < N - baseCount;
      const u = isTent ? tentParam[slotOf[i] * 4 + 1] : 0;
      const k = 1 - Math.exp(-(isTent ? 3.5 + 6 * u : 4) * dt);
      const px = pos[i3],
        py = pos[i3 + 1],
        pz = pos[i3 + 2];
      x = px + (tgt[0] - px) * k;
      y = py + (tgt[1] - py) * k;
      z = pz + (tgt[2] - pz) * k;
      const mx = x - px,
        my = y - py,
        mz = z - pz;
      const moved = Math.hypot(mx, my, mz);
      readQ(qCur, i, _q);
      if (moved / dt > 4) dirQuat(mx, my, mz, _q2);
      else yawQuat((Math.round((y - FOOT) / CELL) % 2) * (Math.PI / 2), _q2);
      _q.slerp(_q2, 1 - Math.exp(-10 * dt));
      writeQ(qCur, i, _q);
      if (edge && moved > 0.01) flipAcc[i] += (moved / 0.9) * Math.PI;
      else {
        const home = Math.round(flipAcc[i] / (Math.PI * 2)) * Math.PI * 2;
        flipAcc[i] += (home - flipAcc[i]) * (1 - Math.exp(-6 * dt));
      }
      flip = flipAcc[i];
    }
    pos[i3] = x;
    pos[i3 + 1] = y;
    pos[i3 + 2] = z;
    if (flip) _q.multiply(_qf.setFromAxisAngle(Z, flip));
    _m.compose(_p.set(x, y, z), _q, _s);
    mesh.setMatrixAt(i, _m);
  }
  mesh.instanceMatrix.needsUpdate = true;

  controls.update();
  renderer.render(scene, camera);

  frames++;
  fpsT += dt;
  if (fpsT > 0.5) {
    fps = Math.round(frames / fpsT);
    frames = 0;
    fpsT = 0;
    statsEl.textContent = `${N.toLocaleString()} bots, ${fps} fps`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
