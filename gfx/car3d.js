/* Neon Rush car renderer (ours). Every car, van, truck and bike is a small 3D model built from lofted cross-sections in code,
   rasterised here in software (z-buffer, per-pixel normals, clear-coat paint with sky reflections, glass, chrome, rubber, lenses)
   and returned as sprites: one per yaw angle and time of day, plus separate wheel sprites per spin phase for the cars that animate their wheels.
   Runs inside a Web Worker when it can (this same file), so the menu stays smooth while the garage is being "photographed".
   No assets, no build step. Car space: x right, y up, z forward, metres. */
(function(root){
'use strict';
const PI=Math.PI, TAU=PI*2;
const clamp=(v,a,b)=>v<a?a:v>b?b:v, lerp=(a,b,t)=>a+(b-a)*t, smooth=(a,b,x)=>{ const t=clamp((x-a)/(b-a),0,1); return t*t*(3-2*t); };
const frac=x=>x-Math.floor(x); const hyp=(a,b,c)=>Math.sqrt(a*a+b*b+(c===undefined?0:c*c));
function hex(c){ return [parseInt(c.slice(1,3),16)/255,parseInt(c.slice(3,5),16)/255,parseInt(c.slice(5,7),16)/255]; }
function mixc(a,b,t){ return [lerp(a[0],b[0],t),lerp(a[1],b[1],t),lerp(a[2],b[2],t)]; }
// piecewise smooth curve through knots [[u,v],...]
function curve(k){ return u=>{ if (u<=k[0][0]) return k[0][1]; for (let i=1;i<k.length;i++){ if (u<=k[i][0]){ const a=k[i-1], b=k[i], t=(u-a[0])/(b[0]-a[0]); const s=t*t*(3-2*t); return a[1]+(b[1]-a[1])*s; } } return k[k.length-1][1]; }; }

// ------------------------------------------------------------------ meshes
// mesh: {v: Float32Array-ish list of vertices [px,py,pz, lx,ly,lz, nx,ny,nz], t:[a,b,c,...], part, paint, cull}
function Mesh(part){ return {v:[], t:[], part:part||0, flat:null}; }
function addV(m,x,y,z,lx,ly,lz){ m.v.push(x,y,z,lx,ly,lz,0,0,0); return m.v.length/9-1; }
// loft: rings[i] = {c:[cx,cy,cz] (ring centre used to orient faces), p:[[x,y,z],...]} all same length, closed rings
function loft(m,rings,capA,capB,local){ const n=rings[0].p.length, base=m.v.length/9;
  for (const r of rings) for (const q of r.p){ const L=local?local(q):q; addV(m,q[0],q[1],q[2],L[0],L[1],L[2]); }
  const F=[];
  for (let i=0;i<rings.length-1;i++) for (let j=0;j<n;j++){ const a=base+i*n+j, b=base+i*n+(j+1)%n, c=base+(i+1)*n+(j+1)%n, d=base+(i+1)*n+j;
    const cc=rings[i].c; quad(m,a,b,c,d,cc,rings[i+1].c); }
  smoothNormals(m,base,m.v.length/9);
  if (capA) cap(m,rings[0],-1,capA); if (capB) cap(m,rings[rings.length-1],1,capB);
}
function quad(m,a,b,c,d,c0,c1){ const V=m.v; const ax=V[a*9],ay=V[a*9+1],az=V[a*9+2];
  const cx=(c0[0]+c1[0])/2, cy=(c0[1]+c1[1])/2, cz=(c0[2]+c1[2])/2;
  // orient: face normal must point away from the axis centre
  const ux=V[b*9]-ax,uy=V[b*9+1]-ay,uz=V[b*9+2]-az, vx=V[d*9]-ax,vy=V[d*9+1]-ay,vz=V[d*9+2]-az;
  let nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx; const mx=(ax+V[c*9])/2-cx, my=(ay+V[c*9+1])/2-cy, mz=(az+V[c*9+2])/2-cz;
  if (nx*mx+ny*my+nz*mz<0){ m.t.push(a,d,c, a,c,b); } else { m.t.push(a,b,c, a,c,d); } }
function triN(V,a,b,c){ const ax=V[a*9],ay=V[a*9+1],az=V[a*9+2]; const ux=V[b*9]-ax,uy=V[b*9+1]-ay,uz=V[b*9+2]-az, vx=V[c*9]-ax,vy=V[c*9+1]-ay,vz=V[c*9+2]-az; return [uy*vz-uz*vy, uz*vx-ux*vz, ux*vy-uy*vx]; }
function smoothNormals(m,v0,v1){ const V=m.v, T=m.t;
  // positions can repeat (collapsed rings): accumulate by position key so seams stay smooth
  const key=i=>Math.round(V[i*9]*2000)+','+Math.round(V[i*9+1]*2000)+','+Math.round(V[i*9+2]*2000); const acc=new Map();
  for (let k=0;k<T.length;k+=3){ const a=T[k],b=T[k+1],c=T[k+2]; if (a<v0||a>=v1) continue; const n=triN(V,a,b,c); for (const i of [a,b,c]){ const kk=key(i); let s=acc.get(kk); if (!s){ s=[0,0,0]; acc.set(kk,s); } s[0]+=n[0]; s[1]+=n[1]; s[2]+=n[2]; } }
  for (let i=v0;i<v1;i++){ const s=acc.get(key(i)); if (!s) continue; const l=hyp(s[0],s[1],s[2])||1; V[i*9+6]=s[0]/l; V[i*9+7]=s[1]/l; V[i*9+8]=s[2]/l; } }
function cap(m,ring,dir,kind){ const V=m.v; const n=ring.p.length; let cx=0,cy=0,cz=0; for (const q of ring.p){ cx+=q[0]; cy+=q[1]; cz+=q[2]; } cx/=n; cy/=n; cz/=n;
  const sub=Mesh(kind); sub.flat=1; const ci=addV(sub,cx,cy,cz,cx,cy,cz); const idx=[]; for (const q of ring.p) idx.push(addV(sub,q[0],q[1],q[2],q[0],q[1],q[2]));
  const ax=ring.axis||[0,0,1]; for (let i=0;i<sub.v.length/9;i++){ sub.v[i*9+6]=ax[0]*dir; sub.v[i*9+7]=ax[1]*dir; sub.v[i*9+8]=ax[2]*dir; }
  for (let j=0;j<n;j++){ const a=idx[j], b=idx[(j+1)%n]; const fn=triN(sub.v,ci,a,b); if ((fn[0]*ax[0]+fn[1]*ax[1]+fn[2]*ax[2])*dir<0) sub.t.push(ci,b,a); else sub.t.push(ci,a,b); }
  (m.caps||(m.caps=[])).push(sub); }
// helpers producing rings
function circle(cx,cy,z,rx,ry,n){ const p=[]; for (let j=0;j<n;j++){ const a=j/n*TAU; p.push([cx+Math.cos(a)*rx, cy+Math.sin(a)*ry, z]); } return {c:[cx,cy,z],p}; }
function rrect(cx,cy,z,hw,hh,r,n){ // rounded rectangle ring, n points per corner
  const p=[]; r=Math.min(r,hw,hh); const C=[[hw-r,hh-r,0],[-(hw-r),hh-r,PI/2],[-(hw-r),-(hh-r),PI],[hw-r,-(hh-r),PI*1.5]];
  for (const [x,y,a0] of C) for (let k=0;k<=n;k++){ const a=a0+k/n*PI/2; p.push([cx+x+Math.cos(a)*r, cy+y+Math.sin(a)*r, z]); } return {c:[cx,cy,z],p}; }
function extrude(m,ringAt,z0,z1,ns,capA,capB,local){ const R=[]; for (let i=0;i<=ns;i++){ const z=lerp(z0,z1,i/ns); R.push(ringAt(z,i/ns)); } loft(m,R,capA,capB,local); }
function ellipsoid(m,cx,cy,cz,rx,ry,rz,ns,nr){ const R=[]; for (let i=0;i<=ns;i++){ const t=-1+2*i/ns; const tt=Math.sign(t)*Math.min(0.999,Math.abs(t)); const s=Math.sqrt(1-tt*tt); R.push(circle(cx,cy,cz+tt*rz,Math.max(0.002,rx*s),Math.max(0.002,ry*s),nr)); } loft(m,R,null,null); }
// rotate a mesh about the y axis then translate (wheels are built along z and turned onto the x axis)
function xform(m,ang,tx,ty,tz){ const c=Math.cos(ang), s=Math.sin(ang); const all=[m].concat(m.caps||[]);
  for (const mm of all){ const V=mm.v; for (let i=0;i<V.length;i+=9){ const x=V[i],z=V[i+2]; V[i]=x*c+z*s+tx; V[i+2]=-x*s+z*c+tz; V[i+1]+=ty; const nx=V[i+6],nz=V[i+8]; V[i+6]=nx*c+nz*s; V[i+8]=-nx*s+nz*c; } } return m; }
function flatten(list){ const out=[]; for (const m of list){ out.push(m); if (m.caps) for (const c of m.caps){ c.part=c.part||m.part; c.paint=c.paint||m.paint; c.capOf=m; out.push(c); } } return out; }

// ------------------------------------------------------------------ environments (time of day): what the paint and glass reflect
const ENV=[
 { zen:hex('#2f6fe0'), hor:hex('#e8f4ff'), gnd:hex('#2a2a36'), gh:hex('#8a8aa0'), sun:hex('#fff4dc'), L:[-0.32,0.82,-0.47], key:1.0, amb:0.55, band:0 },        // day
 { zen:hex('#3b1d9a'), hor:hex('#ffb070'), gnd:hex('#2a1830'), gh:hex('#c0607a'), sun:hex('#ffb37a'), L:[0.55,0.45,-0.7], key:0.85, amb:0.5, band:0.4, strip:0.6 },     // sunset
 { zen:hex('#0a0a2a'), hor:hex('#5a4a9a'), gnd:hex('#07060f'), gh:hex('#3a2a5a'), sun:hex('#cfe6ff'), L:[-0.2,0.9,-0.4], key:0.5, amb:0.55, band:1, strip:0.35 },        // night: neon streaks in every reflection
];
const NEON=[hex('#ff2fb0'),hex('#19f0ff'),hex('#ffd200'),hex('#c13dff')];
function env(E,rx,ry,rz,o){ let r,g,b;
  if (ry>=0){ const t=Math.pow(ry,0.55); r=lerp(E.hor[0],E.zen[0],t); g=lerp(E.hor[1],E.zen[1],t); b=lerp(E.hor[2],E.zen[2],t);
    // soft sky light band (clouds / studio strip) and the horizon line
    const sb=(ry>0.26&&ry<0.36?0.75:0)+(ry>0.5&&ry<0.56?0.45:0)+Math.exp(-Math.pow((ry-0.31)/0.12,2))*0.2; const kk=E.strip||1; r+=sb*kk; g+=sb*kk; b+=sb*kk;
    if (E.band>0 && ry<0.14){ const az=Math.atan2(rx,rz); const k=Math.floor((az+PI)/TAU*26), on=((k*7)%5)<2; if (on){ const nc=NEON[k%4], w=E.band*smooth(0.14,0.04,ry)*0.9; r+=nc[0]*w; g+=nc[1]*w; b+=nc[2]*w; } } }
  else { const t=Math.min(1,-ry*5); r=lerp(E.gh[0],E.gnd[0],t); g=lerp(E.gh[1],E.gnd[1],t); b=lerp(E.gh[2],E.gnd[2],t); }
  const hl=Math.exp(-ry*ry*900)*0.55; r+=hl*E.hor[0]; g+=hl*E.hor[1]; b+=hl*E.hor[2];
  o[0]=r; o[1]=g; o[2]=b; }

// ------------------------------------------------------------------ material ids
const M_PAINT=0, M_GLASS=1, M_CHROME=2, M_RUBBER=3, M_PLASTIC=4, M_LENS=5, M_CARBON=6, M_MATTE=8, M_METAL=9, M_SHADOW=10, M_LINER=11, M_HOLE=12, M_EMIT=13;
// paint output record (reused)
function Out(){ return {m:0, c:[0,0,0], e:[0,0,0], er:0, a:1, gloss:1, nb:null, nx:0,ny:0,nz:0}; }

// ------------------------------------------------------------------ models
// body profile along u (0 rear .. 1 front): bottom, belt, half width, roof, roof half width, cabin amount
function bodyLUT(P){ const N=256, o={y0:new Float32Array(N),yb:new Float32Array(N),w:new Float32Array(N),yr:new Float32Array(N),wr:new Float32Array(N),cab:new Float32Array(N)};
  for (let i=0;i<N;i++){ const u=i/(N-1); const c=P.cab(u); const ru=u<0.045?1-Math.sqrt(Math.max(0,1-Math.pow(1-u/0.045,2))):0, fu=u>0.96?1-Math.sqrt(Math.max(0,1-Math.pow((u-0.96)/0.04,2))):0, rf=ru+fu; o.y0[i]=P.y0(u)+rf*0.05; o.yb[i]=P.yb(u)-rf*0.05; o.w[i]=P.w(u)-rf*0.06; o.cab[i]=c; const deck=o.yb[i]+0.035; o.yr[i]=lerp(deck,P.yr(u),c); o.wr[i]=lerp(o.w[i]*0.55,P.wr(u),c); } return o; }
function lut(T,u){ const f=clamp(u,0,1)*255, i=f|0, j=Math.min(255,i+1), t=f-i; return T[i]+(T[j]-T[i])*t; }
function crSub(P,sub){ // Catmull-Rom through control points (open), sub extra points per span
  const out=[]; for (let i=0;i<P.length-1;i++){ const p0=P[Math.max(0,i-1)], p1=P[i], p2=P[i+1], p3=P[Math.min(P.length-1,i+2)];
    for (let k=0;k<=sub;k++){ if (k===sub && i<P.length-2) continue; const t=k/sub, t2=t*t, t3=t2*t; const f=(a,b,c,d)=>0.5*((2*b)+(-a+c)*t+(2*a-5*b+4*c-d)*t2+(-a+3*b-3*c+d)*t3); out.push([f(p0[0],p1[0],p2[0],p3[0]), f(p0[1],p1[1],p2[1],p3[1])]); } }
  return out; }
function bodyRing(B,u,z,flare){ const y0=lut(B.y0,u), yb=lut(B.yb,u), w=lut(B.w,u), c=lut(B.cab,u), yr=lut(B.yr,u), wr=lut(B.wr,u); const wb=w*0.9, gw=lerp(w*0.7,w*0.84,c), fw=w+(flare||0);
  const P=[[0,y0],[wb*0.8,y0],[wb,y0+0.035],[fw*0.99,y0+(yb-y0)*0.3],[fw,y0+(yb-y0)*0.6],[w*0.975,yb-0.045],[w*0.925,yb],[gw,yb+0.015+0.012*c],[lerp(gw,wr,0.62),lerp(yb+0.03,yr,0.72)],[wr,yr-0.03*c],[wr*0.55,yr+0.004],[0,yr+0.008]];
  const half=crSub(P,2); const p=[]; for (const q of half) p.push([q[0],q[1],z]); for (let i=half.length-2;i>=1;i--) p.push([-half[i][0],half[i][1],z]);
  return {c:[0,(y0+yr)/2,z],p}; }

// plates: a little canvas, sampled as a decal
function makePlate(text){ const w=128,h=32; let cv=null; try{ cv=(typeof OffscreenCanvas!=='undefined')?new OffscreenCanvas(w,h):document.createElement('canvas'); }catch(e){ return null; } cv.width=w; cv.height=h; const g=cv.getContext('2d');
  g.fillStyle='#f2f2e8'; g.fillRect(0,0,w,h); g.fillStyle='#1a4ad8'; g.fillRect(0,0,14,h); g.fillStyle='#ffd200'; g.fillRect(4,6,6,6); g.fillStyle='#111'; g.font='bold 22px Arial,Helvetica,sans-serif'; g.textAlign='center'; g.textBaseline='middle'; g.fillText(String(text||'').slice(0,7),71,17);
  g.strokeStyle='#333'; g.lineWidth=2; g.strokeRect(1,1,w-2,h-2); const d=g.getImageData(0,0,w,h).data; return {w,h,d}; }
function samplePlate(pl,u,v,c){ const x=clamp(u*pl.w|0,0,pl.w-1), y=clamp(v*pl.h|0,0,pl.h-1), i=(y*pl.w+x)*4; c[0]=pl.d[i]/255; c[1]=pl.d[i+1]/255; c[2]=pl.d[i+2]/255; }

// ---- light-cluster helper: unlit lens with reflector texture, lit core
function lens(o,col,lit,k,pat){ o.m=M_LENS; const d=0.22+0.12*pat; o.c[0]=col[0]*d; o.c[1]=col[1]*d; o.c[2]=col[2]*d; if (lit>0){ const e=lit*(0.75+0.5*k); o.e[0]=Math.min(4,col[0]*e*1.6+k*k*lit*0.9); o.e[1]=col[1]*e*1.2+k*k*lit*0.75; o.e[2]=col[2]*e*1.2+k*k*lit*0.7; } }
const RED=hex('#ff1a36'), AMBER=hex('#ffa31a'), WHITE=[1,1,1], HEAD=hex('#eaf6ff');

// Each model: dims, profile, wheels, extra meshes and a paint function. opts: {col, acc, plate, rim, lights:{run,brake,ind}}
const MODELS={};
function wheelsStd(zr,zf,r,rf,tw,x){ return [{z:zr,r,w:tw,x,front:false},{z:zf,r:rf,w:tw*0.9,x,front:true}]; }
MODELS.comet={ L:4.5, Wd:2.0, H:1.2, wheels:wheelsStd(-1.36,1.42,0.35,0.33,0.31,0.8), rim:'#22242c', pm:1,
  prof:{ y0:curve([[0,0.3],[0.1,0.2],[0.9,0.17],[1,0.25]]), yb:curve([[0,0.8],[0.12,0.86],[0.42,0.84],[0.72,0.76],[0.93,0.62],[1,0.5]]), w:curve([[0,0.84],[0.07,0.95],[0.2,0.99],[0.42,0.94],[0.62,0.92],[0.82,0.95],[0.96,0.9],[1,0.78]]),
    cab:curve([[0,0],[0.17,0],[0.36,1],[0.6,1],[0.75,0],[1,0]]), yr:curve([[0,1.0],[0.3,1.13],[0.48,1.18],[0.62,1.14],[1,0.9]]), wr:curve([[0,0.5],[0.45,0.6],[1,0.5]]) } };
MODELS.titan={ L:4.7, Wd:2.0, H:1.36, wheels:wheelsStd(-1.42,1.48,0.37,0.35,0.33,0.8), rim:'#c8ccd8', pm:1,
  prof:{ y0:curve([[0,0.32],[0.08,0.24],[0.9,0.22],[1,0.3]]), yb:curve([[0,0.86],[0.3,0.88],[0.66,0.86],[0.9,0.84],[1,0.74]]), w:curve([[0,0.9],[0.05,0.97],[0.25,0.99],[0.5,0.95],[0.75,0.97],[0.97,0.95],[1,0.86]]),
    cab:curve([[0,0],[0.25,0],[0.37,1],[0.6,1],[0.7,0],[1,0]]), yr:curve([[0,1.1],[0.4,1.31],[0.55,1.32],[1,1.1]]), wr:curve([[0,0.6],[0.5,0.68],[1,0.6]]) } };
MODELS.arrow={ L:4.6, Wd:2.04, H:1.1, wheels:wheelsStd(-1.4,1.5,0.36,0.33,0.33,0.82), rim:'#d8dbe4', pm:1,
  prof:{ y0:curve([[0,0.24],[0.1,0.15],[0.9,0.14],[1,0.18]]), yb:curve([[0,0.72],[0.15,0.76],[0.35,0.74],[0.62,0.7],[0.9,0.55],[1,0.42]]), w:curve([[0,0.9],[0.06,1.0],[0.22,1.02],[0.42,0.9],[0.6,0.9],[0.8,0.99],[0.95,0.94],[1,0.82]]),
    cab:curve([[0,0],[0.26,0],[0.4,1],[0.6,1],[0.76,0],[1,0]]), yr:curve([[0,0.9],[0.4,1.06],[0.52,1.09],[0.62,1.05],[1,0.8]]), wr:curve([[0,0.35],[0.5,0.44],[1,0.35]]) } };
MODELS.hatch={ L:4.1, Wd:1.84, H:1.5, wheels:wheelsStd(-1.3,1.3,0.32,0.32,0.24,0.74), rim:'#b8bcc8', pm:1,
  prof:{ y0:curve([[0,0.34],[0.07,0.26],[0.92,0.25],[1,0.34]]), yb:curve([[0,0.95],[0.1,0.96],[0.6,0.92],[0.85,0.84],[1,0.72]]), w:curve([[0,0.84],[0.05,0.9],[0.3,0.91],[0.7,0.9],[0.95,0.86],[1,0.78]]),
    cab:curve([[0,0.2],[0.06,1],[0.6,1],[0.78,0],[1,0]]), yr:curve([[0,1.25],[0.1,1.43],[0.45,1.47],[0.62,1.42],[1,1.0]]), wr:curve([[0,0.6],[0.4,0.7],[1,0.6]]) } };
MODELS.van={ L:5.0, Wd:2.0, H:2.1, wheels:wheelsStd(-1.6,1.65,0.36,0.36,0.25,0.82), rim:'#9aa0ae', pm:1,
  prof:{ y0:curve([[0,0.4],[0.06,0.34],[0.94,0.34],[1,0.4]]), yb:curve([[0,1.05],[0.7,1.06],[0.88,1.0],[1,0.85]]), w:curve([[0,0.94],[0.04,0.99],[0.9,0.98],[1,0.9]]),
    cab:curve([[0,1],[0.82,1],[0.97,0.2],[1,0]]), yr:curve([[0,1.98],[0.02,2.04],[0.8,2.04],[0.95,1.5],[1,1.2]]), wr:curve([[0,0.74],[0.03,0.8],[0.85,0.8],[1,0.66]]) } };
MODELS.truck={ L:8.4, Wd:2.5, H:3.8, wheels:[{z:-3.0,r:0.5,w:0.52,x:0.95,dual:1},{z:-1.8,r:0.5,w:0.52,x:0.95,dual:1},{z:2.7,r:0.5,w:0.3,x:1.0,front:true}], rim:'#c9ccd6', pm:1, truck:true };
MODELS.bike={ L:2.1, Wd:0.8, H:1.6, wheels:[{z:-0.7,r:0.32,w:0.19,x:0,front:false,single:1},{z:0.72,r:0.31,w:0.13,x:0,front:true,single:1}], rim:'#30323a', pm:1, bike:true };

// ------------------------------------------------------------------ build a model into meshes + paint functions
function build(name,o){ const Md=MODELS[name]; const col=hex(o.col||'#ff2d55'), acc=hex(o.acc||'#ffffff'), L=Md.L, hl=L/2; const meshes=[]; const lit=o.lights||{}; const plate=makePlate(o.plate||'NEON');
  const run=lit.run||0, brake=lit.brake||0, indL=lit.indL||0, indR=lit.indR||0, head=lit.head||0; const isTraffic=!!o.traffic;
  const W=Md.wheels; const wheelList=[]; for (const w of W){ for (const sd of (w.single?[0]:[-1,1])){ const xs=w.single?0:sd*w.x; wheelList.push({x:xs, z:w.z, r:w.r, w:w.w, side:sd||1, front:!!w.front, dual:!!w.dual}); if (w.dual) wheelList.push({x:sd*(w.x-0.4), z:w.z, r:w.r, w:w.w*0.9, side:sd, front:false, dual:true, inner:true}); } }
  const out={meshes, L, Wd:Md.Wd, wheels:wheelList, anchors:{}, name};
  const A=out.anchors;
  if (name==='truck') buildTruck(out,col,acc,o,plate,lit);
  else if (name==='bike') buildBike(out,col,acc,o,plate,lit);
  else {
    const B=bodyLUT(Md.prof); out.B=B;
    // ---- body loft (u from rear to front)
    const body=Mesh(1); const R=[]; const NS=46; for (let i=0;i<=NS;i++){ const u=i/NS; const uu=u<0.5? 0.5*Math.pow(u*2,1.15) : 1-0.5*Math.pow((1-u)*2,1.15); R.push(bodyRing(B,uu,-hl+uu*L, name==='titan'?0.0:0.0)); }
    loft(body,R,2,3); meshes.push(body); body.paint=paintBody; for (const c of body.caps) c.paint=paintBody;
    body.hole=(x,y,z)=>{ const u=(z+hl)/L; for (const wh of wheelList){ if (wh.single||wh.inner) continue; if ((x<0)!==(wh.x<0)) continue; const dz=z-wh.z, dy=y-wh.r; if (dz*dz+dy*dy<(wh.r+0.035)*(wh.r+0.035) && Math.abs(x)>lut(B.w,u)*0.62 && y<lut(B.yb,u)) return true; } return false; };
    body.holeZ=wheelList.filter(w=>!w.single).map(w=>[w.z,w.r+0.04]);
    for (const wh of wheelList){ if (wh.single||wh.inner) continue; const lin=Mesh(11); lin.noCull=1; const R2=wh.r+0.07, sd=wh.x<0?-1:1, x0=wh.x-sd*0.28, x1=wh.x+sd*0.12;
      const ring=(xx)=>{ const p=[]; for (let k=0;k<=12;k++){ const a=-0.25+k/12*(PI+0.5); p.push([xx, wh.r+Math.sin(a)*R2, wh.z+Math.cos(a)*R2]); } for (let k=12;k>=0;k--){ const a=-0.25+k/12*(PI+0.5); p.push([xx, wh.r+Math.sin(a)*R2*0.97, wh.z+Math.cos(a)*R2*0.97]); } return {c:[xx,wh.r,wh.z],p}; };
      const RR=[]; for (let i=0;i<=2;i++){ const r=ring(lerp(x0,x1,i/2)); r.axis=[1,0,0]; RR.push(r); } loft(lin,RR,0,0); lin.paint=(p,n,O)=>{ O.m=M_LINER; }; meshes.push(lin); }
    const st=name;
    // ---- wings, diffusers, exhausts, mirrors
    const ex=[]; let wingY=0;
    if (st==='comet'){ const wy=1.12; wingY=wy; const wing=Mesh(4); extrude(wing,(z,t)=>rrect(0,wy+0.01*Math.sin(t*PI),z,0.92,0.028,0.02,3),-hl+0.04,-hl+0.36,3,4,4); meshes.push(wing);
        for (const sd of [-1,1]){ const ep=Mesh(4); extrude(ep,(z)=>rrect(sd*0.94,wy-0.03,z,0.012,0.1,0.01,2),-hl+0.0,-hl+0.4,2,4,4); meshes.push(ep); const sp=Mesh(4); extrude(sp,(z,t)=>rrect(sd*0.42,lerp(0.9,wy-0.02,0.5),z,0.018,(wy-0.88)/2,0.01,2),-hl+0.12,-hl+0.26,1,4,4); meshes.push(sp); }
        for (const x of [-0.56,-0.42,0.42,0.56]) ex.push([x,0.36,0.052]); }
    else if (st==='titan'){ const lip=Mesh(5); extrude(lip,(z,t)=>rrect(0,0.94+t*0.03,z,0.9,0.03,0.025,3),-hl+0.02,-hl+0.18,2,4,4); meshes.push(lip); lip.paint=paintBody; lip.part=1; for (const c of lip.caps) c.paint=paintBody;
        for (const x of [-0.58,0.58]) ex.push([x,0.36,0.07]); }
    else if (st==='arrow'){ const wy=1.3; wingY=wy; const wing=Mesh(4); extrude(wing,(z,t)=>rrect(0,wy+0.02*Math.sin(t*PI),z,1.0,0.035,0.025,3),-hl-0.12,-hl+0.32,3,4,4); meshes.push(wing);
        for (const sd of [-1,1]){ const ep=Mesh(4); extrude(ep,(z)=>rrect(sd*1.02,wy-0.06,z,0.014,0.16,0.01,2),-hl-0.14,-hl+0.36,2,4,4); meshes.push(ep);
          const neck=Mesh(4); extrude(neck,(z,t)=>{ const yy=lerp(0.72,wy,t); const ring=rrect(sd*0.32,0,0,0.014,0.06,0.01,2); for (const q of ring.p){ const yy2=q[1]; q[1]=yy; q[2]=lerp(-hl+0.42,-hl+0.1,t*t)+yy2; } ring.c=[sd*0.32,yy,lerp(-hl+0.42,-hl+0.1,t*t)]; return ring; },0,1,6,0,0); meshes.push(neck); }
        const fin=Mesh(1); extrude(fin,(z,t)=>{ const h=lerp(0.02,0.2,smooth(0,1,1-t)); return rrect(0,lerp(lut(B.yr,0.5),0.98,1-t)+h/2,z,0.012,h/2+0.01,0.008,2); },-hl+0.25,-hl+2.1,8,4,4); fin.paint=paintBody; for (const c of fin.caps) c.paint=paintBody; meshes.push(fin);
        for (const x of [-0.09,0.09]) ex.push([x,0.62,0.05]); }
    else if (st==='hatch'){ const sp=Mesh(1); extrude(sp,(z,t)=>rrect(0,1.47-t*0.02,z,0.6,0.03,0.025,3),-hl+0.25,-hl+0.55,2,4,4); sp.paint=paintBody; for (const c of sp.caps) c.paint=paintBody; meshes.push(sp); ex.push([-0.52,0.32,0.035]); }
    else if (st==='van'){ ex.push([-0.6,0.3,0.035]); const st2=Mesh(4); extrude(st2,(z)=>rrect(0,0.36,z,0.7,0.04,0.02,2),-hl-0.08,-hl+0.05,1,4,4); meshes.push(st2); }
    for (const e of ex){ const m=Mesh(2); extrude(m,(z,t)=>circle(e[0],e[1],z,e[2]*(1+0.06*t),e[2]*(1+0.06*t),18),-hl-0.06,-hl+0.12,2,7,0); meshes.push(m);
      for (const c of m.caps){ c.part=7; c.paint=(p,n,O)=>{ const r=hyp(p[0]-e[0],p[1]-e[1])/e[2]; if (r>0.78){ O.m=M_CHROME; return; } O.m=M_EMIT; const k=r>0.62?0.12:0.015; O.c[0]=k*1.2; O.c[1]=k*0.8; O.c[2]=k; }; } }
    out.exhaust=ex.map(e=>[e[0],e[1],-hl-0.06]);
    // diffuser fins
    if (st==='comet'||st==='arrow'){ for (const x of (st==='arrow'?[-0.62,-0.34,-0.12,0.12,0.34,0.62]:[-0.48,-0.2,0.2,0.48])){ const f=Mesh(6); extrude(f,(z,t)=>rrect(x,0.27+0.03*t,z,0.008,0.05*(1-t)+0.015,0.004,1),-hl+0.01,-hl+0.5,2,6,6); meshes.push(f); } }
    // mirrors
    const uw=st==='van'?0.86:st==='hatch'?0.74:0.72; const zm=-hl+uw*L, wm=lut(B.w,uw), ym=lut(B.yb,uw)+0.1;
    for (const sd of [-1,1]){ const m=Mesh(1); ellipsoid(m,sd*(wm+0.09),ym,zm,0.09,0.055,0.11,6,12); m.paint=(p,n,O)=>{ O.m=M_PAINT; O.c[0]=col[0]; O.c[1]=col[1]; O.c[2]=col[2]; if (n[2]<-0.55){ O.m=M_CHROME; } else if (n[1]<-0.3){ O.m=M_PLASTIC; O.c[0]=O.c[1]=O.c[2]=0.03; } }; meshes.push(m); const arm=Mesh(4); ellipsoid(arm,sd*(wm+0.02),ym-0.025,zm+0.02,0.07,0.025,0.05,4,8); meshes.push(arm); }
    A.mirror=[[-(wm+0.17),ym,zm],[wm+0.17,ym,zm]];
    if (wingY) A.wing=[[-0.9,wingY+0.03,-hl+0.2],[0.9,wingY+0.03,-hl+0.2]];
  }
  // ---- wheels
  out.wheelMeshes=[]; for (const w of wheelList){ const wm=wheelMesh(w,Md.rim,o.rim); out.wheelMeshes.push(wm); }
  // ---- anchors (car space)
  A.wheel=wheelList.map(w=>[w.x+(w.single?0:w.side*w.w*0.5), w.r, w.z]); A.contact=wheelList.map(w=>[w.x, 0, w.z]);
  A.roof=[0, (out.B?lut(out.B.yr,0.5):Md.H), 0]; A.rear=[0,0.5,-hl]; A.nose=[0,0.5,hl];
  const TL={comet:[0.68,0.655,0.88,0.58],titan:[0.6,0.665,0.24,0.665],arrow:[0.93,0.6,0.93,0.47],hatch:[0.8,0.88,0.8,0.75],van:[0.9,1.05,0.9,0.7]}[name];
  if (TL){ A.tail=[[-TL[0],TL[1],-hl],[TL[0],TL[1],-hl]]; A.ind=[[-TL[2],TL[3],-hl],[TL[2],TL[3],-hl]]; }
  if (!A.tail) A.tail=[[-0.7,0.66,-hl],[0.7,0.66,-hl]]; if (!A.ind) A.ind=[[-0.8,0.6,-hl],[0.8,0.6,-hl]]; if (!A.head) A.head=[[-0.66,0.62,hl],[0.66,0.62,hl]];
  if (!out.exhaust) out.exhaust=[[0.4,0.35,-hl]];
  // shadow quad
  const sh=Mesh(10); { const x=Md.Wd/2+0.7, z=hl+0.8; const a=addV(sh,-x,0.003,-z,-x,0,-z), b=addV(sh,x,0.003,-z,x,0,-z), c=addV(sh,x,0.003,z,x,0,z), d=addV(sh,-x,0.003,z,-x,0,z); for (let i=0;i<4;i++) sh.v[i*9+7]=1; sh.t.push(a,b,c,a,c,d); sh.paint=(p,n,O)=>{ O.m=M_SHADOW; const hx=Md.Wd/2*0.92, hz=hl*0.94; if (Math.abs(p[0])>hx+0.55 || Math.abs(p[2])>hz+0.55){ O.a=0; return; } const dx=Math.max(Math.abs(p[0])-hx,0), dz=Math.max(Math.abs(p[2])-hz,0); const dd=hyp(dx,dz)-Math.min(0,Math.max(Math.abs(p[0])-hx,Math.abs(p[2])-hz)); let a=0.72*Math.pow(clamp(1-(dd+0.12)/0.62,0,1),1.5);
      for (const w of wheelList){ const ex=Math.abs(p[2]-w.z)/(w.r*0.9), ey=Math.abs(p[0]-w.x)/(w.w*0.7+0.06); const q=1-(ex*ex+ey*ey); if (q>0) a=Math.max(a,Math.min(0.92,0.6+q*0.5)); }
      O.a=a; }; }
  out.shadow=sh;
  return out;

  // ================= paint: body
  function paintBody(p,n,O,part){ const x=p[0], y=p[1], z=p[2]; const u=(z+hl)/L; const ax=Math.abs(x);
    O.m=M_PAINT; O.c[0]=col[0]; O.c[1]=col[1]; O.c[2]=col[2]; O.a=1;
    if (!out.B) return; const B=out.B; const yb=lut(B.yb,u), yr=lut(B.yr,u), cab=lut(B.cab,u), w=lut(B.w,u), y0=lut(B.y0,u);
    // wheel arches: a hole where the tyre shows, a dark liner rim around it, a flared lip
    for (const wh of wheelList){ if (wh.single) continue; const dz=z-wh.z, dy=y-wh.r, rr=Math.sqrt(dz*dz+dy*dy), R1=wh.r+0.035, R2=wh.r+0.075;
      if (rr<R2 && ax>w*0.62 && Math.sign(x)===Math.sign(wh.x) && y<yb){ if (rr<R1){ O.m=M_LINER; return; } O.m=M_LINER; O.c[0]=O.c[1]=O.c[2]=0.02; return; }
      if (rr<R2+0.03 && ax>w*0.8 && Math.sign(x)===Math.sign(wh.x) && y<yb){ const k=(rr-R2)/0.03; O.c[0]*=0.7+0.3*k; O.c[1]*=0.7+0.3*k; O.c[2]*=0.7+0.3*k; } }
    const rear=part===2, front=part===3;
    if (rear) return paintRear(x,y,O,yb,w,y0);
    if (front) return paintFront(x,y,O,yb,w,y0);
    // sills / lower skirts in carbon or black
    if (y<y0+0.07 && ax>w*0.6){ O.m=name==='hatch'||name==='van'?M_PLASTIC:M_CARBON; O.c[0]=O.c[1]=O.c[2]=0.06; return; }
    // greenhouse: glass with black frames, pillars
    if (cab>0.18 && y>yb+0.03){ const top=yr-0.035; const inG=y<top;
      if (inG){ let pillar=false; const sideways=Math.abs(n[0])>0.45; if (name==='van'){ if (u<0.82 && sideways) { // van: no side windows behind the cab, rear windows on the doors
            O.m=M_PAINT; return; } }
        if (sideways){ const um=name==='hatch'?0.42:0.5; if (Math.abs(u-um)<0.012) pillar=true; }
        const edge=Math.min(y-(yb+0.03), top-y); if (edge<0.022 || pillar){ O.m=M_PLASTIC; O.c[0]=O.c[1]=O.c[2]=0.03; return; }
        O.m=M_GLASS; O.c[0]=0.01; O.c[1]=0.015; O.c[2]=0.03;
        if (name==='titan' && n[2]<-0.25){ const k=frac((y-yb)*26); if (k<0.42){ O.m=M_PLASTIC; O.c[0]=O.c[1]=O.c[2]=0.025; } }   // window louvres
        if (n[2]<-0.25 && name!=='titan' && ax<0.5){ // rear window: heating lines + a third brake light at the top
          if (Math.abs(frac((y-yb)*30)-0.5)<0.03) { O.c[0]+=0.08; O.c[1]+=0.04; O.c[2]+=0.03; }
          if (top-y<0.05 && ax<0.22) { lens(O,RED,brake,1-ax/0.22,frac(x*40)<0.5?1:0); } }
        return; }
      // roof
      if (name==='comet'){ O.m=M_PAINT; O.c[0]=0.03; O.c[1]=0.03; O.c[2]=0.035; }
    }
    // livery
    if (name==='comet'){ if (ax>0.06 && ax<0.17 && (n[1]>0.25 || y>yb-0.02)){ O.c[0]=acc[0]; O.c[1]=acc[1]; O.c[2]=acc[2]; } else if (ax<0.035 && n[1]>0.25){ O.c[0]=O.c[1]=O.c[2]=0.95; } }
    else if (name==='titan'){ if (ax>0.2 && ax<0.4 && n[1]>0.3){ O.c[0]=acc[0]; O.c[1]=acc[1]; O.c[2]=acc[2]; } if (Math.abs(n[0])>0.6 && Math.abs(y-(y0+(yb-y0)*0.55))<0.035){ O.c[0]=acc[0]; O.c[1]=acc[1]; O.c[2]=acc[2]; } }
    else if (name==='arrow'){ if (Math.abs(n[0])>0.5){ const s=y-(y0+0.1)-(u-0.15)*0.35; if (s>0 && s<0.12 && u>0.1 && u<0.85){ O.c[0]=acc[0]; O.c[1]=acc[1]; O.c[2]=acc[2]; } }
      if (Math.abs(n[0])>0.5 && u>0.43 && u<0.57 && Math.abs(y-(y0+(yb-y0)*0.55))<0.13){ const dx=(u-0.5)*L, dy=y-(y0+(yb-y0)*0.55); if (dx*dx+dy*dy<0.016){ O.m=M_MATTE; O.c[0]=O.c[1]=O.c[2]=0.95; if (dx*dx+dy*dy<0.008 && Math.abs(dx)<0.035 && dy>-0.06) { O.c[0]=O.c[1]=O.c[2]=0.05; } } } }
    else if (isTraffic && name==='van'){ if (Math.abs(n[0])>0.6 && y>0.9 && y<1.25 && u>0.15 && u<0.75){ O.c[0]=acc[0]; O.c[1]=acc[1]; O.c[2]=acc[2]; } }
    // panel lines (door seams, boot lid, fuel flap)
    if (Math.abs(n[0])>0.55 && y<yb){ const d1=Math.abs(u-(name==='van'?0.5:0.4)), d2=Math.abs(u-(name==='van'?0.83:0.66)); if (d1<0.0016 || d2<0.0016){ dim(O,0.35); }
      if (Math.abs(y-(y0+(yb-y0)*0.78))<0.004 && u>0.08 && u<0.92) dim(O,0.75); if (Math.abs(y-(yb-0.04))<0.008) light(O,0.18);
      if (name!=='van' && u>0.17 && u<0.25 && y<yb-0.05 && y>y0+0.12 && name!=='hatch'){ const k=frac((y-y0)*22); if (k<0.45){ O.m=M_PLASTIC; O.c[0]=O.c[1]=O.c[2]=0.03; } }   // side intake slats
      if (name!=='van' && Math.abs(u-0.83)<0.012 && Math.abs(y-(yb-0.09))<0.03 && ax>0) { /* side repeater */ lens(O,AMBER,0,0.5,0); }
    }
    if (n[1]>0.5 && u<0.16 && u>0.02 && y>yb-0.01){ const lid=Math.abs(u-0.15)<0.0018 || (Math.abs(ax-0.72)<0.004 && u<0.15); if (lid) dim(O,0.45); }
    if (n[1]>0.5 && u>0.8 && u<0.98){ if (Math.abs(ax-0.6)<0.004 || Math.abs(u-0.8)<0.0015) dim(O,0.55); if (name!=='hatch' && name!=='van' && u>0.84 && u<0.92 && ax>0.18 && ax<0.42 && frac(u*120)<0.5){ O.m=M_PLASTIC; O.c[0]=O.c[1]=O.c[2]=0.03; } }   // bonnet vents
  }
  function dim(O,k){ O.c[0]*=k; O.c[1]*=k; O.c[2]*=k; }
  function light(O,k){ O.c[0]+= (1-O.c[0])*k; O.c[1]+=(1-O.c[1])*k; O.c[2]+=(1-O.c[2])*k; }
  function rect(x,y,x0,x1,y0,y1){ return x>=x0&&x<=x1&&y>=y0&&y<=y1; }
  function paintRear(x,y,O,yb,w,y0){ const ax=Math.abs(x), sd=x<0?-1:1, ind=sd<0?indL:indR;
    // lower bumper / diffuser
    const lowY=name==='van'?0.48:name==='hatch'?0.45:0.42;
    if (y<lowY){ O.m=(name==='comet'||name==='arrow')?M_CARBON:M_PLASTIC; O.c[0]=O.c[1]=O.c[2]=name==='titan'?0.05:0.04;
      if (name==='titan' && y>lowY-0.08){ O.m=M_CHROME; }
      if (ax>w-0.18 && y>y0+0.08 && y<y0+0.14){ lens(O,RED,run*0.4,0.3,0); }   // rear reflectors / fog light
      if (name==='comet' && ax<0.12 && y>0.22 && y<0.3){ lens(O,RED,Math.max(run*0.8,brake),0.5,1); }   // rain light
      return; }
    if (Math.abs(y-lowY)<0.012) { dim(O,0.4); return; }
    // plate recess + plate
    const pw=0.26, py0=lowY+0.03, py1=py0+0.12; if (ax<pw+0.02 && y>py0-0.02 && y<py1+0.02){ if (ax<pw && y>py0 && y<py1 && plate){ samplePlate(plate,(x+pw)/(2*pw),1-(y-py0)/(py1-py0),O.c); O.m=M_MATTE; if (run>0){ O.e[0]=O.c[0]*0.25*run; O.e[1]=O.c[1]*0.25*run; O.e[2]=O.c[2]*0.25*run; } return; } O.m=M_PLASTIC; O.c[0]=O.c[1]=O.c[2]=0.03; return; }
    if (name==='comet'){
      if (rect(ax,y,0.42,w-0.02,0.6,0.71)){ const k=1-Math.abs(y-0.655)/0.055; const seg=frac((ax-0.42)*24)<0.8?1:0; if (ax>w-0.1 && y<0.64){ lens(O,AMBER,ind,0.6,seg); return; } lens(O,RED,Math.max(run,brake),k*(brake?1:0.6),seg); return; }
      if (rect(ax,y,0,0.42,0.64,0.668)){ lens(O,RED,Math.max(run,brake*0.8),0.6,frac(ax*30)<0.6?1:0); return; }
      if (rect(ax,y,0.3,0.4,0.56,0.6)){ lens(O,WHITE,0,0.3,1); return; }
      if (ax<0.1 && Math.abs(y-0.74)<0.03){ O.m=M_CHROME; return; }   // badge
      if (ax<0.17 && ax>0.06 && y>0.68){ O.c[0]=acc[0]; O.c[1]=acc[1]; O.c[2]=acc[2]; } }
    else if (name==='titan'){
      if (rect(ax,y,0.08,w-0.04,0.57,0.76)){ O.m=M_PLASTIC; O.c[0]=O.c[1]=O.c[2]=0.025;
        for (const cx of [0.48,0.72]){ const dx=ax-cx, dy=y-0.665, r=Math.sqrt(dx*dx+dy*dy); if (r<0.075){ if (r>0.062){ O.m=M_CHROME; return; } const ring=frac(r*55)<0.5?1:0; lens(O,RED,Math.max(run,brake),1-r/0.062,ring); return; } }
        if (ax<0.12 && Math.abs(y-0.665)<0.04){ O.m=M_CHROME; } if (Math.abs(ax-0.24)<0.05 && Math.abs(y-0.665)<0.03) lens(O,WHITE,0,0.3,1); return; }
      if (Math.abs(y-0.565)<0.008 || Math.abs(y-0.765)<0.008) { O.m=M_CHROME; return; }
      if (ax>0.2 && ax<0.4 && y>0.76){ O.c[0]=acc[0]; O.c[1]=acc[1]; O.c[2]=acc[2]; } }
    else if (name==='arrow'){
      if (rect(ax,y,w-0.13,w-0.03,0.44,0.72)){ const k=1-Math.abs(ax-(w-0.08))/0.05; const seg=frac(y*40)<0.7?1:0; if (y<0.5) lens(O,AMBER,ind,0.6,seg); else lens(O,RED,Math.max(run,brake),k,seg); return; }
      if (rect(ax,y,0,w-0.13,0.69,0.705)){ lens(O,RED,Math.max(run*0.7,brake),0.5,1); return; }
      if (ax<0.18 && y>0.55 && y<0.69){ O.m=M_CARBON; O.c[0]=O.c[1]=O.c[2]=0.04; return; }
      if (ax>0.2 && ax<0.7 && y>0.45 && y<0.66){ O.m=M_PLASTIC; O.c[0]=O.c[1]=O.c[2]=0.02; if (frac((y-0.45)*30)<0.35) O.c[0]=O.c[1]=O.c[2]=0.08; return; }   // rear mesh vents
    }
    else if (name==='hatch'){
      if (rect(ax,y,w-0.2,w-0.01,0.72,0.95)){ const seg=frac(y*18)<0.85?1:0; if (y<0.78){ lens(O,AMBER,ind,0.5,seg); return; } if (y<0.82 && ax<w-0.12){ lens(O,WHITE,0,0.3,seg); return; } lens(O,RED,Math.max(run,brake),1-Math.abs(y-0.88)/0.08,seg); return; }
      if (ax<0.08 && Math.abs(y-0.78)<0.035){ O.m=M_CHROME; return; } if (Math.abs(y-0.62)<0.004) dim(O,0.5); }
    else if (name==='van'){
      if (rect(ax,y,w-0.13,w-0.02,0.62,1.25)){ const seg=frac(y*14)<0.85?1:0; if (y<0.78){ lens(O,AMBER,ind,0.5,seg); return; } if (y<0.86){ lens(O,WHITE,0,0.3,seg); return; } lens(O,RED,Math.max(run,brake),0.7,seg); return; }
      if (ax<0.006) { dim(O,0.3); return; }
      if (y>1.22 && y<1.85 && ax>0.06 && ax<w-0.2){ const e=Math.min(y-1.22,1.85-y,ax-0.06,w-0.2-ax); if (e<0.025){ O.m=M_PLASTIC; O.c[0]=O.c[1]=O.c[2]=0.03; return; } O.m=M_GLASS; O.c[0]=0.01; O.c[1]=0.015; O.c[2]=0.03; return; }
      if (Math.abs(ax-0.1)<0.03 && Math.abs(y-1.0)<0.07) { O.m=M_CHROME; return; }
      if (y>1.95 && ax<0.25){ lens(O,RED,Math.max(run,brake),0.6,1); return; } }
  }
  function paintFront(x,y,O,yb,w,y0){ const ax=Math.abs(x);
    if (y<0.36){ O.m=M_PLASTIC; O.c[0]=O.c[1]=O.c[2]=0.04; if (ax<0.6 && y>0.18 && frac(ax*30)<0.5) O.c[0]=O.c[1]=O.c[2]=0.015; return; }
    if (ax>w-0.42 && ax<w-0.05 && y>yb-0.2 && y<yb-0.06){ O.m=M_LENS; O.c[0]=O.c[1]=O.c[2]=0.12; if (head>0){ O.e[0]=O.e[1]=O.e[2]=head*1.5; } else if (ax>w-0.4 && ax<w-0.08 && Math.abs(y-(yb-0.08))<0.008){ O.c[0]=0.8; O.c[1]=0.9; O.c[2]=1; O.m=M_EMIT; } return; }
    if (ax<0.35 && y>0.38 && y<yb-0.12){ O.m=M_PLASTIC; O.c[0]=O.c[1]=O.c[2]=0.03; return; }
  }
}

// ------------------------------------------------------------------ wheels: tyre with tread and lettering, rim with spokes, brake disc and calliper
function wheelMesh(w,rimDef,rimOpt){ const m=Mesh(20); const r=w.r, hw=w.w/2, rimR=r*0.7;
  const prof=[[-hw,r*0.84],[-hw*0.96,r*0.95],[-hw*0.8,r],[hw*0.8,r],[hw*0.96,r*0.95],[hw,r*0.84]];
  const R=prof.map(([a,rr])=>{ const c=circle(0,0,a,rr,rr,40); return c; }); for (const ring of R) ring.c=[0,0,ring.p[0][2]];
  loft(m,R,0,21); const face=m.caps[0];
  // turn onto the x axis: outer face points away from the car
  const ang=(w.single?1:w.side)*PI/2; const dx=w.x, dz=w.z, dy=r; xform(m,ang,dx,dy,dz);
  m.wheel=w; m.wheelLocalSpace=1; face.wheelLocalSpace=1; m.rimCol=hex(rimOpt||rimDef); m.paint=null; face.part=21; m.part=20; return m; }
function paintWheel(wh,phase,blur,steerless){ const rimC=wh.rimCol, w=wh.wheel, r=w.r, rimR=r*0.72, cal=hex('#ff2d55');
  return (p,n,O,part)=>{ // p = local (built along z): x,y in the wheel plane, z axial
    const lx=p[0], ly=p[1]; const rr=Math.sqrt(lx*lx+ly*ly); let a=Math.atan2(ly,lx);
    if (part===20){ // tread
      O.m=M_RUBBER; const az=p[2]/(w.w/2); const g=Math.abs(az);
      let c=0.05; if (Math.abs(g-0.45)<0.06 || g<0.05) c=0.015; else if (!blur){ const k=frac((a+phase)*24/TAU + (az>0?0.25:0)); if (k<0.18) c=0.02; } else c=0.04;
      if (g>0.85) c=0.07; O.c[0]=O.c[1]=O.c[2]=c; return; }
    // face
    if (rr>rimR){ O.m=M_RUBBER; O.c[0]=O.c[1]=O.c[2]=0.045; if (rr>r*0.8 && rr<r*0.86){ const k=frac((a+(blur?0:phase))*6/TAU); if (k>0.1 && k<0.35){ O.m=M_MATTE; O.c[0]=O.c[1]=O.c[2]=blur?0.12:0.6; } } return; }
    if (rr>rimR-0.018){ O.m=M_CHROME; return; }
    if (rr<0.045){ O.m=rr<0.025?M_CHROME:M_PLASTIC; O.c[0]=O.c[1]=O.c[2]=0.05; return; }
    const ap=a+phase; const s=frac(ap*5/TAU); const spoke = Math.abs(s-0.5)>0.36 || (Math.abs(s-0.5)<0.03 && rr>rimR*0.55);
    // behind the spokes: drilled disc and a calliper that does not spin
    const behind=()=>{ O.m=M_METAL; O.c[0]=O.c[1]=O.c[2]=0.22; if (rr>rimR*0.55 && rr<rimR*0.9 && frac(ap*18/TAU)<0.12 && frac(rr*40)<0.5){ O.c[0]=O.c[1]=O.c[2]=0.05; }
      const ca=a-(-0.9); if (rr>rimR*0.5 && rr<rimR*0.98 && Math.abs(Math.atan2(Math.sin(ca),Math.cos(ca)))<0.5){ O.m=M_PAINT; O.c[0]=cal[0]; O.c[1]=cal[1]; O.c[2]=cal[2]; } if (rr<rimR*0.48){ O.c[0]=O.c[1]=O.c[2]=0.06; } };
    if (blur){ // spokes smeared into a disc: rim colour over the disc, with soft concentric streaks
      behind(); const k=0.62+0.08*Math.sin(rr*140); O.m=M_PAINT; O.c[0]=lerp(O.c[0],rimC[0],k); O.c[1]=lerp(O.c[1],rimC[1],k); O.c[2]=lerp(O.c[2],rimC[2],k); O.gloss=0.5; return; }
    if (spoke){ O.m=M_PAINT; O.c[0]=rimC[0]; O.c[1]=rimC[1]; O.c[2]=rimC[2]; O.gloss=0.9; const e=Math.abs(Math.abs(s-0.5)-0.36); if (e<0.02) { O.c[0]*=0.6; O.c[1]*=0.6; O.c[2]*=0.6; } return; }
    behind(); }; }

// ------------------------------------------------------------------ truck and bike
function buildTruck(out,col,acc,o,plate,lit){ const M=out.meshes, A=out.anchors; const hl=out.L/2; const run=lit.run||0, brake=lit.brake||0, indL=lit.indL||0, indR=lit.indR||0;
  const z0=-hl+0.2, z1=hl-1.9;   // container
  const box=Mesh(1); extrude(box,(z)=>rrect(0,2.35,z,1.25,1.25,0.06,3),z0,z1,10,2,3); M.push(box);
  box.paint=(p,n,O,part)=>{ const x=p[0],y=p[1],z=p[2],ax=Math.abs(x); O.m=M_PAINT; O.c[0]=col[0]; O.c[1]=col[1]; O.c[2]=col[2];
    if (part===2){ // rear doors
      O.c[0]=lerp(col[0],0.7,0.35); O.c[1]=lerp(col[1],0.7,0.35); O.c[2]=lerp(col[2],0.72,0.35); O.gloss=0.35;
      if (ax<0.008) { O.c[0]*=0.3; O.c[1]*=0.3; O.c[2]*=0.3; return; }
      for (const bx of [0.32,0.82]){ if (Math.abs(ax-bx)<0.025){ O.m=M_CHROME; if (Math.abs(y-1.9)<0.05){ O.m=M_PLASTIC; O.c[0]=O.c[1]=O.c[2]=0.05; } return; } }
      if (ax>1.17 && Math.abs(frac((y-1.1)/0.8)-0.5)>0.42) { O.m=M_METAL; O.c[0]=O.c[1]=O.c[2]=0.4; return; }
      if (y<1.18 || y>3.52 || ax>1.19) { O.c[0]*=0.55; O.c[1]*=0.55; O.c[2]*=0.55; }
      if (y>2.9 && y<3.25 && ax<1.0){ O.c[0]=acc[0]; O.c[1]=acc[1]; O.c[2]=acc[2]; if (frac(x*2.2+y*1.3)<0.12) { O.c[0]=O.c[1]=O.c[2]=1; } }
      if (ax>1.0 && ax<1.12 && y>3.45 && y<3.55) lens(O,AMBER,run*0.6,0.5,1);
      return; }
    if (Math.abs(n[0])>0.6){ if (frac((z-z0)/0.6)<0.05) { O.c[0]*=0.6; O.c[1]*=0.6; O.c[2]*=0.6; } if (y>1.9 && y<2.6 && z>z0+0.6 && z<z1-0.6){ O.c[0]=acc[0]; O.c[1]=acc[1]; O.c[2]=acc[2]; } if (y<1.18) { O.c[0]*=0.5; O.c[1]*=0.5; O.c[2]*=0.5; } }
    if (n[1]>0.6) { O.c[0]=lerp(O.c[0],0.7,0.5); O.c[1]=lerp(O.c[1],0.7,0.5); O.c[2]=lerp(O.c[2],0.72,0.5); } };
  for (const c of box.caps) c.paint=box.paint;
  // chassis rails, under-ride bar with lights, mud flaps
  const ch=Mesh(4); extrude(ch,(z)=>rrect(0,0.85,z,0.55,0.16,0.03,2),z0+0.1,hl-0.2,4,4,4); M.push(ch);
  const bar=Mesh(4); extrude(bar,(z)=>rrect(0,0.62,z,1.12,0.09,0.03,2),z0-0.08,z0+0.08,1,22,4); M.push(bar);
  bar.caps[0].paint=(p,n,O)=>{ const ax=Math.abs(p[0]); O.m=M_PLASTIC; O.c[0]=0.9; O.c[1]=0.85; O.c[2]=0.2; if (frac(p[0]*3+p[1]*3)<0.5){ O.c[0]=O.c[1]=O.c[2]=0.06; } };
  const lb=Mesh(4); extrude(lb,(z)=>rrect(0,0.96,z,1.2,0.11,0.03,2),z0-0.1,z0+0.02,1,23,4); M.push(lb);
  lb.caps[0].paint=(p,n,O)=>{ const x=p[0], ax=Math.abs(x), y=p[1], sd=x<0?indL:indR; O.m=M_PLASTIC; O.c[0]=O.c[1]=O.c[2]=0.05;
    const L=[[1.05,RED,Math.max(run,brake)],[0.83,RED,Math.max(run,brake)],[0.61,AMBER,sd],[0.4,WHITE,0]]; for (const [cx,c,l] of L){ const dx=ax-cx, dy=y-0.96, r=Math.sqrt(dx*dx+dy*dy); if (r<0.085){ if (r>0.072){ O.m=M_CHROME; return; } lens(O,c,l,1-r/0.072,frac(r*60)<0.5?1:0); return; } }
    if (ax<0.26 && Math.abs(y-0.96)<0.07 && plate){ samplePlate(plate,(x+0.26)/0.52,1-(y-0.89)/0.14,O.c); O.m=M_MATTE; } };
  for (const sd of [-1,1]){ const f=Mesh(4); extrude(f,(z)=>rrect(sd*0.95,0.45,z,0.27,0.3,0.02,2),-3.0-0.62,-3.0-0.6,1,24,4); M.push(f); f.caps[0].paint=(p,n,O)=>{ O.m=M_RUBBER; O.c[0]=O.c[1]=O.c[2]=0.06; if (Math.abs(p[1]-0.6)<0.06 && Math.abs(Math.abs(p[0])-0.95)<0.2){ O.m=M_MATTE; O.c[0]=O.c[1]=O.c[2]=0.75; } }; }
  // cab
  const cab=Mesh(1); extrude(cab,(z,t)=>rrect(0,1.75,z,1.22,1.3-0.15*t,0.18,3),hl-1.8,hl,4,0,3); M.push(cab);
  cab.paint=(p,n,O)=>{ O.m=M_PAINT; O.c[0]=0.9; O.c[1]=0.9; O.c[2]=0.92; if (p[1]>2.0 && p[2]>hl-0.1 && Math.abs(p[0])<1.1){ O.m=M_GLASS; O.c[0]=0.01; O.c[1]=0.015; O.c[2]=0.03; } if (Math.abs(n[0])>0.6 && p[1]>2.1 && p[2]>hl-1.2){ O.m=M_GLASS; O.c[0]=0.01; O.c[1]=0.015; O.c[2]=0.03; } }; for (const c of cab.caps) c.paint=cab.paint;
  for (const sd of [-1,1]){ const ex=Mesh(2); extrude(ex,(z)=>circle(sd*1.15,2.6,z,0.07,0.07,14),hl-2.0,hl-1.7,1,0,0); M.push(ex); }
  A.tail=[[-0.94,0.96,z0-0.1],[0.94,0.96,z0-0.1]]; A.ind=[[-0.61,0.96,z0-0.1],[0.61,0.96,z0-0.1]]; out.exhaust=[[1.15,3.3,hl-1.85]]; A.roofLamp=[[-1.06,3.5,z0],[1.06,3.5,z0]];
}
function buildBike(out,col,acc,o,plate,lit){ const M=out.meshes, A=out.anchors; const run=lit.run||0, brake=lit.brake||0; const suit=hex(o.suit||'#20202a'), helm=col;
  // tail cowl and seat
  const tail=Mesh(1); const R=[]; for (let i=0;i<=10;i++){ const t=i/10, z=lerp(-1.0,0.15,t); const hw=lerp(0.07,0.15,smooth(0,0.6,t)), y=lerp(0.86,0.7,t), hh=lerp(0.07,0.13,t); R.push(rrect(0,y,z,hw,hh,Math.min(hw,hh)*0.8,3)); } loft(tail,R,2,0); M.push(tail);
  tail.paint=(p,n,O,part)=>{ O.m=M_PAINT; O.c[0]=col[0]; O.c[1]=col[1]; O.c[2]=col[2]; if (part===2){ if (p[1]>0.84) lens(O,RED,Math.max(run,brake),1-Math.abs(p[0])/0.07,frac(p[0]*60)<0.6?1:0); else { O.m=M_PLASTIC; O.c[0]=O.c[1]=O.c[2]=0.03; } return; } if (p[1]>0.86 && p[2]>-0.6){ O.m=M_PLASTIC; O.c[0]=O.c[1]=O.c[2]=0.04; } if (Math.abs(p[0])>0.05 && Math.abs(n[0])>0.5 && frac(p[2]*3)<0.3){ O.c[0]=acc[0]; O.c[1]=acc[1]; O.c[2]=acc[2]; } }; for (const c of tail.caps) c.paint=tail.paint;
  // tank + fairing
  const tank=Mesh(1); ellipsoid(tank,0,0.82,0.42,0.19,0.14,0.36,10,18); tank.paint=(p,n,O)=>{ O.m=M_PAINT; O.c[0]=col[0]; O.c[1]=col[1]; O.c[2]=col[2]; if (Math.abs(p[0])<0.03) { O.c[0]=acc[0]; O.c[1]=acc[1]; O.c[2]=acc[2]; } }; M.push(tank);
  const fair=Mesh(1); ellipsoid(fair,0,0.62,0.55,0.2,0.24,0.4,10,18); fair.paint=tank.paint; M.push(fair);
  // plate hanger + plate
  const ph=Mesh(4); extrude(ph,(z,t)=>rrect(0,0.68-t*0.12,z,0.1,0.06,0.01,2),-1.02,-0.96,1,25,0); M.push(ph); ph.caps[0].paint=(p,n,O)=>{ O.m=M_MATTE; if (plate) samplePlate(plate,(p[0]+0.1)/0.2,1-(p[1]-0.62)/0.12,O.c); };
  // exhaust can
  const ex=Mesh(2); extrude(ex,(z,t)=>circle(0.17,0.48+t*0.1,z,0.055,0.055,16),-0.95,-0.3,3,7,0); M.push(ex); out.exhaust=[[0.17,0.48,-0.95]];
  // rider: torso, hips, helmet, arms, legs
  const sp=(p,n,O)=>{ O.m=M_PLASTIC; O.c[0]=suit[0]; O.c[1]=suit[1]; O.c[2]=suit[2]; O.gloss=0.4; if (Math.abs(p[0])>0.12 && Math.abs(p[0])<0.16){ O.c[0]=acc[0]; O.c[1]=acc[1]; O.c[2]=acc[2]; } };
  const torso=Mesh(1); { const RR=[]; for (let i=0;i<=10;i++){ const t=i/10, s=Math.sin(t*PI); RR.push(rrect(0,lerp(1.02,1.3,t),lerp(-0.42,0.08,t),0.04+0.17*Math.pow(s,0.5),0.04+0.12*Math.pow(s,0.6),0.08,3)); } loft(torso,RR,0,0); } torso.paint=sp; M.push(torso);
  const hip=Mesh(1); ellipsoid(hip,0,0.98,-0.38,0.19,0.13,0.17,8,16); hip.paint=sp; M.push(hip);
  const hel=Mesh(1); ellipsoid(hel,0,1.38,0.2,0.135,0.13,0.15,10,20); hel.paint=(p,n,O)=>{ O.m=M_PAINT; O.c[0]=helm[0]; O.c[1]=helm[1]; O.c[2]=helm[2]; if (n[2]>0.4 && p[1]<1.43 && p[1]>1.31) { O.m=M_GLASS; O.c[0]=0.02; O.c[1]=0.02; O.c[2]=0.05; } if (Math.abs(p[0])<0.02){ O.c[0]=1; O.c[1]=1; O.c[2]=1; } }; M.push(hel);
  for (const sd of [-1,1]){ const arm=Mesh(1); const RR=[]; for (let i=0;i<=6;i++){ const t=i/6; const c=circle(sd*lerp(0.2,0.3,t),lerp(1.24,0.96,t),lerp(0.02,0.42,t),0.055,0.055,10); RR.push(c); } loft(arm,RR,0,0); arm.paint=sp; M.push(arm);
    const leg=Mesh(1); const LL=[]; for (let i=0;i<=6;i++){ const t=i/6; LL.push(circle(sd*lerp(0.14,0.25,t),lerp(0.95,0.72,t),lerp(-0.35,0.0,t),0.075,0.08,10)); } loft(leg,LL,0,0); leg.paint=sp; M.push(leg);
    const boot=Mesh(4); ellipsoid(boot,sd*0.25,0.58,-0.12,0.06,0.12,0.13,6,10); M.push(boot); }
  A.tail=[[0,0.88,-1.0]]; A.ind=[[-0.12,0.7,-0.98],[0.12,0.7,-0.98]];
}

// ------------------------------------------------------------------ rasteriser
// job: {model, opts, yaw (deg), pitch (deg), persp (m), pm (px per m), ss, tod, layer:'body'|'baked'|'wheel', wheel (index), phase, blur, steer (deg)}
let GB=null; function gbuf(n){ if (!GB || GB.n<n){ GB={n, z:new Float32Array(n), tri:new Int32Array(n), b1:new Float32Array(n), b2:new Float32Array(n)}; } return GB; }
const SH=Out();
const BC=new Map();
function render(job){ const t0=Date.now(); const key=job.model+'|'+JSON.stringify(job.opts||{}); let car=BC.get(key); if (!car){ car=build(job.model, job.opts||{}); BC.set(key,car); if (BC.size>24) BC.delete(BC.keys().next().value); } const yaw=(job.yaw||0)*PI/180, pit=(job.pitch==null?12:job.pitch)*PI/180, f=job.persp||9, ss=job.ss||2, pm=(job.pm||100)*ss; const E=ENV[job.tod|0];
  const cy=Math.cos(yaw), sy=Math.sin(yaw), cp=Math.cos(pit), sp=Math.sin(pit);
  // which meshes
  let list=[]; const wheelPaints=[]; const layer=job.layer||'baked';
  const meshes=flatten(car.meshes); for (const m of meshes) if (!m.paint) m.paint=defaultPaint(m.part);
  if (layer!=='wheel'){ for (const m of meshes) list.push(m); }
  const wm=flatten(car.wheelMeshes.map(x=>x));
  car.wheelMeshes.forEach((w,i)=>{ const pnt=paintWheel(w, job.phase||0, !!job.blur); w.paint=pnt; for (const c of (w.caps||[])) c.paint=pnt; });
  for (const w of car.wheelMeshes){ if (w.steered){ steerWheel(w,-w.steered); w.steered=0; } w.mask=0; for (const c of w.caps) c.mask=0; }
  if (layer==='baked'){ for (const w of car.wheelMeshes){ list.push(w); for (const c of w.caps) list.push(c); } }
  if (layer==='body'){ for (const w of car.wheelMeshes){ w.mask=1; list.push(w); for (const c of w.caps){ c.mask=1; list.push(c); } } }
  if (layer==='wheel'){ const w=car.wheelMeshes[job.wheel|0]; const st=(job.steer||0)*PI/180; if (st && w.wheel.front){ steerWheel(w,st); w.steered=st; } list.push(w); for (const c of w.caps) list.push(c); }
  // project all vertices
  const dRef=-(car.L/2)*cp - 0.5*sp;   /* scale 1 at the rear bumper: the end we look at keeps its real width */
  const proj=(x,y,z,o)=>{ const wx=x*cy+z*sy, wz=-x*sy+z*cy; const up=y*cp+wz*sp, d=wz*cp-y*sp; const s=(f+dRef)/(f+d); o[0]=wx*s*pm; o[1]=-up*s*pm; o[2]=d; return o; };
  let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9; const P=[]; const tmp=[0,0,0];
  for (const m of list){ const V=m.v, n=V.length/9, S=new Float32Array(n*3); for (let i=0;i<n;i++){ proj(V[i*9],V[i*9+1],V[i*9+2],tmp); S[i*3]=tmp[0]; S[i*3+1]=tmp[1]; S[i*3+2]=tmp[2]; { if (tmp[0]<x0) x0=tmp[0]; if (tmp[0]>x1) x1=tmp[0]; if (tmp[1]<y0) y0=tmp[1]; if (tmp[1]>y1) y1=tmp[1]; } } P.push(S); }
  // the shadow quad is large: clip the canvas to the car plus a margin
  if (layer!=='wheel'){ const mg=0.3*pm; x0-=mg; x1+=mg; y1+=mg*0.45; y0-=4*ss; }
  else { x0-=2*ss; y0-=2*ss; x1+=2*ss; y1+=2*ss; }
  // snap to whole output pixels
  x0=Math.floor(x0/ss)*ss; y0=Math.floor(y0/ss)*ss; const W=Math.ceil((x1-x0)/ss)*ss+ss, H=Math.ceil((y1-y0)/ss)*ss+ss; const N=W*H; const G=gbuf(N);
  G.z.fill(1e9,0,N); G.tri.fill(-1,0,N);
  // triangle table
  const triMesh=[], triIdx=[]; let tid=0; const TRI=[];
  for (let k=0;k<list.length;k++){ const m=list[k], S=P[k], T=m.t, V=m.v;
    for (let i=0;i<T.length;i+=3){ const a=T[i],b=T[i+1],c=T[i+2];
      // cull by the face normal (world): faces turned away from the camera are skipped
      if (!m.noCull){ const fn=triN(V,a,b,c); const wx=fn[0]*cy+fn[2]*sy, wz=-fn[0]*sy+fn[2]*cy; const vd=wx*0 + fn[1]*sp + wz*(-cp); if (vd<=0) continue; }
      const ax=S[a*3]-x0, ay=S[a*3+1]-y0, bx=S[b*3]-x0, by=S[b*3+1]-y0, cx=S[c*3]-x0, cyy=S[c*3+1]-y0; const az=S[a*3+2], bz=S[b*3+2], cz=S[c*3+2];
      const area=(bx-ax)*(cyy-ay)-(by-ay)*(cx-ax); if (Math.abs(area)<1e-6) continue; const id=TRI.length; TRI.push([k,a,b,c]);
      let hole=null; if (m.hole){ const zmin=Math.min(V[a*9+2],V[b*9+2],V[c*9+2]), zmax=Math.max(V[a*9+2],V[b*9+2],V[c*9+2]), ymin=Math.min(V[a*9+1],V[b*9+1],V[c*9+1]); for (const [zc,rr] of m.holeZ){ if (zmax>zc-rr && zmin<zc+rr && ymin<rr*2+0.1){ hole=m.hole; break; } } }
      let minx=Math.max(0,Math.floor(Math.min(ax,bx,cx))), maxx=Math.min(W-1,Math.ceil(Math.max(ax,bx,cx))), miny=Math.max(0,Math.floor(Math.min(ay,by,cyy))), maxy=Math.min(H-1,Math.ceil(Math.max(ay,by,cyy)));
      const ia=1/area; const dx0=(by-cyy)*ia, dx1=(cyy-ay)*ia;
      for (let py=miny;py<=maxy;py++){ const yy=py+0.5, xs=minx+0.5; let w0=((bx-xs)*(cyy-yy)-(by-yy)*(cx-xs))*ia, w1=((cx-xs)*(ay-yy)-(cyy-yy)*(ax-xs))*ia; let o=py*W+minx; let inside=false;
        for (let px=minx;px<=maxx;px++,o++,w0+=dx0,w1+=dx1){ const w2=1-w0-w1; if (w0<-1e-5||w1<-1e-5||w2<-1e-5){ if (inside) break; continue; } inside=true;
          const zz=w0*az+w1*bz+w2*cz; if (zz<G.z[o]){ if (hole && hole(w0*V[a*9]+w1*V[b*9]+w2*V[c*9], w0*V[a*9+1]+w1*V[b*9+1]+w2*V[c*9+1], w0*V[a*9+2]+w1*V[b*9+2]+w2*V[c*9+2])) continue; G.z[o]=zz; G.tri[o]=id; G.b1[o]=w1; G.b2[o]=w2; } } } } }
  const tR=Date.now();
  // shade
  const col=new Float32Array(N*4), emi=new Float32Array(N*3); const lp=[0,0,0], nn=[0,0,0], O=SH; const Ld=norm(E.L), Vd=[0,sp,-cp]; const Hd=norm([Ld[0]+Vd[0],Ld[1]+Vd[1],Ld[2]+Vd[2]]); const ec=[0,0,0];
  const shadowA=layer!=='wheel'?car.shadow.paint:null; const gp=[0,0,0];
  for (let o=0;o<N;o++){ const id=G.tri[o];
    if (id<0 || list[TRI[id][0]].mask){ if (!shadowA) continue; // ground point under this pixel (y=0 plane), back into car space
      const X=(o%W+0.5+x0)/pm, Y=(((o/W)|0)+0.5+y0)/pm; const fr_=f+dRef; const wz=-Y*f/(sp*fr_+Y*cp); if (!(wz>-50&&wz<50)) continue; const s_=fr_/(f+wz*cp); const wx=X/s_; gp[0]=wx*cy-wz*sy; gp[2]=wx*sy+wz*cy; O.a=0; shadowA(gp,null,O); if (O.a>0.004){ col[o*4]=0; col[o*4+1]=0; col[o*4+2]=0.01; col[o*4+3]=O.a; } continue; } const T=TRI[id], m=list[T[0]], V=m.v; const a=T[1],b=T[2],c=T[3], w1=G.b1[o], w2=G.b2[o], w0=1-w1-w2;
    for (let j=0;j<3;j++){ lp[j]=V[a*9+3+j]*w0+V[b*9+3+j]*w1+V[c*9+3+j]*w2; nn[j]=V[a*9+6+j]*w0+V[b*9+6+j]*w1+V[c*9+6+j]*w2; }
    O.m=0; O.a=1; O.e[0]=O.e[1]=O.e[2]=0; O.gloss=1; O.c[0]=O.c[1]=O.c[2]=0.5;
    // local paint coords: wheels paint in their own (pre-transform) space
    let pp=lp; if (m.wheelLocal) pp=m.wheelLocal(lp);
    const nl=hyp(nn[0],nn[1],nn[2])||1; nn[0]/=nl; nn[1]/=nl; nn[2]/=nl;
    m.paint(pp,nn,O,m.part);
    if (O.m===M_HOLE) continue;
    if (O.m===M_SHADOW){ col[o*4]=0; col[o*4+1]=0; col[o*4+2]=0.01; col[o*4+3]=O.a; continue; }
    // world normal: car normals turned by the yaw; cap normals get a gentle bulge so flat ends still shade
    let nx=nn[0], ny=nn[1], nz=nn[2]; if (m.flat && (m.part===2||m.part===3) && m.capOf && m.capOf.part===1){ const B=car.Wd/2; nx+=lp[0]/B*0.35; ny+=(lp[1]-0.7)*0.25; const l=hyp(nx,ny,nz); nx/=l; ny/=l; nz/=l; }
    if (m.wheelN){ const r=m.wheelN(nx,ny,nz); nx=r[0]; ny=r[1]; nz=r[2]; }
    const Nx=nx*cy+nz*sy, Nz=-nx*sy+nz*cy, Ny=ny;
    { const px=lp[0]*cy+lp[2]*sy, pz=-lp[0]*sy+lp[2]*cy, py=lp[1]; if (!m.wheelLocalSpace){ let vx=-px, vy=f*sp-py, vz=-f*cp-pz; const vl=Math.sqrt(vx*vx+vy*vy+vz*vz); Vd[0]=vx/vl; Vd[1]=vy/vl; Vd[2]=vz/vl; } else { Vd[0]=0; Vd[1]=sp; Vd[2]=-cp; }
      let hx=Ld[0]+Vd[0], hy=Ld[1]+Vd[1], hz=Ld[2]+Vd[2]; const hl_=Math.sqrt(hx*hx+hy*hy+hz*hz); Hd[0]=hx/hl_; Hd[1]=hy/hl_; Hd[2]=hz/hl_; }
    const ndl=Math.max(0,Nx*Ld[0]+Ny*Ld[1]+Nz*Ld[2]), ndv=Math.max(0,Nx*Vd[0]+Ny*Vd[1]+Nz*Vd[2]), ndh=Math.max(0,Nx*Hd[0]+Ny*Hd[1]+Nz*Hd[2]);
    const dv=Nx*Vd[0]+Ny*Vd[1]+Nz*Vd[2]; const Rx=2*dv*Nx-Vd[0], Ry=2*dv*Ny-Vd[1], Rz=2*dv*Nz-Vd[2]; env(E,Rx,Ry,Rz,ec);
    const hemi=0.5+0.5*Ny; const ambR=lerp(E.gh[0],E.hor[0],hemi)*E.amb, ambG=lerp(E.gh[1],E.hor[1],hemi)*E.amb, ambB=lerp(E.gh[2],E.hor[2],hemi)*E.amb;
    const kd=E.key*ndl; let r,g,bb; const C=O.c; const fres=Math.pow(1-ndv,5);
    // ambient occlusion: lower body and wheel wells are darker
    const ao=m.part===20||m.part===21?1:clamp(0.55+lp[1]*0.9,0.55,1);
    switch(O.m){
      case M_PAINT: { const F=(0.08+0.92*fres)*O.gloss; const sp1=Math.pow(ndh,140)*2.4*O.gloss, sp2=Math.pow(ndh,24)*0.18*O.gloss;
        r=C[0]*(ambR+kd*E.sun[0])*ao*(1-F)+ec[0]*F*0.95+(sp1+sp2)*E.sun[0]; g=C[1]*(ambG+kd*E.sun[1])*ao*(1-F)+ec[1]*F*0.95+(sp1+sp2)*E.sun[1]; bb=C[2]*(ambB+kd*E.sun[2])*ao*(1-F)+ec[2]*F*0.95+(sp1+sp2)*E.sun[2];
        // metallic flake: a little of the sky tinted by the paint
        r+=ec[0]*C[0]*0.22; g+=ec[1]*C[1]*0.22; bb+=ec[2]*C[2]*0.22; break; }
      case M_GLASS: { const F=0.12+0.88*Math.pow(1-ndv,3.5); const sp1=Math.pow(ndh,300)*3; r=C[0]+ec[0]*F*0.62+sp1*E.sun[0]; g=C[1]+ec[1]*F*0.62+sp1*E.sun[1]; bb=C[2]+ec[2]*F*0.66+sp1*E.sun[2]; break; }
      case M_CHROME: { const sp1=Math.pow(ndh,90)*2; r=ec[0]*0.85+0.04+sp1; g=ec[1]*0.85+0.04+sp1; bb=ec[2]*0.88+0.05+sp1; break; }
      case M_METAL: { const sp1=Math.pow(ndh,30)*0.5; r=C[0]*(ambR+kd)+ec[0]*0.25+sp1; g=C[1]*(ambG+kd)+ec[1]*0.25+sp1; bb=C[2]*(ambB+kd)+ec[2]*0.25+sp1; break; }
      case M_RUBBER: { const sp1=Math.pow(ndh,10)*0.05; r=C[0]*(ambR+kd)*1.2+sp1+ec[0]*fres*0.1; g=C[1]*(ambG+kd)*1.2+sp1+ec[1]*fres*0.1; bb=C[2]*(ambB+kd)*1.2+sp1+ec[2]*fres*0.1; break; }
      case M_CARBON: { const wv=((Math.floor(lp[0]*70)+Math.floor(lp[1]*70)+Math.floor(lp[2]*70))&1)?1.5:0.7; const F=0.05+0.95*fres; const sp1=Math.pow(ndh,60)*0.8; r=C[0]*wv*(ambR+kd)+ec[0]*F*0.6+sp1; g=C[1]*wv*(ambG+kd)+ec[1]*F*0.6+sp1; bb=C[2]*wv*(ambB+kd)+ec[2]*F*0.6+sp1; break; }
      case M_LENS: { const F=0.08+0.92*Math.pow(1-ndv,4); const sp1=Math.pow(ndh,200)*2.5; r=C[0]*(0.4+ambR+kd)+ec[0]*F*0.5+sp1; g=C[1]*(0.4+ambG+kd)+ec[1]*F*0.5+sp1; bb=C[2]*(0.4+ambB+kd)+ec[2]*F*0.5+sp1; break; }
      case M_EMIT: { r=C[0]; g=C[1]; bb=C[2]; break; }
      case M_LINER: { r=0.012; g=0.012; bb=0.016; break; }
      case M_MATTE: { r=C[0]*(ambR+kd)*1.1; g=C[1]*(ambG+kd)*1.1; bb=C[2]*(ambB+kd)*1.1; break; }
      default: { const F=0.04+0.5*fres; const sp1=Math.pow(ndh,40)*0.35*O.gloss; r=C[0]*(ambR+kd)*ao+ec[0]*F*0.5+sp1; g=C[1]*(ambG+kd)*ao+ec[1]*F*0.5+sp1; bb=C[2]*(ambB+kd)*ao+ec[2]*F*0.5+sp1; }
    }
    col[o*4]=r; col[o*4+1]=g; col[o*4+2]=bb; col[o*4+3]=1; emi[o*3]=O.e[0]; emi[o*3+1]=O.e[1]; emi[o*3+2]=O.e[2]; }
  const tS=Date.now();
  // downsample (ss x ss box), tone map; body colour and emissive (lights) as separate images
  const w=W/ss, h=H/ss, outC=new Uint8ClampedArray(w*h*4), outE=new Uint8ClampedArray(w*h*4); let eAny=false; const runIn=!!job.runIn;
  const tm=v=>{ v=v<0?0:v; return 255*(v<0.8?v:0.8+0.2*(1-Math.exp(-(v-0.8)*2.2))/1)/1; };
  for (let y=0;y<h;y++) for (let x=0;x<w;x++){ let r=0,g=0,b=0,a=0, er=0,eg=0,eb=0;
    for (let j=0;j<ss;j++) for (let i=0;i<ss;i++){ const o=(y*ss+j)*W+(x*ss+i); const al=col[o*4+3]; r+=col[o*4]*al; g+=col[o*4+1]*al; b+=col[o*4+2]*al; a+=al; er+=emi[o*3]; eg+=emi[o*3+1]; eb+=emi[o*3+2]; }
    const k=ss*ss, q=(y*w+x)*4; if (a>0){ let R=r/a, Gc=g/a, Bc=b/a; if (runIn){ R+=er/k; Gc+=eg/k; Bc+=eb/k; } outC[q]=tm(R); outC[q+1]=tm(Gc); outC[q+2]=tm(Bc); outC[q+3]=255*a/k; }
    if (!runIn){ er/=k; eg/=k; eb/=k; const m=Math.max(er,eg,eb); if (m>0.004){ eAny=true; const A=Math.min(1,m); outE[q]=255*Math.min(1,er/m); outE[q+1]=255*Math.min(1,eg/m); outE[q+2]=255*Math.min(1,eb/m); outE[q+3]=255*A; } } }
  // anchors in output pixels
  const ox=-x0/ss, oy=-y0/ss; const pt=(q)=>{ proj(q[0],q[1],q[2],tmp); return [tmp[0]/ss+ox, tmp[1]/ss+oy, tmp[2]]; };
  const A=car.anchors, an={ axle:car.wheels.map(w=>pt([w.x,w.r,w.z])), rax:pt([0,0,car.wheels[0].z]), wheel:A.wheel.map(pt), contact:A.contact.map(pt), tail:A.tail.map(pt), ind:A.ind.map(pt), head:A.head.map(pt), exhaust:car.exhaust.map(pt), roof:pt(A.roof), rear:pt(A.rear), nose:pt(A.nose), mirror:A.mirror?A.mirror.map(pt):null, wing:A.wing?A.wing.map(pt):null, front:car.wheels.map(w=>w.front), side:car.wheels.map(w=>w.side), dual:car.wheels.map(w=>!!w.inner) };
  let wc=null; if (layer==='wheel'){ const ww=car.wheels[job.wheel|0]; wc=pt([ww.x,ww.r,ww.z]); }
  // car width in output px at yaw 0 (for scaling at runtime)
  return {w,h,ox,oy,data:outC, emis:eAny?outE:null, anchors:an, wc, pm:pm/ss, Wd:car.Wd, L:car.L, ms:Date.now()-t0, msR:tR-t0, msS:tS-tR};
}
function norm(v){ const l=hyp(v[0],v[1],v[2])||1; return [v[0]/l,v[1]/l,v[2]/l]; }
function defaultPaint(part){ return (p,n,O,pt)=>{ if (part===2){ O.m=M_CHROME; return; } if (part===7||pt===7){ const r=hyp(p[0]%1,p[1]%1); O.m=M_PLASTIC; O.c[0]=O.c[1]=O.c[2]=0.01; return; } if (part===6){ O.m=M_CARBON; O.c[0]=O.c[1]=O.c[2]=0.05; return; } O.m=M_PLASTIC; O.c[0]=O.c[1]=O.c[2]=0.03; }; }
// exhaust tips: the end cap is a dark hole with a hot rim
function steerWheel(w,ang){ // rotate the wheel about its own vertical axis (around its centre)
  const ww=w.wheel; const all=[w].concat(w.caps||[]); for (const m of all){ const V=m.v; for (let i=0;i<V.length;i+=9){ const x=V[i]-ww.x, z=V[i+2]-ww.z; const c=Math.cos(ang), s=Math.sin(ang); V[i]=ww.x+x*c+z*s; V[i+2]=ww.z-x*s+z*c; const nx=V[i+6], nz=V[i+8]; V[i+6]=nx*c+nz*s; V[i+8]=-nx*s+nz*c; } } }

const API={ render, MODELS:Object.keys(MODELS), version:1 };
root.NR_CAR3D=API;
// worker side
if (typeof document==='undefined' && typeof self!=='undefined' && typeof postMessage==='function'){
  self.onmessage=(ev)=>{ const jobs=ev.data.jobs||[]; for (const j of jobs){ try{ const r=render(j); const tr=[r.data.buffer]; if (r.emis) tr.push(r.emis.buffer); postMessage({id:j.id, r}, tr); } catch(e){ postMessage({id:j.id, err:String(e&&e.stack||e)}); } } postMessage({done:ev.data.batch}); };
}
})(typeof self!=='undefined'?self:this);
