import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, weld, simplify, textureCompress, flatten, join, meshopt, resample } from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import fs from 'node:fs';

const [,, inPath, outPath, mode = 'textured'] = process.argv;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const t0 = Date.now();
const doc = await io.read(inPath);
const log = (m) => console.log(`[${((Date.now()-t0)/1000).toFixed(1)}s] ${m}`);
const root = doc.getRoot();
const DROP = /(_s_mesh_overlay|blocklight|_bl_mesh|^unnamed_.*hammer_mesh|skybox|sky_|fog_card|blocker|clip)/i;
let dropped = 0, kept = 0;
for (const node of root.listNodes()) {
  const name = node.getName() || '';
  const mesh = node.getMesh();
  if (!mesh) continue;
  const matName = mesh.listPrimitives().map(p => p.getMaterial()?.getName() || '').join(',');
  const toolMat = mesh.listPrimitives().some(p => (p.getMaterial()?.getExtras()?.vmat?.Name || '').includes('materials/tools/'));
  if (DROP.test(name) || toolMat || /^tools/.test(matName)) { node.setMesh(null); node.dispose(); dropped++; } else kept++;
}
log(`nodes dropped=${dropped} kept=${kept}`);
if (mode === 'flat') {
  for (const tex of root.listTextures()) tex.dispose();
  for (const mat of root.listMaterials()) { mat.setBaseColorTexture(null); mat.setNormalTexture(null); mat.setMetallicRoughnessTexture(null); mat.setOcclusionTexture(null); mat.setEmissiveTexture(null); }
  for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) { for (const s of ['TEXCOORD_0','TEXCOORD_1','TANGENT']) { const a = p.getAttribute(s); if (a) { p.setAttribute(s, null); } } }
}
await doc.transform(dedup(), prune());
log('dedup+prune');
await doc.transform(flatten(), join());
log('flatten+join');
await doc.transform(weld());
log('weld');
await MeshoptSimplifier.ready;
await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: 0.35, error: 0.002, lockBorder: true }));
log('simplify');
if (mode === 'textured') {
  await doc.transform(textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [256, 256], quality: 60 }));
  log('textures');
}
await doc.transform(prune(), meshopt({ encoder: MeshoptEncoder, level: 'high' }));
log('meshopt');
let tris = 0; for (const m of root.listMeshes()) for (const p of m.listPrimitives()) tris += (p.getIndices()?.getCount() ?? 0) / 3;
await io.write(outPath, doc);
log(`wrote ${outPath} ${(fs.statSync(outPath).size/1e6).toFixed(1)} MB tris=${tris} meshes=${root.listMeshes().length} textures=${root.listTextures().length}`);
