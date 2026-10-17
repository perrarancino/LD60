#!/usr/bin/env python3
"""Проверка целостности ссылок между data/ и assets/ (спрайты, тайлы, враги, уровни).

    python tools/validate_data.py        # код возврата 1, если найдены ошибки
"""
import json
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
DATA, SPRITES = ROOT / "data", ROOT / "assets" / "sprites"


def load(rel: str):
    return json.loads((DATA / rel).read_text(encoding="utf-8"))


errors: list[str] = []


def check(cond: bool, msg: str) -> None:
    if not cond:
        errors.append(msg)


sprites = {s["id"]: s for s in load("sprites/sprites.json")["sprites"]}
for sid, s in sprites.items():
    png = SPRITES / s["image"]
    check(png.parent.name == s["category"], f"{sid}: категория {s['category']} не совпадает с папкой {png.parent.name}")
    if not png.exists():
        errors.append(f"{sid}: нет файла {png}")
        continue
    cols = s.get("columns", s["frames"])
    rows = -(-s["frames"] // cols)
    expected = (cols * s["frame_width"], rows * s["frame_height"])
    check(Image.open(png).size == expected, f"{sid}: размер PNG {Image.open(png).size}, ожидалось {expected}")
    for name, anim in s["animations"].items():
        check(all(f < s["frames"] for f in anim["frames"]), f"{sid}.{name}: кадр за пределами листа")
    hb = s.get("hitbox")
    if hb:
        check(hb["offset_x"] + hb["width"] <= s["frame_width"] and hb["offset_y"] + hb["height"] <= s["frame_height"],
              f"{sid}: хитбокс выходит за кадр")

tileset = load("tiles/tiles.json")
tiles = {t["id"]: t for t in tileset["tiles"]}
for t in tiles.values():
    check(t["sprite_id"] in sprites, f"тайл {t['id']}: нет спрайта {t['sprite_id']}")
    sp = sprites.get(t["sprite_id"])
    if sp:
        check(sp["frame_width"] == sp["frame_height"] == tileset["tile_size"], f"тайл {t['id']}: спрайт не {tileset['tile_size']}x{tileset['tile_size']}")

enemies = {e["id"]: e for e in load("enemies/enemies.json")}
for e in enemies.values():
    for sid in e["sprite_variants"]:
        check(sid in sprites, f"враг {e['id']}: нет спрайта {sid}")
check(load("player/player_initial_state.json")["sprite_id"] in sprites, "игрок: sprite_id не найден")

for path in sorted((DATA / "levels").glob("*.json")):
    lv = json.loads(path.read_text(encoding="utf-8"))
    n = lv["id"]
    check(lv["tile_size"] == tileset["tile_size"], f"{n}: tile_size не совпадает с tiles.json")
    check(len(lv["rows"]) == lv["height"], f"{n}: число строк != height")
    for i, row in enumerate(lv["rows"]):
        check(len(row) == lv["width"], f"{n}: строка {i} длиной {len(row)}, ожидалось {lv['width']}")
        for ch in row:
            check(ch in lv["legend"], f"{n}: символ '{ch}' нет в легенде")
    for ch, tid in lv["legend"].items():
        check(tid is None or tid in tiles, f"{n}: легенда '{ch}' -> неизвестный тайл {tid}")
    for en in lv["enemies"]:
        check(en["enemy_id"] in enemies, f"{n}: неизвестный враг {en['enemy_id']}")
        check(en["sprite_id"] in enemies.get(en["enemy_id"], {}).get("sprite_variants", []),
              f"{n}: спрайт {en['sprite_id']} не входит в варианты врага {en['enemy_id']}")

sys.stdout.reconfigure(encoding="utf-8")  # корректная кириллица в консоли Windows
print("\n".join(errors) if errors else "OK: данные и ассеты согласованы")
sys.exit(1 if errors else 0)
