/* Neon Rush car models (ours). Every car, van, truck and bike is a small 3D model built from lofted cross-sections in code.
   This file builds the meshes and bakes their procedural paint (clear-coat body with liveries, glass, chrome, lenses, panel lines, plates)
   into texture atlases plus indexed geometry for the live three.js renderer in gfx/cars-gl.js, which draws every car in real time
   (continuous yaw, roll, pitch, spinning and steering wheels, lights as emissive channels, lighting from the scene palette).
   Body colour and accent colour are not baked: tint masks let one bake serve every livery of a model. Lamp lenses carry a light channel
   (running, tail, brake, left / right indicator, head) so the renderer switches them per car and per frame.
   Runs inside a Web Worker when it can (this same file), so the menu stays smooth while the garage is being prepared.
   No assets, no build step. Car space: x right, y up, z forward, metres; the ground is y = 0, the rear axle is wheels[0].z. */
(function(root){
'use strict';
const PI=Math.PI, TAU=PI*2; let WHEEL_SEG=40;   /* tools/dump_cars.mjs raises this to 96 for the shipped meshes (1,056 triangles per wheel) */
const clamp=(v,a,b)=>v<a?a:v>b?b:v, lerp=(a,b,t)=>a+(b-a)*t, smooth=(a,b,x)=>{ const t=clamp((x-a)/(b-a),0,1); return t*t*(3-2*t); };
const frac=x=>x-Math.floor(x); const hyp=(a,b,c)=>Math.sqrt(a*a+b*b+(c===undefined?0:c*c));
function hex(c){ return [parseInt(c.slice(1,3),16)/255,parseInt(c.slice(3,5),16)/255,parseInt(c.slice(5,7),16)/255]; }
// piecewise smooth curve through knots [[u,v],...]
function curve(k){ return u=>{ if (u<=k[0][0]) return k[0][1]; for (let i=1;i<k.length;i++){ if (u<=k[i][0]){ const a=k[i-1], b=k[i], t=(u-a[0])/(b[0]-a[0]); const s=t*t*(3-2*t); return a[1]+(b[1]-a[1])*s; } } return k[k.length-1][1]; }; }

// ------------------------------------------------------------------ meshes
// mesh: {v: list of vertices [px,py,pz, lx,ly,lz, nx,ny,nz], t:[a,b,c,...], part, paint, rings (the loft it was made from), caps}
function Mesh(part){ return {v:[], t:[], part:part||0, flat:null, rings:null, caps:null}; }
function addV(m,x,y,z,lx,ly,lz){ m.v.push(x,y,z,lx,ly,lz,0,0,0); return m.v.length/9-1; }
// loft: rings[i] = {c:[cx,cy,cz] (ring centre used to orient faces), p:[[x,y,z],...]} all same length, closed rings
function loft(m,rings,capA,capB,local){ const n=rings[0].p.length, base=m.v.length/9;
  for (const r of rings) for (const q of r.p){ const L=local?local(q):q; addV(m,q[0],q[1],q[2],L[0],L[1],L[2]); }
  m.rings=rings; m.loftBase=base; m.loftT0=m.t.length;
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
  sub.axis=[ax[0]*dir,ax[1]*dir,ax[2]*dir]; sub.ring=ring;
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

// ------------------------------------------------------------------ material ids and light channels (shared with gfx/cars-gl.js)
const M_PAINT=0, M_GLASS=1, M_CHROME=2, M_RUBBER=3, M_PLASTIC=4, M_LENS=5, M_CARBON=6, M_MATTE=8, M_METAL=9, M_SHADOW=10, M_LINER=11, M_HOLE=12, M_EMIT=13;
const CH_RUN=1, CH_TAIL=2, CH_BRAKE=3, CH_INDL=4, CH_INDR=5, CH_HEAD=6;
// paint output record (reused). tint: 0 as painted, 1 body colour, 2 accent colour, 3 number plate (pu,pv = plate texture coords)
function Out(){ return {m:0, c:[0,0,0], e:[0,0,0], a:1, gloss:1, tint:0, ch:0, pu:0, pv:0}; }
function grey(O,v){ O.c[0]=O.c[1]=O.c[2]=v; O.tint=0; }
function setc(O,r,g,b){ O.c[0]=r; O.c[1]=g; O.c[2]=b; O.tint=0; }
function setv(O,v){ O.c[0]=v[0]; O.c[1]=v[1]; O.c[2]=v[2]; O.tint=0; }
function tintCol(O){ O.c[0]=O.c[1]=O.c[2]=1; O.tint=1; }
function tintAcc(O){ O.c[0]=O.c[1]=O.c[2]=1; O.tint=2; }
function plateAt(O,u,v){ O.m=M_MATTE; O.tint=3; O.pu=clamp(u,0,1); O.pv=clamp(v,0,1); O.c[0]=O.c[1]=O.c[2]=0.8; O.ch=CH_RUN; }
// light-cluster helper: unlit lens with reflector texture; ch = light channel, scale = brightness at full channel intensity
function lens(o,col,ch,scale,k,pat){ o.m=M_LENS; o.tint=0; const d=0.22+0.12*pat; o.c[0]=col[0]*d; o.c[1]=col[1]*d; o.c[2]=col[2]*d; if (ch){ o.ch=ch; const lit=scale, e=lit*(0.75+0.5*k); o.e[0]=Math.min(4,col[0]*e*1.6+k*k*lit*0.9); o.e[1]=col[1]*e*1.2+k*k*lit*0.75; o.e[2]=col[2]*e*1.2+k*k*lit*0.7; } }
const RED=hex('#ff1a36'), AMBER=hex('#ffa31a'), WHITE=[1,1,1];

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

// Each model: dims, profile, wheels, extra meshes and a paint function. opts: {rim, traffic, suit}
const MODELS={};
function wheelsStd(zr,zf,r,rf,tw,x){ return [{z:zr,r,w:tw,x,front:false},{z:zf,r:rf,w:tw*0.9,x,front:true}]; }
MODELS.comet={ L:4.5, Wd:2.0, H:1.2, wheels:wheelsStd(-1.36,1.42,0.35,0.33,0.31,0.8), rim:'#22242c', pm:1,
  prof:{ y0:curve([[0,0.3],[0.1,0.2],[0.9,0.17],[1,0.25]]), yb:curve([[0,0.8],[0.12,0.86],[0.42,0.84],[0.72,0.76],[0.93,0.62],[1,0.5]]), w:curve([[0,0.84],[0.07,0.95],[0.2,0.99],[0.42,0.94],[0.62,0.92],[0.82,0.95],[0.96,0.9],[1,0.78]]),
    cab:curve([[0,0],[0.17,0],[0.36,1],[0.6,1],[0.75,0],[1,0]]), yr:curve([[0,1.0],[0.3,1.17],[0.48,1.23],[0.62,1.19],[1,0.9]]), wr:curve([[0,0.52],[0.45,0.66],[1,0.52]]) } };
MODELS.titan={ L:4.7, Wd:2.0, H:1.36, wheels:wheelsStd(-1.42,1.48,0.37,0.35,0.33,0.8), rim:'#c8ccd8', pm:1,
  prof:{ y0:curve([[0,0.32],[0.08,0.24],[0.9,0.22],[1,0.3]]), yb:curve([[0,0.86],[0.3,0.88],[0.66,0.86],[0.9,0.84],[1,0.74]]), w:curve([[0,0.9],[0.05,0.97],[0.25,0.99],[0.5,0.95],[0.75,0.97],[0.97,0.95],[1,0.86]]),
    cab:curve([[0,0],[0.25,0],[0.37,1],[0.6,1],[0.7,0],[1,0]]), yr:curve([[0,1.1],[0.4,1.31],[0.55,1.32],[1,1.1]]), wr:curve([[0,0.6],[0.5,0.68],[1,0.6]]) } };
MODELS.arrow={ L:4.6, Wd:2.04, H:1.1, wheels:wheelsStd(-1.4,1.5,0.36,0.33,0.33,0.82), rim:'#d8dbe4', pm:1,
  prof:{ y0:curve([[0,0.24],[0.1,0.15],[0.9,0.14],[1,0.18]]), yb:curve([[0,0.72],[0.15,0.76],[0.35,0.74],[0.62,0.7],[0.9,0.55],[1,0.42]]), w:curve([[0,0.9],[0.06,1.0],[0.22,1.02],[0.42,0.9],[0.6,0.9],[0.8,0.99],[0.95,0.94],[1,0.82]]),
    cab:curve([[0,0],[0.26,0],[0.4,1],[0.6,1],[0.76,0],[1,0]]), yr:curve([[0,0.9],[0.4,1.12],[0.52,1.15],[0.62,1.1],[1,0.8]]), wr:curve([[0,0.4],[0.5,0.54],[1,0.4]]) } };
MODELS.hatch={ L:4.1, Wd:1.84, H:1.5, wheels:wheelsStd(-1.3,1.3,0.32,0.32,0.24,0.74), rim:'#b8bcc8', pm:1,
  prof:{ y0:curve([[0,0.34],[0.07,0.26],[0.92,0.25],[1,0.34]]), yb:curve([[0,0.95],[0.1,0.96],[0.6,0.92],[0.85,0.84],[1,0.72]]), w:curve([[0,0.84],[0.05,0.9],[0.3,0.91],[0.7,0.9],[0.95,0.86],[1,0.78]]),
    cab:curve([[0,0.2],[0.06,1],[0.6,1],[0.78,0],[1,0]]), yr:curve([[0,1.25],[0.1,1.43],[0.45,1.47],[0.62,1.42],[1,1.0]]), wr:curve([[0,0.6],[0.4,0.7],[1,0.6]]) } };
MODELS.van={ L:5.0, Wd:2.0, H:2.1, wheels:wheelsStd(-1.6,1.65,0.36,0.36,0.25,0.82), rim:'#9aa0ae', pm:1,
  prof:{ y0:curve([[0,0.4],[0.06,0.34],[0.94,0.34],[1,0.4]]), yb:curve([[0,1.05],[0.7,1.06],[0.88,1.0],[1,0.85]]), w:curve([[0,0.94],[0.04,0.99],[0.9,0.98],[1,0.9]]),
    cab:curve([[0,1],[0.82,1],[0.97,0.2],[1,0]]), yr:curve([[0,1.98],[0.02,2.04],[0.8,2.04],[0.95,1.5],[1,1.2]]), wr:curve([[0,0.74],[0.03,0.8],[0.85,0.8],[1,0.66]]) } };
MODELS.truck={ L:8.4, Wd:2.5, H:3.8, wheels:[{z:-3.0,r:0.5,w:0.52,x:0.95,dual:1},{z:-1.8,r:0.5,w:0.52,x:0.95,dual:1},{z:2.7,r:0.5,w:0.3,x:1.0,front:true}], rim:'#c9ccd6', pm:1, truck:true };
MODELS.bike={ L:2.1, Wd:0.8, H:1.6, wheels:[{z:-0.7,r:0.32,w:0.19,x:0,front:false,single:1},{z:0.72,r:0.31,w:0.13,x:0,front:true,single:1}], rim:'#30323a', pm:1, bike:true };

// ------------------------------------------------------------------ build a model into meshes + paint functions
function build(name,o){ const Md=MODELS[name]; const L=Md.L, hl=L/2; const meshes=[]; const isTraffic=!!o.traffic;
  const W=Md.wheels; const wheelList=[]; for (const w of W){ for (const sd of (w.single?[0]:[-1,1])){ const xs=w.single?0:sd*w.x; wheelList.push({x:xs, z:w.z, r:w.r, w:w.w, side:sd||1, front:!!w.front, dual:!!w.dual}); if (w.dual) wheelList.push({x:sd*(w.x-0.4), z:w.z, r:w.r, w:w.w*0.9, side:sd, front:false, dual:true, inner:true}); } }
  const out={meshes, L, Wd:Md.Wd, H:Md.H, wheels:wheelList, anchors:{}, name};
  const A=out.anchors;
  if (name==='truck') buildTruck(out,o);
  else if (name==='bike') buildBike(out,o);
  else {
    const B=bodyLUT(Md.prof); out.B=B;
    // ---- body loft (u from rear to front)
    const body=Mesh(1); const R=[]; const NS=46; for (let i=0;i<=NS;i++){ const u=i/NS; const uu=u<0.5? 0.5*Math.pow(u*2,1.15) : 1-0.5*Math.pow((1-u)*2,1.15); R.push(bodyRing(B,uu,-hl+uu*L,0)); }
    loft(body,R,2,3); meshes.push(body); body.paint=paintBody; for (const c of body.caps) c.paint=paintBody; body.weight=1.0; body.caps[0].weight=1.7; body.caps[1].weight=1.2;
    body.hole=(x,y,z)=>{ const u=(z+hl)/L; for (const wh of wheelList){ if (wh.single||wh.inner) continue; if ((x<0)!==(wh.x<0)) continue; const dz=z-wh.z, dy=y-wh.r; if (dz*dz+dy*dy<(wh.r+0.035)*(wh.r+0.035) && Math.abs(x)>lut(B.w,u)*0.62 && y<lut(B.yb,u)) return true; } return false; };
    for (const wh of wheelList){ if (wh.single||wh.inner) continue; const lin=Mesh(11); lin.noCull=1; const R2=wh.r+0.07, sd=wh.x<0?-1:1, x0=wh.x-sd*0.28, x1=wh.x+sd*0.12;
      const ring=(xx)=>{ const p=[]; for (let k=0;k<=12;k++){ const a=-0.25+k/12*(PI+0.5); p.push([xx, wh.r+Math.sin(a)*R2, wh.z+Math.cos(a)*R2]); } for (let k=12;k>=0;k--){ const a=-0.25+k/12*(PI+0.5); p.push([xx, wh.r+Math.sin(a)*R2*0.97, wh.z+Math.cos(a)*R2*0.97]); } return {c:[xx,wh.r,wh.z],p}; };
      const RR=[]; for (let i=0;i<=2;i++){ const r=ring(lerp(x0,x1,i/2)); r.axis=[1,0,0]; RR.push(r); } loft(lin,RR,0,0); lin.paint=(p,n,O)=>{ O.m=M_LINER; grey(O,0.012); }; lin.weight=0.5; meshes.push(lin); }
    const st=name;
    // ---- wings, diffusers, exhausts, mirrors
    const ex=[]; let wingY=0;
    if (st==='comet'){ const wy=1.06; wingY=wy; const wing=Mesh(4); extrude(wing,(z,t)=>rrect(0,wy+0.01*Math.sin(t*PI),z,0.8,0.024,0.018,3),-hl+0.06,-hl+0.32,3,4,4); meshes.push(wing);
        for (const sd of [-1,1]){ const ep=Mesh(4); extrude(ep,(z)=>rrect(sd*0.82,wy-0.03,z,0.012,0.08,0.01,2),-hl+0.04,-hl+0.36,2,4,4); meshes.push(ep); const sp=Mesh(4); extrude(sp,(z,t)=>rrect(sd*0.42,lerp(0.9,wy-0.02,0.5),z,0.018,(wy-0.88)/2,0.01,2),-hl+0.12,-hl+0.26,1,4,4); meshes.push(sp); }
        for (const x of [-0.56,-0.42,0.42,0.56]) ex.push([x,0.36,0.052]); }
    else if (st==='titan'){ const lip=Mesh(5); extrude(lip,(z,t)=>rrect(0,0.94+t*0.03,z,0.9,0.03,0.025,3),-hl+0.02,-hl+0.18,2,4,4); meshes.push(lip); lip.paint=paintBody; lip.part=1; for (const c of lip.caps) c.paint=paintBody;
        for (const x of [-0.58,0.58]) ex.push([x,0.36,0.07]); }
    else if (st==='arrow'){ const wy=1.2; wingY=wy; const wing=Mesh(4); extrude(wing,(z,t)=>rrect(0,wy+0.015*Math.sin(t*PI),z,0.86,0.03,0.022,3),-hl-0.06,-hl+0.3,3,4,4); meshes.push(wing);
        for (const sd of [-1,1]){ const ep=Mesh(4); extrude(ep,(z)=>rrect(sd*0.88,wy-0.05,z,0.014,0.12,0.01,2),-hl-0.08,-hl+0.34,2,4,4); meshes.push(ep);
          const neck=Mesh(4); extrude(neck,(z,t)=>{ const yy=lerp(0.72,wy,t); const ring=rrect(sd*0.32,0,0,0.014,0.06,0.01,2); for (const q of ring.p){ const yy2=q[1]; q[1]=yy; q[2]=lerp(-hl+0.42,-hl+0.1,t*t)+yy2; } ring.c=[sd*0.32,yy,lerp(-hl+0.42,-hl+0.1,t*t)]; return ring; },0,1,6,0,0); meshes.push(neck); }
        const fin=Mesh(1); extrude(fin,(z,t)=>{ const h=lerp(0.02,0.2,smooth(0,1,1-t)); return rrect(0,lerp(lut(B.yr,0.5),0.98,1-t)+h/2,z,0.012,h/2+0.01,0.008,2); },-hl+0.25,-hl+2.1,8,4,4); fin.paint=paintBody; for (const c of fin.caps) c.paint=paintBody; meshes.push(fin);
        for (const x of [-0.09,0.09]) ex.push([x,0.62,0.05]); }
    else if (st==='hatch'){ const sp=Mesh(1); extrude(sp,(z,t)=>rrect(0,1.47-t*0.02,z,0.6,0.03,0.025,3),-hl+0.25,-hl+0.55,2,4,4); sp.paint=paintBody; for (const c of sp.caps) c.paint=paintBody; meshes.push(sp); ex.push([-0.52,0.32,0.035]); }
    else if (st==='van'){ ex.push([-0.6,0.3,0.035]); const st2=Mesh(4); extrude(st2,(z)=>rrect(0,0.36,z,0.7,0.04,0.02,2),-hl-0.08,-hl+0.05,1,4,4); meshes.push(st2); }
    for (const e of ex){ const m=Mesh(2); extrude(m,(z,t)=>circle(e[0],e[1],z,e[2]*(1+0.06*t),e[2]*(1+0.06*t),18),-hl-0.06,-hl+0.12,2,7,0); meshes.push(m);
      for (const c of m.caps){ c.part=7; c.paint=(p,n,O)=>{ const r=hyp(p[0]-e[0],p[1]-e[1])/e[2]; if (r>0.78){ O.m=M_CHROME; return; } O.m=M_EMIT; const k=r>0.62?0.12:0.015; setc(O,k*1.2,k*0.8,k); }; } }
    out.exhaust=ex.map(e=>[e[0],e[1],-hl-0.06]);
    // diffuser fins
    if (st==='comet'||st==='arrow'){ for (const x of (st==='arrow'?[-0.62,-0.34,-0.12,0.12,0.34,0.62]:[-0.48,-0.2,0.2,0.48])){ const f=Mesh(6); extrude(f,(z,t)=>rrect(x,0.27+0.03*t,z,0.008,0.05*(1-t)+0.015,0.004,1),-hl+0.01,-hl+0.5,2,6,6); f.weight=0.4; meshes.push(f); } }
    // mirrors
    const uw=st==='van'?0.86:st==='hatch'?0.74:0.72; const zm=-hl+uw*L, wm=lut(B.w,uw), ym=lut(B.yb,uw)+0.1;
    for (const sd of [-1,1]){ const m=Mesh(1); ellipsoid(m,sd*(wm+0.09),ym,zm,0.09,0.055,0.11,6,12); m.paint=(p,n,O)=>{ O.m=M_PAINT; tintCol(O); if (n[2]<-0.55){ O.m=M_CHROME; } else if (n[1]<-0.3){ O.m=M_PLASTIC; grey(O,0.03); } }; meshes.push(m); const arm=Mesh(4); ellipsoid(arm,sd*(wm+0.02),ym-0.025,zm+0.02,0.07,0.025,0.05,4,8); arm.weight=0.5; meshes.push(arm); }
    A.mirror=[[-(wm+0.17),ym,zm],[wm+0.17,ym,zm]];
    if (wingY) A.wing=[[-0.8,wingY+0.03,-hl+0.2],[0.8,wingY+0.03,-hl+0.2]];
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
  return out;

  // ================= paint: body
  function paintBody(p,n,O,part){ const x=p[0], y=p[1], z=p[2]; const u=(z+hl)/L; const ax=Math.abs(x);
    O.m=M_PAINT; tintCol(O); O.a=1;
    if (!out.B) return; const B=out.B; const yb=lut(B.yb,u), yr=lut(B.yr,u), cab=lut(B.cab,u), w=lut(B.w,u), y0=lut(B.y0,u);
    // wheel arches: a hole where the tyre shows, a dark liner rim around it, a flared lip
    for (const wh of wheelList){ if (wh.single) continue; const dz=z-wh.z, dy=y-wh.r, rr=Math.sqrt(dz*dz+dy*dy), R1=wh.r+0.035, R2=wh.r+0.075;
      if (rr<R2 && ax>w*0.62 && Math.sign(x)===Math.sign(wh.x) && y<yb){ O.m=M_LINER; grey(O,rr<R1?0.012:0.02); return; }
      if (rr<R2+0.03 && ax>w*0.8 && Math.sign(x)===Math.sign(wh.x) && y<yb){ const k=(rr-R2)/0.03; dim(O,0.7+0.3*k); } }
    const rear=part===2, front=part===3;
    if (rear) return paintRear(x,y,O,yb,w,y0);
    if (front) return paintFront(x,y,O,yb,w,y0);
    // sills / lower skirts in carbon or black
    if (y<y0+0.07 && ax>w*0.6){ O.m=name==='hatch'||name==='van'?M_PLASTIC:M_CARBON; grey(O,0.06); return; }
    // greenhouse: glass with black frames, pillars
    if (cab>0.18 && y>yb+0.03){ const top=yr-0.035; const inG=y<top;
      if (inG){ let pillar=false; const sideways=Math.abs(n[0])>0.45; if (name==='van'){ if (u<0.82 && sideways) { // van: no side windows behind the cab, rear windows on the doors
            O.m=M_PAINT; return; } }
        if (sideways){ const um=name==='hatch'?0.42:0.5; if (Math.abs(u-um)<0.012) pillar=true; }
        const edge=Math.min(y-(yb+0.03), top-y); if (edge<0.022 || pillar){ O.m=M_PLASTIC; grey(O,0.03); return; }
        O.m=M_GLASS; setc(O,0.01,0.015,0.03);
        if (name==='titan' && n[2]<-0.25){ const k=frac((y-yb)*26); if (k<0.42){ O.m=M_PLASTIC; grey(O,0.025); } }   // window louvres
        if (n[2]<-0.25 && name!=='titan' && ax<0.5){ // rear window: heating lines + a third brake light at the top
          if (Math.abs(frac((y-yb)*30)-0.5)<0.03) { O.c[0]+=0.08; O.c[1]+=0.04; O.c[2]+=0.03; }
          if (top-y<0.05 && ax<0.22) { lens(O,RED,CH_BRAKE,1,1-ax/0.22,frac(x*40)<0.5?1:0); } }
        return; }
      // roof
      if (name==='comet'){ O.m=M_PAINT; setc(O,0.03,0.03,0.035); }
    }
    // livery
    if (name==='comet'){ if (ax>0.06 && ax<0.17 && (n[1]>0.25 || y>yb-0.02)){ tintAcc(O); } else if (ax<0.035 && n[1]>0.25){ grey(O,0.95); } }
    else if (name==='titan'){ if (ax>0.2 && ax<0.4 && n[1]>0.3){ tintAcc(O); } if (Math.abs(n[0])>0.6 && Math.abs(y-(y0+(yb-y0)*0.55))<0.035){ tintAcc(O); } }
    else if (name==='arrow'){ if (Math.abs(n[0])>0.5){ const s=y-(y0+0.1)-(u-0.15)*0.35; if (s>0 && s<0.12 && u>0.1 && u<0.85){ tintAcc(O); } }
      if (Math.abs(n[0])>0.5 && u>0.43 && u<0.57 && Math.abs(y-(y0+(yb-y0)*0.55))<0.13){ const dx=(u-0.5)*L, dy=y-(y0+(yb-y0)*0.55); if (dx*dx+dy*dy<0.016){ O.m=M_MATTE; grey(O,0.95); if (dx*dx+dy*dy<0.008 && Math.abs(dx)<0.035 && dy>-0.06) { grey(O,0.05); } } } }
    else if (isTraffic && name==='van'){ if (Math.abs(n[0])>0.6 && y>0.9 && y<1.25 && u>0.15 && u<0.75){ tintAcc(O); } }
    // panel lines (door seams, boot lid, fuel flap)
    if (Math.abs(n[0])>0.55 && y<yb){ const d1=Math.abs(u-(name==='van'?0.5:0.4)), d2=Math.abs(u-(name==='van'?0.83:0.66)); if (d1<0.0016 || d2<0.0016){ dim(O,0.35); }
      if (Math.abs(y-(y0+(yb-y0)*0.78))<0.004 && u>0.08 && u<0.92) dim(O,0.75); if (Math.abs(y-(yb-0.04))<0.008) light(O,0.18);
      if (name!=='van' && u>0.17 && u<0.25 && y<yb-0.05 && y>y0+0.12 && name!=='hatch'){ const k=frac((y-y0)*22); if (k<0.45){ O.m=M_PLASTIC; grey(O,0.03); } }   // side intake slats
      if (name!=='van' && Math.abs(u-0.83)<0.012 && Math.abs(y-(yb-0.09))<0.03 && ax>0) { /* side repeater */ lens(O,AMBER,0,0,0.5,0); }
    }
    if (n[1]>0.5 && u<0.16 && u>0.02 && y>yb-0.01){ const lid=Math.abs(u-0.15)<0.0018 || (Math.abs(ax-0.72)<0.004 && u<0.15); if (lid) dim(O,0.45); }
    if (n[1]>0.5 && u>0.8 && u<0.98){ if (Math.abs(ax-0.6)<0.004 || Math.abs(u-0.8)<0.0015) dim(O,0.55); if (name!=='hatch' && name!=='van' && u>0.84 && u<0.92 && ax>0.18 && ax<0.42 && frac(u*120)<0.5){ O.m=M_PLASTIC; grey(O,0.03); } }   // bonnet vents
  }
  function paintRear(x,y,O,yb,w,y0){ const ax=Math.abs(x), sd=x<0?-1:1, IND=sd<0?CH_INDL:CH_INDR;
    // lower bumper / diffuser
    const lowY=name==='van'?0.48:name==='hatch'?0.45:0.42;
    if (y<lowY){ O.m=(name==='comet'||name==='arrow')?M_CARBON:M_PLASTIC; grey(O,name==='titan'?0.05:0.04);
      if (name==='titan' && y>lowY-0.08){ O.m=M_CHROME; }
      if (ax>w-0.18 && y>y0+0.08 && y<y0+0.14){ lens(O,RED,CH_RUN,0.4,0.3,0); }   // rear reflectors / fog light
      if (name==='comet' && ax<0.12 && y>0.22 && y<0.3){ lens(O,RED,CH_TAIL,0.9,0.5,1); }   // rain light
      return; }
    if (Math.abs(y-lowY)<0.012) { dim(O,0.4); return; }
    // plate recess + plate
    const pw=0.26, py0=lowY+0.03, py1=py0+0.12; if (ax<pw+0.02 && y>py0-0.02 && y<py1+0.02){ if (ax<pw && y>py0 && y<py1){ plateAt(O,(x+pw)/(2*pw),1-(y-py0)/(py1-py0)); return; } O.m=M_PLASTIC; grey(O,0.03); return; }
    if (name==='comet'){
      if (rect(ax,y,0.42,w-0.02,0.6,0.71)){ const k=1-Math.abs(y-0.655)/0.055; const seg=frac((ax-0.42)*24)<0.8?1:0; if (ax>w-0.1 && y<0.64){ lens(O,AMBER,IND,1,0.6,seg); return; } lens(O,RED,CH_TAIL,1,k*0.85,seg); return; }
      if (rect(ax,y,0,0.42,0.64,0.668)){ lens(O,RED,CH_TAIL,0.9,0.6,frac(ax*30)<0.6?1:0); return; }
      if (rect(ax,y,0.3,0.4,0.56,0.6)){ lens(O,WHITE,0,0,0.3,1); return; }
      if (ax<0.1 && Math.abs(y-0.74)<0.03){ O.m=M_CHROME; return; }   // badge
      if (ax<0.17 && ax>0.06 && y>0.68){ tintAcc(O); } }
    else if (name==='titan'){
      if (rect(ax,y,0.08,w-0.04,0.57,0.76)){ O.m=M_PLASTIC; grey(O,0.025);
        for (const cx of [0.48,0.72]){ const dx=ax-cx, dy=y-0.665, r=Math.sqrt(dx*dx+dy*dy); if (r<0.075){ if (r>0.062){ O.m=M_CHROME; return; } const ring=frac(r*55)<0.5?1:0; lens(O,RED,CH_TAIL,1,1-r/0.062,ring); return; } }
        if (ax<0.12 && Math.abs(y-0.665)<0.04){ O.m=M_CHROME; } if (Math.abs(ax-0.24)<0.05 && Math.abs(y-0.665)<0.03) lens(O,WHITE,0,0,0.3,1); return; }
      if (Math.abs(y-0.565)<0.008 || Math.abs(y-0.765)<0.008) { O.m=M_CHROME; return; }
      if (ax>0.2 && ax<0.4 && y>0.76){ tintAcc(O); } }
    else if (name==='arrow'){
      if (rect(ax,y,w-0.13,w-0.03,0.44,0.72)){ const k=1-Math.abs(ax-(w-0.08))/0.05; const seg=frac(y*40)<0.7?1:0; if (y<0.5) lens(O,AMBER,IND,1,0.6,seg); else lens(O,RED,CH_TAIL,1,k,seg); return; }
      if (rect(ax,y,0,w-0.13,0.69,0.705)){ lens(O,RED,CH_TAIL,0.8,0.5,1); return; }
      if (ax<0.18 && y>0.55 && y<0.69){ O.m=M_CARBON; grey(O,0.04); return; }
      if (ax>0.2 && ax<0.7 && y>0.45 && y<0.66){ O.m=M_PLASTIC; grey(O,0.02); if (frac((y-0.45)*30)<0.35) grey(O,0.08); return; }   // rear mesh vents
    }
    else if (name==='hatch'){
      if (rect(ax,y,w-0.2,w-0.01,0.72,0.95)){ const seg=frac(y*18)<0.85?1:0; if (y<0.78){ lens(O,AMBER,IND,1,0.5,seg); return; } if (y<0.82 && ax<w-0.12){ lens(O,WHITE,0,0,0.3,seg); return; } lens(O,RED,CH_TAIL,1,1-Math.abs(y-0.88)/0.08,seg); return; }
      if (ax<0.08 && Math.abs(y-0.78)<0.035){ O.m=M_CHROME; return; } if (Math.abs(y-0.62)<0.004) dim(O,0.5); }
    else if (name==='van'){
      if (rect(ax,y,w-0.13,w-0.02,0.62,1.25)){ const seg=frac(y*14)<0.85?1:0; if (y<0.78){ lens(O,AMBER,IND,1,0.5,seg); return; } if (y<0.86){ lens(O,WHITE,0,0,0.3,seg); return; } lens(O,RED,CH_TAIL,1,0.7,seg); return; }
      if (ax<0.006) { dim(O,0.3); return; }
      if (y>1.22 && y<1.85 && ax>0.06 && ax<w-0.2){ const e=Math.min(y-1.22,1.85-y,ax-0.06,w-0.2-ax); if (e<0.025){ O.m=M_PLASTIC; grey(O,0.03); return; } O.m=M_GLASS; setc(O,0.01,0.015,0.03); return; }
      if (Math.abs(ax-0.1)<0.03 && Math.abs(y-1.0)<0.07) { O.m=M_CHROME; return; }
      if (y>1.95 && ax<0.25){ lens(O,RED,CH_TAIL,1,0.6,1); return; } }
  }
  function paintFront(x,y,O,yb,w,y0){ const ax=Math.abs(x);
    if (y<0.36){ O.m=M_PLASTIC; grey(O,0.04); if (ax<0.6 && y>0.18 && frac(ax*30)<0.5) grey(O,0.015); return; }
    if (ax>w-0.42 && ax<w-0.05 && y>yb-0.2 && y<yb-0.06){ O.m=M_LENS; grey(O,0.12); O.ch=CH_HEAD; O.e[0]=O.e[1]=O.e[2]=1.5;
      if (ax>w-0.4 && ax<w-0.08 && Math.abs(y-(yb-0.08))<0.008){ setc(O,0.8,0.9,1); O.m=M_EMIT; O.ch=0; O.e[0]=O.e[1]=O.e[2]=0; } return; }   /* daytime running strip */
    if (ax<0.35 && y>0.38 && y<yb-0.12){ O.m=M_PLASTIC; grey(O,0.03); return; }
  }
}
function dim(O,k){ O.c[0]*=k; O.c[1]*=k; O.c[2]*=k; }
function light(O,k){ if (O.tint){ dim(O,1+k*0.7); return; } O.c[0]+= (1-O.c[0])*k; O.c[1]+=(1-O.c[1])*k; O.c[2]+=(1-O.c[2])*k; }
function rect(x,y,x0,x1,y0,y1){ return x>=x0&&x<=x1&&y>=y0&&y<=y1; }

// ------------------------------------------------------------------ wheels: tyre with tread and lettering, rim with spokes, brake disc and calliper
function wheelMesh(w,rimDef,rimOpt){ const m=Mesh(20); const r=w.r, hw=w.w/2;
  const prof=[[-hw,r*0.84],[-hw*0.96,r*0.95],[-hw*0.8,r],[hw*0.8,r],[hw*0.96,r*0.95],[hw,r*0.84]];
  const R=prof.map(([a,rr])=>{ const c=circle(0,0,a,rr,rr,WHEEL_SEG); return c; }); for (const ring of R) ring.c=[0,0,ring.p[0][2]];
  loft(m,R,0,21); const face=m.caps[0];
  // turn onto the x axis: outer face points away from the car
  const ang=(w.single?1:w.side)*PI/2; const dx=w.x, dz=w.z, dy=r; xform(m,ang,dx,dy,dz);
  m.wheel=w; m.ang=ang; m.wheelLocalSpace=1; face.wheelLocalSpace=1; m.rimCol=hex(rimOpt||rimDef); m.paint=null; face.part=21; m.part=20; return m; }
function paintWheel(wh,phase,blur){ const rimC=wh.rimCol, w=wh.wheel, r=w.r, rimR=r*0.72, cal=hex('#ff2d55');
  return (p,n,O,part)=>{ // p = local (built along z): x,y in the wheel plane, z axial
    const lx=p[0], ly=p[1]; const rr=Math.sqrt(lx*lx+ly*ly); let a=Math.atan2(ly,lx);
    if (part===20){ // tread
      O.m=M_RUBBER; const az=p[2]/(w.w/2); const g=Math.abs(az);
      let c=0.05; if (Math.abs(g-0.45)<0.06 || g<0.05) c=0.015; else if (!blur){ const k=frac((a+phase)*24/TAU + (az>0?0.25:0)); if (k<0.18) c=0.02; } else c=0.04;
      if (g>0.85) c=0.07; grey(O,c); return; }
    // face
    if (rr>rimR){ O.m=M_RUBBER; grey(O,0.045); if (rr>r*0.8 && rr<r*0.86){ const k=frac((a+(blur?0:phase))*6/TAU); if (k>0.1 && k<0.35){ O.m=M_MATTE; grey(O,blur?0.12:0.6); } } return; }
    if (rr>rimR-0.018){ O.m=M_CHROME; return; }
    if (rr<0.045){ O.m=rr<0.025?M_CHROME:M_PLASTIC; grey(O,0.05); return; }
    const ap=a+phase; const s=frac(ap*5/TAU); const spoke = Math.abs(s-0.5)>0.36 || (Math.abs(s-0.5)<0.03 && rr>rimR*0.55);
    // behind the spokes: drilled disc and a calliper
    const behind=()=>{ O.m=M_METAL; grey(O,0.22); if (rr>rimR*0.55 && rr<rimR*0.9 && frac(ap*18/TAU)<0.12 && frac(rr*40)<0.5){ grey(O,0.05); }
      const ca=a-(-0.9); if (rr>rimR*0.5 && rr<rimR*0.98 && Math.abs(Math.atan2(Math.sin(ca),Math.cos(ca)))<0.5){ O.m=M_PAINT; setv(O,cal); } if (rr<rimR*0.48){ grey(O,0.06); } };
    if (blur){ // spokes smeared into a disc: rim colour over the disc, with soft concentric streaks
      behind(); const k=0.62+0.08*Math.sin(rr*140); O.m=M_PAINT; setc(O,lerp(O.c[0],rimC[0],k),lerp(O.c[1],rimC[1],k),lerp(O.c[2],rimC[2],k)); O.gloss=0.5; return; }
    if (spoke){ O.m=M_PAINT; setv(O,rimC); O.gloss=0.9; const e=Math.abs(Math.abs(s-0.5)-0.36); if (e<0.02) dim(O,0.6); return; }
    behind(); }; }

// ------------------------------------------------------------------ truck and bike
function buildTruck(out,o){ const M=out.meshes, A=out.anchors; const hl=out.L/2;
  const z0=-hl+0.2, z1=hl-1.9;   // container
  const box=Mesh(1); extrude(box,(z)=>rrect(0,2.35,z,1.25,1.25,0.06,3),z0,z1,10,2,3); M.push(box); box.caps[0].weight=1.5;
  box.paint=(p,n,O,part)=>{ const x=p[0],y=p[1],z=p[2],ax=Math.abs(x); O.m=M_PAINT; tintCol(O); O.gloss=0.45;   /* a painted container, not a clear-coated car: less sky in it */
    if (part===2){ // rear doors: satin panels, corrugated, darker than the box so they keep their shape under a bright sky or in the rain
      O.m=M_PLASTIC; O.gloss=0.25; O.c[0]=O.c[1]=O.c[2]=0.55;
      { const rb=frac(ax*5.2); if (rb<0.12) dim(O,0.72); else if (rb<0.2) dim(O,1.12); }
      if (Math.abs(y-1.55)<0.025 || Math.abs(y-3.1)<0.025) dim(O,0.6);
      if (ax<0.008) { dim(O,0.3); return; }
      for (const bx of [0.32,0.82]){ if (Math.abs(ax-bx)<0.025){ O.m=M_CHROME; if (Math.abs(y-1.9)<0.05){ O.m=M_PLASTIC; grey(O,0.05); } return; } }
      if (ax>1.17 && Math.abs(frac((y-1.1)/0.8)-0.5)>0.42) { O.m=M_METAL; grey(O,0.4); return; }
      if (y<1.18 || y>3.52 || ax>1.19) dim(O,0.55);
      if (y>2.9 && y<3.25 && ax<1.0){ tintAcc(O); dim(O,0.8); if (frac(x*2.2+y*1.3)<0.12) grey(O,0.82); }
      if (ax>1.0 && ax<1.12 && y>3.45 && y<3.55) lens(O,AMBER,CH_RUN,0.6,0.5,1);
      return; }
    if (Math.abs(n[0])>0.6){ if (frac((z-z0)/0.6)<0.05) dim(O,0.6); if (y>1.9 && y<2.6 && z>z0+0.6 && z<z1-0.6){ tintAcc(O); } if (y<1.18) dim(O,0.5); }
    if (n[1]>0.6) dim(O,1.12); };
  for (const c of box.caps) c.paint=box.paint;
  // chassis rails, under-ride bar with lights, mud flaps
  const ch=Mesh(4); extrude(ch,(z)=>rrect(0,0.85,z,0.55,0.16,0.03,2),z0+0.1,hl-0.2,4,4,4); M.push(ch);
  const bar=Mesh(4); extrude(bar,(z)=>rrect(0,0.62,z,1.12,0.09,0.03,2),z0-0.08,z0+0.08,1,22,4); M.push(bar);
  bar.caps[0].paint=(p,n,O)=>{ O.m=M_PLASTIC; setc(O,0.9,0.85,0.2); if (frac(p[0]*3+p[1]*3)<0.5){ grey(O,0.06); } }; bar.caps[0].weight=1.4;
  const lb=Mesh(4); extrude(lb,(z)=>rrect(0,0.96,z,1.2,0.11,0.03,2),z0-0.1,z0+0.02,1,23,4); M.push(lb); lb.caps[0].weight=1.6;
  lb.caps[0].paint=(p,n,O)=>{ const x=p[0], ax=Math.abs(x), y=p[1]; O.m=M_PLASTIC; grey(O,0.05);
    const L=[[1.05,RED,CH_TAIL],[0.83,RED,CH_TAIL],[0.61,AMBER,x<0?CH_INDL:CH_INDR],[0.4,WHITE,0]]; for (const [cx,c,chn] of L){ const dx=ax-cx, dy=y-0.96, r=Math.sqrt(dx*dx+dy*dy); if (r<0.085){ if (r>0.072){ O.m=M_CHROME; return; } lens(O,c,chn,1,1-r/0.072,frac(r*60)<0.5?1:0); return; } }
    if (ax<0.26 && Math.abs(y-0.96)<0.07){ plateAt(O,(x+0.26)/0.52,1-(y-0.89)/0.14); } };
  for (const sd of [-1,1]){ const f=Mesh(4); extrude(f,(z)=>rrect(sd*0.95,0.45,z,0.27,0.3,0.02,2),-3.0-0.62,-3.0-0.6,1,24,4); M.push(f); f.caps[0].paint=(p,n,O)=>{ O.m=M_RUBBER; grey(O,0.06); if (Math.abs(p[1]-0.6)<0.06 && Math.abs(Math.abs(p[0])-0.95)<0.2){ O.m=M_MATTE; grey(O,0.75); } }; }
  // cab
  const cab=Mesh(1); extrude(cab,(z,t)=>rrect(0,1.75,z,1.22,1.3-0.15*t,0.18,3),hl-1.8,hl,4,0,3); M.push(cab);
  cab.paint=(p,n,O)=>{ O.m=M_PAINT; setc(O,0.9,0.9,0.92); if (p[1]>2.0 && p[2]>hl-0.1 && Math.abs(p[0])<1.1){ O.m=M_GLASS; setc(O,0.01,0.015,0.03); } if (Math.abs(n[0])>0.6 && p[1]>2.1 && p[2]>hl-1.2){ O.m=M_GLASS; setc(O,0.01,0.015,0.03); } }; for (const c of cab.caps) c.paint=cab.paint;
  for (const sd of [-1,1]){ const ex=Mesh(2); extrude(ex,(z)=>circle(sd*1.15,2.6,z,0.07,0.07,14),hl-2.0,hl-1.7,1,0,0); M.push(ex); }
  A.tail=[[-0.94,0.96,z0-0.1],[0.94,0.96,z0-0.1]]; A.ind=[[-0.61,0.96,z0-0.1],[0.61,0.96,z0-0.1]]; out.exhaust=[[1.15,3.3,hl-1.85]]; A.roofLamp=[[-1.06,3.5,z0],[1.06,3.5,z0]];
}
function buildBike(out,o){ const M=out.meshes, A=out.anchors; const suit=hex(o.suit||'#20202a');
  // tail cowl and seat
  const tail=Mesh(1); const R=[]; for (let i=0;i<=10;i++){ const t=i/10, z=lerp(-1.0,0.15,t); const hw=lerp(0.07,0.15,smooth(0,0.6,t)), y=lerp(0.86,0.7,t), hh=lerp(0.07,0.13,t); R.push(rrect(0,y,z,hw,hh,Math.min(hw,hh)*0.8,3)); } loft(tail,R,2,0); M.push(tail); tail.caps[0].weight=1.6;
  tail.paint=(p,n,O,part)=>{ O.m=M_PAINT; tintCol(O); if (part===2){ if (p[1]>0.84) lens(O,RED,CH_TAIL,1,1-Math.abs(p[0])/0.07,frac(p[0]*60)<0.6?1:0); else { O.m=M_PLASTIC; grey(O,0.03); } return; } if (p[1]>0.86 && p[2]>-0.6){ O.m=M_PLASTIC; grey(O,0.04); } if (Math.abs(p[0])>0.05 && Math.abs(n[0])>0.5 && frac(p[2]*3)<0.3){ tintAcc(O); } }; for (const c of tail.caps) c.paint=tail.paint;
  // tank + fairing
  const tank=Mesh(1); ellipsoid(tank,0,0.82,0.42,0.19,0.14,0.36,10,18); tank.paint=(p,n,O)=>{ O.m=M_PAINT; tintCol(O); if (Math.abs(p[0])<0.03) tintAcc(O); }; M.push(tank);
  const fair=Mesh(1); ellipsoid(fair,0,0.62,0.55,0.2,0.24,0.4,10,18); fair.paint=tank.paint; M.push(fair);
  // plate hanger + plate
  const ph=Mesh(4); extrude(ph,(z,t)=>rrect(0,0.68-t*0.12,z,0.1,0.06,0.01,2),-1.02,-0.96,1,25,0); M.push(ph); ph.caps[0].paint=(p,n,O)=>{ plateAt(O,(p[0]+0.1)/0.2,1-(p[1]-0.62)/0.12); }; ph.caps[0].weight=1.6;
  // exhaust can
  const ex=Mesh(2); extrude(ex,(z,t)=>circle(0.17,0.48+t*0.1,z,0.055,0.055,16),-0.95,-0.3,3,7,0); M.push(ex); out.exhaust=[[0.17,0.48,-0.95]];
  // rider: torso, hips, helmet, arms, legs
  const sp=(p,n,O)=>{ O.m=M_PLASTIC; setv(O,suit); O.gloss=0.4; if (Math.abs(p[0])>0.12 && Math.abs(p[0])<0.16){ tintAcc(O); } };
  const torso=Mesh(1); { const RR=[]; for (let i=0;i<=10;i++){ const t=i/10, s=Math.sin(t*PI); RR.push(rrect(0,lerp(1.02,1.3,t),lerp(-0.42,0.08,t),0.04+0.17*Math.pow(s,0.5),0.04+0.12*Math.pow(s,0.6),0.08,3)); } loft(torso,RR,0,0); } torso.paint=sp; M.push(torso);
  const hip=Mesh(1); ellipsoid(hip,0,0.98,-0.38,0.19,0.13,0.17,8,16); hip.paint=sp; M.push(hip);
  const hel=Mesh(1); ellipsoid(hel,0,1.38,0.2,0.135,0.13,0.15,10,20); hel.paint=(p,n,O)=>{ O.m=M_PAINT; tintCol(O); if (n[2]>0.4 && p[1]<1.43 && p[1]>1.31) { O.m=M_GLASS; setc(O,0.02,0.02,0.05); } if (Math.abs(p[0])<0.02){ grey(O,1); } }; M.push(hel);
  for (const sd of [-1,1]){ const arm=Mesh(1); const RR=[]; for (let i=0;i<=6;i++){ const t=i/6; const c=circle(sd*lerp(0.2,0.3,t),lerp(1.24,0.96,t),lerp(0.02,0.42,t),0.055,0.055,10); RR.push(c); } loft(arm,RR,0,0); arm.paint=sp; M.push(arm);
    const leg=Mesh(1); const LL=[]; for (let i=0;i<=6;i++){ const t=i/6; LL.push(circle(sd*lerp(0.14,0.25,t),lerp(0.95,0.72,t),lerp(-0.35,0.0,t),0.075,0.08,10)); } loft(leg,LL,0,0); leg.paint=sp; M.push(leg);
    const boot=Mesh(4); ellipsoid(boot,sd*0.25,0.58,-0.12,0.06,0.12,0.13,6,10); M.push(boot); }
  A.tail=[[0,0.88,-1.0]]; A.ind=[[-0.12,0.7,-0.98],[0.12,0.7,-0.98]];
}
function defaultPaint(part){ return (p,n,O,pt)=>{ if (part===2){ O.m=M_CHROME; return; } if (part===7||pt===7){ O.m=M_PLASTIC; grey(O,0.01); return; } if (part===6){ O.m=M_CARBON; grey(O,0.05); return; } O.m=M_PLASTIC; grey(O,0.03); }; }

// ------------------------------------------------------------------ bake: paint sampled per texel into an atlas, meshes exported as indexed geometry
/* items: one per surface. loft: u along the rings (index-linear), v around the ring (wrapping, seam duplicated in the geometry).
   cap: planar, in the two axes across the cap's normal. Wheels bake twice: sharp and spin-blurred (uv2), the renderer cross-fades. */
function itemsOf(car){ const items=[]; const meshes=flatten(car.meshes); for (const m of meshes){ if (!m.paint) m.paint=defaultPaint(m.part); if (m.part===10) continue; }
  const add=(m,o)=>{ items.push(Object.assign({m, weight:m.weight||(m.capOf&&m.capOf.weight)||0.8, blur:false, wheelOf:null},o)); };
  for (const m of meshes){ if (m.part===10) continue; if (m.flat) add(m,{kind:'cap'}); else add(m,{kind:'loft'}); }
  car.wheelMeshes.forEach((w,wi)=>{ const face=w.caps[0]; for (const blur of [false,true]){ const pnt=paintWheel(w,0,blur); add(w,{kind:'loft',blur,wheelOf:wi,paint:pnt,weight:0.9}); add(face,{kind:'cap',blur,wheelOf:wi,paint:pnt,weight:1.2}); } });
  for (const it of items){ const m=it.m;
    if (it.kind==='loft'){ const R=m.rings, nr=R.length, n=R[0].p.length; let len=0; for (let i=1;i<nr;i++){ let d=0; for (let j=0;j<n;j++){ const a=R[i-1].p[j], b=R[i].p[j]; d+=hyp(b[0]-a[0],b[1]-a[1],b[2]-a[2]); } len+=d/n; }
      let circ=0; for (let i=0;i<nr;i++){ let c=0; for (let j=0;j<n;j++){ const a=R[i].p[j], b=R[i].p[(j+1)%n]; c+=hyp(b[0]-a[0],b[1]-a[1],b[2]-a[2]); } circ+=c; } circ/=nr; it.len=Math.max(0.01,len); it.circ=Math.max(0.01,circ); }
    else { const ax=m.axis; const ia=Math.abs(ax[0])>0.5?[1,2]:Math.abs(ax[1])>0.5?[0,2]:[0,1]; it.ia=ia; let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9; for (const q of m.ring.p){ const a=q[ia[0]], b=q[ia[1]]; if (a<x0) x0=a; if (a>x1) x1=a; if (b<y0) y0=b; if (b>y1) y1=b; } const g=0.01; it.bb=[x0-g,y0-g,x1+g,y1+g]; it.len=Math.max(0.01,x1-x0+2*g); it.circ=Math.max(0.01,y1-y0+2*g); } }
  return items; }
function pack(items,W,H){ const PAD=2; let area=0; for (const it of items) area+=it.len*it.circ*it.weight*it.weight; let D=Math.sqrt(0.74*W*H/area);
  for (let tries=0;tries<30;tries++){ for (const it of items){ it.w=clamp(Math.ceil(it.len*D*it.weight),3,W-2*PAD); it.h=clamp(Math.ceil(it.circ*D*it.weight),3,H-2*PAD); }
    const ord=items.slice().sort((a,b)=>b.h-a.h); let x=PAD, y=PAD, rowH=0, ok=true;
    for (const it of ord){ if (x+it.w+PAD>W){ x=PAD; y+=rowH+PAD; rowH=0; } if (y+it.h+PAD>H){ ok=false; break; } it.x=x; it.y=y; x+=it.w+PAD; if (it.h>rowH) rowH=it.h; }
    if (ok) return D; D*=0.93; }
  return D; }
function bake(model,o,W,H){ const car=build(model,o||{}); const items=itemsOf(car); pack(items,W,H);
  const col=new Uint8ClampedArray(W*H*4), mask=new Uint8ClampedArray(W*H*4), ids=new Uint8ClampedArray(W*H*2); const emF=new Float32Array(W*H*3), emP=new Uint8Array(W*H);
  const O=Out(); const P=[0,0,0], N=[0,0,0]; const PAD=2;
  for (const it of items){ const m=it.m, paint=it.paint||m.paint, part=m.part, V=m.v; const hole=m.hole;
    const x0=it.x-PAD, x1=it.x+it.w+PAD, y0=it.y-PAD, y1=it.y+it.h+PAD;
    if (it.kind==='loft'){ const R=m.rings, nr=R.length, n=R[0].p.length, base=m.loftBase;
      for (let ty=y0;ty<y1;ty++){ let v=(ty+0.5-it.y)/it.h; v-=Math.floor(v); const t=v*n, j=Math.min(n-1,Math.floor(t)), ft=t-j, j1=(j+1)%n;
        for (let tx=x0;tx<x1;tx++){ const u=clamp((tx+0.5-it.x)/it.w,0,1); const s=u*(nr-1); const i=Math.min(nr-2,Math.floor(s)), fs=s-i;
          const a=R[i].p[j], b=R[i].p[j1], c=R[i+1].p[j], d=R[i+1].p[j1];
          for (let k=0;k<3;k++) P[k]=(a[k]*(1-ft)+b[k]*ft)*(1-fs)+(c[k]*(1-ft)+d[k]*ft)*fs;
          const ia=(base+i*n+j)*9+6, ib=(base+i*n+j1)*9+6, ic=(base+(i+1)*n+j)*9+6, id=(base+(i+1)*n+j1)*9+6;
          for (let k=0;k<3;k++) N[k]=(V[ia+k]*(1-ft)+V[ib+k]*ft)*(1-fs)+(V[ic+k]*(1-ft)+V[id+k]*ft)*fs;
          texel(tx,ty,P,N,paint,part,hole); } } }
    else { const ia=it.ia, bb=it.bb, ring=m.ring; const other=3-ia[0]-ia[1]; const zc=ring.p[0][other]; const ax=m.axis; const bulge=(part===2||part===3)&&m.capOf&&m.capOf.part===1&&!m.wheelLocalSpace; const B=car.Wd/2;
      for (let ty=y0;ty<y1;ty++){ const vb=(ty+0.5-it.y)/it.h; for (let tx=x0;tx<x1;tx++){ const ub=(tx+0.5-it.x)/it.w;
          P[ia[0]]=bb[0]+(bb[2]-bb[0])*ub; P[ia[1]]=bb[1]+(bb[3]-bb[1])*vb; P[other]=zc; N[0]=ax[0]; N[1]=ax[1]; N[2]=ax[2];
          if (bulge){ N[0]+=P[0]/B*0.35; N[1]+=(P[1]-0.7)*0.25; const l=hyp(N[0],N[1],N[2]); N[0]/=l; N[1]/=l; N[2]/=l; }
          texel(tx,ty,P,N,paint,part,null); } } } }
  function texel(tx,ty,P,N,paint,part,hole){ if (tx<0||ty<0||tx>=W||ty>=H) return; const q=ty*W+tx;
    O.m=0; O.tint=0; O.ch=0; O.e[0]=O.e[1]=O.e[2]=0; O.gloss=1; O.a=1; O.c[0]=O.c[1]=O.c[2]=0.5; O.pu=O.pv=0;
    paint(P,N,O,part);
    const tn=O.tint, k=tn===1||tn===2?0.8:1;
    col[q*4]=255*Math.min(1,O.c[0]*k); col[q*4+1]=255*Math.min(1,O.c[1]*k); col[q*4+2]=255*Math.min(1,O.c[2]*k); col[q*4+3]=(hole && hole(P[0],P[1],P[2]))?0:255;
    mask[q*4]=tn===1?255:0; mask[q*4+1]=tn===2?255:0; mask[q*4+2]=tn===3?255:0; mask[q*4+3]=255;
    ids[q*2]=O.m*16+O.ch; ids[q*2+1]=255*clamp(O.gloss,0,1);
    if (tn===3){ emF[q*3]=O.pu; emF[q*3+1]=O.pv; emF[q*3+2]=0; emP[q]=1; } else { emF[q*3]=O.e[0]/4; emF[q*3+1]=O.e[1]/4; emF[q*3+2]=O.e[2]/4; } }
  // emissive at half resolution (lamps are large; plate coordinates averaged over plate texels only)
  const W2=W>>1, H2=H>>1, emi=new Uint8ClampedArray(W2*H2*4);
  for (let y=0;y<H2;y++) for (let x=0;x<W2;x++){ let r=0,g=0,b=0,np=0,pu=0,pv=0; for (let j=0;j<2;j++) for (let i=0;i<2;i++){ const q=(y*2+j)*W+(x*2+i); if (emP[q]){ np++; pu+=emF[q*3]; pv+=emF[q*3+1]; } else { r+=emF[q*3]; g+=emF[q*3+1]; b+=emF[q*3+2]; } }
    const o=(y*W2+x)*4; if (np>0){ emi[o]=255*pu/np; emi[o+1]=255*pv/np; emi[o+2]=0; emi[o+3]=255; } else { emi[o]=255*Math.min(1,r/4); emi[o+1]=255*Math.min(1,g/4); emi[o+2]=255*Math.min(1,b/4); emi[o+3]=255; } }
  // ---- geometry
  const geo=exportGeometry(car,items,W,H);
  const A=car.anchors; const meta={ model, L:car.L, Wd:car.Wd, H:car.H, rz:car.wheels[0].z, fz:car.wheels.find(w=>w.front).z, wheels:car.wheels, anchors:{tail:A.tail, ind:A.ind, head:A.head, roof:A.roof, rear:A.rear, nose:A.nose, mirror:A.mirror||null, wing:A.wing||null, exhaust:car.exhaust}, bbox:geo.bbox };
  return {W,H,col,mask,ids,emi,body:geo.body,body2:geo.body2,wheels:geo.wheels,meta}; }
function exportGeometry(car,items,W,H){ const bodyParts=[]; const wheelParts={};
  const bbox=[1e9,1e9,1e9,-1e9,-1e9,-1e9];
  for (const it of items){ const m=it.m; const uvOf=it.kind==='loft'?null:null; const P=[], Nn=[], UV=[], I=[]; const V=m.v;
    const wheel=it.wheelOf!=null?car.wheelMeshes[it.wheelOf]:null; const ang=wheel?wheel.ang:0, ca=Math.cos(-ang), sa=Math.sin(-ang);
    const pushV=(vi,u,v)=>{ // position: model space, or the wheel's own space (pre-xform local) for wheels; normals turned back for wheels
      let x=V[vi*9], y=V[vi*9+1], z=V[vi*9+2], nx=V[vi*9+6], ny=V[vi*9+7], nz=V[vi*9+8];
      if (wheel){ x=V[vi*9+3]; y=V[vi*9+4]; z=V[vi*9+5]; const tx=nx*ca+nz*sa, tz=-nx*sa+nz*ca; nx=tx; nz=tz; }
      else { if (x<bbox[0]) bbox[0]=x; if (y<bbox[1]) bbox[1]=y; if (z<bbox[2]) bbox[2]=z; if (x>bbox[3]) bbox[3]=x; if (y>bbox[4]) bbox[4]=y; if (z>bbox[5]) bbox[5]=z; }
      P.push(x,y,z); Nn.push(nx,ny,nz); UV.push((it.x+u*it.w)/W, (it.y+v*it.h)/H); return P.length/3-1; };
    if (it.kind==='loft'){ const R=m.rings, nr=R.length, n=R[0].p.length, base=m.loftBase, T=m.t, t0=m.loftT0;
      const idx=(i,j)=>i*(n+1)+j; for (let i=0;i<nr;i++) for (let j=0;j<=n;j++) pushV(base+i*n+(j%n), i/(nr-1), j/n);
      for (let i=0;i<nr-1;i++) for (let j=0;j<n;j++){ const q=t0+(i*n+j)*6; const a=idx(i,j), b=idx(i,j+1), c=idx(i+1,j+1), d=idx(i+1,j); const oa=base+i*n+j, od=base+(i+1)*n+j;
        if (T[q]===oa && T[q+1]===od){ I.push(a,d,c, a,c,b); } else { I.push(a,b,c, a,c,d); } } }
    else { const ia=it.ia, bb=it.bb; const n=m.v.length/9; for (let vi=0;vi<n;vi++){ const x=V[vi*9+ia[0]], y=V[vi*9+ia[1]]; pushV(vi,(x-bb[0])/(bb[2]-bb[0]),(y-bb[1])/(bb[3]-bb[1])); }
      for (let k=0;k<m.t.length;k++) I.push(m.t[k]);
      const bulge=(m.part===2||m.part===3)&&m.capOf&&m.capOf.part===1&&!m.wheelLocalSpace; if (bulge){ const B=car.Wd/2; for (let vi=0;vi<n;vi++){ let nx=Nn[vi*3]+P[vi*3]/B*0.35, ny=Nn[vi*3+1]+(P[vi*3+1]-0.7)*0.25, nz=Nn[vi*3+2]; const l=hyp(nx,ny,nz); Nn[vi*3]=nx/l; Nn[vi*3+1]=ny/l; Nn[vi*3+2]=nz/l; } } }
    const part={P,N:Nn,UV,I,twoSided:!!m.noCull};
    if (wheel){ const k=it.wheelOf; const W_=wheelParts[k]||(wheelParts[k]={sharp:[],blur:[]}); (it.blur?W_.blur:W_.sharp).push(part); } else bodyParts.push(part); }
  const merge=(parts,parts2)=>{ let nv=0, ni=0; for (const p of parts){ nv+=p.P.length/3; ni+=p.I.length; } const pos=new Float32Array(nv*3), nrm=new Float32Array(nv*3), uv=new Float32Array(nv*2), uv2=parts2?new Float32Array(nv*2):null, idx=nv>65000?new Uint32Array(ni):new Uint16Array(ni), two=new Uint8Array(nv); let vo=0, io=0;
    parts.forEach((p,pi)=>{ const n=p.P.length/3; pos.set(p.P,vo*3); nrm.set(p.N,vo*3); uv.set(p.UV,vo*2); if (uv2) uv2.set(parts2[pi].UV,vo*2); if (p.twoSided) two.fill(1,vo,vo+n); for (let k=0;k<p.I.length;k++) idx[io+k]=p.I[k]+vo; vo+=n; io+=p.I.length; });
    return {pos,nrm,uv,uv2,idx,two}; };
  const body=merge(bodyParts.filter(p=>!p.twoSided),null), body2=merge(bodyParts.filter(p=>p.twoSided),null); const wheels=car.wheelMeshes.map((wm,k)=>{ const W_=wheelParts[k]; const g=merge(W_.sharp,W_.blur); const w=wm.wheel; return Object.assign(g,{x:w.x,z:w.z,r:w.r,w:w.w,ang:wm.ang,side:w.side,front:w.front,dual:w.dual,inner:!!w.inner}); });
  return {body,body2,wheels,bbox}; }

const API={ bake, build, setWheelSeg:n=>{ WHEEL_SEG=n; }, MODELS:Object.keys(MODELS), version:2, M:{M_PAINT,M_GLASS,M_CHROME,M_RUBBER,M_PLASTIC,M_LENS,M_CARBON,M_MATTE,M_METAL,M_SHADOW,M_LINER,M_HOLE,M_EMIT}, CH:{CH_RUN,CH_TAIL,CH_BRAKE,CH_INDL,CH_INDR,CH_HEAD} };
root.NR_CAR3D=API;
// worker side: {bake:{id, model, opts, W, H}} -> {id, r} with every buffer transferred
if (typeof document==='undefined' && typeof self!=='undefined' && typeof postMessage==='function'){
  self.onmessage=(ev)=>{ const j=ev.data&&ev.data.bake; if (!j) return; try{ const t0=Date.now(); const r=bake(j.model,j.opts||{},j.W,j.H); r.ms=Date.now()-t0;
      const tr=[r.col.buffer,r.mask.buffer,r.ids.buffer,r.emi.buffer]; for (const g of [r.body,r.body2]) tr.push(g.pos.buffer,g.nrm.buffer,g.uv.buffer,g.idx.buffer,g.two.buffer); for (const w of r.wheels) tr.push(w.pos.buffer,w.nrm.buffer,w.uv.buffer,w.uv2.buffer,w.idx.buffer,w.two.buffer);
      postMessage({id:j.id, r}, tr); } catch(e){ postMessage({id:j.id, err:String(e&&e.stack||e)}); } };
}
})(typeof self!=='undefined'?self:this);
