"""
Запись .aseprite из слоёв-картинок без установленного Aseprite (обратное к tools/aseprite2png): холст W x H, один кадр, режим RGBA (32 бита), на каждый слой — своя
клетка (cel) по ограничивающему прямоугольнику непрозрачных пикселей, сжатая zlib. Слои идут снизу вверх в порядке списка. Файл открывается в Aseprite как обычный
(слои с именами, видимые, непрозрачность 255) и читается tools/aseprite2png.

Использование как модуль:
    from png2aseprite import write_aseprite
    write_aseprite("out.aseprite", 128, 128, [("Body", img_rgba), ("Head", img_rgba2)])
"""
from __future__ import annotations

import struct
import zlib
from pathlib import Path

from PIL import Image


def _chunk(ctype: int, data: bytes) -> bytes:
    return struct.pack("<IH", len(data) + 6, ctype) + data


def _string(s: str) -> bytes:
    b = s.encode("utf-8")
    return struct.pack("<H", len(b)) + b


def write_aseprite(path: str | Path, width: int, height: int, layers: list[tuple[str, Image.Image]], duration_ms: int = 100) -> None:
    chunks: list[bytes] = []
    for name, _ in layers:
        # флаги 3 = видимый + редактируемый, тип 0 = обычный слой, уровень вложенности 0, режим наложения 0 (normal), непрозрачность 255
        chunks.append(_chunk(0x2004, struct.pack("<HHHHHHB3x", 3, 0, 0, 0, 0, 0, 255) + _string(name)))
    for index, (_, img) in enumerate(layers):
        img = img.convert("RGBA")
        if img.size != (width, height):
            canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
            canvas.paste(img, (0, 0))
            img = canvas
        bbox = img.getchannel("A").getbbox()
        if bbox is None:
            continue  # пустой слой: слой есть, клетки нет
        x0, y0, x1, y1 = bbox
        crop = img.crop(bbox)
        header = struct.pack("<HhhBHh5x", index, x0, y0, 255, 2, 0) + struct.pack("<HH", x1 - x0, y1 - y0)
        chunks.append(_chunk(0x2005, header + zlib.compress(crop.tobytes(), 9)))
    body = b"".join(chunks)
    frame = struct.pack("<IHHH2xI", 16 + len(body), 0xF1FA, min(len(chunks), 0xFFFF), duration_ms, len(chunks)) + body
    # заголовок файла: 128 байт
    header = struct.pack(
        "<IHHHHHIHIIB3xHBBhhHH84x",
        128 + len(frame), 0xA5E0, 1, width, height, 32, 1, duration_ms, 0, 0, 0, 0, 1, 1, 0, 0, 16, 16
    )
    assert len(header) == 128
    Path(path).write_bytes(header + frame)
