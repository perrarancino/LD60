"""
Генератор арта второй локации — «внутренности блока питания компьютера»: тайлы (tilemap_loc2.png, 6 кадров 32x32 — плиты с разной текстурой, верхнего края нет) и
параллакс-фон (bg_loc2.png + 8 слоёв по 512x128). Стиль: общий синий (рампа cobalt палитры проекта) с золотым акцентом (рампа gold: медная обмотка, провода, светодиоды) и бирюзой (рампа electric) в свечении.
Плотность пикселя — как у арта первой локации: кадр тайла 32x32 и слой фона 512x128, без шума и дизеринга, детали от 2 пикселей.
Тайлы — металлические плиты с золотыми болтами по углам и золотой окантовкой; поверхность каждой плиты — своя текстура (шесть вариантов): рифлёный металл, пятнистая патина, царапины и вмятины, рифлёная «противоскользящая» сталь, ржавые подтёки от болтов, трещины.
Фон — колонны и балка корпуса, огромные вентиляторы в корпусах, электролитические конденсаторы, тороидальные катушки, трансформаторы, радиаторы,
пучки проводов, бирюзовое свечение и туман у горизонта.
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


def vnoise(w, h, cell, rng):
    """Гладкий value-шум 0..1 размером w x h (ячейки по cell пикселей, плавная интерполяция)."""
    gw, gh = w // cell + 3, h // cell + 3
    grid = np.array([[rng.random() for _ in range(gw)] for _ in range(gh)])
    out = np.zeros((h, w))
    for y in range(h):
        for x in range(w):
            fx, fy = x / cell, y / cell
            x0, y0 = int(fx), int(fy)
            tx, ty = fx - x0, fy - y0
            tx, ty = tx * tx * (3 - 2 * tx), ty * ty * (3 - 2 * ty)
            a = grid[y0][x0] * (1 - tx) + grid[y0][x0 + 1] * tx
            b = grid[y0 + 1][x0] * (1 - tx) + grid[y0 + 1][x0 + 1] * tx
            out[y, x] = a * (1 - ty) + b * ty
    return out


def quant(v, steps):
    """Значение 0..1 -> цвет по порогам (steps: список (порог, цвет), по возрастанию)."""
    col = steps[0][1]
    for th, c in steps:
        if v >= th:
            col = c
    return col


def bolt(cv, x, y):
    """Золотой болт 4x4: тело, блик сверху-слева, тень снизу-справа, шлиц."""
    for dy in range(4):
        for dx in range(4):
            if (dx in (0, 3)) and (dy in (0, 3)):
                continue
            cv.put(x + dx, y + dy, C('gold', 5))
    cv.put(x + 1, y, C('gold', 7))
    cv.put(x, y + 1, C('gold', 7))
    cv.put(x + 1, y + 1, C('gold', 6))
    cv.put(x + 3, y + 2, C('gold', 3))
    cv.put(x + 2, y + 3, C('gold', 3))
    cv.put(x + 1, y + 3, C('gold', 3))
    cv.put(x + 2, y + 2, C('gold', 1))  # шлиц


FACE = (3, 3, 29, 29)  # поверхность плиты внутри окантовки (x0, y0, x1, y1), не включая x1/y1


def face_pixels():
    x0, y0, x1, y1 = FACE
    return [(x, y) for y in range(y0, y1) for x in range(x0, x1)]


def tex_brushed(cv, rng):
    for x, y in face_pixels():
        cv.put(x, y, C('cobalt', 1))
    for _ in range(46):  # штрихи шлифовки
        y = rng.randint(3, 28)
        x0 = rng.randint(3, 24)
        n = rng.randint(5, 16)
        col = C('cobalt', 2) if rng.random() < 0.7 else C('cobalt', 0)
        for x in range(x0, min(29, x0 + n)):
            cv.put(x, y, col)
    for _ in range(7):  # светлые блики по штрихам
        y = rng.randint(4, 27)
        x0 = rng.randint(4, 20)
        for x in range(x0, x0 + rng.randint(4, 9)):
            cv.put(x, y, C('cobalt', 3))


def tex_patina(cv, rng):
    n = vnoise(32, 32, 8, rng) * 0.7 + vnoise(32, 32, 4, rng) * 0.3
    g = vnoise(32, 32, 6, rng)
    steps = [(0.0, C('cobalt', 0)), (0.36, C('cobalt', 1)), (0.58, C('cobalt', 2)), (0.74, C('cobalt', 3))]
    for x, y in face_pixels():
        col = quant(n[y, x], steps)
        if g[y, x] > 0.76:
            col = C('gold', 2) if g[y, x] < 0.84 else C('gold', 3)  # золотистая патина пятнами
        cv.put(x, y, col)


def tex_scratch(cv, rng):
    for x, y in face_pixels():
        cv.put(x, y, C('cobalt', 1))
    for _ in range(9):  # царапины: светлая линия с тёмным подбоем
        x0, y0 = rng.randint(4, 26), rng.randint(4, 26)
        ang = rng.uniform(-0.7, 0.7) + (math.pi / 2 if rng.random() < 0.3 else 0)
        ln = rng.randint(7, 14)
        for t in range(ln):
            xx, yy = x0 + math.cos(ang) * t, y0 + math.sin(ang) * t
            if 3 <= xx < 29 and 3 <= yy < 29:
                cv.put(xx, yy + 1, C('cobalt', 0))
                cv.put(xx, yy, C('cobalt', 3))
    for _ in range(3):  # вмятины
        cx, cy, r = rng.randint(7, 24), rng.randint(7, 24), rng.choice((2, 3))
        for yy in range(cy - r, cy + r + 1):
            for xx in range(cx - r, cx + r + 1):
                d = math.hypot(xx - cx, yy - cy)
                if d <= r:
                    cv.put(xx, yy, C('cobalt', 0) if (xx - cx) + (yy - cy) <= 0 else C('cobalt', 2))


def tex_tread(cv, rng):
    for x, y in face_pixels():
        cv.put(x, y, C('cobalt', 1))
    for j, y0 in enumerate(range(5, 27, 6)):  # рифлёная сталь: косые чёрточки, чередуются в шахматном порядке
        for i, x0 in enumerate(range(5, 27, 6)):
            if i in (0, 3) and j in (0, 3):
                continue  # у болтов — без рифления
            slash = (i + j) % 2 == 0
            for t in range(3):
                xx = x0 + 1 + t
                yy = y0 + 1 + (2 - t if slash else t)
                cv.put(xx, yy, C('cobalt', 4))
                cv.put(xx, yy + 1, C('cobalt', 0))


def tex_rust(cv, rng):
    n = vnoise(32, 32, 10, rng)
    steps = [(0.0, C('cobalt', 1)), (0.5, C('cobalt', 2))]
    for x, y in face_pixels():
        cv.put(x, y, quant(n[y, x], steps))
    for bx in (3, 25):  # подтёки от верхних болтов: вертикальные золотистые полосы с разрывами
        for k in range(2):
            x = bx + 1 + k * 2
            ln = rng.randint(10, 22)
            y = 7
            while y < 7 + ln and y < 29:
                seg = rng.randint(2, 5)
                for yy in range(y, min(29, y + seg)):
                    cv.put(x, yy, C('gold', 3) if k == 0 else C('gold', 2))
                y += seg + rng.randint(0, 2)
    g = vnoise(32, 32, 5, rng)
    for x, y in face_pixels():
        if g[y, x] > 0.78:
            cv.put(x, y, C('gold', 2))


def tex_cracks(cv, rng):
    n = vnoise(32, 32, 9, rng)
    steps = [(0.0, C('cobalt', 1)), (0.55, C('cobalt', 2))]
    for x, y in face_pixels():
        cv.put(x, y, quant(n[y, x], steps))
    for _ in range(2):  # трещины: ломаная, тёмная с золотым просветом
        x, y = rng.randint(6, 25), 3
        pts = []
        while y < 29:
            pts.append((x, y))
            y += 1
            x += rng.choice((-1, 0, 0, 1))
            x = max(4, min(27, x))
        for x, y in pts:
            cv.put(x, y, C('cobalt', 0))
            cv.put(x + 1, y, C('gold', 3))
        for k in range(len(pts) // 2, len(pts) // 2 + 6):  # ответвление
            x, y = pts[min(k, len(pts) - 1)]
            cv.put(x + (k - len(pts) // 2), y, C('cobalt', 0))


TEXTURES = [tex_brushed, tex_patina, tex_scratch, tex_tread, tex_rust, tex_cracks]


def plate_tile(v):
    """Плита: тёмный шов по краю, светлая фаска сверху-слева, текстурная поверхность, золотая окантовка и болты по углам."""
    import random
    rng = random.Random(7000 + v * 131)
    cv = Canvas(TS, TS)
    for y in range(TS):
        for x in range(TS):
            cv.put(x, y, C('cobalt', 0))  # шов
    for i in range(1, TS - 1):  # фаска: светлая сверху-слева, тёмная снизу-справа
        cv.put(i, 1, C('cobalt', 4))
        cv.put(1, i, C('cobalt', 3))
        cv.put(i, TS - 2, C('cobalt', 1))
        cv.put(TS - 2, i, C('cobalt', 1))
    cv.put(1, 1, C('cobalt', 5))
    TEXTURES[v](cv, rng)
    for k in range(7, 25):  # золотая окантовка поверхности между болтами (внутри фаски)
        for pos in (2, TS - 3):
            cv.put(k, pos, C('gold', 4))
            cv.put(pos, k, C('gold', 4))
    for bx, by in ((3, 3), (TS - 7, 3), (3, TS - 7), (TS - 7, TS - 7)):
        bolt(cv, bx, by)
    return cv


def make_tiles():
    sheet = Image.new('RGBA', (TS * len(TEXTURES), TS), (0, 0, 0, 0))
    for v in range(len(TEXTURES)):
        sheet.paste(plate_tile(v).image(), (v * TS, 0))
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


def make_columns():
    """Далёкие колонны и балка корпуса (шаг 128 делит 512): простые широкие формы, мягкая подсветка бирюзой у основания."""
    cv = Canvas(BW, BH, wrap=True)
    cv.rect(0, 24, BW, 8, C('cobalt', 1))  # балка
    cv.rect(0, 24, BW, 1, C('cobalt', 2))
    cv.rect(0, 31, BW, 1, C('cobalt', 0))
    for x0 in range(0, BW, 128):
        x = x0 + 57
        cv.rect(x, 0, 14, BH, C('cobalt', 1))
        cv.rect(x, 0, 2, BH, C('cobalt', 2))
        cv.rect(x + 12, 0, 2, BH, C('cobalt', 0))
        for y in range(10, BH - 14, 18):
            cv.rect(x + 5, y, 4, 2, C('cobalt', 2))
        cv.rect(x + 5, 52, 4, 4, C('gold', 5))  # метка на колонне
        cv.rect(x - 4, 24, 22, 8, C('cobalt', 1))  # узел крепления балки
        cv.rect(x - 4, 24, 22, 1, C('cobalt', 2))
        cv.rect(x - 4, 31, 22, 1, C('cobalt', 0))
    return cv


def fan(cv, cx, cy, R, seed):
    """Вентилятор в квадратном корпусе: рама с отверстиями под винты, обод, семь изогнутых лопастей, втулка со светодиодом.
    Рисуется с 4-кратной передискретизацией и сжимается — края гладкие, без «лесенки» лопастей."""
    S = 4
    side = 2 * R + 10
    n = side * S
    ys, xs = np.mgrid[0:n, 0:n]
    x = (xs + 0.5) / S - side / 2
    y = (ys + 0.5) / S - side / 2
    r = np.hypot(x, y)
    th = np.arctan2(y, x)
    half = side / 2
    k = 6  # скругление рамы
    qx = np.maximum(np.abs(x) - (half - k), 0)
    qy = np.maximum(np.abs(y) - (half - k), 0)
    frame = np.hypot(qx, qy) <= k
    opening = r <= R
    rim = (r <= R) & (r > R - 2.2)
    step = 2 * math.pi / 7
    sweep = (th - r * 0.055) % step
    blades = (r > R * 0.26) & (r <= R - 2.2) & (sweep < step * (0.5 + 0.12 * (r / R)))
    lead = blades & (sweep < step * 0.16)
    hub = r <= R * 0.26
    hub_ring = hub & (r > R * 0.2)
    led = (np.abs(x) <= 1) & (np.abs(y) <= 1)
    screws = np.zeros_like(frame)
    for sx in (-1, 1):
        for sy in (-1, 1):
            screws |= np.hypot(x - sx * (half - 4.5), y - sy * (half - 4.5)) <= 1.6

    def cov(m):
        return m.reshape(side, S, side, S).mean(axis=(1, 3)) > 0.5

    layers = [
        (cov(frame), C('cobalt', 1)),
        (cov(opening), C('cobalt', 0)),
        (cov(blades), C('cobalt', 2)),
        (cov(lead), C('cobalt', 3)),
        (cov(rim), C('cobalt', 3)),
        (cov(hub), C('cobalt', 1)),
        (cov(hub_ring), C('cobalt', 3)),
        (cov(led), C('gold', 5)),
    ]
    fm = layers[0][0]
    ox, oy = int(cx - side // 2), int(cy - side // 2)
    for m, col in layers:
        for yy, xx in zip(*np.nonzero(m)):
            cv.put(ox + xx, oy + yy, col)
    for yy, xx in zip(*np.nonzero(fm)):  # светлая кромка рамы сверху-слева, тёмная снизу-справа
        up = yy == 0 or not fm[yy - 1, xx]
        lf = xx == 0 or not fm[yy, xx - 1]
        dn = yy == side - 1 or not fm[yy + 1, xx]
        rt = xx == side - 1 or not fm[yy, xx + 1]
        if not opening_at(opening, S, yy, xx, side):
            if up or lf:
                cv.put(ox + xx, oy + yy, C('cobalt', 2))
            elif dn or rt:
                cv.put(ox + xx, oy + yy, C('cobalt', 0))
    for yy, xx in zip(*np.nonzero(cov(screws))):
        cv.put(ox + xx, oy + yy, C('cobalt', 0))


def opening_at(opening, S, yy, xx, side):
    return opening[yy * S + S // 2, xx * S + S // 2]


def make_fans():
    cv = Canvas(BW, BH, wrap=True)
    for cx, cy, R in ((70, 52, 34), (255, 46, 28), (430, 54, 38)):
        fan(cv, cx, cy, R, cx)
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
    cv.rect(x, y, 2, 2, C('gold', 6) if bright else C('gold', 5))


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
    cv.rect(x + w - 4, top + 8, 2, 4, C('gold', 5))  # полоса полярности
    cv.rect(x, top + 6, w, 1, C('gold', 3))  # золотое кольцо обжима
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
            cv.put(x + math.cos(a) * rr, cy + math.sin(a) * rr, C('gold', 3))  # медная обмотка
            cv.put(x + math.cos(a + 0.12) * rr, cy + math.sin(a + 0.12) * rr, C('gold', 2))
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
        cv.rect(x + 4, yy, w - 8, 2, C('gold', 2))  # медная обмотка
    cv.rect(x + w // 2 - 1, top + 4, 2, h - 8, body)
    cv.rect(x + 3, base - 4, w - 6, 2, C('gold', 3))
    led(cv, x + w - 6, top + 4, True)


def heatsink(cv, x, base, w, h, body, edge, light, rng):
    """Радиатор: основание и гребёнка рёбер; между рёбрами внизу светится бирюза."""
    cv.rect(x, base - 6, w, 6, body)
    cv.rect(x, base - 6, w, 1, light)
    for k, xx in enumerate(range(x + 1, x + w - 2, 5)):
        fh = h - (k % 2) * 4
        cv.rect(xx, base - 6 - fh, 3, fh, body)
        cv.rect(xx, base - 6 - fh, 1, fh, edge)
        cv.rect(xx + 3, base - 12, 2, 6, C('gold', 2))  # тёплое свечение между рёбрами


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
            cable(cv, xa, ya + 4, xb, yb + 4, rng.randint(8, 16), dark, C('gold', 2) if rng.random() < 0.5 else edge_c)  # часть проводов — с медным бликом
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
    wall = make_columns()
    fans = make_fans()
    haze_dark = gradient_layer(C('cobalt', 0), 36, BH - 1, 0, 150)
    haze_light = glow_layer(C('electric', 4), 108, 24, 100)
    machines = make_machines(53, 9, 1.0, C('cobalt', 0), C('cobalt', 1), C('cobalt', 2), wrap=False)
    fog = glow_layer(C('gold', 2), 126, 12, 120)  # тёплая дымка у пола
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
