// Skin-preservation check for the player pipeline: shrink-player.mjs keeps a
// simplified mesh only when skinSurvives(before, after) holds, and verifies the
// finished file against the raw export the same way.

/** Animation (clip) names, sorted. */
export function clipNames(doc) {
  return doc.getRoot().listAnimations().map((a) => a.getName()).sort();
}

/** `JOINTS_n` / `WEIGHTS_n` semantics of a primitive. */
function skinSemantics(prim) {
  return prim.listSemantics().filter((s) => /^(JOINTS|WEIGHTS)_\d+$/.test(s));
}

/** Mesh nodes that carry a skin. */
function skinnedNodes(doc) {
  return doc.getRoot().listNodes().filter((n) => n.getMesh() && n.getSkin());
}

/** Largest joint index any JOINTS_n attribute of the document references (-1 if none). */
function maxJointIndex(doc) {
  let max = -1;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      for (const s of prim.listSemantics()) {
        if (!s.startsWith('JOINTS_')) continue;
        const arr = prim.getAttribute(s).getArray();
        for (let i = 0; i < arr.length; i++) if (arr[i] > max) max = arr[i];
      }
    }
  }
  return max;
}

/**
 * True when `after` still animates like `before`:
 * - both have exactly one skin, with the same joint count, and every JOINTS_n
 *   index in `after` is below it;
 * - the same number of mesh nodes is skinned, every one with that skin;
 * - every primitive that had JOINTS_n/WEIGHTS_n attributes still has all of them
 *   (primitives are matched by mesh and primitive position, so a primitive that
 *   simplification deleted fails the check);
 * - every clip of `before` is present in `after` with the same channel count.
 * @param {import('@gltf-transform/core').Document} before
 * @param {import('@gltf-transform/core').Document} after
 */
export function skinSurvives(before, after) {
  const b = before.getRoot(), a = after.getRoot();

  if (b.listSkins().length !== 1 || a.listSkins().length !== 1) return false;
  const joints = b.listSkins()[0].listJoints().length;
  const skin = a.listSkins()[0];
  if (skin.listJoints().length !== joints) return false;
  if (maxJointIndex(after) >= joints) return false;

  const nodesBefore = skinnedNodes(before), nodesAfter = skinnedNodes(after);
  if (nodesAfter.length !== nodesBefore.length) return false;
  if (nodesAfter.some((n) => n.getSkin() !== skin)) return false;

  const meshesB = b.listMeshes(), meshesA = a.listMeshes();
  if (meshesA.length !== meshesB.length) return false;
  for (let m = 0; m < meshesB.length; m++) {
    const primsB = meshesB[m].listPrimitives(), primsA = meshesA[m].listPrimitives();
    if (primsA.length !== primsB.length) return false;
    for (let p = 0; p < primsB.length; p++) {
      const kept = new Set(skinSemantics(primsA[p]));
      if (!skinSemantics(primsB[p]).every((s) => kept.has(s))) return false;
    }
  }

  const channels = new Map(a.listAnimations().map((anim) => [anim.getName(), anim.listChannels().length]));
  for (const anim of b.listAnimations()) {
    if (channels.get(anim.getName()) !== anim.listChannels().length) return false;
  }
  return true;
}
