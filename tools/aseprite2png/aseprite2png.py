#!/usr/bin/env python3
"""Конвертер .aseprite -> .png без установленного Aseprite.

Статичный файл (1 кадр)  -> обычный PNG.
Анимация (>1 кадра)      -> PNG-лист из тайлов (кадры одного размера) + JSON с метаданными.

Использование:
    python aseprite2png.py файл.aseprite [папка/ или ещё файлы ...] [-o OUT] [--columns N] [-r] [--layers]
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
import zlib
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image, ImageChops

DEFAULT_OUT = Path(__file__).resolve().parents[2] / "assets" / "sprites"

# chunk types
C_OLD_PAL_A, C_OLD_PAL_B = 0x0004, 0x0011
C_LAYER, C_CEL, C_TAGS, C_PALETTE = 0x2004, 0x2005, 0x2018, 0x2019

# layer flags
L_VISIBLE, L_BACKGROUND = 1, 8
LAYER_TILEMAP, LAYER_GROUP = 2, 1

TAG_DIRECTIONS = ("forward", "reverse", "pingpong", "pingpong_reverse")


@dataclass
class Layer:
    flags: int
    kind: int
    level: int
    blend: int
    opacity: int
    name: str
    parent: int | None = None


@dataclass
class Cel:
    layer: int
    x: int
    y: int
    opacity: int
    z: int
    image: Image.Image | None = None  # None для linked cel до разрешения
    link: int | None = None


@dataclass
class Frame:
    duration: int
    cels: dict[int, Cel] = field(default_factory=dict)


@dataclass
class Sprite:
    width: int
    height: int
    depth: int
    transparent_index: int
    palette: list[tuple[int, int, int, int]]
    layers: list[Layer]
    frames: list[Frame]
    tags: list[dict]


class Reader:
    def __init__(self, data: bytes):
        self.d = data
        self.p = 0

    def unpack(self, fmt: str):
        fmt = "<" + fmt
        size = struct.calcsize(fmt)
        v = struct.unpack_from(fmt, self.d, self.p)
        self.p += size
        return v if len(v) > 1 else v[0]

    def skip(self, n: int):
        self.p += n

    def string(self) -> str:
        n = self.unpack("H")
        s = self.d[self.p:self.p + n].decode("utf-8", "replace")
        self.p += n
        return s

    def rest(self, end: int) -> bytes:
        return self.d[self.p:end]


def parse(path: Path) -> Sprite:
    data = path.read_bytes()
    r = Reader(data)
    _size, magic, n_frames, width, height, depth, _flags, _speed = r.unpack("IHHHHHIH")
    if magic != 0xA5E0:
        raise ValueError("не .aseprite файл (неверная сигнатура)")
    r.skip(8)
    transparent_index = r.unpack("B")
    r.p = 128

    palette: list[tuple[int, int, int, int]] = [(0, 0, 0, 255)] * 256
    new_palette_seen = False
    layers: list[Layer] = []
    frames: list[Frame] = []
    tags: list[dict] = []

    for _ in range(n_frames):
        frame_start = r.p
        frame_bytes, fmagic, old_chunks, duration = r.unpack("IHHH")
        if fmagic != 0xF1FA:
            raise ValueError("битый заголовок кадра")
        r.skip(2)
        new_chunks = r.unpack("I")
        n_chunks = new_chunks if new_chunks else old_chunks
        frame = Frame(duration)
        frames.append(frame)

        for _c in range(n_chunks):
            chunk_start = r.p
            chunk_size, ctype = r.unpack("IH")
            chunk_end = chunk_start + chunk_size

            if ctype == C_LAYER:
                flags, kind, level, _dw, _dh, blend, opacity = r.unpack("HHHHHHB")
                r.skip(3)
                name = r.string()
                layer = Layer(flags, kind, level, blend, opacity, name)
                # родитель — ближайший предыдущий слой с меньшим уровнем
                for i in range(len(layers) - 1, -1, -1):
                    if layers[i].level < level:
                        layer.parent = i
                        break
                layers.append(layer)

            elif ctype == C_CEL:
                layer_idx, x, y, opacity, ctype2, z = r.unpack("HhhBHh")
                r.skip(5)
                cel = Cel(layer_idx, x, y, opacity, z)
                if ctype2 == 1:
                    cel.link = r.unpack("H")
                elif ctype2 in (0, 2):
                    w, h = r.unpack("HH")
                    raw = r.rest(chunk_end)
                    if ctype2 == 2:
                        raw = zlib.decompress(raw)
                    cel.image = pixels_to_image(raw, w, h, depth, palette, transparent_index,
                                                layers[layer_idx].flags & L_BACKGROUND)
                else:
                    print(f"  ! {path.name}: tilemap-слой '{layers[layer_idx].name}' пропущен",
                          file=sys.stderr)
                    r.p = chunk_end
                    continue
                frame.cels[layer_idx] = cel

            elif ctype == C_PALETTE:
                _n, first, last = r.unpack("III")
                r.skip(8)
                for i in range(first, last + 1):
                    eflags = r.unpack("H")
                    pr, pg, pb, pa = r.unpack("BBBB")
                    if eflags & 1:
                        r.string()
                    palette[i] = (pr, pg, pb, pa)
                new_palette_seen = True

            elif ctype in (C_OLD_PAL_A, C_OLD_PAL_B) and not new_palette_seen:
                n_packets = r.unpack("H")
                idx = 0
                for _p in range(n_packets):
                    skip, n = r.unpack("BB")
                    idx += skip
                    for _k in range(n or 256):
                        pr, pg, pb = r.unpack("BBB")
                        if ctype == C_OLD_PAL_B:  # 0..63 -> 0..255
                            pr, pg, pb = (pr << 2) | (pr >> 4), (pg << 2) | (pg >> 4), (pb << 2) | (pb >> 4)
                        palette[idx] = (pr, pg, pb, 255)
                        idx += 1

            elif ctype == C_TAGS:
                n_tags = r.unpack("H")
                r.skip(8)
                for _t in range(n_tags):
                    t_from, t_to, direction, repeat = r.unpack("HHBH")
                    r.skip(6 + 3 + 1)
                    tags.append({
                        "name": r.string(),
                        "from": t_from,
                        "to": t_to,
                        "direction": TAG_DIRECTIONS[direction] if direction < 4 else "forward",
                        "repeat": repeat,
                    })

            r.p = chunk_end
        r.p = frame_start + frame_bytes

    # разрешаем linked cels
    for fi, frame in enumerate(frames):
        for li, cel in frame.cels.items():
            if cel.link is not None:
                src = frames[cel.link].cels.get(li)
                cel.image = src.image if src else None

    return Sprite(width, height, depth, transparent_index, palette, layers, frames, tags)


def pixels_to_image(raw: bytes, w: int, h: int, depth: int, palette, transparent_index: int,
                    is_background: int) -> Image.Image:
    if depth == 32:
        return Image.frombytes("RGBA", (w, h), raw)
    if depth == 16:  # grayscale + alpha
        return Image.frombytes("LA", (w, h), raw).convert("RGBA")
    if depth == 8:  # indexed
        pal = list(palette)
        out = bytearray()
        for idx in raw:
            pr, pg, pb, pa = pal[idx]
            if idx == transparent_index and not is_background:
                pa = 0
            out += bytes((pr, pg, pb, pa))
        return Image.frombytes("RGBA", (w, h), bytes(out))
    raise ValueError(f"неизвестная глубина цвета: {depth}")


def layer_visible(sprite: Sprite, idx: int) -> bool:
    while idx is not None:
        if not sprite.layers[idx].flags & L_VISIBLE:
            return False
        idx = sprite.layers[idx].parent
    return True


def layer_opacity(sprite: Sprite, idx: int) -> float:
    return sprite.layers[idx].opacity / 255


# режимы наложения Aseprite: 0 normal, 1 multiply, 2 screen, 3 overlay, 4 darken, 5 lighten,
# 16 addition, 17 subtract; остальные откатываем в normal
BLENDERS = {
    1: ImageChops.multiply,
    2: ImageChops.screen,
    4: ImageChops.darker,
    5: ImageChops.lighter,
    16: ImageChops.add,
    17: ImageChops.subtract,
}


def render_frame(sprite: Sprite, fi: int, warned: set, only_layer: int | None = None) -> Image.Image:
    """Композит кадра. only_layer — рисовать только этот слой (на полном холсте, видимость слоя игнорируется)."""
    canvas = Image.new("RGBA", (sprite.width, sprite.height), (0, 0, 0, 0))
    cels = sorted(sprite.frames[fi].cels.values(), key=lambda c: (c.layer + c.z, c.z))
    for cel in cels:
        if only_layer is not None:
            if cel.layer != only_layer or cel.image is None:
                continue
        elif cel.image is None or not layer_visible(sprite, cel.layer):
            continue
        layer = sprite.layers[cel.layer]
        if layer.kind == LAYER_GROUP:
            continue
        opacity = cel.opacity / 255
        li = cel.layer
        while li is not None:  # прозрачность слоя и всех его групп
            opacity *= layer_opacity(sprite, li)
            li = sprite.layers[li].parent
        img = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
        img.paste(cel.image, (cel.x, cel.y))
        if opacity < 1:
            a = img.getchannel("A").point(lambda v: round(v * opacity))
            img.putalpha(a)

        blender = BLENDERS.get(layer.blend)
        if layer.blend and blender is None and layer.blend not in warned:
            warned.add(layer.blend)
            print(f"  ! режим наложения {layer.blend} не поддержан, использую normal", file=sys.stderr)
        if blender:
            mixed = blender(canvas.convert("RGB"), img.convert("RGB"))
            rgb = Image.composite(mixed, canvas.convert("RGB"), img.getchannel("A"))
            alpha = ImageChops.lighter(canvas.getchannel("A"), img.getchannel("A"))
            rgb.putalpha(alpha)
            canvas = rgb
        else:
            canvas = Image.alpha_composite(canvas, img)
    return canvas


def safe_name(name: str) -> str:
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in name) or "layer"


def sheet_of(frames: list[Image.Image], columns: int | None) -> tuple[Image.Image, int, int]:
    """Склеивает кадры в лист из тайлов: возвращает (картинка, колонок, строк)."""
    w, h = frames[0].size
    cols = min(columns, len(frames)) if columns else len(frames)
    rows = -(-len(frames) // cols)
    sheet = Image.new("RGBA", (cols * w, rows * h), (0, 0, 0, 0))
    for i, fr in enumerate(frames):
        sheet.paste(fr, ((i % cols) * w, (i // cols) * h))
    return sheet, cols, rows


def convert_layers(path: Path, out_dir: Path, columns: int | None) -> None:
    """Каждый слой — отдельный PNG на полном холсте (положение в спрайте сохраняется: части кладутся в (0,0)).

    Результат: <out>/<имя>_layers/<слой>.png (+ <имя>.layers.json: порядок слоёв снизу вверх и bbox каждого).
    """
    sprite = parse(path)
    warned: set = set()
    layers_dir = out_dir / f"{path.stem}_layers"
    layers_dir.mkdir(parents=True, exist_ok=True)
    meta_layers = []
    used: set[str] = set()
    for li, layer in enumerate(sprite.layers):
        if layer.kind == LAYER_GROUP or not any(li in fr.cels for fr in sprite.frames):
            continue
        frames = [render_frame(sprite, fi, warned, only_layer=li) for fi in range(len(sprite.frames))]
        name = safe_name(layer.name)
        while name in used:
            name += "_"
        used.add(name)
        sheet, _, _ = sheet_of(frames, columns)
        sheet.save(layers_dir / f"{name}.png")
        boxes = [b for b in (f.getbbox() for f in frames) if b]
        bbox = None if not boxes else [min(b[0] for b in boxes), min(b[1] for b in boxes),
                                       max(b[2] for b in boxes), max(b[3] for b in boxes)]
        meta_layers.append({"name": layer.name, "file": f"{layers_dir.name}/{name}.png",
                            "z": len(meta_layers), "visible": bool(layer.flags & L_VISIBLE), "bbox": bbox})
    meta = {
        "source": path.name,
        "canvasWidth": sprite.width,
        "canvasHeight": sprite.height,
        "frames": len(sprite.frames),
        "columns": min(columns, len(sprite.frames)) if columns else len(sprite.frames),
        "layers": meta_layers,  # порядок снизу вверх (как в Aseprite)
    }
    (out_dir / f"{path.stem}.layers.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{path.name} -> {layers_dir.name}/  ({len(meta_layers)} слоёв: "
          f"{', '.join(m['name'] for m in meta_layers)})")


def convert(path: Path, out_dir: Path, columns: int | None, write_json: bool) -> None:
    sprite = parse(path)
    warned: set = set()
    frames = [render_frame(sprite, i, warned) for i in range(len(sprite.frames))]
    n = len(frames)
    out_dir.mkdir(parents=True, exist_ok=True)
    png_path = out_dir / (path.stem + ".png")

    if n == 1:
        frames[0].save(png_path)
        print(f"{path.name} -> {png_path.name}  ({sprite.width}x{sprite.height}, статика)")
        return

    sheet, cols, rows = sheet_of(frames, columns)
    sheet.save(png_path)

    if write_json:
        meta = {
            "image": png_path.name,
            "frameWidth": sprite.width,
            "frameHeight": sprite.height,
            "frames": n,
            "columns": cols,
            "rows": rows,
            "durations": [f.duration for f in sprite.frames],
            "tags": sprite.tags,
        }
        (out_dir / (path.stem + ".json")).write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{path.name} -> {png_path.name}  (лист {cols}x{rows} тайлов по "
          f"{sprite.width}x{sprite.height}, {n} кадров)")


def main() -> int:
    for stream in (sys.stdout, sys.stderr):  # корректная кириллица в консоли Windows
        stream.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="+", type=Path, help=".aseprite файлы или папки")
    ap.add_argument("-o", "--out", type=Path, default=DEFAULT_OUT,
                    help=f"папка вывода (по умолчанию {DEFAULT_OUT})")
    ap.add_argument("-c", "--columns", type=int, default=None,
                    help="колонок в листе анимации (по умолчанию — все кадры в одну строку)")
    ap.add_argument("--no-json", action="store_true", help="не писать JSON для анимаций")
    ap.add_argument("-l", "--layers", action="store_true",
                    help="дополнительно экспортировать каждый слой отдельным PNG (для процедурной анимации частей)")
    ap.add_argument("-r", "--recursive", action="store_true",
                    help="для папок: обходить подпапки и повторять их структуру в папке вывода")
    args = ap.parse_args()

    jobs: list[tuple[Path, Path]] = []  # (исходник, папка вывода)
    for p in args.inputs:
        if not p.is_dir():
            jobs.append((p, args.out))
        elif args.recursive:
            jobs += [(f, args.out / f.parent.relative_to(p)) for f in sorted(p.rglob("*.aseprite"))]
        else:
            jobs += [(f, args.out) for f in sorted(p.glob("*.aseprite"))]

    failed = 0
    for f, out_dir in jobs:
        try:
            convert(f, out_dir, args.columns, not args.no_json)
            if args.layers:
                convert_layers(f, out_dir, args.columns)
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"{f.name}: ОШИБКА — {e}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
