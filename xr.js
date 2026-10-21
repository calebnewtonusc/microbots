// Vision Pro mode. Safari on visionOS runs WebXR immersive-vr with hand
// tracking, so the same page goes immersive with no native build.
//
// Scale: the bot model is 0.54 scene units and Disney's bot is 1.5 inches
// (38.1 mm), so 14.2 units is one real meter. The camera sits in a rig scaled
// by that, which makes every bot its true size in the room. ?scale=2 makes the
// world twice as big, for tuning on the headset without a code change.
//
// Input: a pinch fires onPinch(handedness). visionOS reports gaze-and-pinch as
// a transient-pointer source, and tracked hands as hand sources; both send
// select events. Index fingertips go to onTips every frame, in scene units.
import * as THREE from "three";

const UNITS_PER_METER = 0.54 / 0.0381;

export async function setupXR({
  renderer,
  scene,
  camera,
  standAt,
  onPinch,
  onTips,
  onStart,
  onEnd,
}) {
  const params = new URLSearchParams(location.search);
  // ?emulate loads Meta's IWER runtime so the immersive path can be tested in a
  // desktop browser. It never loads otherwise.
  if (params.has("emulate")) {
    const { XRDevice, metaQuest3 } = await import(
      "https://cdn.jsdelivr.net/npm/iwer@2.5.0/+esm"
    );
    const device = new XRDevice(metaQuest3);
    device.installRuntime({ forceInstall: true });
    device.stereoEnabled = true;
    window.__xrDevice = device;
  }

  const k = UNITS_PER_METER / (parseFloat(params.get("scale") ?? "") || 1);
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType("local-floor");
  renderer.xr.setFoveation(1);

  const rig = new THREE.Group();
  scene.add(rig);
  rig.add(camera);

  const hands = [0, 1].map((i) => {
    const hand = renderer.xr.getHand(i);
    rig.add(hand);
    return hand;
  });
  const controllers = [0, 1].map((i) => {
    const c = renderer.xr.getController(i);
    c.addEventListener(
      "connected",
      (e) => (c.userData.handedness = e.data.handedness),
    );
    c.addEventListener("selectstart", () => {
      // Read by the ?emulate test to count pinches.
      (window.__xrLog ??= []).push(c.userData.handedness);
      onPinch?.(c.userData.handedness ?? "right");
    });
    rig.add(c);
    return c;
  });

  let saved = null;
  renderer.xr.addEventListener("sessionstart", () => {
    saved = { pos: camera.position.clone(), quat: camera.quaternion.clone() };
    rig.position.set(standAt[0], 0, standAt[2]);
    rig.scale.setScalar(k);
    onStart?.();
  });
  renderer.xr.addEventListener("sessionend", () => {
    rig.position.set(0, 0, 0);
    rig.scale.setScalar(1);
    camera.position.copy(saved.pos);
    camera.quaternion.copy(saved.quat);
    onEnd?.();
  });

  const tips = [new THREE.Vector3(), new THREE.Vector3()];
  function update() {
    if (!renderer.xr.isPresenting || !onTips) return;
    const out = [];
    hands.forEach((hand, i) => {
      const tip = hand.joints?.["index-finger-tip"];
      if (tip && tip.visible) out.push(tip.getWorldPosition(tips[i]));
    });
    if (out.length) onTips(out);
  }

  const supported = navigator.xr
    ? await navigator.xr.isSessionSupported("immersive-vr").catch(() => false)
    : false;
  mountButton(renderer, supported);
  return { update, rig, controllers };
}

function mountButton(renderer, supported) {
  const wrap = document.createElement("div");
  wrap.className =
    "pointer-events-auto fixed right-4 top-4 z-10 sm:right-6 sm:top-6";
  const b = document.createElement("button");
  b.type = "button";
  b.className =
    "rounded-xl border border-black/10 bg-white/50 px-3 py-1.5 text-sm font-medium text-neutral-900 backdrop-blur-md transition-colors duration-150 hover:bg-white/80 active:scale-[0.97] focus-visible:outline focus-visible:outline-2 focus-visible:outline-black/40 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-white/50";
  if (!supported) {
    b.disabled = true;
    b.textContent = "Open in Safari on Vision Pro to go immersive";
  } else {
    b.textContent = "Enter Vision Pro";
    let session = null;
    b.addEventListener("click", async () => {
      if (session) return session.end();
      try {
        session = await navigator.xr.requestSession("immersive-vr", {
          optionalFeatures: ["local-floor", "hand-tracking"],
        });
      } catch (err) {
        b.textContent = `Couldn't start: ${err.message}`;
        return;
      }
      session.addEventListener("end", () => {
        session = null;
        b.textContent = "Enter Vision Pro";
      });
      b.textContent = "Exit";
      await renderer.xr.setSession(session);
    });
  }
  wrap.appendChild(b);
  document.body.appendChild(wrap);
}
