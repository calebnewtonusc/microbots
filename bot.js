// Hiro's microbot from Caleb's Microbot.STL (86,900 triangles, 38.1 mm long,
// the 1.5 inches Disney gives for the bot), decimated in Blender to 216
// triangles ("lo") so tens of thousands of instances stay at frame rate, and
// to 68 ("xlo") for the 96k-bot swarm, where 216 dropped Chrome to 20 fps.
import * as THREE from "three";
import { STLLoader } from "three/addons/loaders/STLLoader.js";

// Returns geometry with its long axis on local x, centered, `len` long.
export async function loadBotGeometry(len, fallback, detail = "lo") {
  try {
    const g = await new STLLoader().loadAsync(new URL(`./assets/microbot_${detail}.stl`, import.meta.url).href);
    g.computeBoundingBox();
    const c = new THREE.Vector3();
    g.boundingBox.getCenter(c);
    g.translate(-c.x, -c.y, -c.z);
    const size = new THREE.Vector3();
    g.boundingBox.getSize(size);
    // The STL stands on z; lay it along x.
    if (size.z >= size.x && size.z >= size.y) g.rotateY(Math.PI / 2);
    else if (size.y >= size.x) g.rotateZ(-Math.PI / 2);
    g.computeBoundingBox();
    const L = g.boundingBox.max.x - g.boundingBox.min.x;
    g.scale(len / L, len / L, len / L);
    g.computeVertexNormals();
    return g;
  } catch (err) {
    console.error("microbot STL failed to load, using the cone stand-in", err);
    return fallback();
  }
}
