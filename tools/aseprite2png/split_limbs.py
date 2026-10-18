#!/usr/bin/env python3
"""Режет одиночный слой существа на конечности (лапки) — для процедурной анимации без перерисовки.

Лапки находятся по цветам (пиксели заданных цветов, 8-связные компоненты). Каждая лапка сохраняется целиком отдельным
полнохолстным PNG-маской (в игре тело и лапки — одна общая сетка, маски нужны, чтобы знать, какие пиксели чьи) (как слои из aseprite2png); рядом пишется JSON с точками: корень лапки и кончик. Сгибается лапка в игре:
FlexLimb режет её на сегменты вдоль оси корень -> кончик и ведёт цепочкой костей.

Использование:
    python split_limbs.py слой.png -o ПАПКА --colors "#56f436,#b9ff97,#22d04c" [--static-box x0,y0,x1,y1 ...]
        [--prefix имя] [--min-limb 12]

--static-box   прямоугольник (включительно): пиксели лапкового цвета внутри остаются в теле (гребень, рога)
--min-limb     компоненты меньше этого размера считаются осколками и приклеиваются к ближайшей лапке
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from PIL import Image


def hex_rgb(s: str) -> tuple[int, int, int]:
    s = s.lstrip("#")
    return int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("layer")
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--colors", required=True)
    ap.add_argument("--static-box", action="append", default=[])
    ap.add_argument("--prefix", default="limb")
    ap.add_argument("--min-limb", type=int, default=12)
    args = ap.parse_args()

    im = Image.open(args.layer).convert("RGBA")
    w, h = im.size
    px = im.load()
    colors = {hex_rgb(c) for c in args.colors.split(",")}
    boxes = [tuple(int(v) for v in b.split(",")) for b in args.static_box]

    def static(x: int, y: int) -> bool:
        return any(b[0] <= x <= b[2] and b[1] <= y <= b[3] for b in boxes)

    limb = {(x, y) for y in range(h) for x in range(w)
            if px[x, y][3] > 0 and px[x, y][:3] in colors and not static(x, y)}

    # 8-связные компоненты
    seen: set[tuple[int, int]] = set()
    comps: list[list[tuple[int, int]]] = []
    for start in sorted(limb):
        if start in seen:
            continue
        seen.add(start)
        stack, pts = [start], []
        while stack:
            cx, cy = stack.pop()
            pts.append((cx, cy))
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    n = (cx + dx, cy + dy)
                    if n in limb and n not in seen:
                        seen.add(n)
                        stack.append(n)
        comps.append(pts)

    big = [c for c in comps if len(c) >= args.min_limb]
    for c in comps:  # осколки — к ближайшей лапке
        if len(c) >= args.min_limb:
            continue
        best, best_d = None, 1e9
        for b in big:
            d = min(math.hypot(p[0] - q[0], p[1] - q[1]) for p in c for q in b)
            if d < best_d:
                best, best_d = b, d
        if best is not None:
            best.extend(c)

    body_pts = [(x, y) for y in range(h) for x in range(w) if px[x, y][3] > 0 and (x, y) not in limb]
    cx = sum(p[0] for p in body_pts) / len(body_pts) + 0.5
    cy = sum(p[1] for p in body_pts) / len(body_pts) + 0.5

    # порядок лапок: по углу вокруг центра, от верхней левой по часовой
    def angle(c: list[tuple[int, int]]) -> float:
        mx = sum(p[0] for p in c) / len(c) + 0.5 - cx
        my = sum(p[1] for p in c) / len(c) + 0.5 - cy
        return (math.atan2(my, mx) + math.pi * 1.25) % (math.pi * 2)

    big.sort(key=angle)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    meta = {"canvas": {"width": w, "height": h}, "center": {"x": round(cx, 2), "y": round(cy, 2)}, "limbs": []}
    for k, c in enumerate(big, start=1):
        root = min(c, key=lambda p: math.hypot(p[0] + 0.5 - cx, p[1] + 0.5 - cy))
        rx, ry = root[0] + 0.5, root[1] + 0.5
        dist = {p: math.hypot(p[0] + 0.5 - rx, p[1] + 0.5 - ry) for p in c}
        tip = max(c, key=lambda p: dist[p])
        maxd = dist[tip]
        limb_img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        lpx = limb_img.load()
        for p in c:
            lpx[p] = px[p]
        name = f"{args.prefix}{k}"
        limb_img.save(out / f"{name}.png")
        meta["limbs"].append({
            "name": name,
            "root": {"x": rx, "y": ry},
            "tip": {"x": tip[0] + 0.5, "y": tip[1] + 0.5},
            "pixels": len(c)
        })

    (out / "parts.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{args.layer} -> {out}  ({len(big)} лапок)")


if __name__ == "__main__":
    main()
