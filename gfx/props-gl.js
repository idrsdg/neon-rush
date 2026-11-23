/* Neon Rush world props (ours). Every roadside object, sky piece and effect shape is a mesh modelled in Blender (race/tools/build_props.py),
   read once from assets/props.bin. The nearest few are drawn live each frame into cells of the shared GL canvas, in the same pass as the cars; further
   away the game keeps drawing an image of the same mesh (rendered from it once at load), which costs what the old sprites cost.
   Nothing is created during a race: no allocation per frame, programs and buffers are on the GPU before the first race. */
window.NR_PROPS=(function(){
'use strict';
const T=window.THREE, GL=window.NR_GL;
const PR={state:'loading', p:0, items:{}, map:new WeakMap(), frame:0, pool:[], used:0, drawn:0, promise:null};
const VS=`
attribute vec4 aCol; varying vec4 vCol; varying vec3 vN; varying vec2 vUv;
uniform vec4 uS; uniform vec3 uQ; uniform vec3 uView;
#ifdef RIG
attribute float aBone; uniform vec4 uB[BONES*3];
#endif
void main(){ vec3 p=position*uQ, n=normal;
#ifdef RIG
  int b=int(aBone+0.5)*3; vec4 r0=uB[b], r1=uB[b+1], r2=uB[b+2]; vec4 q=vec4(p,1.0); p=vec3(dot(r0,q),dot(r1,q),dot(r2,q)); n=vec3(dot(r0.xyz,n),dot(r1.xyz,n),dot(r2.xyz,n));
#endif
  float c=uView.x, s=uView.y; float xr=p.x*c+p.z*s, zr=p.z*c-p.x*s; vN=normalize(vec3(n.x*c+n.z*s,n.y,n.z*c-n.x*s)); vCol=aCol; vUv=uv;
  gl_Position=vec4(xr*uS.x+uS.z,(p.y+zr*uView.z)*uS.y+uS.w,zr*0.45,1.0); }`;
const FS=`
precision highp float; varying vec4 vCol; varying vec3 vN; varying vec2 vUv; uniform sampler2D tFace; uniform float uHasTex, uSnow, uLift;
void main(){ vec3 N=normalize(vN); float a=vCol.a; vec3 c=vCol.rgb, o; const vec3 L=vec3(-0.40,0.74,-0.54);
  if (a<0.4){ if (uHasTex<0.5) discard; vec4 t=texture2D(tFace,vUv); if (t.a<0.5) discard; c=t.rgb/max(t.a,0.001); o=c*(0.88+0.2*max(dot(N,L),0.0)); }
  else if (a<0.75){ o=c; }
  else { float d=max(dot(N,L),0.0); float h=0.5+0.5*N.y; if (uSnow>0.0){ float k=smoothstep(0.42,0.72,N.y)*uSnow; c=mix(c,vec3(0.93,0.95,1.0),k); } o=c*(0.52+uLift+0.62*d*(1.0-uLift)+0.2*h)+pow(max(dot(reflect(-L,N),vec3(0.0,0.0,-1.0)),0.0),18.0)*0.08; }
  gl_FragColor=vec4(min(o,vec3(1.0)),1.0); }`;
const RVS=`attribute vec4 aCol; varying vec3 vN; varying float vY; uniform float uArr[49]; uniform vec3 uQ;
void main(){ vec3 p=position*uQ; float f=clamp(p.x,0.0,1.0)*48.0; int i=int(min(f,47.0)); float t=f-float(i); float h=uArr[i]*(1.0-t)+uArr[i+1]*t; float y=p.y*h; vN=normal; vY=p.y; gl_Position=vec4(p.x*2.0-1.0,y*2.0-1.0,p.z*0.2,1.0); }`;
const RFS=`precision highp float; varying vec3 vN; varying float vY; uniform vec3 uA, uB2; uniform float uHaze; uniform vec3 uFog;
void main(){ vec3 N=normalize(vN); float d=max(dot(N,normalize(vec3(-0.55,0.62,-0.56))),0.0); vec3 c=mix(uB2,uA,vY)*(0.62+0.72*d); float z=(1.0-vY); c=mix(c,uFog,uHaze*z*z); gl_FragColor=vec4(c,1.0); }`;

function geom(buf,e){ const a=(C,q)=>new C(buf,q[0],q[1]), g=new T.BufferGeometry();
  g.setAttribute('position',new T.BufferAttribute(a(Int16Array,e.pos),3,true)); g.setAttribute('normal',new T.BufferAttribute(a(Int8Array,e.nrm),3,true)); g.setAttribute('aCol',new T.BufferAttribute(a(Uint8Array,e.col),4,true)); g.setAttribute('uv',new T.BufferAttribute(a(Uint16Array,e.uv),2,true));
  if (e.bone) g.setAttribute('aBone',new T.BufferAttribute(a(Uint8Array,e.bone),1,false)); g.setIndex(new T.BufferAttribute(a(Uint16Array,e.idx),1)); g.boundingSphere=new T.Sphere(new T.Vector3(),1e6); return g; }
function material(rigBones){ const u={uS:{value:new T.Vector4()},uQ:{value:new T.Vector3(1,1,1)},uView:{value:new T.Vector3(1,0,0.1)},tFace:{value:null},uHasTex:{value:0},uSnow:{value:0},uLift:{value:0}}; if (rigBones) u.uB={value:new Float32Array(rigBones*12)};
  return new T.ShaderMaterial({uniforms:u,vertexShader:VS,fragmentShader:FS,defines:rigBones?{RIG:1,BONES:rigBones}:{},side:T.DoubleSide,blending:T.NoBlending,depthTest:true,depthWrite:true,transparent:false}); }
const scene=new T.Scene(), cam=new T.Camera(); scene.matrixWorldAutoUpdate=false; cam.matrixAutoUpdate=false; cam.matrixWorldAutoUpdate=false; let mesh=null;
const TEXC=new WeakMap();
function faceTex(cv){ let t=TEXC.get(cv); if (!t){ t=new T.CanvasTexture(cv); t.flipY=false; t.premultiplyAlpha=false; t.generateMipmaps=true; t.minFilter=T.LinearMipmapLinearFilter; t.magFilter=T.LinearFilter; t.wrapS=t.wrapT=T.ClampToEdgeWrapping; TEXC.set(cv,t); GL.G.renderer.initTexture(t); } return t; }

// bones of an animated prop, from its sampled action (no allocation)
const W=new Float32Array(32*12);
function poseRig(it,time,out){ const nb=it.nb, n=it.frames, tb=it.clip, inv=it.inv, par=it.par; let ph=(time*it.rate)%1; if (ph<0) ph+=1; const f=ph*(n-1), i0=f|0, i1=i0+1<n?i0+1:i0, k=f-i0;
  for (let b=0;b<nb;b++){ const o0=(b*n+i0)*7, o1=(b*n+i1)*7; const sg=(tb[o0]*tb[o1]+tb[o0+1]*tb[o1+1]+tb[o0+2]*tb[o1+2]+tb[o0+3]*tb[o1+3])<0?-1:1;
    let x=tb[o0]+(sg*tb[o1]-tb[o0])*k, y=tb[o0+1]+(sg*tb[o1+1]-tb[o0+1])*k, z=tb[o0+2]+(sg*tb[o1+2]-tb[o0+2])*k, q=tb[o0+3]+(sg*tb[o1+3]-tb[o0+3])*k; const l=Math.sqrt(x*x+y*y+z*z+q*q)||1; x/=l; y/=l; z/=l; q/=l;
    const tx=tb[o0+4]+(tb[o1+4]-tb[o0+4])*k, ty=tb[o0+5]+(tb[o1+5]-tb[o0+5])*k, tz=tb[o0+6]+(tb[o1+6]-tb[o0+6])*k;
    const a00=1-2*(y*y+z*z), a01=2*(x*y-z*q), a02=2*(x*z+y*q), a10=2*(x*y+z*q), a11=1-2*(x*x+z*z), a12=2*(y*z-x*q), a20=2*(x*z-y*q), a21=2*(y*z+x*q), a22=1-2*(x*x+y*y), o=b*12, p=par[b]; let c00=a00,c01=a01,c02=a02,c03=tx,c10=a10,c11=a11,c12=a12,c13=ty,c20=a20,c21=a21,c22=a22,c23=tz;
    if (p>=0){ const u=p*12; c00=W[u]*a00+W[u+1]*a10+W[u+2]*a20; c01=W[u]*a01+W[u+1]*a11+W[u+2]*a21; c02=W[u]*a02+W[u+1]*a12+W[u+2]*a22; c03=W[u]*tx+W[u+1]*ty+W[u+2]*tz+W[u+3]; c10=W[u+4]*a00+W[u+5]*a10+W[u+6]*a20; c11=W[u+4]*a01+W[u+5]*a11+W[u+6]*a21; c12=W[u+4]*a02+W[u+5]*a12+W[u+6]*a22; c13=W[u+4]*tx+W[u+5]*ty+W[u+6]*tz+W[u+7]; c20=W[u+8]*a00+W[u+9]*a10+W[u+10]*a20; c21=W[u+8]*a01+W[u+9]*a11+W[u+10]*a21; c22=W[u+8]*a02+W[u+9]*a12+W[u+10]*a22; c23=W[u+8]*tx+W[u+9]*ty+W[u+10]*tz+W[u+11]; }
    W[o]=c00; W[o+1]=c01; W[o+2]=c02; W[o+3]=c03; W[o+4]=c10; W[o+5]=c11; W[o+6]=c12; W[o+7]=c13; W[o+8]=c20; W[o+9]=c21; W[o+10]=c22; W[o+11]=c23;
    const i=inv, v=b*12; out[v]=c00*i[v]+c01*i[v+4]+c02*i[v+8]; out[v+1]=c00*i[v+1]+c01*i[v+5]+c02*i[v+9]; out[v+2]=c00*i[v+2]+c01*i[v+6]+c02*i[v+10]; out[v+3]=c00*i[v+3]+c01*i[v+7]+c02*i[v+11]+c03; out[v+4]=c10*i[v]+c11*i[v+4]+c12*i[v+8]; out[v+5]=c10*i[v+1]+c11*i[v+5]+c12*i[v+9]; out[v+6]=c10*i[v+2]+c11*i[v+6]+c12*i[v+10]; out[v+7]=c10*i[v+3]+c11*i[v+7]+c12*i[v+11]+c13; out[v+8]=c20*i[v]+c21*i[v+4]+c22*i[v+8]; out[v+9]=c20*i[v+1]+c21*i[v+5]+c22*i[v+9]; out[v+10]=c20*i[v+2]+c21*i[v+6]+c22*i[v+10]; out[v+11]=c20*i[v+3]+c21*i[v+7]+c22*i[v+11]+c23; } }

/* draws prop `it` into a cell of the GL canvas: pw,ph device px for the sprite box, margins around it. Returns the cell or null. */
function drawCell(it,tex,pw,ph,yaw,time,snow,cell){ const mx=Math.ceil(pw*0.18), mt=Math.ceil(ph*0.1), mb=Math.ceil(ph*0.04), cw=Math.ceil(pw)+mx*2, ch=Math.ceil(ph)+mt+mb; const c=GL.alloc(cw,ch); if (!c) return null;
  const m=it.mat, u=m.uniforms; u.uS.value.set(2*pw/cw, 2*(ph/it.asp)/ch, 0, -1+2*mb/ch); u.uQ.value.fromArray(it.scale); u.uView.value.set(Math.cos(yaw),Math.sin(yaw),0.1); u.uHasTex.value=tex?1:0; u.tFace.value=tex; u.uSnow.value=snow||0; u.uLift.value=it.kind==='sky'?0.4:0; if (it.nb) poseRig(it,time,u.uB.value); m.uniformsNeedUpdate=true;
  mesh.geometry=it.g; mesh.material=m; const R=GL.G.renderer, H=GL.G.H; R.setViewport(c.x,H-c.y-c.h,c.w,c.h); R.setScissor(c.x,H-c.y-c.h,c.w,c.h); R.setScissorTest(true); R.render(scene,cam); PR.drawn++;
  cell.x=c.x; cell.y=c.y; cell.w=c.w; cell.h=c.h; cell.mx=mx/pw; cell.mt=mt/ph; cell.mb=mb/ph; cell.frame=PR.frame; return cell; }

async function fetchBin(url,size,onP){ const r=await fetch(url); if (!r.ok) throw new Error(url); if (!r.body) return r.arrayBuffer(); const out=new Uint8Array(size), rd=r.body.getReader(); let at=0; for (;;){ const {done,value}=await rd.read(); if (done) break; out.set(value,at); at+=value.length; onP(at/size); } return out.buffer; }
function preload(onP){ if (PR.promise) return PR.promise; PR.promise=(async()=>{ try{ await GL.preload(); if (GL.pack.state!=='ready') throw new Error('no base pack'); const j=await (await fetch('assets/props.json?v=1')).json(); const buf=await fetchBin('assets/props.bin?v=1',j.size,f=>{ PR.p=f; if (onP) onP(f); });
    mesh=new T.Mesh(new T.BufferGeometry(),null); mesh.frustumCulled=false; mesh.matrixAutoUpdate=false; scene.add(mesh); const mats={};
    for (const id in j.props){ const e=j.props[id], it={id,asp:e.asp,kind:e.kind,scale:e.scale,tris:e.tris,g:geom(buf,e),nb:e.bones||0}; if (e.bones){ it.par=Int8Array.from(e.par); it.inv=new Float32Array(buf,e.inv[0],e.inv[1]); it.clip=new Float32Array(buf,e.clip[0],e.clip[1]); it.frames=e.frames; it.rate=id==='flame'?3.1:id==='banner'?1.1:0.28; it.mat=material(e.bones); } else it.mat=mats.s||(mats.s=material(0)); PR.items[id]=it; }
    // programs and vertex buffers go to the GPU now
    const R=GL.G.renderer; R.setViewport(0,0,4,4); R.setScissorTest(false); for (const id in PR.items){ const it=PR.items[id]; mesh.geometry=it.g; mesh.material=it.mat; it.mat.uniforms.uS.value.set(0,0,0,0); R.render(scene,cam); } R.clear(true,true,false);
    PR.state='ready'; } catch(e){ console.info('Neon Rush: props stay as images',e&&e.message); PR.state='failed'; } PR.p=1; if (onP) onP(1); })(); return PR.promise; }

/* a mesh image over an existing sprite canvas (same size and identity, every sprite reference stays valid) */
function bakeInto(cv,id,keep){ const it=PR.items[id]; if (!it) return false; const G=GL.G, w=cv.width, h=cv.height; if (w+4>=G.W || h+4>=G.H) return false; PR.frame++; GL.begin(); const c=drawCell(it,null,w,h,0,0,0,{}); if (!c){ GL.end(); return false; }
  const g=cv.getContext('2d'); g.save(); g.setTransform(1,0,0,1,0,0); if (!keep) g.clearRect(0,0,w,h); const mx=Math.round(c.mx*w), mt=Math.round(c.mt*h); g.drawImage(GL.canvas(),c.x+mx,c.y+mt,w,h,0,0,w,h); g.restore(); GL.end(); PR.map.set(cv,{id}); return true; }
function touch(cv){ const t=TEXC.get(cv); if (t) t.needsUpdate=true; }
function reg(cv,id,o){ if (cv) PR.map.set(cv,Object.assign({id},o||{})); }
function cellFor(){ let c=PR.pool[PR.used]; if (!c) c=PR.pool[PR.used]={x:0,y:0,w:0,h:0,mx:0,mt:0,mb:0,frame:0}; PR.used++; return c; }
function begin(){ PR.frame++; PR.used=0; PR.drawn=0; }
function put(sp,it,tex,dw,dh,M,yaw,time,snow){ const s=Math.hypot(M.a,M.b)||1, c=drawCell(it,tex,dw*s,dh*s,yaw,time,snow,cellFor()); if (!c){ PR.used--; return false; } sp._pc=c; return true; }
/* the cell of this frame in place of the sprite box dx,dy,dw,dh (CSS px, current canvas transform), cut at the crest clip */
function blit(ctx,sp,dx,dy,dw,dh,clip,alpha){ const c=sp._pc; if (!c || c.frame!==PR.frame) return false; const X=dx-c.mx*dw, Y=dy-c.mt*dh, Wd=dw*(1+2*c.mx), Hd=dh*(1+c.mt+c.mb); ctx.globalAlpha=alpha; let sh=c.h, dh2=Hd; if (clip && Y+Hd>clip){ const v=clip-Y; if (v<=0) return true; sh=c.h*v/Hd; dh2=v; } ctx.drawImage(GL.canvas(),c.x,c.y,c.w,sh,X,Y,Wd,dh2); return true; }
/* a background ridge: the shipped ridge mesh, its crest following the heights of this theme's skyline, painted once into a strip canvas (at load / resize) */
let ridgeM=null;
function ridge(g,w,h,arr,col,lift,fog,hz){ const it=PR.items.ridge; if (!it) return false; const G=GL.G, cw=Math.min(G.W-4,Math.round(w)), ch=Math.min(G.H-4,Math.round(h)); if (cw<32||ch<16) return false; PR.frame++; GL.begin(); const c=GL.alloc(cw,ch); if (!c){ GL.end(); return false; }
  if (!ridgeM) ridgeM=new T.ShaderMaterial({uniforms:{uArr:{value:new Float32Array(49)},uQ:{value:new T.Vector3()},uA:{value:new T.Vector3()},uB2:{value:new T.Vector3()},uFog:{value:new T.Vector3()},uHaze:{value:0}},vertexShader:RVS,fragmentShader:RFS,side:T.DoubleSide,blending:T.NoBlending,depthTest:true,depthWrite:true});
  const u=ridgeM.uniforms; for (let i=0;i<49;i++) u.uArr.value[i]=arr[i]; u.uQ.value.fromArray(it.scale); const k=1+lift; u.uA.value.set(Math.min(1,col[0]/255*k),Math.min(1,col[1]/255*k),Math.min(1,col[2]/255*k)); u.uB2.value.set(col[0]/255,col[1]/255,col[2]/255); u.uFog.value.set(fog[0]/255,fog[1]/255,fog[2]/255); u.uHaze.value=hz||0; ridgeM.uniformsNeedUpdate=true;
  mesh.geometry=it.g; mesh.material=ridgeM; const R=G.renderer; R.setViewport(c.x,G.H-c.y-c.h,c.w,c.h); R.setScissor(c.x,G.H-c.y-c.h,c.w,c.h); R.setScissorTest(true); R.render(scene,cam); g.drawImage(GL.canvas(),c.x,c.y,c.w,c.h,0,0,w,h); GL.end(); return true; }
function stats(){ let n=0,minT=1e9; for (const k in PR.items){ n++; if (PR.items[k].tris<minT) minT=PR.items[k].tris; } return {state:PR.state, items:n, minTris:minT, drawn:PR.drawn}; }
return {preload, PR, ridge, touch, reg, bakeInto, begin, put, blit, stats, faceTex, item:id=>PR.items[id], ready:()=>PR.state==='ready', onP:null};
})();
