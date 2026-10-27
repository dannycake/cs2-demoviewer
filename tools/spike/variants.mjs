import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, weld, simplify, textureCompress, flatten, join, meshopt } from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import fs from 'node:fs'; import zlib from 'node:zlib';
const [,, inPath, mode, ratio='0.35', err='0.002', texSize='256'] = process.argv;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(inPath); const root = doc.getRoot();
const DROP = /(_s_mesh_overlay|blocklight|_bl_mesh|^unnamed_.*hammer_mesh|skybox|sky_|fog_card|blocker|clip)/i;
for (const node of root.listNodes()) { const m = node.getMesh(); if (!m) continue;
  const toolMat = m.listPrimitives().some(p => (p.getMaterial()?.getExtras()?.vmat?.Name || '').includes('materials/tools/'));
  if (DROP.test(node.getName()||'') || toolMat) node.dispose(); }
if (mode === 'avgcolor') {
  for (const mat of root.listMaterials()) {
    const t = mat.getBaseColorTexture();
    if (t) { try { const st = await sharp(t.getImage()).stats(); const c = st.channels.slice(0,3).map(ch => Math.pow(ch.mean/255, 2.2)); mat.setBaseColorFactor([c[0],c[1],c[2],1]); } catch {} }
    mat.setBaseColorTexture(null); mat.setNormalTexture(null); mat.setMetallicRoughnessTexture(null); mat.setOcclusionTexture(null); mat.setEmissiveTexture(null);
  }
  for (const t of root.listTextures()) t.dispose();
  for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) for (const s of ['TEXCOORD_0','TEXCOORD_1','TANGENT','COLOR_0']) if (p.getAttribute(s)) p.setAttribute(s, null);
}
await doc.transform(dedup(), prune(), flatten(), join(), weld());
await MeshoptSimplifier.ready;
await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: +ratio, error: +err, lockBorder: true }));
if (mode === 'textured') await doc.transform(textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [+texSize, +texSize], quality: 70 }));
await doc.transform(prune(), meshopt({ encoder: MeshoptEncoder, level: 'high' }));
let tris = 0; for (const m of root.listMeshes()) for (const p of m.listPrimitives()) tris += (p.getIndices()?.getCount() ?? 0) / 3;
const out = `${mode}_${ratio}_${err}_${texSize}.glb`; await io.write(out, doc);
const raw = fs.statSync(out).size, gz = zlib.gzipSync(fs.readFileSync(out)).length;
console.log(`${out}\t${(raw/1e6).toFixed(1)} MB\tgz ${(gz/1e6).toFixed(1)} MB\ttris ${tris|0}\ttextures ${root.listTextures().length}`);
