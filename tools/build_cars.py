"""Step 2 of the car pipeline (Blender 5.3, headless):

  blender --background --python race/tools/build_cars.py -- <dumpDir> <assetsDir> [previewDir] [model ...]

Reads the geometry dumped by dump_cars.mjs, adds the mechanical parts, builds a real armature for each vehicle, keyframes one action per
animation channel, samples those actions into compact tables, makes index-only LODs and writes race/assets/cars.bin + cars.json + atlases.
Space is the game's: x right, y up, z forward, metres. Nothing here is generated at runtime; the game only reads the result."""
import bpy, sys, os, json, math, struct
import numpy as np
from mathutils import Matrix, Quaternion, Vector

argv = sys.argv[sys.argv.index('--') + 1:]
DUMP, OUT = argv[0], argv[1]
PREVIEW = argv[2] if len(argv) > 2 and argv[2] != '-' else None
ONLY = argv[3:]
os.makedirs(OUT, exist_ok=True)
INDEX = json.load(open(os.path.join(DUMP, 'index.json')))

# material ids shared with gfx/cars-gl.js
M_PAINT, M_GLASS, M_CHROME, M_RUBBER, M_PLASTIC, M_LENS, M_CARBON, M_MATTE, M_METAL = 0, 1, 2, 3, 4, 5, 6, 8, 9
SAMPLES = {'spin': 33, 'steer': 17, 'susp': 9, 'wing': 9, 'flap': 9, 'wiper': 25, 'rattle': 25, 'sway': 25, 'lean': 17}
CHANNELS = list(SAMPLES)


# ------------------------------------------------------------------ small mesh parts (numpy, outward-facing counter-clockwise)
class Part:
    def __init__(self, bone, col, mat, min_lod=1):
        self.bone, self.col, self.mat, self.min_lod = bone, col, mat, min_lod
        self.v, self.n, self.t = [], [], []

    def add(self, v, n, t):
        o = len(self.v)
        self.v += v; self.n += n; self.t += [(a + o, b + o, c + o) for a, b, c in t]
        return self


def frame_of(d):
    d = Vector(d).normalized()
    u = d.cross(Vector((0, 1, 0)) if abs(d.y) < 0.9 else Vector((1, 0, 0))).normalized()
    return d, u, d.cross(u).normalized()


def tube(p, a, b, ra, rb=None, n=10, caps=True):
    rb = ra if rb is None else rb
    a, b = Vector(a), Vector(b)
    d, u, w = frame_of(b - a)
    v, nn, t = [], [], []
    for k, (c, r) in enumerate(((a, ra), (b, rb))):
        for j in range(n):
            s = j / n * math.tau
            q = u * math.cos(s) + w * math.sin(s)
            v.append(tuple(c + q * r)); nn.append(tuple(q))
    for j in range(n):
        i0, i1, i2, i3 = j, (j + 1) % n, n + (j + 1) % n, n + j
        t += orient(v, [(i0, i1, i2), (i0, i2, i3)], (a + b) / 2)
    if caps:
        for c, r, sgn, o in ((a, ra, -1, 0), (b, rb, 1, n)):
            ci = len(v); v.append(tuple(c)); nn.append(tuple(d * sgn)); e0 = len(v)
            for j in range(n):
                s = j / n * math.tau
                v.append(tuple(c + (u * math.cos(s) + w * math.sin(s)) * r)); nn.append(tuple(d * sgn))
            for j in range(n):
                tri = (ci, e0 + j, e0 + (j + 1) % n)
                A, B, C = (Vector(v[x]) for x in tri)
                t.append(tri if (B - A).cross(C - A).dot(d * sgn) > 0 else (tri[0], tri[2], tri[1]))
    return p.add(v, nn, t)


def orient(v, tris, center):
    out = []
    for tri in tris:
        A, B, C = (Vector(v[x]) for x in tri)
        out.append(tri if (B - A).cross(C - A).dot((A + B + C) / 3 - center) > 0 else (tri[0], tri[2], tri[1]))
    return out


def box(p, c, h, seg=1):
    c = Vector(c); v, nn, t = [], [], []
    for ax in range(3):
        for sg in (-1, 1):
            a1, a2 = (ax + 1) % 3, (ax + 2) % 3
            base = len(v)
            for i in range(seg + 1):
                for j in range(seg + 1):
                    q = [0, 0, 0]; q[ax] = sg * h[ax]; q[a1] = (2 * i / seg - 1) * h[a1]; q[a2] = (2 * j / seg - 1) * h[a2]
                    nv = [0, 0, 0]; nv[ax] = sg
                    v.append(tuple(c + Vector(q))); nn.append(tuple(nv))
            for i in range(seg):
                for j in range(seg):
                    a = base + i * (seg + 1) + j; b = a + seg + 1
                    t += orient(v, [(a, b, b + 1), (a, b + 1, a + 1)], c)
    return p.add(v, nn, t)


def spring(p, c, height, r, turns=4, n=48, rt=0.012):
    pts = [Vector((c[0] + r * math.cos(i / n * turns * math.tau), c[1] + height * (i / n), c[2] + r * math.sin(i / n * turns * math.tau))) for i in range(n + 1)]
    for a, b in zip(pts, pts[1:]):
        tube(p, a, b, rt, n=5, caps=False)
    return p


# ------------------------------------------------------------------ rig definition per vehicle
class Rig:
    def __init__(self):
        self.bones = []; self.ix = {}

    def add(self, name, parent, head, tail, ch=None, amp=1.0, phase=0.0, axis=(1, 0, 0), kind='rot'):
        self.ix[name] = len(self.bones)
        self.bones.append(dict(name=name, parent=parent, head=tuple(head), tail=tuple(tail), ch=ch, amp=amp, phase=phase, axis=axis, kind=kind))
        return name


def build_rig(name, e):
    R = Rig(); meta = e['meta']; bb = meta['bbox']; H = bb[4]; L0, L1 = bb[2], bb[5]; hw = bb[3]
    R.add('root', None, (0, 0, 0), (0, 0.25, 0))
    R.add('chassis', 'root', (0, 0.35, (meta['rz'] + meta['fz']) / 2), (0, 0.75, (meta['rz'] + meta['fz']) / 2))
    wheels = e['wheels']
    for i, w in enumerate(wheels):
        hub = (w['x'], w['r'], w['z']); up = (w['x'], w['r'] + 0.2, w['z'])
        R.add(f'susp{i}', 'root', hub, up, 'susp', kind='loc', axis=(0, 1, 0))
        parent = f'susp{i}'
        if w['front']:
            parent = R.add(f'steer{i}', parent, hub, up, 'steer', axis=(0, 1, 0))
        R.add(f'hub{i}', parent, hub, (w['x'] + 0.15, w['r'], w['z']), 'spin', axis=(1, 0, 0))
        R.add(f'caliper{i}', parent, (w['x'], w['r'] + w['r'] * 0.55, w['z']), (w['x'], w['r'] + w['r'] * 0.8, w['z']), 'rattle', amp=0.04, phase=i * 0.13, axis=(1, 0, 0))
    if name == 'bike':
        z_s, y_s = 0.0, 0.98
        R.add('fork', 'chassis', (0, 0.62, 0.62), (0, 1.02, 0.42), 'steer', amp=0.8, axis=(0, 0.88, -0.47))
        R.add('swingarm', 'chassis', (0, 0.58, -0.1), (0, 0.5, -0.62), 'sway', amp=0.05)
        R.add('pelvis', 'chassis', (0, y_s, -0.28), (0, y_s + 0.16, -0.22), 'lean', amp=0.1, axis=(0, 0, 1))
        R.add('spine1', 'pelvis', (0, y_s + 0.16, -0.22), (0, y_s + 0.3, -0.12), 'lean', amp=0.12, axis=(0, 0, 1))
        R.add('spine2', 'spine1', (0, y_s + 0.3, -0.12), (0, y_s + 0.42, 0.0), 'lean', amp=0.12, axis=(0, 0, 1))
        R.add('neck', 'spine2', (0, y_s + 0.42, 0.0), (0, y_s + 0.48, 0.06), 'sway', amp=0.05, axis=(1, 0, 0))
        R.add('head', 'neck', (0, y_s + 0.48, 0.06), (0, y_s + 0.62, 0.1), 'lean', amp=-0.18, axis=(0, 0, 1))
        for sd, S in ((-1, 'L'), (1, 'R')):
            R.add('upperarm' + S, 'spine2', (sd * 0.2, y_s + 0.38, -0.02), (sd * 0.26, y_s + 0.2, 0.18), 'sway', amp=0.06, phase=0.25 if sd > 0 else 0.75)
            R.add('forearm' + S, 'upperarm' + S, (sd * 0.26, y_s + 0.2, 0.18), (sd * 0.3, y_s + 0.08, 0.38), 'sway', amp=0.08, phase=0.3 if sd > 0 else 0.8)
            R.add('thigh' + S, 'pelvis', (sd * 0.12, y_s, -0.26), (sd * 0.22, y_s - 0.2, 0.06), 'lean', amp=0.06, axis=(0, 0, 1))
            R.add('shin' + S, 'thigh' + S, (sd * 0.22, y_s - 0.2, 0.06), (sd * 0.2, y_s - 0.5, -0.12), 'sway', amp=0.04, phase=0.5)
            R.add('mirror' + S, 'fork', (sd * 0.3, 1.2, 0.44), (sd * 0.36, 1.26, 0.44), 'rattle', amp=0.09, phase=0.2 if sd > 0 else 0.7)
        R.add('flapL', 'chassis', (-0.16, 0.52, L0 + 0.02), (-0.16, 0.6, L0 + 0.02), 'flap', amp=0.8)
        R.add('flapR', 'chassis', (0.16, 0.52, L0 + 0.02), (0.16, 0.6, L0 + 0.02), 'flap', amp=0.8)
        return R
    door_z = (meta['rz'] + 0.32, meta['fz'] - 0.4)
    for sd, S in ((-1, 'L'), (1, 'R')):
        R.add('door' + S, 'chassis', (sd * hw * 0.92, 0.55, door_z[1]), (sd * hw * 0.92, 0.95, door_z[1]), 'rattle', amp=0.035 * -sd, phase=0.1 if sd > 0 else 0.6, axis=(0, 1, 0))
        R.add('mirror' + S, 'chassis', (sd * hw * 0.9, H * 0.68, door_z[1] + 0.05), (sd * (hw + 0.1), H * 0.7, door_z[1] + 0.05), 'rattle', amp=0.09, phase=0.3 if sd > 0 else 0.8, axis=(0, 1, 0))
        R.add('wiper' + S, 'chassis', (sd * 0.5, H * 0.72, meta['fz'] - 0.42), (sd * 0.05, H * 0.76, meta['fz'] - 0.42), 'wiper', amp=1.15 if sd > 0 else 1.15, axis=(0, 0.45, 0.89))
        R.add('flap' + S, 'chassis', (sd * 0.5, 0.42, L0 + 0.01), (sd * 0.5, 0.56, L0 + 0.01), 'flap', amp=0.9)
    R.add('hood', 'chassis', (0, H * 0.62, meta['fz'] - 0.3), (0, H * 0.7, meta['fz'] - 0.3), 'rattle', amp=0.02, phase=0.45)
    R.add('trunk', 'chassis', (0, H * 0.72, L0 + 0.35), (0, H * 0.8, L0 + 0.35), 'rattle', amp=0.018, phase=0.9)
    R.add('wing', 'chassis', (0, H * 0.82, L0 + 0.22), (0, H * 0.95, L0 + 0.22), 'wing', amp=-0.2)
    for sd, S in ((-1, 'L'), (1, 'R')):
        R.add('plate' + S, 'wing', (sd * hw * 0.74, H * 0.85, L0 + 0.2), (sd * hw * 0.74, H * 0.95, L0 + 0.2), 'rattle', amp=0.03, phase=0.15 if sd > 0 else 0.65, axis=(0, 0, 1))
    a0 = (-0.34, H * 0.97, meta['rz'] + 0.1)
    for k in range(3):
        R.add(f'ant{k}', 'chassis' if k == 0 else f'ant{k-1}', (a0[0], a0[1] + k * 0.11, a0[2] - k * 0.015), (a0[0], a0[1] + (k + 1) * 0.11, a0[2] - (k + 1) * 0.015), 'sway', amp=0.1 + 0.08 * k, phase=k * 0.07)
    return R


def mech_parts(name, e, R):
    parts = []; meta = e['meta']; bb = meta['bbox']; H = bb[4]; L0 = bb[2]; hw = bb[3]
    red = (0.95, 0.12, 0.2); dark = (0.05, 0.05, 0.07); steel = (0.62, 0.64, 0.7)
    for i, w in enumerate(e['wheels']):
        sd = 1 if w['x'] >= 0 else -1; x = w['x'] + sd * w['w'] * 0.32; r = w['r']
        parts.append(box(Part(f'caliper{i}', red, M_PLASTIC, 1), (x, r + r * 0.5, w['z']), (w['w'] * 0.08, r * 0.14, r * 0.26), 2))
        parts.append(spring(Part(f'susp{i}', steel, M_METAL, 0), (w['x'] - sd * w['w'] * 0.45, r + 0.02, w['z']), 0.26, 0.045))
        if w['front'] and name != 'bike':
            parts.append(tube(Part(f'steer{i}', dark, M_METAL, 1), (w['x'] - sd * w['w'] * 0.48, r, w['z'] - 0.03), (w['x'] - sd * 0.5, r, w['z'] - 0.1), 0.016, n=8))
    if name == 'bike':
        parts.append(tube(Part('fork', steel, M_CHROME, 1), (-0.07, 0.62, 0.62), (-0.07, 1.02, 0.42), 0.018, n=10))
        parts.append(tube(Part('fork', steel, M_CHROME, 1), (0.07, 0.62, 0.62), (0.07, 1.02, 0.42), 0.018, n=10))
        parts.append(tube(Part('swingarm', dark, M_METAL, 1), (0.08, 0.58, -0.1), (0.05, 0.5, -0.62), 0.022, n=8))
        parts.append(tube(Part('swingarm', dark, M_METAL, 1), (-0.08, 0.58, -0.1), (-0.05, 0.5, -0.62), 0.022, n=8))
        for b in R.bones:
            if b['name'].startswith(('pelvis', 'spine', 'neck', 'head', 'upperarm', 'forearm', 'thigh', 'shin')):
                rr = 0.09 if b['name'][:2] in ('pe', 'sp') else 0.05
                parts.append(tube(Part(b['name'], (0.13, 0.13, 0.17), M_MATTE, 1), b['head'], b['tail'], rr, rr * 0.86, n=10))
            if b['name'].startswith('mirror'):
                parts.append(box(Part(b['name'], dark, M_PLASTIC, 1), b['tail'], (0.04, 0.025, 0.012), 1))
        for S in 'LR':
            b = R.bones[R.ix['flap' + S]]
            parts.append(box(Part('flap' + S, dark, M_METAL, 1), ((b['head'][0]), 0.56, b['head'][2]), (0.05, 0.04, 0.006), 2))
        return parts
    for S, sd in (('L', -1), ('R', 1)):
        b = R.bones[R.ix['wiper' + S]]
        parts.append(tube(Part('wiper' + S, dark, M_RUBBER, 1), b['head'], b['tail'], 0.008, n=6))
        parts.append(tube(Part('wiper' + S, dark, M_RUBBER, 1), Vector(b['tail']) + Vector((0.14, 0.012, 0)), Vector(b['tail']) + Vector((-0.14, 0.012, 0)), 0.006, n=5))
        f = R.bones[R.ix['flap' + S]]
        parts.append(box(Part('flap' + S, dark, M_METAL, 1), (f['head'][0], 0.47, f['head'][2] - 0.006), (0.09, 0.05, 0.006), 3))
        d = R.bones[R.ix['door' + S]]
        parts.append(box(Part('door' + S, steel, M_CHROME, 1), (sd * (hw * 0.985), H * 0.56, d['head'][2] - 0.34), (0.008, 0.012, 0.055), 2))
        m = R.bones[R.ix['mirror' + S]]
        parts.append(box(Part('mirror' + S, dark, M_PLASTIC, 1), m['tail'], (0.07, 0.04, 0.03), 2))
        p = R.bones[R.ix['plate' + S]]
        parts.append(box(Part('plate' + S, dark, M_CARBON, 1), (p['head'][0], p['head'][1] + 0.02, p['head'][2]), (0.006, 0.012, 0.012), 1))
    parts.append(box(Part('hood', dark, M_PLASTIC, 1), (0, H * 0.655, meta['fz'] - 0.2), (0.16, 0.006, 0.03), 3))
    parts.append(box(Part('trunk', dark, M_PLASTIC, 1), (0, H * 0.73, L0 + 0.5), (0.1, 0.006, 0.02), 3))
    parts.append(box(Part('wing', dark, M_CARBON, 1), (0, H * 0.84, L0 + 0.22), (0.05, 0.012, 0.03), 3))
    for k in range(3):
        b = R.bones[R.ix[f'ant{k}']]
        parts.append(tube(Part(f'ant{k}', dark, M_METAL, 1), b['head'], b['tail'], 0.007 - k * 0.0015, 0.0055 - k * 0.0015, n=6))
    return parts


# ------------------------------------------------------------------ vertex -> bone
def islands(nv, idx):
    parent = np.arange(nv)
    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]; a = parent[a]
        return a
    for k in range(0, len(idx), 3):
        a, b, c = find(idx[k]), find(idx[k + 1]), find(idx[k + 2])
        if b != a: parent[b] = a
        c = find(c)
        if c != a: parent[c] = a
    return np.array([find(i) for i in range(nv)])


def assign_body(name, pos, idx, e, R):
    meta = e['meta']; bb = meta['bbox']; H = bb[4]; L0 = bb[2]; hw = bb[3]; bones = np.full(len(pos), R.ix['chassis'], dtype=np.uint8)
    if len(pos) == 0: return bones
    lab = islands(len(pos), idx); uniq, inv, counts = np.unique(lab, return_inverse=True, return_counts=True); shell = uniq[np.argmax(counts)]
    for u_i, u in enumerate(uniq):
        m = inv == u_i; P = pos[m]; c = P.mean(0); ext = P.max(0) - P.min(0)
        if u == shell: continue
        if name == 'bike':
            continue
        if c[1] > H * 0.72 and c[2] < L0 + 0.75 and ext[2] < 0.7:
            bones[m] = R.ix['plateL'] if c[0] < -hw * 0.6 else R.ix['plateR'] if c[0] > hw * 0.6 else R.ix['wing']
        elif abs(c[0]) > hw * 0.72 and c[1] > H * 0.45 and ext[1] < 0.3 and ext[2] < 0.4:
            bones[m] = R.ix['mirrorL' if c[0] < 0 else 'mirrorR']
    if name == 'bike':
        # rider shapes sit above the frame: nearest rider bone
        rb = [b for b in R.bones if b['name'].startswith(('pelvis', 'spine', 'neck', 'head', 'upperarm', 'forearm', 'thigh', 'shin'))]
        mids = np.array([(np.array(b['head']) + np.array(b['tail'])) / 2 for b in rb]); ids = np.array([R.ix[b['name']] for b in rb], dtype=np.uint8)
        rider = pos[:, 1] > 0.86
        if rider.any():
            d = ((pos[rider][:, None, :] - mids[None, :, :]) ** 2).sum(2)
            bones[rider] = ids[np.argmin(d, axis=1)]
        return bones
    sm = lab == shell; z0, z1 = meta['rz'] + 0.32, meta['fz'] - 0.4
    for sd, S in ((-1, 'L'), (1, 'R')):
        door = sm & (pos[:, 0] * sd > hw * 0.6) & (pos[:, 2] > z0) & (pos[:, 2] < z1) & (pos[:, 1] > 0.34) & (pos[:, 1] < H * 0.62)
        bones[door] = R.ix['door' + S]
    bones[sm & (pos[:, 2] > meta['fz'] - 0.55) & (pos[:, 1] > H * 0.55) & (np.abs(pos[:, 0]) < hw * 0.7)] = R.ix['hood']
    bones[sm & (pos[:, 2] < L0 + 0.6) & (pos[:, 1] > H * 0.6) & (np.abs(pos[:, 0]) < hw * 0.7)] = R.ix['trunk']
    return bones


# ------------------------------------------------------------------ index-only LODs by vertex clustering (per bone, normal-aware)
def lod_indices(pos, nrm, bone, idx, cell, nk):
    key = np.floor(pos / cell).astype(np.int64)
    nb = np.round(nrm * nk).astype(np.int64) + 2
    h = (key[:, 0] + 4096) | ((key[:, 1] + 4096) << 13) | ((key[:, 2] + 4096) << 26) | (nb[:, 0] << 39) | (nb[:, 1] << 42) | (nb[:, 2] << 45) | (bone.astype(np.int64) << 48)
    _, first, inv = np.unique(h, return_index=True, return_inverse=True)
    rep = first[inv]
    t = rep[idx].reshape(-1, 3)
    keep = (t[:, 0] != t[:, 1]) & (t[:, 1] != t[:, 2]) & (t[:, 0] != t[:, 2])
    t = t[keep]
    return np.unique(t, axis=0).reshape(-1) if len(t) else t.reshape(-1)


# ------------------------------------------------------------------ the armature, its actions and the sampled tables
def bake_rig(name, R):
    arm = bpy.data.armatures.new(name + '_rig'); ob = bpy.data.objects.new(name + '_rig', arm); bpy.context.scene.collection.objects.link(ob)
    bpy.context.view_layer.objects.active = ob; ob.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    for b in R.bones:
        eb = arm.edit_bones.new(b['name']); eb.head = b['head']; eb.tail = b['tail']
        if (Vector(b['tail']) - Vector(b['head'])).length < 1e-4: eb.tail = Vector(b['head']) + Vector((0, 0.05, 0))
        eb.roll = 0
    for b in R.bones:
        if b['parent']: arm.edit_bones[b['name']].parent = arm.edit_bones[b['parent']]
    bpy.ops.object.mode_set(mode='POSE')
    for pb in ob.pose.bones: pb.rotation_mode = 'QUATERNION'
    rest = {b.name: b.matrix_local.copy() for b in arm.bones}
    ob.animation_data_create()
    tables = {}
    scene = bpy.context.scene
    for ch in CHANNELS:
        users = [b for b in R.bones if b['ch'] == ch]
        n = SAMPLES[ch]
        if not users: continue
        act = bpy.data.actions.new(f'{name}_{ch}'); ob.animation_data.action = act
        for f in range(n):
            s = f / (n - 1)
            for b in users:
                pb = ob.pose.bones[b['name']]; B = rest[b['name']].to_3x3().to_4x4()
                if ch == 'spin': val = s * math.tau
                elif ch in ('steer', 'lean'): val = (2 * s - 1) * (0.6 if ch == 'steer' else 1) * b['amp']
                elif ch == 'susp': val = (2 * s - 1) * 0.16
                elif ch in ('wing', 'flap'): val = s * b['amp']
                else: val = math.sin((s + b['phase']) * math.tau) * b['amp']
                if ch == 'wiper': val = (0.5 - 0.5 * math.cos(s * math.tau)) * b['amp'] * (1 if b['head'][0] > 0 else 1)
                if b['kind'] == 'loc':
                    d = (B.inverted() @ Vector(b['axis'])) * val; pb.location = d; pb.keyframe_insert('location', frame=f + 1)
                else:
                    q = Quaternion(Vector(b['axis']).normalized(), val)
                    pb.rotation_quaternion = (B.inverted() @ q.to_matrix().to_4x4() @ B).to_quaternion(); pb.keyframe_insert('rotation_quaternion', frame=f + 1)
        data = np.zeros((len(users), n, 7), dtype=np.float32)
        for f in range(n):
            scene.frame_set(f + 1); bpy.context.view_layer.update()
            for u, b in enumerate(users):
                pb = ob.pose.bones[b['name']]
                # pose relative to the parent: world(bone) = world(parent) * this; the parent's own channel is applied at runtime
                pr = rest[pb.parent.name] if pb.parent else Matrix.Identity(4)
                t, q, _ = (pr.inverted() @ rest[b['name']] @ pb.matrix_basis).decompose()
                data[u, f] = (q.x, q.y, q.z, q.w, t.x, t.y, t.z)
        tables[ch] = (users, data)
        for pb in ob.pose.bones:
            pb.location = (0, 0, 0); pb.rotation_quaternion = (1, 0, 0, 0)
        ob.animation_data.action = None
    bpy.ops.object.mode_set(mode='OBJECT')
    return ob, rest, tables


# ------------------------------------------------------------------ pack
class Pack:
    def __init__(self): self.buf = bytearray()

    def add(self, a):
        a = np.asarray(a); al = a.dtype.itemsize
        while len(self.buf) % max(al, 4): self.buf.append(0)
        o = len(self.buf); self.buf += a.tobytes(); return [o, int(a.size)]


def save_webp(path, raw, w, h, lossless, quality=88):
    img = bpy.data.images.new('t', w, h, alpha=True); img.colorspace_settings.name = 'Non-Color'; img.alpha_mode = 'STRAIGHT'
    a = np.frombuffer(raw, dtype=np.uint8).reshape(h, w, -1)
    if a.shape[2] == 2:
        b = np.zeros((h, w, 4), dtype=np.uint8); b[..., 0] = a[..., 0]; b[..., 1] = a[..., 1]; b[..., 3] = 255; a = b
    img.pixels.foreach_set((a[::-1].astype(np.float32) / 255).ravel())
    st = bpy.context.scene.render.image_settings; st.file_format = 'WEBP'; st.color_mode = 'RGBA'; st.quality = 100 if lossless else quality
    img.save_render(path); bpy.data.images.remove(img)


def read(f, t):
    p = os.path.join(DUMP, f)
    return np.fromfile(p, dtype=t) if os.path.exists(p) else np.zeros(0, dtype=t)


def process(name, e, pack):
    R = build_rig(name, e)
    pp, nn, uu, u2, bo, ii2 = [], [], [], [], [], []; vo = 0; main = []; two = []
    for key, sink in (('body', main), ('body2', two)):
        g = e[key]
        if not g['ni']: continue
        P = read(f'{name}.{key}.pos', np.float32).reshape(-1, 3); N = read(f'{name}.{key}.nrm', np.float32).reshape(-1, 3); U = read(f'{name}.{key}.uv', np.float32).reshape(-1, 2); I = read(f'{name}.{key}.idx', np.uint32)
        pp.append(P); nn.append(N); uu.append(U); u2.append(U); bo.append(assign_body(name, P, I, e, R)); sink.append(I + vo); vo += len(P)
    for i, w in enumerate(e['wheels']):
        P = read(f'{name}.w{i}.pos', np.float32).reshape(-1, 3); N = read(f'{name}.w{i}.nrm', np.float32).reshape(-1, 3); U = read(f'{name}.w{i}.uv', np.float32).reshape(-1, 2); U2 = read(f'{name}.w{i}.uv2', np.float32).reshape(-1, 2); I = read(f'{name}.w{i}.idx', np.uint32)
        c, s = math.cos(w['ang']), math.sin(w['ang'])
        Pm = np.stack([P[:, 0] * c + P[:, 2] * s + w['x'], P[:, 1] + w['r'], -P[:, 0] * s + P[:, 2] * c + w['z']], 1)
        Nm = np.stack([N[:, 0] * c + N[:, 2] * s, N[:, 1], -N[:, 0] * s + N[:, 2] * c], 1)
        pp.append(Pm.astype(np.float32)); nn.append(Nm.astype(np.float32)); uu.append(U); u2.append(U2); bo.append(np.full(len(P), R.ix[f'hub{i}'], dtype=np.uint8)); main.append(I + vo); vo += len(P)
    n_base = vo
    cols = [np.zeros((n_base, 4), dtype=np.uint8)]
    cols[0][np.isin(np.concatenate(bo), [R.ix[f'hub{i}'] for i in range(len(e['wheels']))]), 0] = 255   # red with alpha 0 marks a wheel vertex (blurred spokes, no body AO)
    parts = mech_parts(name, e, R); pmain = []; minl = []
    for p in parts:
        P = np.array(p.v, dtype=np.float32); N = np.array(p.n, dtype=np.float32); T = np.array(p.t, dtype=np.uint32).reshape(-1)
        pp.append(P); nn.append(N); uu.append(np.zeros((len(P), 2), np.float32)); u2.append(np.zeros((len(P), 2), np.float32)); bo.append(np.full(len(P), R.ix[p.bone], dtype=np.uint8))
        c = np.zeros((len(P), 4), dtype=np.uint8); c[:, 0] = int(p.col[0] * 255); c[:, 1] = int(p.col[1] * 255); c[:, 2] = int(p.col[2] * 255); c[:, 3] = (p.mat + 1) * 16; cols.append(c)
        pmain.append((T + vo, p.min_lod)); vo += len(P)
    P = np.concatenate(pp); N = np.concatenate(nn); U = np.concatenate(uu); U2 = np.concatenate(u2); B = np.concatenate(bo); C = np.concatenate(cols)
    M = np.concatenate(main); T2 = np.concatenate(two) if two else np.zeros(0, np.uint32); PA = np.concatenate([t for t, _ in pmain]) if pmain else np.zeros(0, np.uint32)
    assert vo < 65536, name
    lod0 = np.concatenate([M, PA]); lod1b = lod_indices(P, N, B, M, 0.075, 1.5); lod2b = lod_indices(P, N, B, M, 0.26, 0.8)
    lod1 = lod1b
    used = sorted(set(int(x) for x in np.unique(B[lod0])) | set(int(x) for x in np.unique(B[T2])) if len(T2) else set(int(x) for x in np.unique(B[lod0])))
    scale = np.abs(P).max(0) * 1.001
    Pq = np.round(P / scale * 32767).astype(np.int16); Nq = np.round(np.clip(N, -1, 1) * 127).astype(np.int8); Uq = np.round(np.clip(U, 0, 1) * 65535).astype(np.uint16); U2q = np.round(np.clip(U2, 0, 1) * 65535).astype(np.uint16)
    ob, rest, tables = bake_rig(name, R)
    if PREVIEW: preview(name, ob, R, P, N, B, np.concatenate([lod0, T2]))
    ent = {'W': e['W'], 'H': e['H'], 'meta': e['meta'], 'scale': [float(x) for x in scale], 'nv': int(vo),
           'pos': pack.add(Pq), 'nrm': pack.add(Nq), 'uv': pack.add(Uq), 'uv2': pack.add(U2q), 'col': pack.add(C), 'bone': pack.add(B),
           'lods': [pack.add(lod0.astype(np.uint16)), pack.add(lod1.astype(np.uint16)), pack.add(lod2b.astype(np.uint16))], 'two': pack.add(T2.astype(np.uint16)),
           'tris': [len(lod0) // 3 + len(T2) // 3, len(lod1) // 3 + len(T2) // 3, len(lod2b) // 3],
           'wheelTris': [int(e['wheels'][i]['ni'] // 3) for i in range(len(e['wheels']))],
           'usedBones': len(used), 'bones': [], 'channels': {}}
    for b in R.bones:
        m = rest[b['name']].inverted()
        ent['bones'].append({'n': b['name'], 'p': R.ix[b['parent']] if b['parent'] else -1, 'inv': [round(x, 6) for row in m.transposed() for x in row]})
    for ch, (users, data) in tables.items():
        ent['channels'][ch] = {'n': SAMPLES[ch], 'bones': [R.ix[b['name']] for b in users], 'data': pack.add(data)}
    # rest local (parent space) for the bones no channel drives
    locs = np.zeros((len(R.bones), 7), np.float32)
    for i, b in enumerate(R.bones):
        pr = rest[b['parent']] if b['parent'] else Matrix.Identity(4)
        t, q, _ = (pr.inverted() @ rest[b['name']]).decompose(); locs[i] = (q.x, q.y, q.z, q.w, t.x, t.y, t.z)
    ent['rest'] = pack.add(locs)
    for k, lossless, w, h in (('col', False, e['W'], e['H']), ('mask', True, e['W'], e['H']), ('ids', True, e['W'], e['H']), ('emi', True, e['W'] >> 1, e['H'] >> 1)):
        src = f'{name}.{k}.' + ('rg' if k == 'ids' else 'rgba')
        save_webp(os.path.join(OUT, f'car_{name}_{k}.webp'), open(os.path.join(DUMP, src), 'rb').read(), w, h, lossless)
    print(f'[car] {name} bones {len(R.bones)} used {len(used)} tris {ent["tris"]} verts {vo}', flush=True)
    return ent


def preview(name, ob, R, P, N, B, I):
    me = bpy.data.meshes.new(name + '_pv'); tris = I.reshape(-1, 3)
    me.from_pydata(P.tolist(), [], tris.tolist()); me.update()
    o = bpy.data.objects.new(name + '_pv', me); bpy.context.scene.collection.objects.link(o)
    groups = {i: o.vertex_groups.new(name=b['name']) for i, b in enumerate(R.bones)}
    for i in np.unique(B): groups[int(i)].add(np.nonzero(B == i)[0].tolist(), 1.0, 'REPLACE')
    md = o.modifiers.new('arm', 'ARMATURE'); md.object = ob
    me.polygons.foreach_set('use_smooth', [True] * len(me.polygons)); me.update()
    print('[preview]', name, 'rigged mesh', len(me.polygons), 'faces', len(o.vertex_groups), 'groups', flush=True)
    bpy.data.objects.remove(o); bpy.data.meshes.remove(me)


bpy.ops.wm.read_factory_settings(use_empty=True)
pack = Pack(); out = {}
names = ONLY or list(INDEX)
for nm in names:
    out[nm] = process(nm, INDEX[nm], pack)
    for o in list(bpy.data.objects): bpy.data.objects.remove(o)
    for a in list(bpy.data.armatures): bpy.data.armatures.remove(a)
    for a in list(bpy.data.actions): bpy.data.actions.remove(a)
open(os.path.join(OUT, 'cars.bin'), 'wb').write(bytes(pack.buf))
json.dump({'version': 1, 'size': len(pack.buf), 'channels': CHANNELS, 'models': out}, open(os.path.join(OUT, 'cars.json'), 'w'), separators=(',', ':'))
print('[cars] bin bytes', len(pack.buf), flush=True)
