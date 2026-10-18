#!/usr/bin/env python3
"""Режет одиночный слой существа на тело и конечности (лапки) — для процедурной анимации без перерисовки.

Лапки находятся по цветам (пиксели заданных цветов, 8-связные компоненты). Каждая лапка делится пополам на две части
(внутреннюю и внешнюю), чтобы она сгибалась в «колене». Все части сохраняются полнохолстными PNG (как слои из aseprite2png),
рядом пишется JSON с точками: корень лапки, колено (середина), кончик.

Использование:
    python split_limbs.py слой.png -o ПАПКА --colors "#56f436,#b9ff97,#22d04c" [--static-box x0,y0,x1,y1 ...]
        [--prefix имя] [--min-limb 12] [--stub 3]

--static-box   прямоугольник (включительно): пиксели лапкового цвета внутри остаются в теле (гребень, рога)
--min-limb     компоненты меньше этого размера считаются осколками и приклеиваются к ближайшей лапке
--stub         сколько px от корня лапки остаётся и в теле (закрывает стык при повороте лапки)
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
    ap.add_argument("--stub", type=float, default=3.0)
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
    body = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    bpx = body.load()
    for p in body_pts:
        bpx[p] = px[p]

    meta = {"canvas": {"width": w, "height": h}, "center": {"x": round(cx, 2), "y": round(cy, 2)}, "limbs": []}
    for k, c in enumerate(big, start=1):
        root = min(c, key=lambda p: math.hypot(p[0] + 0.5 - cx, p[1] + 0.5 - cy))
        rx, ry = root[0] + 0.5, root[1] + 0.5
        dist = {p: math.hypot(p[0] + 0.5 - rx, p[1] + 0.5 - ry) for p in c}
        tip = max(c, key=lambda p: dist[p])
        maxd = dist[tip]
        # корневой «пенёк» остаётся и в теле: закрывает стык при повороте
        for p in c:
            if dist[p] <= args.stub:
                bpx[p] = px[p]
        # колено — на середине длины лапки (по расстоянию от корня)
        mid_d = maxd * 0.5
        band = [p for p in c if abs(dist[p] - mid_d) <= 1.0]
        mx = sum(p[0] for p in band) / len(band) + 0.5 if band else rx
        my = sum(p[1] for p in band) / len(band) + 0.5 if band else ry
        inner = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        outer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        ipx, opx = inner.load(), outer.load()
        for p in c:
            if dist[p] < mid_d:
                ipx[p] = px[p]
            else:
                opx[p] = px[p]
            if mid_d - 2 <= dist[p] < mid_d:  # нахлёст внешней части на внутреннюю: шов не раскрывается при изгибе
                opx[p] = px[p]
        name = f"{args.prefix}{k}"
        inner.save(out / f"{name}_a.png")
        outer.save(out / f"{name}_b.png")
        meta["limbs"].append({
            "name": name,
            "root": {"x": rx, "y": ry},
            "knee": {"x": round(mx, 2), "y": round(my, 2)},
            "tip": {"x": tip[0] + 0.5, "y": tip[1] + 0.5},
            "pixels": len(c)
        })

    body.save(out / "body.png")
    (out / "parts.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{args.layer} -> {out}  (тело + {len(big)} лапок)")


if __name__ == "__main__":
    main()
