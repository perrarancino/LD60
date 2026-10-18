"""
Генератор арта второй локации — «внутренности блока питания компьютера»: тайлы (tilemap_loc2.png, 10 кадров 32x32: 0-4 — заливка, 5-9 — верхний
край) и параллакс-фон (bg_loc2.png + 8 слоёв по 512x128). Стиль: общий синий (рампа cobalt палитры проекта) с бирюзовым акцентом (рампа electric).
Плотность пикселя — как у арта первой локации: кадр тайла 32x32 и слой фона 512x128, без шума и дизеринга, детали от 2 пикселей.
Тайлы — клёпаные металлические панели корпуса: вентрешётка, перфорация, наклейка с предупреждением, разъём с проводами, вентилятор, радиатор;
фон — вентиляционная стена, огромные вентиляторы, электролитические конденсаторы, тороидальные катушки, трансформаторы, радиаторы, пучки проводов.
Цвета — только из assets/palettes/oldtech-vivid-72.gpl.

Запуск из корня проекта:  python tools/gen_loc2_art.py
Результат: assets/sprites/tiles/tilemap_loc2.png, assets/sprites/backgrounds/bg_loc2.png и bg_loc2_layers/Layer_1..8.png.
Рисунок детерминирован (фиксированные семена): повторный запуск даёт те же файлы. Правки арта — здесь (или руками в .aseprite, тогда этот файл не нужен).
"""
import math
import os
import random
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
        x = int(round(x))
        y = int(round(y))
        if self.wrap:
            x %= self.w
        elif not 0 <= x < self.w:
            return
        if 0 <= y < self.h:
            self.a[y, x] = (c[0], c[1], c[2], alpha)

    def rect(self, x, y, w, h, c, alpha=255):
        for yy in range(int(y), int(y + h)):
            for xx in range(int(x), int(x + w)):
                self.put(xx, yy, c, alpha)

    def line(self, x0, y0, x1, y1, c, alpha=255):
        x0, y0, x1, y1 = int(round(x0)), int(round(y0)), int(round(x1)), int(round(y1))
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

    def disc(self, cx, cy, r, c, alpha=255):
        for yy in range(int(cy - r - 1), int(cy + r + 2)):
            for xx in range(int(cx - r - 1), int(cx + r + 2)):
                if (xx - cx) ** 2 + (yy - cy) ** 2 <= r * r:
                    self.put(xx, yy, c, alpha)

    def ring(self, cx, cy, r0, r1, c, alpha=255):
        for yy in range(int(cy - r1 - 1), int(cy + r1 + 2)):
            for xx in range(int(cx - r1 - 1), int(cx + r1 + 2)):
                d = (xx - cx) ** 2 + (yy - cy) ** 2
                if r0 * r0 <= d <= r1 * r1:
                    self.put(xx, yy, c, alpha)

    def image(self):
        return Image.fromarray(self.a, 'RGBA')


# ----------------------------------------------------------------------------------------------------------------------------- Тайлы

TS = 32


def plate(cv):
    """Клёпаная панель корпуса: грань cobalt-1, фаска (светлая сверху-слева, тёмная снизу-справа)."""
    cv.rect(0, 0, TS, TS, C('cobalt', 1))
    for i in range(TS):
        cv.put(i, 0, C('cobalt', 3))
        cv.put(0, i, C('cobalt', 3))
        cv.put(i, TS - 1, C('cobalt', 0))
        cv.put(TS - 1, i, C('cobalt', 0))
    for i in range(1, TS - 1):
        cv.put(i, 1, C('cobalt', 2))
        cv.put(1, i, C('cobalt', 2))
        cv.put(i, TS - 2, C('cobalt', 0))
        cv.put(TS - 2, i, C('cobalt', 0))


def screw(cv, x, y):
    cv.rect(x - 1, y - 1, 3, 3, C('cobalt', 3))
    cv.put(x, y, C('cobalt', 0))
    cv.put(x - 1, y - 1, C('cobalt', 5))


def slot(cv, x, y, w):
    cv.rect(x, y, w, 2, C('cobalt', 0))
    cv.rect(x + 1, y + 2, w - 1, 1, C('cobalt', 3))


def v_vent(cv, rng, ox, oy):
    for k in range(4):
        slot(cv, 9 + ox, 9 + oy + k * 4, 14)


def v_perf(cv, rng, ox, oy):
    for gy in range(3):
        for gx in range(4):
            x, y = 8 + ox + gx * 5, 9 + oy + gy * 5
            cv.rect(x, y, 3, 3, C('cobalt', 0))
            cv.put(x + 2, y + 2, C('cobalt', 1))
            cv.rect(x + 1, y + 3, 3, 1, C('cobalt', 2))


def v_label(cv, rng, ox, oy):
    x, y = 7 + ox, 9 + oy
    cv.rect(x, y, 18, 13, C('cobalt', 6))
    cv.rect(x + 1, y + 1, 16, 2, C('cobalt', 0))  # полоса предупреждения
    for k in range(0, 16, 4):
        cv.rect(x + 1 + k, y + 1, 2, 2, C('electric', 5))
    for k in range(3):  # строки текста
        cv.rect(x + 2, y + 5 + k * 3, 14 - (k == 2) * 5, 1, C('cobalt', 3))
    cv.rect(x + 12, y + 10, 4, 2, C('electric', 4))
    cv.rect(x, y + 13, 18, 1, C('cobalt', 0))


def v_connector(cv, rng, ox, oy):
    x, y = 6 + ox, 10 + oy
    cv.rect(x, y, 10, 10, C('cobalt', 0))  # разъём
    cv.rect(x + 1, y + 1, 8, 1, C('cobalt', 3))
    for r in range(2):
        for c in range(2):
            cv.rect(x + 2 + c * 4, y + 3 + r * 4, 2, 2, C('electric', 4))
    cols = ((C('electric', 5), C('electric', 7)), (C('cobalt', 5), C('cobalt', 7)), (C('electric', 3), C('electric', 5)))  # три провода: тело и блик
    for k, (col, hi) in enumerate(cols):
        wy = y + 1 + k * 3
        cv.rect(x + 10, wy, 12, 2, col)
        cv.rect(x + 10, wy, 12, 1, hi)
    cv.rect(x + 20, y, 2, 10, C('cobalt', 0))  # хомут


def v_fan(cv, rng, ox, oy):
    cx, cy = 16 + ox, 16 + oy
    cv.disc(cx, cy, 9, C('cobalt', 3))
    cv.disc(cx, cy, 7, C('cobalt', 0))
    for b in range(5):  # лопасти, загнутые по ходу
        a0 = b * 2 * math.pi / 5
        for r in range(2, 7):
            for da in (0.0, 0.18, 0.36, 0.54):
                a = a0 + da + r * 0.16
                cv.put(cx + math.cos(a) * r, cy + math.sin(a) * r, C('cobalt', 2) if da < 0.5 else C('cobalt', 4))
    cv.disc(cx, cy, 2, C('cobalt', 4))
    cv.put(cx, cy, C('electric', 6))


def v_heatsink(cv, rng, ox, oy):
    for k in range(6):
        x = 8 + ox + k * 3
        cv.rect(x, 9 + oy, 2, 14, C('cobalt', 3))
        cv.rect(x, 9 + oy, 1, 14, C('cobalt', 5))
        cv.rect(x + 2, 9 + oy, 1, 14, C('cobalt', 0))
    cv.rect(7 + ox, 22 + oy, 18, 2, C('electric', 3))  # бирюзовое свечение у основания рёбер


VARIANTS = [v_vent, v_perf, v_label, v_connector, v_fan, v_heatsink]


def fill_frame(variant, seed):
    rng = random.Random(seed)
    cv = Canvas(TS, TS)
    plate(cv)
    VARIANTS[variant](cv, rng, rng.randint(-1, 1), rng.randint(-1, 1))
    for x, y in ((4, 4), (27, 4), (4, 27), (27, 27)):
        screw(cv, x, y)
    return cv


def top_frame(variant, seed):
    """Верхний край: фланец корпуса — светлая бирюзовая кромка, фаска, индикаторы и прорези; ниже панель с рисунком."""
    rng = random.Random(seed)
    cv = Canvas(TS, TS)
    plate(cv)
    VARIANTS[variant](cv, rng, rng.randint(-1, 1), 2 + rng.randint(0, 1))
    for x, y in ((4, 28), (27, 28)):
        screw(cv, x, y)
    cv.rect(0, 0, TS, 6, C('cobalt', 4))
    cv.rect(0, 0, TS, 1, C('electric', 6))
    cv.rect(0, 1, TS, 1, C('cobalt', 6))
    cv.rect(0, 2, TS, 1, C('cobalt', 5))
    cv.rect(0, 5, TS, 1, C('cobalt', 0))
    for _ in range(rng.randint(2, 3)):  # прорези фланца
        cv.rect(rng.randint(2, 26), 3, 3, 2, C('cobalt', 0))
    for _ in range(rng.randint(1, 2)):  # индикаторы
        x = rng.randint(2, 28)
        cv.rect(x, 3, 2, 2, C('electric', 5))
        cv.put(x, 3, C('electric', 7))
    cv.rect(0, 6, TS, 1, C('cobalt', 0))  # тень под фланцем
    return cv


def make_tiles():
    sheet = Image.new('RGBA', (TS * 10, TS), (0, 0, 0, 0))
    fill_order = [0, 1, 2, 3, 4]
    top_order = [5, 0, 4, 3, 1]
    for i, v in enumerate(fill_order):
        sheet.paste(fill_frame(v, 100 + i).image(), (i * TS, 0))
    for i, v in enumerate(top_order):
        sheet.paste(top_frame(v, 200 + i).image(), ((5 + i) * TS, 0))
    return sheet


# ------------------------------------------------------------------------------------------------------------------------------- Фон

BW, BH = 512, 128


def lerp_color(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def make_sky():
    """Небо: ступенчатый градиент без дизеринга (полосы по 8 строк): тёмно-синий сверху -> синий -> бирюзовый у горизонта."""
    cv = Canvas(BW, BH)
    stops = [(0.0, C('cobalt', 0)), (0.5, C('cobalt', 1)), (0.8, C('cobalt', 2)), (1.0, C('electric', 2))]
    for y in range(BH):
        t = min(1.0, (y // 8 * 8 + 4) / (BH - 1))
        for i in range(len(stops) - 1):
            if stops[i][0] <= t <= stops[i + 1][0]:
                k = (t - stops[i][0]) / (stops[i + 1][0] - stops[i][0])
                cv.rect(0, y, BW, 1, lerp_color(stops[i][1], stops[i + 1][1], k))
                break
    return cv


def make_vent_wall():
    """Далёкая вентиляционная стена: перфорация квадратными отверстиями (сверху тёмные, ниже — подсвечены бирюзой изнутри); шаг делит 512."""
    cv = Canvas(BW, BH, wrap=True)
    pitch = 8
    for row, y in enumerate(range(6, 92, pitch)):
        t = (y - 6) / 86
        col = lerp_color(C('cobalt', 1), C('electric', 2), t * t)
        edge = lerp_color(C('cobalt', 2), C('electric', 3), t * t)
        for x in range(0, BW, pitch):
            xx = x + (pitch // 2 if row % 2 else 0)
            cv.rect(xx, y, 4, 4, col)
            cv.rect(xx + 1, y + 4, 3, 1, edge)
    return cv


def fan(cv, cx, cy, r, ring_col, blade_col, hub_col, led_col):
    """Вентилятор: обод, семь сплошных загнутых лопастей (сектор шириной ~55% шага, закрученный с радиусом), втулка со светодиодом."""
    cv.ring(cx, cy, r - 2, r, ring_col)
    step = 2 * math.pi / 7
    for yy in range(cy - r, cy + r + 1):
        for xx in range(cx - r, cx + r + 1):
            d = math.hypot(xx - cx, yy - cy)
            if 4 <= d < r - 2:
                th = (math.atan2(yy - cy, xx - cx) - d * 0.045) % step
                if th < step * 0.55:
                    cv.put(xx, yy, blade_col)
    cv.disc(cx, cy, 4, hub_col)
    cv.rect(cx - 1, cy - 1, 2, 2, led_col)


def make_fans():
    rng = random.Random(37)
    cv = Canvas(BW, BH, wrap=True)
    for cx, r in ((70, 38), (240, 30), (420, 42)):
        cy = rng.randint(34, 52)
        fan(cv, cx, cy, r, C('cobalt', 2), C('cobalt', 1), C('cobalt', 2), C('electric', 5))
    return cv


def gradient_layer(color, y0, y1, a0, a1):
    cv = Canvas(BW, BH)
    for y in range(y0, y1 + 1):
        t = (y - y0) / max(1, (y1 - y0))
        cv.rect(0, y, BW, 1, color, int(round(a0 + (a1 - a0) * t)))
    return cv


def glow_layer(color, ymid, spread, peak):
    cv = Canvas(BW, BH)
    for y in range(BH):
        k = math.exp(-((y - ymid) / spread) ** 2)
        cv.rect(0, y, BW, 1, color, int(round(peak * k)))
    return cv


# --- силуэты предметов блока питания
def led(cv, x, y, bright=False):
    cv.rect(x, y, 2, 2, C('electric', 6) if bright else C('electric', 5))


def capacitor(cv, x, base, w, h, body, edge, light, rng):
    """Электролитический конденсатор: цилиндр с выпуклой крышкой, светлой полосой по высоте и обжимными кольцами."""
    top = base - h
    cv.rect(x, top + 3, w, h - 3, body)
    cv.rect(x + 1, top + 1, w - 2, 2, body)
    cv.rect(x + 2, top, w - 4, 1, body)
    cv.rect(x + 2, top + 1, w - 4, 1, light)
    cv.rect(x + 2, top + 3, 2, h - 6, edge)
    for yy in (top + 6, base - 7):
        cv.rect(x, yy, w, 1, edge)
    cv.rect(x + w - 4, top + 8, 2, 4, C('electric', 4))
    cv.rect(x - 2, base - 3, w + 4, 3, body)
    cv.rect(x - 2, base - 3, w + 4, 1, light)


def toroid(cv, x, base, r, body, edge, light, rng):
    """Тороидальная катушка на ножках: толстое кольцо с обмоткой (радиальные полосы по всему кольцу)."""
    cy = base - r - 6
    cv.ring(x, cy, r * 0.38, r, body)
    n = 16
    for k in range(n):
        a = k * 2 * math.pi / n
        for rr in range(int(r * 0.45), int(r * 0.9)):
            cv.put(x + math.cos(a) * rr, cy + math.sin(a) * rr, edge)
            cv.put(x + math.cos(a + 0.12) * rr, cy + math.sin(a + 0.12) * rr, edge)
    cv.ring(x, cy, r - 1.5, r, light)
    cv.rect(x - r + 2, base - 6, 3, 6, body)
    cv.rect(x + r - 4, base - 6, 3, 6, body)


def transformer(cv, x, base, w, h, body, edge, light, rng):
    """Трансформатор: сердечник-«кирпич» с обмоткой полосами и бирюзовой щелью."""
    top = base - h
    cv.rect(x, top, w, h, body)
    cv.rect(x, top, w, 2, light)
    cv.rect(x, top, 2, h, edge)
    for yy in range(top + 6, base - 4, 4):
        cv.rect(x + 4, yy, w - 8, 2, edge)
    cv.rect(x + w // 2 - 1, top + 4, 2, h - 8, body)
    cv.rect(x + 3, base - 4, w - 6, 2, C('electric', 3))
    led(cv, x + w - 6, top + 4, True)


def heatsink(cv, x, base, w, h, body, edge, light, rng):
    """Радиатор: основание и гребёнка рёбер; между рёбрами внизу светится бирюза."""
    cv.rect(x, base - 6, w, 6, body)
    cv.rect(x, base - 6, w, 1, light)
    for k, xx in enumerate(range(x + 1, x + w - 2, 5)):
        fh = h - (k % 2) * 4
        cv.rect(xx, base - 6 - fh, 3, fh, body)
        cv.rect(xx, base - 6 - fh, 1, fh, edge)
        cv.rect(xx + 3, base - 12, 2, 6, C('electric', 2))


def cable(cv, x0, y0, x1, y1, sag, body, light):
    n = max(2, abs(x1 - x0))
    for i in range(n + 1):
        t = i / n
        x = x0 + (x1 - x0) * t
        y = y0 + (y1 - y0) * t + sag * 4 * t * (1 - t)
        cv.put(x, y, light)
        cv.put(x, y + 1, body)
        cv.put(x, y + 2, body)


def make_machines(seed, count, size_scale, dark, edge_c, light_c, wrap):
    rng = random.Random(seed)
    cv = Canvas(BW, BH, wrap=wrap)
    base = BH - 1
    pos = rng.randint(4, 24)
    tops = []
    kinds = ['cap', 'toroid', 'trans', 'heat', 'cap', 'trans', 'toroid', 'heat', 'cap']
    k = 0
    while pos < BW - 40 and k < count:
        kind = kinds[k % len(kinds)]
        k += 1
        s = size_scale
        if kind == 'cap':
            w, h = int(rng.randint(14, 20) * s), int(rng.randint(40, 78) * s)
            capacitor(cv, pos, base, w, h, dark, edge_c, light_c, rng)
            tops.append((pos + w // 2, base - h))
            pos += w + rng.randint(26, 46)
        elif kind == 'toroid':
            r = int(rng.randint(16, 24) * s)
            toroid(cv, pos + r, base, r, dark, edge_c, light_c, rng)
            tops.append((pos + r, base - 2 * r - 6))
            pos += 2 * r + rng.randint(26, 46)
        elif kind == 'trans':
            w, h = int(rng.randint(30, 42) * s), int(rng.randint(30, 52) * s)
            transformer(cv, pos, base, w, h, dark, edge_c, light_c, rng)
            tops.append((pos + w // 2, base - h))
            pos += w + rng.randint(24, 44)
        else:
            w, h = int(rng.randint(26, 40) * s), int(rng.randint(24, 44) * s)
            heatsink(cv, pos, base, w, h, dark, edge_c, light_c, rng)
            tops.append((pos + w // 2, base - h - 6))
            pos += w + rng.randint(24, 44)
    for (xa, ya), (xb, yb) in zip(tops, tops[1:]):  # пучки проводов между верхушками
        if xb - xa < 110 and rng.random() < 0.85:
            cable(cv, xa, ya + 4, xb, yb + 4, rng.randint(8, 16), dark, edge_c)
    return cv


def make_skyline():
    cv = make_machines(71, 11, 0.85, C('cobalt', 0), C('cobalt', 1), C('cobalt', 2), wrap=True)
    for y in range(BH - 12, BH):  # пол корпуса: сплошная плита с фаской и заклёпками
        cv.rect(0, y, BW, 1, C('cobalt', 0))
    cv.rect(0, BH - 12, BW, 1, C('cobalt', 2))
    cv.rect(0, BH - 11, BW, 1, C('cobalt', 1))
    for x in range(6, BW, 16):
        cv.rect(x, BH - 7, 2, 2, C('cobalt', 1))
    for x in range(14, BW, 64):
        led(cv, x, BH - 7, True)
    return cv


def make_background():
    sky = make_sky()
    wall = make_vent_wall()
    fans = make_fans()
    haze_dark = gradient_layer(C('cobalt', 0), 36, BH - 1, 0, 150)
    haze_light = glow_layer(C('electric', 4), 108, 24, 100)
    machines = make_machines(53, 9, 1.0, C('cobalt', 0), C('cobalt', 1), C('cobalt', 2), wrap=False)
    fog = glow_layer(C('electric', 3), 124, 14, 110)
    skyline = make_skyline()
    return [sky, wall, fans, haze_dark, haze_light, machines, fog, skyline]


def composite(layers):
    out = Image.new('RGBA', (BW, BH), (0, 0, 0, 0))
    for im in layers:
        out.alpha_composite(im)
    return out


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
