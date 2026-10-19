# Microbots

Hiro's microbots from Big Hero 6, in the browser with Three.js. 6,000 instanced bots build towers, a hand, an orb and a curling wave out of a swarm lake, and five tentacles chase the cursor.

This is v1 of a Vision Pro piece. The laptop version comes first so the motion is right before hand tracking goes in.

## Run it

```bash
cd ~/code/personal/microbots && python3 -m http.server 5173
```

Open http://localhost:5173. Keys 1 to 6 pick a mode, A toggles autoplay, H hides the UI for recording. `?n=10000` changes the bot count, `?auto=0` starts paused.

## How it moves

It follows what Disney's effects team described in the SideFX Big Hero 6 case study: no flocking and no fluid sim.

- Every shape is voxelized into exactly N lattice slots. Surplus comes out of the hidden interior, and a deficit pools around the base as a two-layer lake.
- Old and new slots are paired by recursive equal-count bisection, so each region of the old shape feeds the matching region of the new one.
- Bots travel on circuit-board paths: down to a floor lane, an octilinear run, then up, with every corner beveled to 45 degrees. Nearby bots share a route pattern, so they move in bundles.
- Shapes grow from the ground up. Low slots fill first.
- Interior bots slide. Only bots bound for the visible edge run the end-over-end flip, which is Disney's fix for a swarm that looked noisy when every bot walked.
- Tentacles walk a smooth curve in fixed steps snapped to the 26 lattice directions, live, every frame.

## Next

WebXR on Vision Pro, then native visionOS with RealityKit and hand tracking. Research notes live in the second brain under `projects/big-hero-6-microbots`.

All glory to God! ✝️❤️
