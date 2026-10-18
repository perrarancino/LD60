"""
Генератор арта второй локации: тайлы (tilemap_loc2.png, 10 кадров 32x32: 0-4 — заливка, 5-9 — верхний край) и фон (bg_loc2.png + 8 слоёв
по 512x128 для параллакса). Стиль: общий синий (рампа cobalt палитры проекта) с бирюзовым акцентом (рампа electric): бирюзовые дорожки платы
в синем корпусе, бирюзовая «кромка» поверхностей, бирюзовое свечение у горизонта. Цвета — только из assets/palettes/oldtech-vivid-72.gpl.

Запуск из корня проекта:  python tools/gen_loc2_art.py
Результат: assets/sprites/tiles/tilemap_loc2.png, assets/sprites/backgrounds/bg_loc2.png и bg_loc2_layers/Layer_1..8.png.
Рисунок детерминирован (фиксированные семена): повторный запуск даёт те же файлы. Правки арта — здесь (или руками в .aseprite, тогда этот файл не нужен).
"""
import math
import os
import re
import sys

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_palette():
    ramps = {}
    path = os.path.join(ROOT, 'assets', 'palettes', 'oldtech-vivid-72.gpl')
    for line in open(path, encoding='utf-8'):
        m = re.match(r'\s*(\d+)\s+(\d+)\s+(\d+)\s+([a-z]+)-(\d)', line)
        if m:
            ramps.setdefault(m.group(4), [None] * 8)[int(m.group(5))] = tuple(int(m.group(i)) for i in (1, 2, 3))
    return ramps


PAL = load_palette()


def C(ramp, i):
    return PAL[ramp][i]


class Canvas:
    """RGBA-холст; wrap — замыкать по горизонтали (слои, которые тайлятся без зеркала, должны стыковаться)."""

    def __init__(self, w, h, wrap=False):
        self.w, self.h, self.wrap = w, h, wrap
        self.a = np.zeros((h, w, 4), dtype=np.uint8)

    def put(self, x, y, c, alpha=255):
        x = int(x)
        y = int(y)
        if self.wrap:
            x %= self.w
        elif not 0 <= x < self.w:
            return
        if 0 <= y < self.h:
            self.a[y, x] = (c[0], c[1], c[2], alpha)

    def get(self, x, y):
        x = int(x)
        if self.wrap:
            x %= self.w
        if 0 <= x < self.w and 0 <= y < self.h:
            return tuple(int(v) for v in self.a[y, x])
        return (0, 0, 0, 0)

    def rect(self, x, y, w, h, c, alpha=255):
        for yy in range(int(y), int(y + h)):
            for xx in range(int(x), int(x + w)):
                self.put(xx, yy, c, alpha)

    def line(self, x0, y0, x1, y1, c, alpha=255):
        x0, y0, x1, y1 = int(x0), int(y0), int(x1), int(y1)
        dx, dy = abs(x1 - x0), -abs(y1 - y0)
        sx, sy = (1 if x0 < x1 else -1), (1 if y0 < y1 else -1)
        err = dx + dy
        while True:
            self.put(x0, y0, c, alpha)
            if x0 == x1 and y0 == y1:
                break
            e2 = 2 * err
            if e2 >= dy:
                err += dy
                x0 += sx
            if e2 <= dx:
                err += dx
                y0 += sy

    def image(self):
        return Image.fromarray(self.a, 'RGBA')


BAYER = np.array([[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]) / 16.0


# ----------------------------------------------------------------------------------------------------------------------------- Тайлы

TS = 32
TRACE_ROWS = (8, 21)  # горизонтальные дорожки, проходящие через стыки тайлов
TRACE_COLS = (9, 23)  # вертикальные


def route(cv, p0, p1, horizontal, rng, c_dim, c_hot):
    """Дорожка от края до края: идёт по своей линии, на середине делает «ступеньку» по 45° в сторону и возвращается на линию (стыки тайлов совпадают)."""
    n = TS
    mid = rng.randint(2, 4)
    a = rng.randint(4, 10)
    b = a + mid + rng.randint(4, 9)
    sign = rng.choice((-1, 1))
    pts = []
    for t in range(n):
        if t < a:
            off = 0
        elif t < a + mid:
            off = sign * (t - a + 1)
        elif t < b:
            off = sign * mid
        elif t < b + mid:
            off = sign * (mid - (t - b + 1))
        else:
            off = 0
        pts.append((t, p0 + off) if horizontal else (p0 + off, t))
    for i, (x, y) in enumerate(pts):
        cv.put(x, y, c_dim)
        if i:
            cv.line(pts[i - 1][0], pts[i - 1][1], x, y, c_dim)
    for _ in range(rng.randint(1, 2)):  # импульсы: короткие яркие участки на дорожке
        i = rng.randint(2, n - 8)
        for k in range(rng.randint(3, 6)):
            cv.put(pts[i + k][0], pts[i + k][1], c_hot)
    return pts


def chip(cv, x, y, w, h, rng):
    cv.rect(x, y, w, h, C('cobalt', 0))
    for xx in range(x, x + w):  # контур: верх и лево светлее
        cv.put(xx, y, C('cobalt', 3))
    for yy in range(y, y + h):
        cv.put(x, yy, C('cobalt', 3))
    for xx in range(x + 1, x + w):
        cv.put(xx, y + h - 1, C('cobalt', 2))
    for yy in range(y + 1, y + h):
        cv.put(x + w - 1, yy, C('cobalt', 2))
    for xx in range(x + 1, x + w - 1, 2):  # выводы
        cv.put(xx, y - 1, C('electric', 4))
        cv.put(xx, y + h, C('electric', 4))
    for yy in range(y + 2, y + h - 2, 2):  # прорези корпуса
        for xx in range(x + 3, x + w - 2):
            cv.put(xx, yy, C('cobalt', 1) if (xx + yy) % 5 else C('cobalt', 2))  # прорези корпуса
    cv.put(x + 1, y + 1, C('electric', 6))  # ключ-светодиод в углу


def fill_frame(seed):
    import random
    rng = random.Random(seed)
    cv = Canvas(TS, TS)
    cv.rect(0, 0, TS, TS, C('cobalt', 1))
    # крупные тёмные панели (швы платы)
    for _ in range(rng.randint(2, 3)):
        w, h = rng.randint(7, 12), rng.randint(5, 9)
        x, y = rng.randint(2, TS - w - 2), rng.randint(2, TS - h - 2)
        cv.rect(x, y, w, h, C('cobalt', 0))
        for xx in range(x, x + w):
            cv.put(xx, y, C('cobalt', 2))
    # зерно
    for yy in range(TS):
        for xx in range(TS):
            r = rng.random()
            if r < 0.04:
                cv.put(xx, yy, C('cobalt', 2))
            elif r < 0.07:
                cv.put(xx, yy, C('cobalt', 0))
    # дорожки: через стыки тайлов (горизонтальные и вертикальные)
    for y0 in TRACE_ROWS:
        route(cv, y0, y0, True, rng, C('electric', 3), C('electric', 5))
    for x0 in TRACE_COLS:
        route(cv, x0, x0, False, rng, C('electric', 3), C('electric', 5))
    # микросхемы и переходные отверстия
    for _ in range(rng.randint(1, 2)):
        w, h = rng.randint(6, 10), rng.randint(4, 7)
        chip(cv, rng.randint(3, TS - w - 3), rng.randint(3, TS - h - 4), w, h, rng)
    for _ in range(rng.randint(2, 3)):
        x, y = rng.randint(3, TS - 4), rng.randint(3, TS - 4)
        cv.put(x, y, C('electric', 6))
        for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            cv.put(x + dx, y + dy, C('electric', 3))
    return cv


def top_frame(seed):
    import random
    rng = random.Random(seed * 7919 + 1)
    cv = fill_frame(seed + 100)
    # нижняя кромка «шапки» зубцами: плавный случайный ход длины 4..10 пикселей
    length = rng.randint(5, 8)
    lens = []
    for x in range(TS):
        length = max(4, min(10, length + rng.choice((-1, -1, 0, 1, 1))))
        lens.append(length)
    for x in range(TS):  # тёмная подводка под зубцами — шапка читается на заливке
        cv.put(x, lens[x], C('cobalt', 0))
        if x and lens[x - 1] > lens[x]:
            for y in range(lens[x], lens[x - 1]):
                cv.put(x, y, C('cobalt', 0))
    for x in range(TS):
        n = lens[x]
        for y in range(n):
            col = C('cobalt', 6) if y == 0 else C('cobalt', 5) if y == 1 else C('cobalt', 4) if y < 4 else C('cobalt', 3)
            cv.put(x, y, col)
        if x and lens[x - 1] < n:  # светлый левый край зубца — бирюзовый акцент
            for y in range(lens[x - 1], n):
                cv.put(x, y, C('electric', 5))
    for x in range(TS):  # верхняя бирюзовая линия света (с редкими разрывами)
        if rng.random() > 0.1:
            cv.put(x, 0, C('electric', 7) if rng.random() < 0.3 else C('electric', 6))
        cv.put(x, 1, C('electric', 5) if rng.random() < 0.65 else C('cobalt', 6))
    # прожилки бирюзового света, уходящие вглубь из шапки
    for _ in range(rng.randint(2, 3)):
        x = rng.randint(1, TS - 2)
        end = lens[x] + rng.randint(3, 8)
        for y in range(lens[x], end):
            cv.put(x, y, C('electric', 4))
        cv.put(x, end - 1, C('electric', 7))
    return cv


def make_tiles():
    sheet = Image.new('RGBA', (TS * 10, TS), (0, 0, 0, 0))
    for i in range(5):
        sheet.paste(fill_frame(i * 31 + 5).image(), (i * TS, 0))
        sheet.paste(top_frame(i * 17 + 3).image(), ((5 + i) * TS, 0))
    return sheet


# ------------------------------------------------------------------------------------------------------------------------------- Фон

BW, BH = 512, 128


def lerp_color(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def make_sky():
    import random
    rng = random.Random(11)
    cv = Canvas(BW, BH)
    stops = [(0.0, C('cobalt', 0)), (0.45, C('cobalt', 1)), (0.78, C('cobalt', 2)), (1.0, C('electric', 2))]
    # палитровый градиент с упорядоченным дизерингом между ближайшими цветами рампы стопов
    for y in range(BH):
        t = y / (BH - 1)
        for i in range(len(stops) - 1):
            if stops[i][0] <= t <= stops[i + 1][0]:
                k = (t - stops[i][0]) / (stops[i + 1][0] - stops[i][0])
                for x in range(BW):
                    cv.put(x, y, stops[i + 1][1] if k > BAYER[y % 4, x % 4] else stops[i][1])
                break
    for _ in range(46):  # редкие «искры данных» вверху
        x, y = rng.randrange(BW), rng.randrange(0, 60)
        cv.put(x, y, C('electric', 4) if rng.random() < 0.7 else C('electric', 6))
    return cv


def trace_walk(cv, rng, color, node_color, n_traces, length_range):
    for _ in range(n_traces):
        x, y = rng.randrange(BW), rng.randrange(8, BH - 8)
        dx = rng.choice((-1, 1))
        for _ in range(rng.randint(*length_range)):
            run = rng.randint(6, 24)
            for _ in range(run):
                cv.put(x, y, color)
                x += dx
            turn = rng.choice((-1, 1))
            for _ in range(rng.randint(3, 9)):  # 45°
                cv.put(x, y, color)
                x += dx
                y += turn
                if not 3 < y < BH - 3:
                    turn = -turn
        for ox in (-1, 0, 1):  # площадка на конце
            for oy in (-1, 0, 1):
                if (ox or oy) and abs(ox) + abs(oy) < 3:
                    cv.put(x + ox, y + oy, node_color)


def make_circuits():
    import random
    rng = random.Random(23)
    cv = Canvas(BW, BH, wrap=True)
    trace_walk(cv, rng, C('cobalt', 2), C('electric', 3), 16, (2, 4))
    trace_walk(cv, rng, C('electric', 2), C('electric', 4), 5, (2, 3))
    return cv


def make_blobs():
    import random
    rng = random.Random(37)
    cv = Canvas(BW, BH, wrap=True)
    for _ in range(11):  # далёкие плавающие блоки-«чипы»
        w, h = rng.randint(22, 62), rng.randint(14, 48)
        x, y = rng.randrange(BW), rng.randint(14, 74)
        cv.rect(x, y, w, h, C('cobalt', 1))
        for xx in range(x, x + w):
            cv.put(xx, y, C('cobalt', 2))
        for yy in range(y, y + h):
            cv.put(x, yy, C('cobalt', 2))
        for k in range(rng.randint(2, 4)):  # ряды огоньков
            yy = y + 4 + k * 5
            if yy < y + h - 2:
                for xx in range(x + 4, x + w - 4, 3):
                    if rng.random() < 0.45:
                        cv.put(xx, yy, C('electric', 3) if rng.random() < 0.8 else C('electric', 5))
    return cv


def gradient_layer(color, y0, y1, a0, a1, mirror_noise=False, step=1):
    cv = Canvas(BW, BH)
    for y in range(BH):
        if y < y0 or y > y1:
            continue
        t = (y - y0) / max(1, (y1 - y0))
        alpha = int(round(a0 + (a1 - a0) * t))
        for x in range(BW):
            cv.put(x, y, color, alpha)
    return cv


def glow_layer(color, ymid, spread, peak):
    cv = Canvas(BW, BH)
    for y in range(BH):
        k = math.exp(-((y - ymid) / spread) ** 2)
        for x in range(BW):
            cv.put(x, y, color, int(round(peak * k)))
    return cv


# --- силуэты
def silhouette_colors(dark):
    return dark, C('cobalt', 1), C('cobalt', 2)


def capacitor(cv, x, base, w, h, body, edge, light, rng):
    top = base - h
    r = max(2, w // 3)
    for yy in range(top, base):
        inset = 0
        if yy - top < r:
            inset = r - int(math.sqrt(max(0, r * r - (r - (yy - top)) ** 2)))
        cv.rect(x + inset, yy, w - inset * 2, 1, body)
    for xx in range(x + r, x + w - r):
        cv.put(xx, top, light)
    for yy in range(top + r, base):
        cv.put(x, yy, edge)
    for band in range(top + 6, base - 4, 7):
        for xx in range(x, x + w):
            cv.put(xx, band, edge)
    for _ in range(2):  # огоньки
        cv.put(x + rng.randint(2, w - 3), top + rng.randint(4, h - 6), C('electric', 5))
    leg = rng.randint(1, 2)
    cv.rect(x + 2, base, leg, 1, body)


def rack(cv, x, base, w, h, body, edge, light, rng):
    top = base - h
    cv.rect(x, top, w, h, body)
    for xx in range(x, x + w):
        cv.put(xx, top, light)
    for yy in range(top, base):
        cv.put(x, yy, edge)
    for yy in range(top + 4, base - 3, 5):  # окна: редкие огоньки
        for xx in range(x + 3, x + w - 3, 4):
            if rng.random() < 0.34:
                col = C('electric', 5) if rng.random() < 0.8 else C('electric', 7)
                cv.rect(xx, yy, 2, 1, col)
            elif rng.random() < 0.3:
                cv.rect(xx, yy, 2, 1, C('cobalt', 1))
    if rng.random() < 0.7:  # антенна
        ax = x + rng.randint(2, w - 3)
        for yy in range(top - rng.randint(6, 16), top):
            cv.put(ax, yy, body)
        cv.put(ax, top - 12, C('electric', 6))


def pylon(cv, x, base, h, spread, body, rng):
    top = base - h
    for yy in range(top, base):
        t = (yy - top) / h
        half = int(round(1 + (spread - 1) * t * t))
        cv.put(x - half, yy, body)
        cv.put(x + half, yy, body)
        if (yy - top) % 8 == 0:  # перекладины
            cv.line(x - half, yy, x + half, yy + 4 if (yy - top) % 16 else yy - 4 if yy - 4 > top else yy, body)
    for yy in range(top - 10, top):
        cv.put(x, yy, body)
    for k in (-1, 1):  # траверсы с изоляторами
        cv.line(x, top + 6, x + k * 12, top + 6, body)
        cv.put(x + k * 12, top + 8, C('electric', 4))
    cv.put(x, top - 10, C('electric', 6))


def dish(cv, x, base, r, body, edge, rng):
    top = base - r * 3
    for yy in range(top, base):
        cv.put(x, yy, body)
    for ang in range(20, 160):
        a = math.radians(ang)
        cv.put(x + math.cos(a) * r, top + 1 - math.sin(a) * r * 0.55, body)
    cv.put(x + r, top - 2, C('electric', 6))


def dome(cv, x, base, r, body, edge, light, rng):
    for yy in range(base - r, base):
        half = int(math.sqrt(max(0, r * r - (base - yy) ** 2)))
        cv.rect(x - half, yy, half * 2, 1, body)
    for ang in range(100, 170):
        a = math.radians(ang)
        cv.put(x + math.cos(a) * r, base - math.sin(a) * r, light)
    cv.put(x + 2, base - r + 5, C('electric', 5))


def cable(cv, x0, y0, x1, y1, sag, color):
    n = max(2, abs(x1 - x0))
    for i in range(n + 1):
        t = i / n
        cv.put(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t + sag * 4 * t * (1 - t), color)


def make_machines(seed, count, size_scale, dark, wrap, parallel_edge=True):
    import random
    rng = random.Random(seed)
    cv = Canvas(BW, BH, wrap=wrap)
    body, edge, light = silhouette_colors(dark)
    base = BH - 1
    xs = []
    pos = rng.randint(4, 30)
    while pos < BW - 20 and len(xs) < count:
        xs.append(pos)
        pos += rng.randint(28, 62)
    objs = []
    for x in xs:
        kind = rng.choice(('cap', 'cap', 'rack', 'rack', 'pylon', 'dish', 'dome'))
        objs.append((x, kind))
    tops = []
    for x, kind in objs:
        s = size_scale
        if kind == 'cap':
            w, h = int(rng.randint(14, 22) * s), int(rng.randint(40, 80) * s)
            capacitor(cv, x, base, w, h, body, edge, light, rng)
            tops.append((x + w // 2, base - h))
        elif kind == 'rack':
            w, h = int(rng.randint(26, 46) * s), int(rng.randint(26, 56) * s)
            rack(cv, x, base, w, h, body, edge, light, rng)
            tops.append((x + w // 2, base - h))
        elif kind == 'pylon':
            h = int(rng.randint(52, 96) * s)
            pylon(cv, x, base, h, int(rng.randint(8, 13) * s), body, rng)
            tops.append((x, base - h + 6))
        elif kind == 'dish':
            r = int(rng.randint(8, 12) * s)
            dish(cv, x, base, r, body, edge, rng)
        else:
            r = int(rng.randint(14, 24) * s)
            dome(cv, x, base, r, body, edge, light, rng)
    # провода между верхушками соседних объектов (провисают)
    for (xa, ya), (xb, yb) in zip(tops, tops[1:]):
        if xb - xa < 90 and rng.random() < 0.8:
            cable(cv, xa, ya + 6, xb, yb + 6, rng.randint(5, 12), body)
    return cv


def make_skyline():
    cv = make_machines(71, 14, 0.9, C('cobalt', 0), wrap=True)
    # земляная полоса: сплошная, с кромкой и огоньками
    for y in range(BH - 12, BH):
        for x in range(BW):
            cv.put(x, y, C('cobalt', 0))
    for x in range(BW):
        cv.put(x, BH - 12, C('cobalt', 2))
    import random
    rng = random.Random(5)
    for x in range(2, BW, 6):
        if rng.random() < 0.55:
            cv.put(x, BH - 8, C('electric', 4) if rng.random() < 0.75 else C('electric', 6))
    return cv


def composite(layers):
    out = Image.new('RGBA', (BW, BH), (0, 0, 0, 0))
    for im in layers:
        out.alpha_composite(im)
    return out


def make_background():
    sky = make_sky()
    circuits = make_circuits()
    blobs = make_blobs()
    haze_dark = gradient_layer(C('cobalt', 0), 30, BH - 1, 0, 150)
    haze_light = glow_layer(C('electric', 4), 108, 24, 110)
    machines = make_machines(53, 9, 1.0, C('cobalt', 0), wrap=False)
    fog = glow_layer(C('electric', 3), 124, 14, 120)
    skyline = make_skyline()
    layers = [sky, circuits, blobs, haze_dark, haze_light, machines, fog, skyline]
    return layers


def main():
    out_tiles = os.path.join(ROOT, 'assets', 'sprites', 'tiles')
    out_bg = os.path.join(ROOT, 'assets', 'sprites', 'backgrounds')
    os.makedirs(out_tiles, exist_ok=True)
    os.makedirs(os.path.join(out_bg, 'bg_loc2_layers'), exist_ok=True)
    make_tiles().save(os.path.join(out_tiles, 'tilemap_loc2.png'))
    layers = make_background()
    imgs = []
    for i, cv in enumerate(layers, 1):
        im = cv.image()
        im.save(os.path.join(out_bg, 'bg_loc2_layers', f'Layer_{i}.png'))
        imgs.append(im)
    composite(imgs).save(os.path.join(out_bg, 'bg_loc2.png'))
    print('ok: tilemap_loc2.png, bg_loc2.png, bg_loc2_layers/Layer_1..%d.png' % len(layers))


if __name__ == '__main__':
    sys.exit(main())
