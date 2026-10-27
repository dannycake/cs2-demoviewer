import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(process.argv[2]); const root = doc.getRoot();
const rows = [];
for (const node of root.listNodes()) { const mesh = node.getMesh(); if (!mesh) continue;
  for (const p of mesh.listPrimitives()) { const mat = p.getMaterial(); const pos = p.getAttribute('POSITION'); if (!pos) continue;
    const mn = pos.getMin([]), mx = pos.getMax([]); const ext = [mx[0]-mn[0], mx[1]-mn[1], mx[2]-mn[2]].sort((a,b)=>b-a);
    const area = ext[0]*ext[1]; const tris = (p.getIndices()?.getCount() ?? 0)/3;
    const vmat = mat?.getExtras()?.vmat?.Name || ''; const shader = mat?.getExtras()?.vmat?.Shader || mat?.getExtras()?.vmat?.shader || '';
    rows.push({ node: node.getName(), mat: mat?.getName(), tex: !!mat?.getBaseColorTexture(), alpha: mat?.getAlphaMode(), vmat, shader, area: +area.toFixed(0), tris, extras: JSON.stringify(mat?.getExtras()||{}).slice(0,160) }); } }
rows.sort((a,b)=>b.area-a.area);
console.log('untextured, largest first:');
for (const r of rows.filter(r=>!r.tex).slice(0,25)) console.log(JSON.stringify(r));
console.log('\ntextured but huge (area>2000):');
for (const r of rows.filter(r=>r.tex && r.area>2000).slice(0,15)) console.log(JSON.stringify({node:r.node,mat:r.mat,vmat:r.vmat,area:r.area,tris:r.tris}));
console.log('\nmaterial extras keys sample:', JSON.stringify(root.listMaterials()[0].getExtras()).slice(0,400));
