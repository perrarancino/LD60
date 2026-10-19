#!/usr/bin/env python3
"""Уменьшение пиксель-арта в целое число раз без новых цветов (палитра рисунка сохраняется).

Каждый блок factor x factor исходных пикселей даёт один пиксель: цвет — самый частый среди непрозрачных, при равенстве — самый тёмный (контур не пропадает);
блок прозрачен, если непрозрачных пикселей в нём меньше половины (одиночный тёмный пиксель блока сохраняется — тонкие линии вроде антенн не рвутся).

    python tools/downscale_pixelart.py вход.png выход.png [factor=2]
    python tools/downscale_pixelart.py папка_слоёв/ папка_выхода/ [factor=2]

Так сделаны слои босса-краба (krab.aseprite нарисован на холсте 400x300, в игре он вдвое меньше: плотность пикселя как у героя).
"""
from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

from PIL import Image


def downscale(img: Image.Image, factor: int = 2) -> Image.Image:
    src = img.convert("RGBA")
    w, h = src.size
    ow, oh = (w + factor - 1) // factor, (h + factor - 1) // factor
    px = src.load()
    out = Image.new("RGBA", (ow, oh), (0, 0, 0, 0))
    op = out.load()
    for y in range(oh):
        for x in range(ow):
            cols = []
            for dy in range(factor):
                for dx in range(factor):
                    sx, sy = x * factor + dx, y * factor + dy
                    if sx < w and sy < h and px[sx, sy][3] > 0:
                        cols.append(px[sx, sy])
            total = factor * factor
            if not cols:
                continue
            darkest = min(cols, key=lambda c: c[0] + c[1] + c[2])
            if len(cols) * 2 < total:
                # почти пустой блок: сохраняем только одиночный очень тёмный пиксель (контур)
                if sum(darkest[:3]) < 90:
                    op[x, y] = darkest
                continue
            count = Counter(cols)
            best = max(count.items(), key=lambda kv: (kv[1], -sum(kv[0][:3])))[0]
            op[x, y] = best
    return out


def main() -> None:
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    factor = int(sys.argv[3]) if len(sys.argv) > 3 else 2
    if src.is_dir():
        dst.mkdir(parents=True, exist_ok=True)
        for f in sorted(src.glob("*.png")):
            downscale(Image.open(f), factor).save(dst / f.name)
            print(f.name)
    else:
        dst.parent.mkdir(parents=True, exist_ok=True)
        downscale(Image.open(src), factor).save(dst)


if __name__ == "__main__":
    main()
