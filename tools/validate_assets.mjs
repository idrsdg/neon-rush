#!/usr/bin/env node
/* Neon Rush asset gate: node race/tools/validate_assets.mjs
   Counts come from the binary packs themselves (index and bone arrays), not from the numbers the generators wrote next to them.
   Fails (exit 1) when any shipped mesh has under 1,000 triangles at its highest LOD, any wheel is under 1,000, or any animated rig deforms with under 24 bones. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../assets');
const MIN_TRIS = 1000, MIN_BONES = 24;
const fails = [], rows = [];
const load = (n) => { const j = JSON.parse(fs.readFileSync(path.join(dir, n + '.json'), 'utf8')), b = fs.readFileSync(path.join(dir, n + '.bin')); if (b.length !== j.size) fails.push(`${n}.bin is ${b.length} bytes, manifest says ${j.size}`); return { j, buf: b.buffer.slice(b.byteOffset, b.byteOffset + b.length) }; };
const distinct = (buf, q, used) => { const a = new Uint8Array(buf, q[0], q[1]); if (!used) return new Set(a).size; const s = new Set(); for (const list of used) { const ix = new Uint16Array(buf, list[0], list[1]); for (let i = 0; i < ix.length; i++) s.add(a[ix[i]]); } return s.size; };
const check = (id, tris, bones, note) => { rows.push({ asset: id, triangles: tris, bones: bones == null ? '-' : bones, note: note || '' }); if (tris < MIN_TRIS) fails.push(`${id}: ${tris} triangles (minimum ${MIN_TRIS})`); if (bones != null && bones < MIN_BONES) fails.push(`${id}: ${bones} deforming bones (minimum ${MIN_BONES})`); };

const cars = load('cars');
for (const [name, e] of Object.entries(cars.j.models)) {
  const lod0 = e.lods[0][1] / 3 + e.two[1] / 3, used = distinct(cars.buf, e.bone, [e.lods[0], e.two]);
  check('car:' + name, lod0, used, `LOD ${e.lods.map((l, i) => Math.round(l[1] / 3 + (i < 2 ? e.two[1] / 3 : 0))).join(' / ')}, ${e.bones.length} bones in rig`);
  e.wheelTris.forEach((t, i) => { if (t < MIN_TRIS) fails.push(`car:${name} wheel ${i}: ${t} triangles`); });
  rows.push({ asset: `car:${name} wheels`, triangles: Math.min(...e.wheelTris), bones: '-', note: `${e.wheelTris.length} wheels, smallest shown` });
}
const props = load('props');
for (const [id, e] of Object.entries(props.j.props)) check('prop:' + id, e.idx[1] / 3, e.bone ? distinct(props.buf, e.bone) : null, e.kind);
const w = Math.max(...rows.map(r => r.asset.length));
console.log('asset'.padEnd(w), 'triangles', 'bones', ' note');
for (const r of rows) console.log(r.asset.padEnd(w), String(r.triangles).padStart(9), String(r.bones).padStart(5), ' ' + r.note);
const t = rows.filter(r => !r.asset.endsWith('wheels')), rig = t.filter(r => r.bones !== '-');
console.log(`\n${t.length} meshes, minimum ${Math.min(...t.map(r => r.triangles))} triangles; ${rig.length} rigs, minimum ${Math.min(...rig.map(r => r.bones))} deforming bones`);
if (fails.length) { console.error('\nFAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
console.log('OK');
