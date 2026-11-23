#!/usr/bin/env node
/* Step 1 of the car pipeline. Runs our own car models (gfx/car3d.js) offline and writes their geometry and painted atlases as raw files,
   which tools/build_cars.py (Blender) reads to rig, detail, LOD and pack them.
   node race/tools/dump_cars.mjs <outDir> */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2];
if (!out) { console.error('usage: dump_cars.mjs <outDir>'); process.exit(2); }
fs.mkdirSync(out, { recursive: true });
const ctx = {}; ctx.self = ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(here, '../gfx/car3d.js'), 'utf8'), ctx);
const A = ctx.NR_CAR3D;
A.setWheelSeg(96);
const TRAFFIC = new Set(['hatch', 'van', 'truck', 'bike']);
const bin = (f, a) => fs.writeFileSync(path.join(out, f), Buffer.from(a.buffer, a.byteOffset, a.byteLength));
const index = {};
for (const name of A.MODELS) {
  const traffic = TRAFFIC.has(name), W = traffic ? 1024 : 2048, H = W / 2;
  const r = A.bake(name, { traffic }, W, H);
  bin(`${name}.col.rgba`, r.col); bin(`${name}.mask.rgba`, r.mask); bin(`${name}.ids.rg`, r.ids); bin(`${name}.emi.rgba`, r.emi);
  const geo = (g, f) => { bin(f + '.pos', g.pos); bin(f + '.nrm', g.nrm); bin(f + '.uv', g.uv); if (g.uv2) bin(f + '.uv2', g.uv2); bin(f + '.idx', new Uint32Array(g.idx)); return { nv: g.pos.length / 3, ni: g.idx.length }; };
  const e = { W, H, meta: r.meta, body: geo(r.body, `${name}.body`), body2: geo(r.body2, `${name}.body2`), wheels: [] };
  r.wheels.forEach((w, i) => { const g = geo(w, `${name}.w${i}`); e.wheels.push(Object.assign(g, { x: w.x, z: w.z, r: w.r, w: w.w, ang: w.ang, side: w.side, front: !!w.front, inner: !!w.inner })); });
  index[name] = e;
  console.log(name, W, 'tris', (r.body.idx.length + r.body2.idx.length + r.wheels.reduce((a, w) => a + w.idx.length, 0)) / 3, 'wheel', r.wheels[0].idx.length / 3);
}
fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify(index));
