"""
Босс «Громовой орёл» (синий орёл с жёлтыми кончиками перьев и молниями) — рисуется кодом по частям и пишется в .aseprite: холст 128x128, слои снизу вверх (как у боссов игры:
каждая часть тела — отдельный слой, чтобы риг мог её вращать): Aura (дымка), Tail, WingL_Outer, WingR_Outer, WingL_Inner, WingR_Inner, Body, Head, Beak, ClawL, ClawR, Lightning
(дуги молний). Слои полные (перо целиком, даже скрытое другим слоем), поэтому при повороте части дыр не остаётся. Цвета — только из assets/palettes/oldtech-vivid-72.gpl.

Перо рисуется многоугольниками без сглаживания (чёткий пиксель-арт): ось пера — кривая от основания к кончику, ширина — лист с острием; цвет — плоские полосы вдоль пера
(тёмное основание, синяя середина, светлый кончик, жёлтое острие у маховых), по верхнему краю — светлый кант, по оси — прожилка, снизу — тёмный край.

Запуск из корня проекта:  python tools/make_eagle_boss.py [выход.aseprite] [превью.png]
По умолчанию пишет assets/source/bosses/boss_eagle.aseprite. Рисунок детерминирован (фиксированное зерно).
"""
import math
import os
import random
import re
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from png2aseprite import write_aseprite  # noqa: E402

N = 128


def load_palette():
    ramps = {}
    for line in open(os.path.join(ROOT, 'assets', 'palettes', 'oldtech-vivid-72.gpl'), encoding='utf-8'):
        m = re.match(r'\s*(\d+)\s+(\d+)\s+(\d+)\s+([a-z]+)-(\d)', line)
        if m:
            ramps.setdefault(m.group(4), [None] * 8)[int(m.group(5))] = tuple(int(m.group(i)) for i in (1, 2, 3))
    return ramps


PAL = load_palette()


def C(ramp, i):
    return PAL[ramp][i]


class Layer:
    """Слой 128x128: PIL-картинка, рисование без сглаживания."""

    def __init__(self):
        self.im = Image.new('RGBA', (N, N), (0, 0, 0, 0))
        self.d = ImageDraw.Draw(self.im)

    def px(self, x, y, c):
        x, y = int(round(x)), int(round(y))
        if 0 <= x < N and 0 <= y < N:
            self.im.putpixel((x, y), (*c, 255))

    def poly(self, pts, c):
        if len(pts) >= 3:
            self.d.polygon([(round(x), round(y)) for x, y in pts], fill=(*c, 255))

    def line(self, pts, c):
        self.d.line([(round(x), round(y)) for x, y in pts], fill=(*c, 255), width=1)

    def alpha(self):
        return np.array(self.im)[..., 3] > 0


rng = random.Random(20260620)

BLUE = {  # рампы оперения по яркости: [основание, середина, светлая середина, кончик, блик]
    'dark': [C('cobalt', 0), C('cobalt', 1), C('cobalt', 2), C('cobalt', 3), C('cobalt', 4)],
    'mid': [C('cobalt', 1), C('cobalt', 2), C('cobalt', 3), C('cobalt', 4), C('cobalt', 5)],
    'light': [C('cobalt', 2), C('cobalt', 3), C('cobalt', 4), C('cobalt', 5), C('electric', 5)],
    'head': [C('cobalt', 3), C('cobalt', 4), C('cobalt', 5), C('electric', 5), C('electric', 6)],
}
GOLD = [C('gold', 3), C('gold', 4), C('gold', 5), C('gold', 6), C('gold', 7)]


def feather(layer, bx, by, ang_deg, length, width, ramp='mid', tip=0.0, bend=0.0, shaft=True):
    """Перо: ось от (bx, by) под углом ang (градусы, экран: 0 вправо, 90 вниз) с изгибом bend (рад к кончику); форма — лист с острием.
    tip — доля длины, окрашенная в жёлтый (кончик маховых). Рисуется полосами вдоль оси: каждая полоса — многоугольник между двумя сечениями."""
    cols = BLUE[ramp]
    n = max(6, int(length / 2.2))
    a0 = math.radians(ang_deg)
    cx, cy = bx, by
    left, right, axis = [], [], []
    for i in range(n + 1):
        t = i / n
        if i:
            aa = a0 + bend * ((i - 0.5) / n) ** 2
            cx += math.cos(aa) * length / n
            cy += math.sin(aa) * length / n
        ang = a0 + bend * t * t
        w = width * (0.5 + 0.5 * math.sin(math.pi * (0.1 + 0.9 * t))) * (1 - 0.35 * t) / 2
        nx, ny = -math.sin(ang), math.cos(ang)
        left.append((cx + nx * w, cy + ny * w))
        right.append((cx - nx * w, cy - ny * w))
        axis.append((cx, cy))
    # полосы по длине
    bands = [(0.0, 0.33, cols[0]), (0.33, 0.62, cols[1]), (0.62, 1.0 - tip, cols[2])]
    if tip > 0:
        bands.append((1.0 - tip, 1.0, GOLD[1]))
    else:
        bands[-1] = (0.62, 1.0, cols[3])
    for t0, t1, col in bands:
        i0, i1 = int(t0 * n), max(int(t0 * n) + 1, int(t1 * n))
        i1 = min(i1, n)
        pts = left[i0:i1 + 1] + right[i0:i1 + 1][::-1]
        layer.poly(pts, col)
    if tip > 0:
        i0 = int((1 - tip) * n)
        layer.poly(left[i0 + (n - i0) // 2:] + right[i0 + (n - i0) // 2:][::-1], GOLD[2])
        layer.poly(left[i0 + (n - i0) * 3 // 4:] + right[i0 + (n - i0) * 3 // 4:][::-1], GOLD[3])
    # кант и прожилка
    layer.line(left[1:], cols[4] if tip == 0 else cols[3])
    layer.line(right[1:], cols[0])
    if shaft and length > 14:
        layer.line(axis[int(n * 0.25):int(n * 0.85)], cols[3])


def ellipse(layer, cx, cy, rx, ry, colfn):
    for y in range(int(cy - ry) - 1, int(cy + ry) + 2):
        for x in range(int(cx - rx) - 1, int(cx + rx) + 2):
            d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2
            if d <= 1:
                layer.px(x, y, colfn(x, y, d))


# ---------------------------------------------------------------------------------------------------------------------------- части

def make_tail():
    L = Layer()
    for k, ang in enumerate((58, 68, 78, 90, 102, 112, 122)):
        feather(L, 64, 86, ang, 36 - abs(k - 3) * 1.5, 9, ramp='dark', tip=0.30, bend=(90 - ang) * 0.004)
    return L


def make_wing_l_outer():
    L = Layer()
    wx, wy = 44, 46
    for k, (ang, ln) in enumerate([(214, 34), (205, 38), (196, 40), (187, 41), (178, 42), (169, 41), (160, 39), (151, 36), (142, 33), (133, 30), (124, 26)]):
        feather(L, wx, wy + k * 0.5, ang, ln, 10, ramp='dark' if k % 2 == 0 else 'mid', tip=0.24 if k > 3 else 0.12, bend=-0.16 * (k - 4) / 5)
    return L


def make_wing_l_inner():
    L = Layer()
    wx, wy = 44, 46
    sx, sy = 56, 54
    for k in range(6):  # вторые маховые
        u = k / 5
        feather(L, wx + (sx - wx) * u, wy + (sy - wy) * u + 1, 112 + (1 - u) * 20, 28 - 8 * u, 10, ramp='mid', tip=0.2, bend=0.22)
    for row, (ln, dy, ramp) in enumerate(((17, 3, 'mid'), (12, 0, 'light'))):  # кроющие: два ряда
        for k in range(8):
            u = k / 7
            feather(L, wx + (sx - wx) * u - 2, wy + (sy - wy) * u - dy, 158 - 60 * u, ln + 3, 9, ramp=ramp, bend=0.1, shaft=False)
    return L


def make_wing_r_outer():
    L = Layer()
    wx, wy = 92, 36
    for k, (ang, ln) in enumerate([(-108, 28), (-90, 33), (-72, 36), (-54, 38), (-36, 38), (-18, 38), (0, 37), (18, 38), (36, 38), (54, 38), (70, 36)]):
        feather(L, wx, wy + (k - 5) * 0.4, ang, ln, 9.5, ramp='dark' if k % 2 == 0 else 'mid', tip=0.24 if k > 3 else 0.12, bend=0.14 * (k - 5) / 5)
    return L


def make_wing_r_inner():
    L = Layer()
    wx, wy = 92, 36
    sx, sy = 76, 52
    for k in range(6):
        u = k / 5
        feather(L, wx + (sx - wx) * u, wy + (sy - wy) * u - 1, 70 + 26 * u, 28 - 9 * u, 9.5, ramp='mid', tip=0.2, bend=-0.22)
    for row, (ln, dy, ramp) in enumerate(((18, 3, 'mid'), (13, 0, 'light'))):
        for k in range(8):
            u = k / 7
            feather(L, wx + (sx - wx) * u + 2, wy + (sy - wy) * u - dy, -20 + 100 * u, ln, 8.5, ramp=ramp, bend=-0.1, shaft=False)
    return L


def make_body():
    L = Layer()
    # бёдра: перья вниз, жёлтые у когтей
    for sx_, ang, sg in ((52, 98, 1), (76, 82, -1)):
        for k in range(4):
            feather(L, sx_ + (k - 1.5) * 2.4, 78, ang + (k - 1.5) * 5, 20 - abs(k - 1.5) * 2, 7.5, ramp='mid', tip=0.34, bend=0.1 * sg)
    # грудь: ряды перьев сверху вниз, нижние перекрывают верхние; чем ниже, тем светлее
    cx, cy = 64, 66
    for row in range(12):
        y = cy - 20 + row * 3.6
        half = 17 * math.sqrt(max(0.0, 1 - ((y - cy) / 24) ** 2))
        n = max(2, int(half * 2 / 4.8))
        for k in range(n + 1):
            x = cx - half + (k + (0.5 if row % 2 else 0)) * (half * 2 / max(1, n))
            feather(L, x, y, 90 + (x - cx) * 0.8, 10.5, 7.2, ramp='dark' if row < 4 else 'mid', tip=0.0, bend=(x - cx) * 0.006, shaft=False)
    return L


def make_head():
    L = Layer()
    hx, hy = 62, 38
    ellipse(L, hx, hy + 2, 13.5, 13, lambda x, y, d: C('cobalt', 3) if d < 0.55 else C('cobalt', 2))
    for k in range(4):  # небольшой хохол-гребень на затылке
        feather(L, hx + k * 3.4, hy - 10, -75 - k * 6, 8 - k, 6, ramp='head', bend=0.2, shaft=False)
    for row in range(5):  # перья на голове — назад-вверх, светлее к макушке
        for k in range(6):
            x = hx - 10 + k * 4.2 + (2 if row % 2 else 0)
            y = hy - 5 + row * 4.8
            feather(L, x, y, 68 + (x - hx) * 1.1, 8, 6, ramp='head' if row < 3 else 'light', bend=0.1, shaft=False)
    # глаз под тяжёлой бровью
    ex, ey = hx - 4, hy + 1
    for dx, dy, c in ((0, 0, C('gold', 6)), (1, 0, C('gold', 7)), (2, 0, C('gold', 6)), (0, 1, C('gold', 5)), (1, 1, C('gold', 6)), (2, 1, C('gold', 5))):
        L.px(ex + dx, ey + dy, c)
    L.px(ex, ey + 1, C('cobalt', 0))
    for dx, dy in ((-3, -2), (-2, -2), (-1, -1), (0, -1), (1, -1), (2, 0)):  # бровь — злой наклон
        L.px(ex + dx, ey + dy, C('cobalt', 0))
    return L


def make_beak():
    L = Layer()
    hx, hy = 62, 38
    up = [(hx - 9, hy + 3), (hx - 15, hy + 3), (hx - 20, hy + 9), (hx - 19, hy + 17), (hx - 15, hy + 12), (hx - 11, hy + 9), (hx - 7, hy + 7)]
    lo = [(hx - 9, hy + 10), (hx - 15, hy + 14), (hx - 14, hy + 20), (hx - 8, hy + 15), (hx - 6, hy + 11)]
    for pts, base in ((lo, GOLD[1]), (up, GOLD[2])):
        m = Image.new('L', (N, N), 0)
        ImageDraw.Draw(m).polygon([(round(x), round(y)) for x, y in pts], fill=255)
        arr = np.array(m) > 0
        ys, xs = np.nonzero(arr)
        for y, x in zip(ys, xs):
            col = base
            if not arr[y - 1, x]:
                col = GOLD[4] if base == GOLD[2] else GOLD[3]
            elif not arr[y + 1, x] or not arr[y, x + 1]:
                col = GOLD[0]
            L.px(x, y, col)
    for dx in range(0, 6):  # пасть между челюстями
        L.px(hx - 14 + dx, hy + 10 + (dx > 3), C('cobalt', 0))
    return L


def make_claw(base_x, base_y, mirror):
    L = Layer()
    m = -1 if mirror else 1
    # голень — жёлтая, три пальца вперёд-вниз с белыми когтями-серпами
    for k in range(4):
        L.line([(base_x - 2 + k, base_y - 8), (base_x - 2 + k, base_y)], GOLD[1 + (k > 1)])
    for ang, ln in ((62, 11), (90, 13), (118, 11)):
        a = math.radians(ang if not mirror else 180 - ang)
        ex, ey = base_x + math.cos(a) * ln, base_y + 1 + math.sin(a) * ln
        L.line([(base_x, base_y + 1), (ex, ey)], GOLD[2])
        L.line([(base_x - 1, base_y), (ex - 1, ey - 1)], GOLD[3])
        for t in range(5):  # коготь
            L.px(ex + m * t * 0.5 * (1 if ang >= 88 else -1), ey + t * 0.9, C('steel', 7) if t < 3 else C('steel', 5))
    return L


def make_aura(parts):
    A = Layer()
    mask = np.zeros((N, N), dtype=bool)
    for P in parts:
        mask |= P.alpha()
    img = Image.fromarray((mask * 255).astype(np.uint8), 'L')
    blur = np.array(img.filter(ImageFilter.MaxFilter(11)).filter(ImageFilter.GaussianBlur(3.5))).astype(float) / 255
    for y in range(N):
        for x in range(N):
            if mask[y, x]:
                continue
            v = blur[y, x]
            bayer = ((x % 4) * 4 + (y % 4) + ((x // 2 + y // 2) % 2) * 2) / 16.0
            if v > 0.42 + 0.4 * bayer and (x + y) % 3:
                A.px(x, y, C('cobalt', 1) if v > 0.7 else C('cobalt', 0))
    return A


def bolt(layer, a, b, depth=4, amp=None):
    ax, ay = a
    bx, by = b
    ln = math.hypot(bx - ax, by - ay)
    amp = amp if amp is not None else min(ln * 0.18, 9)
    pts = [(ax, ay), (bx, by)]
    nx, ny = -(by - ay) / max(ln, 1e-6), (bx - ax) / max(ln, 1e-6)
    for _ in range(depth):
        new = []
        for (px, py), (qx, qy) in zip(pts, pts[1:]):
            off = (rng.random() * 2 - 1) * amp
            new += [(px, py), ((px + qx) / 2 + nx * off, (py + qy) / 2 + ny * off)]
        new.append(pts[-1])
        pts = new
        amp *= 0.55
    layer.line(pts, C('gold', 6))
    return pts


def make_lightning():
    L = Layer()
    anchors = [((54, 50), (12, 72)), ((46, 44), (10, 36)), ((72, 52), (120, 76)), ((88, 38), (112, 8)), ((60, 60), (42, 108)), ((68, 62), (88, 112)), ((62, 28), (34, 14)), ((72, 32), (100, 20))]
    for a, b in anchors:
        pts = bolt(L, a, b)
        for k in range(2, len(pts) - 2, 3):
            if rng.random() < 0.5:
                px, py = pts[k]
                ang = rng.random() * math.pi * 2
                bolt(L, (px, py), (px + math.cos(ang) * 10, py + math.sin(ang) * 10), depth=2, amp=3)
    for _ in range(26):
        L.px(rng.randint(2, N - 3), rng.randint(6, N - 8), C('gold', 5 + rng.randint(0, 2)))
    return L


def build():
    tail = make_tail()
    wlo, wro = make_wing_l_outer(), make_wing_r_outer()
    wli, wri = make_wing_l_inner(), make_wing_r_inner()
    body = make_body()
    head = make_head()
    beak = make_beak()
    cl = make_claw(52, 100, False)
    cr = make_claw(74, 98, True)
    light = make_lightning()
    aura = make_aura([tail, wlo, wro, wli, wri, body, head, beak, cl, cr])
    return [('Aura', aura), ('Tail', tail), ('WingL_Outer', wlo), ('WingR_Outer', wro), ('WingL_Inner', wli), ('WingR_Inner', wri), ('Body', body),
            ('Head', head), ('Beak', beak), ('ClawL', cl), ('ClawR', cr), ('Lightning', light)]


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'assets', 'source', 'bosses', 'boss_eagle.aseprite')
    prev = sys.argv[2] if len(sys.argv) > 2 else None
    layers = build()
    os.makedirs(os.path.dirname(out), exist_ok=True)
    write_aseprite(out, N, N, [(n, L.im) for n, L in layers])
    if prev:
        img = Image.new('RGBA', (N, N), (4, 8, 16, 255))
        for _, L in layers:
            img.alpha_composite(L.im)
        os.makedirs(os.path.dirname(prev), exist_ok=True)
        img.resize((N * 6, N * 6), Image.NEAREST).save(prev)
    print('ok:', out, {n: int(L.alpha().sum()) for n, L in layers})


if __name__ == '__main__':
    main()
