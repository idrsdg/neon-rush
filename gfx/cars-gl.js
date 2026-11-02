/* Neon Rush live car renderer (ours). three.js r149 (local copy), WebGL on a detached canvas.
   Every car is drawn in real time from the baked atlases + geometry of gfx/car3d.js: continuous yaw / pitch / roll, wheels spinning and
   steering, lamp channels as emissive, lighting and reflections from the scene palette (day / sunset / night / tunnel, blended continuously).
   The road is still the 2D pseudo-3D canvas: each car is rendered into its own cell of the GL canvas with a projection that reproduces the
   2D projection (CAMD, horizon, the canvas transform of the frame) exactly, then the cell is copied 1:1 (device pixels) into the game canvas
   at its place in the painter's order, so props, effects, hills and fog still interleave correctly. */
window.NR_GL=(function(){
'use strict';
const G={ok:false, failed:{}, usedMax:0, canvas:null, renderer:null, camera:null, W:0, H:0, models:{}, pending:{}, workers:[], jobs:[], jid:0, insts:new Map(), cells:[], shelfX:0, shelfY:0, shelfH:0, frame:0, drawn:0, dropped:0, ms:0, err:null};
const T=window.THREE;
// -------------------------------------------------------------- environments (what paint and glass reflect), same tables as the old sprite renderer
const hex=c=>[parseInt(c.slice(1,3),16)/255,parseInt(c.slice(3,5),16)/255,parseInt(c.slice(5,7),16)/255];
const ENV=[
 { zen:hex('#2f6fe0'), hor:hex('#e8f4ff'), gnd:hex('#2a2a36'), gh:hex('#8a8aa0'), sun:hex('#fff4dc'), L:[-0.32,0.82,-0.47], key:1.0, amb:0.55, band:0, strip:1 },        // day
 { zen:hex('#3b1d9a'), hor:hex('#ffb070'), gnd:hex('#2a1830'), gh:hex('#c0607a'), sun:hex('#ffb37a'), L:[0.55,0.45,-0.7], key:0.85, amb:0.5, band:0.4, strip:0.6 },     // sunset
 { zen:hex('#0a0a2a'), hor:hex('#5a4a9a'), gnd:hex('#07060f'), gh:hex('#3a2a5a'), sun:hex('#cfe6ff'), L:[-0.2,0.9,-0.4], key:0.5, amb:0.55, band:1, strip:0.35 },        // night: neon streaks in every reflection
 { zen:hex('#14100c'), hor:hex('#b07a3a'), gnd:hex('#0a0806'), gh:hex('#4a3a2a'), sun:hex('#ffd9a0'), L:[0.0,0.98,-0.2], key:0.55, amb:0.6, band:0, strip:0.5 },        // tunnel: sodium lamps overhead
];
const EU={ uZen:{value:new T.Vector3()}, uHor:{value:new T.Vector3()}, uGnd:{value:new T.Vector3()}, uGh:{value:new T.Vector3()}, uSun:{value:new T.Vector3()}, uL:{value:new T.Vector3(0,1,0)}, uKey:{value:1}, uAmb:{value:0.5}, uBand:{value:0}, uStrip:{value:1}, uWet:{value:0}, uTunnel:{value:new T.Vector2(0,0)} };
function setEnv(night,sunset,tunnel,wet,tunnelPhase){ const n=Math.max(0,Math.min(1,night)), s=Math.max(0,Math.min(1,sunset))*(1-n), d=1-n-s, t=Math.max(0,Math.min(1,tunnel)); const w=[d*(1-t),s*(1-t),n*(1-t),t];
  const mix=(k,o)=>{ let x=0,y=0,z=0; for (let i=0;i<4;i++){ const c=ENV[i][k]; x+=c[0]*w[i]; y+=c[1]*w[i]; z+=c[2]*w[i]; } o.set(x,y,z); };
  mix('zen',EU.uZen.value); mix('hor',EU.uHor.value); mix('gnd',EU.uGnd.value); mix('gh',EU.uGh.value); mix('sun',EU.uSun.value); mix('L',EU.uL.value); EU.uL.value.normalize();
  const sc=k=>{ let v=0; for (let i=0;i<4;i++) v+=ENV[i][k]*w[i]; return v; }; EU.uKey.value=sc('key'); EU.uAmb.value=sc('amb'); EU.uBand.value=sc('band'); EU.uStrip.value=sc('strip'); EU.uWet.value=wet||0; EU.uTunnel.value.set(t,tunnelPhase||0); }

// -------------------------------------------------------------- shaders
const VS=`
attribute vec2 uv2;
varying vec3 vPos; varying vec3 vNrm; varying vec2 vUv; varying vec2 vUv2; varying float vAo; varying vec3 vLoc;
void main(){ vec4 wp=modelMatrix*vec4(position,1.0); vPos=wp.xyz; vNrm=normalize(mat3(modelMatrix)*normal); vUv=uv; vLoc=position;
#ifdef WHEEL
  vUv2=uv2; vAo=1.0;
#else
  vUv2=uv; vAo=clamp(0.55+position.y*0.9,0.55,1.0);
#endif
  gl_Position=projectionMatrix*wp; }`;
const FS=`
precision highp float;
uniform sampler2D tCol, tMask, tId, tEmi, tPlate; uniform vec3 uCol, uAcc; uniform vec4 uLights; uniform vec2 uInd; uniform float uBlur, uAlpha, uClip, uGloss;
uniform vec3 uZen, uHor, uGnd, uGh, uSun, uL; uniform float uKey, uAmb, uBand, uStrip, uWet; uniform vec2 uTunnel;
varying vec3 vPos; varying vec3 vNrm; varying vec2 vUv; varying vec2 vUv2; varying float vAo; varying vec3 vLoc;
const float PI=3.14159265, TAU=6.2831853;
vec3 neon(float k){ int i=int(mod(k,4.0)); return i==0?vec3(1.0,0.184,0.69):i==1?vec3(0.098,0.94,1.0):i==2?vec3(1.0,0.82,0.0):vec3(0.757,0.239,1.0); }
vec3 env(vec3 R){ float ry=R.y; vec3 c;
  if (ry>=0.0){ float t=pow(ry,0.55); c=mix(uHor,uZen,t);
    float sb=((ry>0.26&&ry<0.36)?0.75:0.0)+((ry>0.5&&ry<0.56)?0.45:0.0)+exp(-pow((ry-0.31)/0.12,2.0))*0.2; c+=sb*uStrip;
    if (uBand>0.0 && ry<0.14){ float az=atan(R.x,R.z); float k=floor((az+PI)/TAU*26.0); if (mod(k*7.0,5.0)<2.0){ float w=uBand*(1.0-smoothstep(0.04,0.14,ry))*0.9; c+=neon(k)*w; } } }
  else { float t=min(1.0,-ry*5.0); c=mix(uGh,uGnd,t); }
  c+=exp(-ry*ry*900.0)*0.55*uHor; return c; }
float tm(float v){ v=max(v,0.0); return v<0.8?v:0.8+0.2*(1.0-exp(-(v-0.8)*2.2)); }
float lightOf(int ch){ return ch==1?uLights.x:ch==2?uLights.y:ch==3?uLights.z:ch==4?uInd.x:ch==5?uInd.y:ch==6?uLights.w:0.0; }
void main(){
  if (gl_FragCoord.y<uClip) discard;
  vec4 C=texture2D(tCol,vUv); vec4 M=texture2D(tMask,vUv); vec4 I=texture2D(tId,vUv); vec4 E=texture2D(tEmi,vUv);
#ifdef WHEEL
  if (uBlur>0.001){ vec4 C1=texture2D(tCol,vUv2); vec4 M1=texture2D(tMask,vUv2); C=mix(C,C1,uBlur); M=mix(M,M1,uBlur); if (uBlur>0.5) I=texture2D(tId,vUv2); }
#endif
  if (C.a<0.5) discard;
  float idv=floor(I.r*255.0+0.5); int mat=int(floor(idv/16.0+0.001)); int ch=int(idv-16.0*float(mat)+0.5); float gloss=I.g*uGloss;
  float tk=max(M.r,M.g); vec3 c=C.rgb*(1.0+0.25*tk)*mix(vec3(1.0),uCol,M.r)*mix(vec3(1.0),uAcc,M.g);
  vec3 plate=vec3(0.0); if (M.b>0.5){ plate=texture2D(tPlate,vec2(E.r,E.g)).rgb; c=plate; }
  vec3 N=normalize(vNrm); vec3 V=normalize(-vPos); vec3 L=uL; vec3 H=normalize(L+V);
  float ndl=max(0.0,dot(N,L)), ndv=max(0.0,dot(N,V)), ndh=max(0.0,dot(N,H)); float dv=dot(N,V); vec3 R=2.0*dv*N-V; vec3 ec=env(R);
  float hemi=0.5+0.5*N.y; vec3 amb=mix(uGh,uHor,hemi)*uAmb; float kd=uKey*ndl; float fres=pow(1.0-ndv,5.0); float ao=vAo;
  if (uWet>0.0 && (mat==0||mat==4||mat==8)) gloss=max(gloss,uWet*0.85);
  vec3 r;
  if (mat==0){ float F=(0.08+0.92*fres)*gloss; float sp1=pow(ndh,140.0)*2.4*gloss, sp2=pow(ndh,24.0)*0.18*gloss; r=c*(amb+kd*uSun)*ao*(1.0-F)+ec*F*0.95+(sp1+sp2)*uSun; r+=ec*c*0.22; }
  else if (mat==1){ float F=0.12+0.88*pow(1.0-ndv,3.5); float sp1=pow(ndh,300.0)*3.0; r=c+ec*F*vec3(0.62,0.62,0.66)+sp1*uSun; }
  else if (mat==2){ float sp1=pow(ndh,90.0)*2.0; r=ec*vec3(0.85,0.85,0.88)+vec3(0.04,0.04,0.05)+sp1; }
  else if (mat==9){ float sp1=pow(ndh,30.0)*0.5; r=c*(amb+kd)+ec*0.25+sp1; }
  else if (mat==3){ float sp1=pow(ndh,10.0)*0.05; r=c*(amb+kd)*1.2+sp1+ec*fres*0.1; }
  else if (mat==6){ float wv=mod(floor(vLoc.x*70.0)+floor(vLoc.y*70.0)+floor(vLoc.z*70.0),2.0)>0.5?1.5:0.7; float F=0.05+0.95*fres; float sp1=pow(ndh,60.0)*0.8; r=c*wv*(amb+kd)+ec*F*0.6+sp1; }
  else if (mat==5){ float F=0.08+0.92*pow(1.0-ndv,4.0); float sp1=pow(ndh,200.0)*2.5; r=c*(0.4+amb+kd)+ec*F*0.5+sp1; }
  else if (mat==13){ r=c; }
  else if (mat==11){ r=vec3(0.012,0.012,0.016); }
  else if (mat==8){ r=c*(amb+kd)*1.1; }
  else { float F=0.04+0.5*fres; float sp1=pow(ndh,40.0)*0.35*gloss; r=c*(amb+kd)*ao+ec*F*0.5+sp1; }
  vec3 o=vec3(tm(r.r),tm(r.g),tm(r.b));
  if (ch>0){ float li=lightOf(ch); if (M.b>0.5) o+=plate*0.25*li; else o+=E.rgb*4.0*li; }
  if (uTunnel.x>0.001){ float zb=mix(2.6,-2.6,uTunnel.y); float band=exp(-pow((vLoc.z-zb)/0.45,2.0)); o+=uTunnel.x*band*0.55*vec3(1.0,0.86,0.6)*(0.4+0.6*max(0.0,N.y)); }
  gl_FragColor=vec4(o*uAlpha,uAlpha); }`;
// soft shadow blob under the car (rounded rectangle, darker under the wheels)
const SVS=`varying vec2 vXZ; void main(){ vXZ=position.xz; gl_Position=projectionMatrix*modelMatrix*vec4(position,1.0); }`;
const SFS=`precision highp float; varying vec2 vXZ; uniform vec2 uHalf; uniform vec4 uWh[10]; uniform int uNW; uniform float uAlpha, uClip;
void main(){ if (gl_FragCoord.y<uClip) discard; float ax=abs(vXZ.x), az=abs(vXZ.y); if (ax>uHalf.x+0.55 || az>uHalf.y+0.55) discard;
  float dx=max(ax-uHalf.x,0.0), dz=max(az-uHalf.y,0.0); float dd=length(vec2(dx,dz))-min(0.0,max(ax-uHalf.x,az-uHalf.y)); float a=0.72*pow(clamp(1.0-(dd+0.12)/0.62,0.0,1.0),1.5);
  for (int i=0;i<10;i++){ if (i>=uNW) break; vec4 w=uWh[i]; float ex=abs(vXZ.y-w.y)/(w.z*0.9), ey=abs(vXZ.x-w.x)/(w.w*0.7+0.06); float q=1.0-(ex*ex+ey*ey); if (q>0.0) a=max(a,min(0.92,0.6+q*0.5)); }
  a*=uAlpha; gl_FragColor=vec4(0.0,0.0,0.01*a,a); }`;

// -------------------------------------------------------------- setup
function init(){ if (G.ok || G.err) return G.ok; try{ if (!T) throw new Error('three.js missing');
    G.canvas=document.createElement('canvas'); G.canvas.width=64; G.canvas.height=64;
    const px=(window.innerWidth||1280)*(window.innerHeight||800)*Math.pow(Math.min(2,window.devicePixelRatio||1),2)*2; G.msaa=px<=14e6;   /* MSAA where the GL canvas stays under ~14 MP (a 1728x1000 retina laptop qualifies) */
    G.renderer=new T.WebGLRenderer({canvas:G.canvas, alpha:true, antialias:G.msaa, premultipliedAlpha:true, preserveDrawingBuffer:false, powerPreference:'high-performance', stencil:false});
    G.renderer.autoClear=false; G.renderer.setPixelRatio(1); G.renderer.outputEncoding=T.LinearEncoding; G.renderer.setClearColor(0x000000,0);
    G.camera=new T.Camera(); G.camera.matrixAutoUpdate=false; G.camera.matrixWorldAutoUpdate=false;
    G.aniso=Math.min(8,G.renderer.capabilities.getMaxAnisotropy()||1);
    G.ok=true; } catch(e){ G.err=String(e); G.ok=false; } return G.ok; }
function setSize(w,h){ w=Math.max(64,Math.round(w)); h=Math.max(64,Math.round(h)); if (w===G.W && h===G.H) return; G.W=w; G.H=h; if (G.ok) G.renderer.setSize(w,h,false); }

// -------------------------------------------------------------- models: baked in workers (gfx/car3d.js), uploaded as textures + geometry
function workers(){ if (G.workers.length || G.noWorkers) return; try{ const n=Math.max(1,Math.min(2,(navigator.hardwareConcurrency|0)-1)); for (let i=0;i<n;i++){ const w=new Worker('gfx/car3d.js?v=6'); const o={w,busy:null}; w.onmessage=e=>onBaked(o,e.data); w.onerror=()=>{ G.noWorkers=true; if (o.busy){ const j=o.busy; o.busy=null; G.jobs.unshift(j); } pump(); }; G.workers.push(o); } } catch(e){ G.noWorkers=true; } }
function pump(){ if (G.noWorkers){ if (!G.tick && G.jobs.length){ G.tick=setTimeout(()=>{ G.tick=0; const j=G.jobs.shift(); if (j){ try{ const r=window.NR_CAR3D.bake(j.model,j.opts,j.W,j.H); upload(j,r); }catch(e){ console.warn('bake',e); G.failed[j.key]=1; delete G.pending[j.key]; } } pump(); },30); } return; }
  for (const o of G.workers){ if (o.busy) continue; const j=G.jobs.shift(); if (!j) return; o.busy=j; o.w.postMessage({bake:{id:j.id,model:j.model,opts:j.opts,W:j.W,H:j.H}}); } }
function onBaked(o,m){ const j=o.busy; o.busy=null; if (j && m && m.id===j.id){ if (m.r) upload(j,m.r); else { console.warn('bake failed',m.err); G.failed[j.key]=1; delete G.pending[j.key]; } } pump(); }
/* model(key, name, opts, W, H): the baked model if ready; otherwise queues the bake (player's model first when front=true) and returns null */
function model(key,name,opts,W,H,front){ const m=G.models[key]; if (m) return m; if (!G.ok || G.failed[key]) return null; if (G.pending[key]) return null; G.pending[key]=1; const j={id:++G.jid,key,model:name,opts:opts||{},W,H}; if (front) G.jobs.unshift(j); else G.jobs.push(j); workers(); pump(); return null; }
function tex(data,w,h,fmt,nearest,mips){ const t=new T.DataTexture(data,w,h,fmt||T.RGBAFormat,T.UnsignedByteType); t.flipY=false; t.generateMipmaps=!!mips; t.magFilter=nearest?T.NearestFilter:T.LinearFilter; t.minFilter=nearest?T.NearestFilter:(mips?T.LinearMipmapLinearFilter:T.LinearFilter); t.anisotropy=mips?G.aniso:1; t.wrapS=t.wrapT=T.ClampToEdgeWrapping; t.needsUpdate=true; return t; }
/* material ids + light channel + gloss: two bytes per texel. WebGL2 stores RG8 (texStorage2D needs a sized format; LUMINANCE_ALPHA is not one and stays incomplete), WebGL1 gets the pairs spread into RGBA */
function idTex(ids,w,h){ if (G.renderer.capabilities.isWebGL2) return tex(ids,w,h,T.RGFormat,true,false); const d=new Uint8Array(w*h*4); for (let i=0;i<w*h;i++){ d[i*4]=ids[i*2]; d[i*4+1]=ids[i*2+1]; d[i*4+2]=0; d[i*4+3]=255; } return tex(d,w,h,T.RGBAFormat,true,false); }
function geom(g,uv2){ const b=new T.BufferGeometry(); b.setAttribute('position',new T.BufferAttribute(g.pos,3)); b.setAttribute('normal',new T.BufferAttribute(g.nrm,3)); b.setAttribute('uv',new T.BufferAttribute(g.uv,2)); if (uv2 && g.uv2) b.setAttribute('uv2',new T.BufferAttribute(g.uv2,2)); b.setIndex(new T.BufferAttribute(g.idx,1)); return b; }
function upload(j,r){ const t0=performance.now(); const m={key:j.key, name:j.model, W:r.W, H:r.H, meta:r.meta,
    tCol:tex(r.col,r.W,r.H,T.RGBAFormat,false,true), tMask:tex(r.mask,r.W,r.H,T.RGBAFormat,false,true), tId:idTex(r.ids,r.W,r.H), tEmi:tex(r.emi,r.W>>1,r.H>>1,T.RGBAFormat,false,true),
    body:geom(r.body,false), body2:r.body2&&r.body2.idx.length?geom(r.body2,false):null, wheels:r.wheels.map(w=>({g:geom(w,true), x:w.x, z:w.z, r:w.r, w:w.w, ang:w.ang, side:w.side, front:w.front, inner:w.inner})) };
  // the textures go to the GPU now (one hitch per model, on first visit only), not on the frame a car first appears
  for (const t of [m.tCol,m.tMask,m.tId,m.tEmi]) G.renderer.initTexture(t);
  G.models[j.key]=m; delete G.pending[j.key]; m.ms=performance.now()-t0; m.bakeMs=r.ms; for (const fn of G.onModel) fn(m); }
G.onModel=[];
function dropModel(key){ const m=G.models[key]; if (!m) return; for (const t of [m.tCol,m.tMask,m.tId,m.tEmi]) t.dispose(); m.body.dispose(); if (m.body2) m.body2.dispose(); for (const w of m.wheels) w.g.dispose(); delete G.models[key]; for (const [k,i] of G.insts) if (i.model===m) dropInst(k); }

// -------------------------------------------------------------- instances: one per car (model + colours + plate), its own scene of meshes
const PLATES={};
function plateTex(text){ text=String(text||'NEON').slice(0,7); let t=PLATES[text]; if (t) return t; const cv=document.createElement('canvas'); cv.width=128; cv.height=32; const g=cv.getContext('2d');
  g.fillStyle='#f2f2e8'; g.fillRect(0,0,128,32); g.fillStyle='#1a4ad8'; g.fillRect(0,0,14,32); g.fillStyle='#ffd200'; g.fillRect(4,6,6,6); g.fillStyle='#111'; g.font='bold 22px Arial,Helvetica,sans-serif'; g.textAlign='center'; g.textBaseline='middle'; g.fillText(text,71,17); g.strokeStyle='#333'; g.lineWidth=2; g.strokeRect(1,1,126,30);
  t=new T.CanvasTexture(cv); t.flipY=false; t.generateMipmaps=true; t.minFilter=T.LinearMipmapLinearFilter; PLATES[text]=t; return t; }
function mat(m,inst,wheel,twoSided){ const u={ tCol:{value:m.tCol}, tMask:{value:m.tMask}, tId:{value:m.tId}, tEmi:{value:m.tEmi}, tPlate:inst.uPlate, uCol:inst.uCol, uAcc:inst.uAcc, uLights:inst.uLights, uInd:inst.uInd, uBlur:inst.uBlur, uAlpha:inst.uAlpha, uClip:inst.uClip, uGloss:inst.uGloss };
  for (const k in EU) u[k]=EU[k];
  const sm=new T.ShaderMaterial({uniforms:u, vertexShader:VS, fragmentShader:FS, defines:wheel?{WHEEL:1}:{}, side:twoSided?T.DoubleSide:T.BackSide, blending:T.NoBlending, depthTest:true, depthWrite:true, transparent:false});
  return sm; }
/* instance(key, modelKey, {col:'#rrggbb', acc, plate}) -> instance or null while the model bakes */
function instance(key,modelKey,o){ let inst=G.insts.get(key); const m=G.models[modelKey]; if (!m) return null; if (inst && inst.model===m){ const c=o&&o.col||'#ff2d55', a=o&&o.acc||'#ffffff', p=o&&o.plate||'NEON'; if (inst.col!==c) { inst.col=c; inst.uCol.value.fromArray(hex(c)); } if (inst.acc!==a){ inst.acc=a; inst.uAcc.value.fromArray(hex(a)); } if (inst.plate!==p){ inst.plate=p; inst.uPlate.value=plateTex(p); } return inst; }
  if (inst) dropInst(key);
  inst={key, model:m, col:o&&o.col||'#ff2d55', acc:o&&o.acc||'#ffffff', plate:o&&o.plate||'NEON', scene:new T.Scene(), meshes:[], wheels:[], spin:0, state:null, carM:new Float32Array(16)};
  inst.uCol={value:new T.Vector3().fromArray(hex(inst.col))}; inst.uAcc={value:new T.Vector3().fromArray(hex(inst.acc))}; inst.uPlate={value:plateTex(inst.plate)}; inst.uLights={value:new T.Vector4(0,0,0,0)}; inst.uInd={value:new T.Vector2(0,0)}; inst.uBlur={value:0}; inst.uAlpha={value:1}; inst.uClip={value:-1e9}; inst.uGloss={value:1};
  inst.scene.matrixWorldAutoUpdate=false;
  const add=(g,material,order)=>{ const me=new T.Mesh(g,material); me.matrixAutoUpdate=false; me.frustumCulled=false; me.renderOrder=order||0; inst.scene.add(me); inst.meshes.push(me); return me; };
  // shadow first
  { const sg=new T.BufferGeometry(); const hx=m.meta.Wd/2+0.45, hz=m.meta.L/2+0.35; sg.setAttribute('position',new T.BufferAttribute(new Float32Array([-hx,0.003,-hz, hx,0.003,-hz, hx,0.003,hz, -hx,0.003,hz]),3)); sg.setIndex([0,2,1, 0,3,2]);
    const wh=[]; for (let i=0;i<10;i++){ const w=m.meta.wheels[i]; wh.push(w?new T.Vector4(w.x,w.z,w.r,w.w):new T.Vector4(0,0,0.01,0.01)); }
    inst.uShadow={value:0.72}; const sm=new T.ShaderMaterial({uniforms:{uHalf:{value:new T.Vector2(m.meta.Wd/2*0.92,m.meta.L/2*0.94)}, uWh:{value:wh}, uNW:{value:Math.min(10,m.meta.wheels.length)}, uAlpha:inst.uShadow, uClip:inst.uClip}, vertexShader:SVS, fragmentShader:SFS, side:T.DoubleSide, blending:T.CustomBlending, blendSrc:T.OneFactor, blendDst:T.OneMinusSrcAlphaFactor, blendEquation:T.AddEquation, depthTest:false, depthWrite:false, transparent:false});
    inst.shadow=add(sg,sm,-1); }
  inst.body=add(m.body,mat(m,inst,false,false),0); if (m.body2) inst.body2=add(m.body2,mat(m,inst,false,true),0);
  for (const w of m.wheels){ const me=add(w.g,mat(m,inst,true,false),0); inst.wheels.push({mesh:me, def:w}); }
  G.insts.set(key,inst); return inst; }
function dropInst(key){ const i=G.insts.get(key); if (!i) return; for (const me of i.meshes){ me.material.dispose(); } i.shadow.geometry.dispose(); G.insts.delete(key); }

// -------------------------------------------------------------- per-frame: cells
function begin(){ if (!G.ok) return; G.cells.length=0; G.shelfX=1; G.shelfY=1; G.shelfH=0; G.frame++; G.drawn=0; G.dropped=0; G.shrunk=0; G.renderer.setScissorTest(false); G.renderer.setViewport(0,0,G.W,G.H); G.renderer.clear(true,true,false); G.t0=performance.now(); }
function alloc(w,h){ if (w>G.W-2 || h>G.H-2) return null; if (G.shelfX+w+1>G.W){ G.shelfX=1; G.shelfY+=G.shelfH+1; G.shelfH=0; } if (G.shelfY+h+1>G.H) return null; const c={x:G.shelfX,y:G.shelfY,w,h}; G.shelfX+=w+1; if (h>G.shelfH) G.shelfH=h; return c; }
const M4=new T.Matrix4(), M4b=new T.Matrix4(), M4c=new T.Matrix4(), M4d=new T.Matrix4(), V3=new T.Vector3(), Q=new T.Quaternion(), E3=new T.Euler(), S3=new T.Vector3(1,1,1);
G.cornersS=new Float32Array(36);
/* P: { w,h,CAMD,HOR: the 2D projection of this frame (CSS px); vh: vertical scale (default h/2 like the road; cars pass w/2 so they are not squashed by h/w);
        exX, exY: stylised width / height factors; offX,offY: screen shift (CSS px) of the whole car (virtual chase camera, see glVirtual);  M:{a,b,c,d,e,f}: canvas transform CSS -> device px at blit time;
        pos:[X,Y,Z]: camera-space position (game units) of the rear-axle ground point; upm: units per metre; yaw,pitch,roll (rad, whole car);
        body:{dy (m), pitch, roll, sx, sy}; wheels:{spin (rad), steer (rad), dy:[m per wheel]}; shadowDy (m: the car lifts, the shadow stays);
        lights:{run,brake,indL,indR,head}; blur 0..1; alpha; clipY (CSS y, nothing drawn below it) or null; tunnel {k, phase}; shadowA }
   -> cell {x,y,w,h, dx,dy (device px destination), ok:true} or null (off-canvas / no room) */
function render(inst,P){ if (!G.ok || !inst) return null; const m=inst.model, meta=m.meta, upm=P.upm;
  // whole-car matrix: translate to the ground point, yaw / pitch / roll, metres -> units, rear axle at the origin
  E3.set(P.pitch||0,P.yaw||0,P.roll||0,'YXZ'); Q.setFromEuler(E3); V3.set(P.pos[0],P.pos[1],P.pos[2]); S3.set(upm*(P.exX||1),upm*(P.exY||1),upm); M4.compose(V3,Q,S3); M4b.makeTranslation(0,0,-meta.rz); M4.multiply(M4b); inst.carM.set(M4.elements);   // M4 = car matrix (kept for anchors: lamps, exhausts, roof)
  // body: bob / dive / squat / roll about the wheelbase centre
  const B=P.body; if (B && (B.dy||B.pitch||B.roll||(B.sx&&B.sx!==1)||(B.sy&&B.sy!==1))){ const pz=(meta.rz+meta.fz)/2; M4c.makeTranslation(0,0.35,pz); E3.set(B.pitch||0,0,B.roll||0,'YXZ'); Q.setFromEuler(E3); V3.set(0,B.dy||0,0); S3.set(B.sx||1,B.sy||1,1); M4d.compose(V3,Q,S3); M4c.multiply(M4d); M4d.makeTranslation(0,-0.35,-pz); M4c.multiply(M4d); M4b.multiplyMatrices(M4,M4c); } else M4b.copy(M4);
  inst.body.matrixWorld.copy(M4b); if (inst.body2) inst.body2.matrixWorld.copy(M4b);
  // wheels: own springs, steered fronts, spin
  const Wp=P.wheels||{}; const spin=Wp.spin||0, steer=Wp.steer||0;
  for (let i=0;i<inst.wheels.length;i++){ const w=inst.wheels[i], d=w.def; const dy=Wp.dy?Wp.dy[i]||0:0; E3.set(0,d.ang+(d.front?steer:0),spin*(d.ang>0?1:-1),'YXZ'); Q.setFromEuler(E3); V3.set(d.x,d.r+dy,d.z); S3.set(1,1,1); M4c.compose(V3,Q,S3); w.mesh.matrixWorld.multiplyMatrices(M4,M4c); }
  // shadow on the ground under the car (airtime: the car lifts, the shadow stays)
  M4c.makeTranslation(0,-(P.shadowDy||0),0); inst.shadow.matrixWorld.multiplyMatrices(M4,M4c); inst.uShadow.value=(P.shadowA==null?0.72:P.shadowA);
  // screen bounds: the body box and the shadow rectangle (on the ground) through the car matrix and the 2D projection
  const bb=meta.bbox, hx=meta.Wd/2+0.45, hz=meta.L/2+0.35; const sdy=-(P.shadowDy||0);
  const Mx=P.M, w=P.w, h=P.h, CAMD=P.CAMD, HOR=P.HOR||0, vh=P.vh||h/2; const e=M4.elements; const C=G.cornersS; let nc=0;
  for (let k=0;k<12;k++){ let lx,ly,lz; if (k<8){ lx=k&1?bb[3]+0.05:bb[0]-0.05; ly=k&2?bb[4]+0.08:bb[1]-0.05; lz=k&4?bb[5]+0.05:bb[2]-0.05; } else { lx=k&1?hx:-hx; ly=sdy; lz=k&2?hz:-hz; }
    const X=e[0]*lx+e[4]*ly+e[8]*lz+e[12], Y=e[1]*lx+e[5]*ly+e[9]*lz+e[13], Z=e[2]*lx+e[6]*ly+e[10]*lz+e[14]; if (Z<=1) return null;
    C[nc++]=w/2+(P.offX||0)+(w/2)*CAMD*X/Z; C[nc++]=h/2+HOR+(P.offY||0)-vh*CAMD*Y/Z; C[nc++]=Z; }
  let zmin=1e9, zmax=-1e9; for (let k=2;k<36;k+=3){ if (C[k]<zmin) zmin=C[k]; if (C[k]>zmax) zmax=C[k]; }
  // the cell: whole device pixels, the car's own fractional offset lives in the projection. No room at full size (a pile-up of near cars):
  // the car is drawn at half, then quarter resolution and copied up, never dropped to the flat sprite.
  let cell=null, sc=1, vx0=0, vy0=0, ma,mb,mc,md,me,mf;
  for (let attempt=0; attempt<3 && !cell; attempt++, sc*=0.5){
    ma=Mx.a*sc; mb=Mx.b*sc; mc=Mx.c*sc; md=Mx.d*sc; me=Mx.e*sc; mf=Mx.f*sc; let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
    for (let k=0;k<36;k+=3){ const dx=ma*C[k]+mc*C[k+1]+me, dy=mb*C[k]+md*C[k+1]+mf; if (dx<x0) x0=dx; if (dx>x1) x1=dx; if (dy<y0) y0=dy; if (dy>y1) y1=dy; }
    if (x1<=x0) return null;
    const cx0=Math.floor(x0)-1, cy0=Math.floor(y0)-1; const cw=Math.ceil(x1)+2-cx0, ch=Math.ceil(y1)+2-cy0; if (cw<2 || ch<2) return null;
    // clip to the canvas: a huge near car keeps its visible part
    vx0=Math.max(cx0,0); vy0=Math.max(cy0,0); const vx1=Math.min(cx0+cw,(P.devW||1e9)*sc,vx0+G.W-2), vy1=Math.min(cy0+ch,(P.devH||1e9)*sc,vy0+G.H-2); if (vx1<=vx0 || vy1<=vy0) return null;
    cell=alloc(vx1-vx0,vy1-vy0); if (!cell) G.dropped++; }
  if (!cell) return null; sc*=2; cell.ok=true; cell.sc=sc; cell.dx=vx0/sc; cell.dy=vy0/sc; cell.dw=cell.w/sc; cell.dh=cell.h/sc; if (sc<1) G.shrunk++;
  // projection: camera space -> 2D screen -> device -> this cell's clip space (all affine on top of the perspective, so it is exact)
  const Sx0=(w/2)*CAMD, Sx2=w/2+(P.offX||0), Sy1=-vh*CAMD, Sy2=h/2+HOR+(P.offY||0); inst.offX=P.offX||0; inst.offY=P.offY||0; inst.vh=vh;   // sx*Z = Sx0*X + Sx2*Z ; sy*Z = Sy1*Y + Sy2*Z
  const Dx0=ma*Sx0, Dx1=mc*Sy1, Dx2=ma*Sx2+mc*Sy2+me, Dy0=mb*Sx0, Dy1=md*Sy1, Dy2=mb*Sx2+md*Sy2+mf;
  const kx=2/cell.w, ky=2/cell.h; const near=Math.max(1,zmin*0.5), far=zmax*2+10;
  G.camera.projectionMatrix.set(
    kx*Dx0, kx*Dx1, kx*(Dx2-vx0)-1, 0,
    -ky*Dy0, -ky*Dy1, 1-ky*(Dy2-vy0), 0,
    0, 0, (far+near)/(far-near), -2*far*near/(far-near),
    0, 0, 1, 0);
  // per-instance uniforms
  const Lg=P.lights||{}; inst.uLights.value.set(Lg.run||0, Math.max(Lg.run||0,Lg.brake||0), Lg.brake||0, Lg.head||0); inst.uInd.value.set(Lg.indL||0,Lg.indR||0);
  inst.uBlur.value=P.blur||0; inst.uAlpha.value=P.alpha==null?1:P.alpha; inst.uGloss.value=1;
  inst.uClip.value = P.clipY==null ? -1e9 : (G.H - cell.y + vy0 - (mb*(w/2)+md*P.clipY+mf));
  // draw
  const R=G.renderer; R.setViewport(cell.x,G.H-cell.y-cell.h,cell.w,cell.h); R.setScissor(cell.x,G.H-cell.y-cell.h,cell.w,cell.h); R.setScissorTest(true); R.render(inst.scene,G.camera); G.drawn++;
  return cell; }
/* copy a cell into the game canvas at its device position (identity transform), alpha and optional vertical flip (wet-road mirror) */
function blit(ctx,cell,alpha,flipAt,scaleY){ if (!cell || !cell.ok) return; ctx.save(); ctx.setTransform(1,0,0,1,0,0); ctx.globalAlpha=alpha==null?1:alpha;
  if (flipAt!=null){ ctx.translate(0,flipAt); ctx.scale(1,-(scaleY||1)); ctx.drawImage(G.canvas,cell.x,cell.y,cell.w,cell.h,cell.dx,cell.dy-flipAt,cell.dw,cell.dh); }
  else ctx.drawImage(G.canvas,cell.x,cell.y,cell.w,cell.h,cell.dx,cell.dy,cell.dw,cell.dh); ctx.restore(); }
function end(){ if (G.ok){ G.ms=performance.now()-G.t0; const u=G.shelfY+G.shelfH; if (u>G.usedMax) G.usedMax=u; } }
function stats(){ const ms=[]; for (const k in G.models) ms.push(k+':'+Math.round(G.models[k].bakeMs||0)+'/'+Math.round(G.models[k].ms||0)); return {ok:G.ok, err:G.err, msaa:!!G.msaa, models:ms, pending:Object.keys(G.pending), insts:G.insts.size, drawn:G.drawn, dropped:G.dropped, shrunk:G.shrunk||0, W:G.W, H:G.H, usedMax:G.usedMax, ms:G.ms}; }
function anyModel(name){ for (const k in G.models) if (k.split('@')[0]===name) return k; return null; }
return {init, setSize, setEnv, model, anyModel, instance, dropModel, dropInst, begin, render, blit, end, stats, G, onModel:fn=>G.onModel.push(fn), canvas:()=>G.canvas, ready:k=>!!G.models[k]};
})();
