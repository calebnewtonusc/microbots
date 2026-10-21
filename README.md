# Microbots

Hiro's microbots from Big Hero 6, in the browser with Three.js. Two scenes: the Yokai swarm (96,000 bots in daylight building a tower, a hand, a wave and cursor-chasing tentacles out of a tangle of bundles) and the SFIT showcase (22,000 bots in a lattice box that re-forms when you flick one more bot in).

This is v1 of a Vision Pro piece. The laptop version comes first so the motion is right before hand tracking goes in.

## How it moves

Built from three sources, all read: Disney's SIGGRAPH 2015 talk (Byun et al., "Procedural Animation Technology behind Microbots in Big Hero 6"), the SideFX case study, and frame-by-frame reads of the showcase clip.

- The bot is Caleb's Microbot.STL (38.1 mm, the 1.5 inches Disney gives), decimated in Blender to 216 triangles for the showcase and 68 for the swarm.
- Swarm structures are bundles on 45 degree circuit-board paths. Each lane in a bundle is the lane before it extruded one spacing out, so a jog born in one lane carries into every lane after it: the paper's history-dependent generator.
- Flipping follows the paper's cycle: the bottom layer is static, and top-edge bots lift, pass over pivoting on their front tip, and put down one bot length ahead. Interior bots slide, which SideFX says Disney did because walking everything read as noise.
- Showcase +1 re-solves the lattice for N + 1 bots. A wave runs out from where the bot lands and the box re-forms behind it into the next pattern (fine hex, bold open hex, triangles, diamonds), timed from the clip at 0:22.
- The hand is real 3D: a wrist that flares into the base, a rounded palm, fingers as bending phalanx cylinders, and a webbed thumb, all with the lattice wrapped around them.
- Bot placement runs in the vertex shader. The CPU only rebuilds center lines and lattice slots.

## Live

https://microbots.up.railway.app (showcase at /showcase.html). Railway project `microbots`, deployed with `railway up`, not GitHub-linked, so redeploy by hand after edits.

## Vision Pro

Open https://microbots.up.railway.app in Safari on the Vision Pro and tap Enter Vision Pro. It's WebXR immersive-vr, so there's no app to build or install.

- Bots are their real size, 1.5 inches, and the swarm sits on your floor about 1.4 m in front of you. Add `?scale=2` to the URL for a world twice as big.
- Swarm: pinch to go to the next shape. In Tentacles they reach for your index fingertip.
- Showcase: right hand pinch flicks one more bot in, left hand pinch morphs between the box and the hand.
- `?emulate` loads Meta's IWER runtime so the immersive path runs in a desktop browser for testing.

Not tried on a real headset yet. The swarm is 96,000 bots with 4096 shadows in stereo, so if it stutters, `?strands=40` halves the count.

## Run it

```bash
cd ~/code/personal/microbots && python3 -m http.server 5173
```

Swarm at http://localhost:5173 (keys 1 to 5, A autoplay, H hide UI). Showcase at http://localhost:5173/showcase.html (Space adds a bot, M morphs box and hand).

## Next

WebXR on Vision Pro, then native visionOS with RealityKit and hand tracking. Research notes live in the second brain under `projects/big-hero-6-microbots`.

All glory to God! ✝️❤️
