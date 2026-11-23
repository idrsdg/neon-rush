"""Neon Rush world props (Blender 5.3, headless):

  blender --background --python race/tools/build_props.py -- <assetsDir>

Every roadside object, sky piece and effect shape is modelled here. Animated ones get a real armature (at least 24 deforming bones), one keyframed action,
sampled into a table. Output: assets/props.bin + props.json. Space: x across (the sprite's width is 1), y up (0 .. aspect), z depth.
vertex colour alpha: 255 lit, 128 emissive, 64 painted from the object's canvas through uv (signs, facades, boards keep their exact artwork)."""
import bpy, sys, os, json, math
import numpy as np
from mathutils import Matrix, Quaternion, Vector

OUT = sys.argv[sys.argv.index('--') + 1]
TAU = math.tau
LIT, EMI, TEX = 255, 128, 64


def c(h):
    return (int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16))


def noise(x, y, z, seed=0):
    s = seed * 1.37
    return (np.sin(x * 7.1 + s) * np.cos(y * 6.3 - s * 2) + np.sin(y * 13.7 + z * 9.1 + s) * 0.5 + np.sin(z * 17.3 + x * 11.9 - s) * 0.3 + np.sin((x + y + z) * 31.0 + s * 3) * 0.14) / 1.94


class Mesh:
    def __init__(self, asp):
        self.asp = asp; self.P = []; self.N = []; self.C = []; self.U = []; self.T = []; self.n = 0

    def add(self, P, T, col, a=LIT, uv=None, center=None, smooth=True):
        P = np.asarray(P, dtype=np.float64); T = np.asarray(T, dtype=np.int64).reshape(-1, 3)
        if center is not None:
            e1 = P[T[:, 1]] - P[T[:, 0]]; e2 = P[T[:, 2]] - P[T[:, 0]]; fn = np.cross(e1, e2); m = (P[T[:, 0]] + P[T[:, 1]] + P[T[:, 2]]) / 3 - np.asarray(center)
            flip = (fn * m).sum(1) < 0; T[flip] = T[flip][:, [0, 2, 1]]
        if not smooth:
            T0 = T; P = P[T0.reshape(-1)]; T = np.arange(len(P)).reshape(-1, 3)
            if uv is not None: uv = np.asarray(uv)[T0.reshape(-1)]
            if callable(col) is False and isinstance(col, np.ndarray) and col.ndim == 2: col = col[T0.reshape(-1)]
        fn = np.cross(P[T[:, 1]] - P[T[:, 0]], P[T[:, 2]] - P[T[:, 0]]); N = np.zeros_like(P)
        for k in range(3): np.add.at(N, T[:, k], fn)
        N /= np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-9)
        C = np.zeros((len(P), 4), dtype=np.uint8)
        if callable(col): C[:, :3] = np.clip(col(P), 0, 255).astype(np.uint8)
        elif isinstance(col, np.ndarray) and col.ndim == 2: C[:, :3] = np.clip(col, 0, 255).astype(np.uint8)
        else: C[:, :3] = col
        C[:, 3] = a
        self.P.append(P); self.N.append(N); self.C.append(C); self.U.append(np.zeros((len(P), 2)) if uv is None else np.asarray(uv)); self.T.append(T + self.n); self.n += len(P)
        return self

    def grid(self, fn, nu, nv, col, wrap_u=False, a=LIT, uv=None, cap=False, smooth=True):
        """fn(u, v) -> xyz arrays; surface over u,v in 0..1, optionally closed in u"""
        nx = nu if wrap_u else nu + 1
        u = np.arange(nx) / nu; v = np.arange(nv + 1) / nv; U, V = np.meshgrid(u, v, indexing='ij'); P = np.stack(fn(U.ravel(), V.ravel()), 1)
        ix = lambda i, j: (i % nx) * (nv + 1) + j; T = []
        for i in range(nu):
            for j in range(nv):
                T += [ix(i, j), ix(i + 1, j), ix(i + 1, j + 1), ix(i, j), ix(i + 1, j + 1), ix(i, j + 1)]
        UV = np.stack([U.ravel(), V.ravel()], 1) if uv else None
        return self.add(P, T, col, a, UV, center=P.mean(0) if wrap_u else None, smooth=smooth)

    def sweep(self, pts, radii, n, col, a=LIT, flat=1.0):
        pts = np.asarray(pts, dtype=np.float64); radii = np.asarray(radii, dtype=np.float64); k = len(pts); P = []
        for i in range(k):
            d = pts[min(i + 1, k - 1)] - pts[max(i - 1, 0)]; d /= max(np.linalg.norm(d), 1e-9)
            s = np.cross(d, (0, 0, 1) if abs(d[2]) < 0.9 else (1, 0, 0)); s /= np.linalg.norm(s); w = np.cross(d, s)
            for j in range(n):
                t = j / n * TAU; P.append(pts[i] + (s * math.cos(t) + w * math.sin(t) * flat) * radii[i])
        T = []
        for i in range(k - 1):
            for j in range(n):
                a0, b0 = i * n + j, i * n + (j + 1) % n; a1, b1 = a0 + n, b0 + n; T += [a0, b0, b1, a0, b1, a1]
        P = np.array(P); e1 = P[T[1]] - P[T[0]]; e2 = P[T[2]] - P[T[0]]; T = np.array(T).reshape(-1, 3)
        q = T[0]; mid = (pts[0] + pts[1]) / 2
        if np.dot(np.cross(P[q[1]] - P[q[0]], P[q[2]] - P[q[0]]), P[q].mean(0) - mid) < 0: T = T[:, [0, 2, 1]]
        return self.add(P, T, col, a)

    def lathe(self, prof, n, col, cx=0.0, cz=0.0, a=LIT, rmod=None):
        prof = np.asarray(prof, dtype=np.float64)
        def fn(u, v):
            f = v * (len(prof) - 1); i = np.minimum(f.astype(int), len(prof) - 2); t = f - i
            r = prof[i, 0] * (1 - t) + prof[i + 1, 0] * t; y = prof[i, 1] * (1 - t) + prof[i + 1, 1] * t
            if rmod: r = r * rmod(u, v)
            return cx + r * np.cos(u * TAU), y, cz + r * np.sin(u * TAU)
        return self.grid(fn, n, (len(prof) - 1) * 2, col, wrap_u=True, a=a)

    def blob(self, ctr, r, nu, nv, col, amp=0.0, seed=0, a=LIT):
        def fn(u, v):
            th = u * TAU; ph = 0.001 + v * (math.pi - 0.002); x, y, z = np.sin(ph) * np.cos(th), np.cos(ph), np.sin(ph) * np.sin(th)
            k = 1 + amp * noise(x * 1.2, y * 1.2, z * 1.2, seed)
            return ctr[0] + x * r[0] * k, ctr[1] + y * r[1] * k, ctr[2] + z * r[2] * k
        return self.grid(fn, nu, nv, col, wrap_u=True, a=a)

    def box(self, ctr, h, col, seg=2, a=LIT):
        ctr = np.asarray(ctr); h = np.asarray(h)
        for ax in range(3):
            for sg in (-1, 1):
                a1, a2 = (ax + 1) % 3, (ax + 2) % 3
                def fn(u, v):
                    o = [0, 0, 0]; o[ax] = np.full_like(u, sg * h[ax]); o[a1] = (2 * u - 1) * h[a1]; o[a2] = (2 * v - 1) * h[a2]
                    return ctr[0] + o[0], ctr[1] + o[1], ctr[2] + o[2]
                nx = seg + 1; U, V = np.meshgrid(np.arange(nx) / seg, np.arange(nx) / seg, indexing='ij'); P = np.stack(fn(U.ravel(), V.ravel()), 1); T = []
                for i in range(seg):
                    for j in range(seg):
                        p = i * nx + j; T += [p, p + nx, p + nx + 1, p, p + nx + 1, p + 1]
                T = np.array(T).reshape(-1, 3); q = T[0]; out = np.zeros(3); out[ax] = sg
                if np.dot(np.cross(P[q[1]] - P[q[0]], P[q[2]] - P[q[0]]), out) < 0: T = T[:, [0, 2, 1]]
                self.add(P, T, col, a)
        return self

    def slab(self, nu, nv, depth, relief=0.0, seed=0, step=0):
        """the object's canvas on a real surface: front grid (uv = canvas), displaced in depth, with a back and rim"""
        A = self.asp
        def dz(u, v):
            d = relief * noise(u * 3.1, v * 2.3, 0.4, seed) if relief else 0 * u
            if step: d = d + np.floor(v * step) / step * depth * 2.2
            return d
        self.grid(lambda u, v: (u - 0.5, (1 - v) * A, -depth + dz(u, v) * (np.sin(u * math.pi) ** 0.5) * (np.sin(v * math.pi) ** 0.5 if not step else 1)), nu, nv, (255, 255, 255), a=TEX, uv=True)
        self.grid(lambda u, v: (0.5 - u, (1 - v) * A, depth + 0 * u), max(4, nu // 3), max(4, nv // 3), (26, 22, 44))
        return self

    def done(self):
        return np.concatenate(self.P), np.concatenate(self.N), np.concatenate(self.C), np.concatenate(self.U), np.concatenate(self.T)


# ------------------------------------------------------------------ the catalogue
def palm(v):
    M = Mesh(2.0); lean = -1 if v else 1
    tr = lambda t: (lean * (-0.09 * 2 * t * (1 - t) * 2 + 0.136 * t * t), t * 1.5, 0.02 * math.sin(t * 3))
    pts = [tr(i / 15) for i in range(16)]
    rings = np.array([0.052 - 0.022 * (i / 15) + 0.004 * (i % 2) for i in range(16)])
    M.sweep(pts, rings, 14, lambda P: np.stack([120 + 45 * (P[:, 1] / 1.5) + 18 * np.sin(P[:, 1] * 90), 62 + 30 * (P[:, 1] / 1.5) + 10 * np.sin(P[:, 1] * 90), 26 + 14 * (P[:, 1] / 1.5)], 1))
    top = np.array(tr(1.0))
    for k in range(12):
        a = k / 12 * TAU + v * 0.2; L = 0.5 + 0.08 * math.sin(k * 2.4); dirx, dirz = math.cos(a), math.sin(a) * 0.72; lift = 0.2 + 0.09 * math.sin(k * 1.7)
        def frond(u, w):
            s = u; sag = lift * np.sin(s * 2.1) - 0.62 * s * s * L; half = 0.075 * np.sin(np.minimum(s * 1.05 + 0.04, 1.0) * math.pi) * (0.72 + 0.28 * np.abs(np.sin(s * 34)))
            o = (w - 0.5) * 2 * half; x = top[0] + dirx * s * L - dirz * o; z = top[2] + dirz * s * L + dirx * o; y = top[1] + sag - np.abs(w - 0.5) * 0.05
            return x, y, z
        M.grid(frond, 18, 4, lambda P: np.stack([12 + 22 * np.hypot(P[:, 0] - top[0], P[:, 2] - top[2]) / 0.5, 118 + 110 * np.hypot(P[:, 0] - top[0], P[:, 2] - top[2]) / 0.5, 52 + 34 * np.hypot(P[:, 0] - top[0], P[:, 2] - top[2]) / 0.5], 1))
        M.grid(lambda u, w: (lambda q: (q[0], q[1] - 0.006, q[2]))(frond(u, 1 - w)), 8, 2, (10, 92, 42))
    for k in range(4):
        a = k / 4 * TAU; M.blob((top[0] + 0.045 * math.cos(a), top[1] - 0.05, top[2] + 0.045 * math.sin(a)), (0.034, 0.038, 0.034), 10, 7, c('#7a3a12'))
    return M


def bush(v=0):
    M = Mesh(0.6)
    for k, (x, y, z, r) in enumerate(((0, .2, 0, .25), (-.24, .15, .06, .19), (.25, .15, -.03, .2), (-.1, .32, -.05, .17), (.12, .34, .06, .16), (.34, .09, .1, .12), (-.36, .08, -.06, .11))):
        M.blob((x, y, z), (r, r * .95, r), 22, 14, lambda P: np.stack([24 + 60 * P[:, 1], 110 + 240 * P[:, 1] + 26 * np.sin(P[:, 0] * 60), 62 + 60 * P[:, 1]], 1), amp=.24, seed=k + 2)
    return M


def cactus(v):
    M = Mesh(2.0); rib = lambda u, t: 1 + 0.1 * np.abs(np.sin(u * math.pi * 7))
    colf = lambda P: np.stack([34 + 40 * P[:, 1], 128 + 42 * P[:, 1] + 20 * np.sin(np.arctan2(P[:, 2], P[:, 0]) * 14), 66 + 12 * P[:, 1]], 1)
    M.lathe([(.001, 1.9), (.1, 1.85), (.15, 1.65), (.165, 1.2), (.17, .6), (.18, .05), (.18, 0)], 28, colf, rmod=rib)
    s = -1 if v else 1
    for sd, y0, h in ((s, .78, .55), (-s, 1.05, .42)):
        arm = [(sd * (.13 + .24 * math.sin(min(t, .5) * math.pi)), y0 + (max(0, t - .35)) * h * 1.6 + .02 * t, 0) for t in [i / 12 for i in range(13)]]
        M.sweep(arm, [.08 - .025 * (i / 12) ** 3 for i in range(13)], 12, colf)
        M.blob(arm[-1], (.056, .06, .056), 12, 7, colf)
    return M


def rock(v):
    M = Mesh(0.667)
    M.blob((0, .27, 0), (.47, .4, .36), 44, 26, lambda P: np.repeat((np.clip(84 + 170 * P[:, 1] + 34 * noise(P[:, 0] * 3, P[:, 1] * 3, P[:, 2] * 3, v), 30, 210))[:, None], 3, 1) * np.array([.92, .92, 1.02]), amp=.34, seed=v + 3)
    M.blob((.27 * (1 - 2 * v), .1, .12), (.17, .13, .14), 16, 10, (88, 86, 104), amp=.3, seed=v + 7)
    return M


def pine(v):
    M = Mesh(2.1)
    M.lathe([(.05, 0), (.04, .35), (.03, .7)], 12, c('#4a2c18'))
    tiers = 7
    for k in range(tiers):
        t = k / tiers; y0 = .22 + t * 1.55; R = (.46 - .37 * t) * (1 + .05 * math.sin(k * 2.2 + v)); h = .52 - .17 * t; ph = k * 1.3 + v
        M.lathe([(R, y0), (R * .86, y0 + h * .12), (R * .5, y0 + h * .55), (.006, y0 + h)], 26, lambda P: np.stack([14 + 26 * (P[:, 1] / 2), 74 + 60 * (P[:, 1] / 2) + 16 * np.sin(np.arctan2(P[:, 2], P[:, 0]) * 13 + ph), 50 + 24 * (P[:, 1] / 2)], 1), rmod=lambda u, w: 1 + .1 * np.sin(u * TAU * 13 + ph) * (1 - w))
    return M


def lamp():
    M = Mesh(3.83)
    M.lathe([(.14, 0), (.13, .06), (.07, .1), (.05, .4), (.04, 2.2), (.03, 3.5), (.028, 3.62)], 18, c('#4a4e70'))
    arc = [(.0 + .34 * math.sin(i / 12 * math.pi / 2), 3.55 + .17 * math.sin(i / 12 * math.pi), 0) for i in range(13)]
    M.sweep(arc, [.024] * 13, 10, c('#5a5e80'))
    M.box((.36, 3.56, 0), (.13, .028, .05), c('#26283c'), 4)
    M.box((.36, 3.53, 0), (.11, .008, .04), (255, 236, 180), 6, a=EMI)
    for k in range(4): M.lathe([(.058, .3 + k * .75), (.058, .335 + k * .75)], 18, c('#19f0ff'), a=EMI)
    return M


def pylon(col):
    M = Mesh(5.0)
    M.box((0, 2.5, 0), (.27, 2.5, .2), c('#120838'), 6)
    for i in range(6): M.box((0, 4.5 - i * .76, .205), (.17, .23, .012), c(col), 3, a=EMI); M.box((0, 4.5 - i * .76, .2), (.2, .26, .008), (255, 255, 255), 2, a=EMI)
    M.lathe([(.32, 0), (.3, .05), (.24, .09)], 16, c('#26184a'))
    return M


def lighthouse():
    M = Mesh(2.82)
    band = lambda P: np.where((np.floor(P[:, 1] * 2.6) % 2) < 1, 236, 40)[:, None] * np.array([1, .98, .98]) + np.where((np.floor(P[:, 1] * 2.6) % 2) < 1, 0, 170)[:, None] * np.array([1, 0, 0])
    M.lathe([(.36, 0), (.34, .1), (.27, 1.1), (.21, 2.1), (.2, 2.26)], 36, band)
    M.lathe([(.3, 2.26), (.3, 2.3), (.19, 2.31)], 32, c('#1c2036'))
    M.lathe([(.17, 2.31), (.17, 2.54)], 24, (255, 232, 170), a=EMI)
    M.lathe([(.22, 2.54), (.19, 2.58), (.05, 2.73), (.002, 2.8)], 24, c('#b02030'))
    for k in range(16): a = k / 16 * TAU; M.sweep([(.285 * math.cos(a), 2.3, .285 * math.sin(a)), (.285 * math.cos(a), 2.4, .285 * math.sin(a))], [.006, .006], 5, c('#d8dcf0'))
    return M


def moon():
    M = Mesh(1.0)
    M.blob((0, .5, 0), (.21, .21, .21), 44, 30, lambda P: np.stack([175 + 80 * noise(P[:, 0] * 9, P[:, 1] * 9, P[:, 2] * 9, 3)] * 3, 1) * np.array([.86, .95, 1.1]), amp=.015, seed=2, a=EMI)
    return M


def cloud(v):
    M = Mesh(.423); r = np.random.RandomState(40 + v)
    for k in range(9):
        t = k / 8; x = (t - .5) * .74 + r.uniform(-.03, .03); R = (.1 + .1 * math.sin(t * math.pi)) * r.uniform(.8, 1.15)
        M.blob((x, .12 + R * .66, r.uniform(-.04, .04)), (R * 1.15, R * .82, R * .8), 16, 10, lambda P: np.stack([214 + 170 * P[:, 1]] * 3, 1) * np.array([.98, .97, 1.03]), amp=.1, seed=k + v)
    return M


def flame():
    M = Mesh(1.667)
    wob = lambda u, v: 1 + .16 * np.sin(u * TAU * 3 + v * 9) * v + .08 * np.sin(u * TAU * 7 - v * 15)
    for R, h, col in ((.46, 1.62, (255, 90, 20)), (.32, 1.34, (255, 180, 50)), (.17, 1.0, (255, 250, 220))):
        M.lathe([(R * f, h * (1 - t)) for t, f in ((0, .01), (.1, .45), (.25, .76), (.45, 1), (.65, .92), (.85, .62), (1, .2))], 34, col, a=EMI, rmod=wob)
    return M


def banner():
    M = Mesh(.36)
    M.grid(lambda u, v: (u - .5, (1 - v) * .36, .012 * np.sin(u * 12)), 44, 14, (255, 255, 255), a=TEX, uv=True)
    M.grid(lambda u, v: (.5 - u, (1 - v) * .36, .006 + .012 * np.sin((1 - u) * 12)), 12, 4, (60, 60, 90))
    return M


def board(asp, nu=30, nv=20, depth=.012, relief=0, seed=0, step=0, ribs=0):
    M = Mesh(asp); M.slab(nu, nv, depth, relief, seed, step)
    for k in range(ribs):
        y = (k + .5) / ribs * asp; M.box((0, y, depth + .006), (.48, .004, .005), (30, 28, 52), 2)
    return M


def building(asp):
    M = Mesh(asp); d = .32
    M.grid(lambda u, v: (u - .5, (1 - v) * asp, -d + 0 * u), 30, 40, (255, 255, 255), a=TEX, uv=True)
    for sx in (-1, 1): M.grid(lambda u, v: (sx * .5 + 0 * u, (1 - v) * asp, -d + u * 2 * d), 8, 16, (34, 30, 58))
    M.grid(lambda u, v: (u - .5, asp + 0 * u, -d + v * 2 * d), 8, 8, (40, 36, 66))
    for k in range(1, 8):
        y = k / 8 * asp; M.box((0, y, -d - .006), (.5, .005, .008), (70, 66, 100), 2)
    for ux, uz, w, h in ((-.24, -.1, .1, .1), (.2, .08, .12, .07), (.02, -.14, .06, .05)):
        M.box((ux, asp + h, uz), (w, h, w), (56, 52, 84), 3)
    M.lathe([(.012, asp), (.006, asp + .34)], 8, c('#ff2d55'), cx=.3, cz=.1)
    return M


CATALOG = []
def reg(i, fn, animated=False, amp=.05, kind='solid'):
    CATALOG.append(dict(id=i, fn=fn, animated=animated, amp=amp, kind=kind))


for v in (0, 1):
    reg(f'palm{v}', (lambda v: lambda: palm(v))(v), True, .05); reg(f'cactus{v}', (lambda v: lambda: cactus(v))(v)); reg(f'rock{v}', (lambda v: lambda: rock(v))(v)); reg(f'pine{v}', (lambda v: lambda: pine(v))(v), True, .03)
reg('bush', bush); reg('lamp', lamp); reg('lighthouse', lighthouse); reg('moon', moon)
for i, col in enumerate(('#19f0ff', '#ff2fb0', '#c13dff')): reg(f'pylon{i}', (lambda col: lambda: pylon(col))(col))
for v in range(4): reg(f'cloud{v}', (lambda v: lambda: cloud(v))(v), kind='sky')
reg('flame', flame, True, .16, kind='fx')
reg('banner', banner, True, .09, kind='tex')
reg('bill', lambda: board(.8, 28, 22, .02, ribs=4), kind='tex')
reg('sign', lambda: board(.288, 44, 13, .012, ribs=2), kind='tex')
reg('chev', lambda: board(2.0, 18, 30, .03), kind='tex')
reg('stand', lambda: board(.656, 34, 30, .05, step=6), kind='tex')
reg('mesa', lambda: board(.467, 48, 22, .05, relief=.11, seed=2), kind='tex')
reg('cliff', lambda: board(1.72, 24, 40, .07, relief=.13, seed=5), kind='tex')
reg('overpass', lambda: board(.325, 60, 18, .02, ribs=3), kind='tex')
reg('portal', lambda: board(.5, 50, 22, .03, relief=.03, seed=4), kind='tex')
for v in range(3): reg(f'boat{v}', lambda: board(.875, 30, 26, .03, relief=.02, seed=v), True, .03, kind='tex')
def ridge_mesh():
    M = Mesh(1.0)
    def fn(u, v):
        n1 = noise(u * 9.0, v * 2.0, 1.0, 3) * .05 + noise(u * 31.0, v * 7.0, 2.0, 5) * .022
        y = v + (np.sin(u * TAU * 11 + v * 5) * .012 + n1 * .4) * v * (1 - v) * 4
        return u, np.clip(y, 0, 1), -.2 * (1 - v) + n1 * 1.4 * np.sin(v * math.pi)
    M.grid(fn, 192, 10, (255, 255, 255))
    return M


reg('ridge', ridge_mesh, kind='sky')
for asp, nm in ((1.0, 'bldgA'), (1.5, 'bldgB'), (2.0, 'bldgC')): reg(nm, (lambda a: lambda: building(a))(asp), kind='tex')


# ------------------------------------------------------------------ armature for the animated ones
def kmeans(P, k):
    idx = [int(np.argmin(P[:, 1]))]; d = ((P - P[idx[0]]) ** 2).sum(1)
    for _ in range(k - 1):
        i = int(np.argmax(d)); idx.append(i); d = np.minimum(d, ((P - P[i]) ** 2).sum(1))
    C = P[idx].copy()
    for _ in range(4):
        lab = np.argmin(((P[:, None, :] - C[None, :, :]) ** 2).sum(2), 1)
        for j in range(k):
            m = lab == j
            if m.any(): C[j] = P[m].mean(0)
    return C


def bake_rig(name, P, amp, nbones=26, frames=25):
    S = P[:: max(1, len(P) // 4000)]; C = kmeans(S, nbones); order = np.argsort(C[:, 1]); C = C[order]
    lab = np.argmin(((P[:, None, :] - C[None, :, :]) ** 2).sum(2), 1).astype(np.uint8)
    parent = [-1] + [int(np.argmin(((C[:i] - C[i]) ** 2).sum(1))) for i in range(1, nbones)]
    arm = bpy.data.armatures.new(name); ob = bpy.data.objects.new(name, arm); bpy.context.scene.collection.objects.link(ob); bpy.context.view_layer.objects.active = ob; ob.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT'); names = [f'b{i}' for i in range(nbones)]
    for i, n in enumerate(names):
        eb = arm.edit_bones.new(n); h = Vector(C[parent[i]] if parent[i] >= 0 else C[i] - np.array([0, .05, 0])); t = Vector(C[i])
        if (t - h).length < 1e-3: t = h + Vector((0, .02, 0))
        eb.head, eb.tail = h, t; eb.roll = 0
    for i, n in enumerate(names):
        if parent[i] >= 0: arm.edit_bones[n].parent = arm.edit_bones[names[parent[i]]]
    bpy.ops.object.mode_set(mode='POSE'); rest = {b.name: b.matrix_local.copy() for b in arm.bones}; ob.animation_data_create(); act = bpy.data.actions.new(name + '_sway'); ob.animation_data.action = act
    h0 = C[:, 1].min(); hs = max(C[:, 1].max() - h0, 1e-3)
    for pb in ob.pose.bones: pb.rotation_mode = 'QUATERNION'
    for f in range(frames):
        s = f / (frames - 1)
        for i, n in enumerate(names):
            pb = ob.pose.bones[n]; B = rest[n].to_3x3().to_4x4(); hk = (C[i, 1] - h0) / hs
            az = math.sin((s + hk * .35 + i * .013) * TAU) * amp * (.25 + hk); ax = math.sin((s * 2 + hk * .5 + i * .021) * TAU) * amp * .4 * (.2 + hk)
            q = Quaternion((0, 0, 1), az) @ Quaternion((1, 0, 0), ax)
            pb.rotation_quaternion = (B.inverted() @ q.to_matrix().to_4x4() @ B).to_quaternion(); pb.keyframe_insert('rotation_quaternion', frame=f + 1)
    data = np.zeros((nbones, frames, 7), np.float32)
    for f in range(frames):
        bpy.context.scene.frame_set(f + 1); bpy.context.view_layer.update()
        for i, n in enumerate(names):
            pb = ob.pose.bones[n]; pr = rest[pb.parent.name] if pb.parent else Matrix.Identity(4); t, q, _ = (pr.inverted() @ rest[n] @ pb.matrix_basis).decompose(); data[i, f] = (q.x, q.y, q.z, q.w, t.x, t.y, t.z)
    inv = np.zeros((nbones, 12), np.float32)
    for i, n in enumerate(names):
        m = rest[n].inverted(); inv[i] = [m[0][0], m[0][1], m[0][2], m[0][3], m[1][0], m[1][1], m[1][2], m[1][3], m[2][0], m[2][1], m[2][2], m[2][3]]
    bpy.ops.object.mode_set(mode='OBJECT'); bpy.data.objects.remove(ob); bpy.data.armatures.remove(arm); bpy.data.actions.remove(act)
    return lab, parent, inv, data


# ------------------------------------------------------------------ pack
class Pack:
    def __init__(self): self.b = bytearray()
    def add(self, a):
        a = np.asarray(a)
        while len(self.b) % 4: self.b.append(0)
        o = len(self.b); self.b += a.tobytes(); return [o, int(a.size)]


bpy.ops.wm.read_factory_settings(use_empty=True)
pk = Pack(); out = {}
for it in CATALOG:
    M = it['fn'](); P, N, C_, U, T = M.done(); assert len(P) < 65536, it['id']
    sc = np.maximum(np.abs(P).max(0), 1e-4) * 1.001
    e = {'asp': M.asp, 'kind': it['kind'], 'scale': [float(x) for x in sc], 'nv': len(P), 'tris': len(T), 'pos': pk.add(np.round(P / sc * 32767).astype(np.int16)), 'nrm': pk.add(np.round(np.clip(N, -1, 1) * 127).astype(np.int8)), 'col': pk.add(C_), 'uv': pk.add(np.round(np.clip(U, 0, 1) * 65535).astype(np.uint16)), 'idx': pk.add(T.reshape(-1).astype(np.uint16))}
    if it['animated']:
        lab, par, inv, data = bake_rig(it['id'], P.astype(np.float64), it['amp'])
        e.update(bone=pk.add(lab), par=par, inv=pk.add(inv), clip=pk.add(data), frames=data.shape[1], bones=len(par), usedBones=int(len(np.unique(lab))))
    out[it['id']] = e
    print(f"[prop] {it['id']} tris {len(T)} verts {len(P)}" + (f" bones {e['bones']} used {e['usedBones']}" if it['animated'] else ''), flush=True)
open(os.path.join(OUT, 'props.bin'), 'wb').write(bytes(pk.b))
json.dump({'version': 1, 'size': len(pk.b), 'props': out}, open(os.path.join(OUT, 'props.json'), 'w'), separators=(',', ':'))
print('[props] bytes', len(pk.b), flush=True)
