// Spike (D1): does a UV set land inside the lightmap's charts? debug_chart_color holds one flat
// colour per chart, so a triangle of the right UV set samples one colour at its centroid and near
// its corners, and a wrong UV set samples unrelated charts.
import path from 'node:path';
import sharp from 'sharp';

export async function loadChart(map) {
  const file = path.join('assets/spike/lm', map, 'maps', map, 'lightmaps', 'debug_chart_color.png');
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, W: info.width, H: info.height };
}

/** Over triangles covering >= minArea texels: { big, agree } (centroid and 3/4-to-corner samples, one colour). */
export function uvAgreement(chart, uv, idx, minArea = 4) {
  const { data, W, H } = chart;
  const col = (u, v) => { const x = Math.floor(u * W), y = Math.floor(v * H); if (!(x >= 0 && y >= 0 && x < W && y < H)) return -1; const o = (y * W + x) * 3; return (data[o] << 16) | (data[o + 1] << 8) | data[o + 2]; };
  const near = (a, b) => a >= 0 && b >= 0 && Math.abs((a >> 16) - (b >> 16)) <= 24 && Math.abs(((a >> 8) & 255) - ((b >> 8) & 255)) <= 24 && Math.abs((a & 255) - (b & 255)) <= 24;
  const n = idx ? idx.length : uv.length / 2;
  let big = 0, agree = 0;
  for (let i = 0; i + 2 < n; i += 3) {
    const q = [0, 1, 2].map((k) => { const j = idx ? idx[i + k] : i + k; return [uv[2 * j], uv[2 * j + 1]]; });
    const area = Math.abs((q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[2][0] - q[0][0]) * (q[1][1] - q[0][1])) / 2 * W * H;
    if (area < minArea) continue;
    big++;
    const c = [(q[0][0] + q[1][0] + q[2][0]) / 3, (q[0][1] + q[1][1] + q[2][1]) / 3], cc = col(c[0], c[1]);
    let good = cc >= 0;
    for (const v of q) if (good) good = near(cc, col(c[0] + 0.75 * (v[0] - c[0]), c[1] + 0.75 * (v[1] - c[1])));
    if (good) agree++;
  }
  return { big, agree };
}
