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
    check(Path(s["image"]).parts[0] == s["category"], f"{sid}: категория {s['category']} не совпадает с папкой {Path(s['image']).parts[0]}")
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
player = load("player/player_initial_state.json")
check(player["sprite_id"] in sprites, "игрок: sprite_id не найден")
rigs = {r["id"]: r for r in [load(f"rigs/{p.name}") for p in sorted((DATA / "rigs").glob("*.json"))]}
check(player["rig_id"] in rigs, f"игрок: риг {player['rig_id']} не найден")
for e in enemies.values():
    check(e.get("rig_id") is None or e["rig_id"] in rigs, f"враг {e['id']}: риг {e.get('rig_id')} не найден")
    sp_def = e.get("spawns")
    if sp_def:
        check(sp_def["enemy_id"] in enemies, f"враг {e['id']}: spawns -> неизвестный враг {sp_def['enemy_id']}")
        check(sp_def.get("sprite_id") is None or sp_def["sprite_id"] in sprites, f"враг {e['id']}: spawns -> нет спрайта {sp_def.get('sprite_id')}")
for rig in rigs.values():
    for part in rig["parts"]:
        check(part["sprite_id"] in sprites, f"риг {rig['id']}: нет спрайта {part['sprite_id']}")
        sp = sprites.get(part["sprite_id"])
        if sp:
            check((sp["frame_width"], sp["frame_height"]) == (rig["canvas"]["width"], rig["canvas"]["height"]),
                  f"риг {rig['id']}: часть {part['name']} другого размера, чем холст")
    for part in rig["parts"]:
        face_id = part.get("face", {}).get("sprite_id")
        if face_id:
            sp = sprites.get(face_id)
            check(sp is not None, f"риг {rig['id']}: лицо части {part['name']}: нет спрайта {face_id}")
            if sp:
                check((sp["frame_width"], sp["frame_height"]) == (rig["canvas"]["width"], rig["canvas"]["height"]),
                      f"риг {rig['id']}: лицо части {part['name']}: слой {face_id} другого размера, чем холст")
    for leg in rig.get("crawler", {}).get("legs", []):
        for key in ("upper_sprite_id", "lower_sprite_id"):
            sp = sprites.get(leg[key])
            check(sp is not None, f"риг {rig['id']}: нога {leg['name']}: нет спрайта {leg[key]}")
            if sp:
                check((sp["frame_width"], sp["frame_height"]) == (rig["canvas"]["width"], rig["canvas"]["height"]),
                      f"риг {rig['id']}: нога {leg['name']}: слой {leg[key]} другого размера, чем холст")
    wob = rig.get("wobbler")
    if wob:
        ids = [("рисунок", wob["sprite_id"])] + [(l["name"], l["sprite_id"]) for l in wob["limbs"]]
        for what, sid in ids:
            sp = sprites.get(sid)
            check(sp is not None, f"риг {rig['id']}: {what}: нет спрайта {sid}")
            if sp:
                check((sp["frame_width"], sp["frame_height"]) == (rig["canvas"]["width"], rig["canvas"]["height"]),
                      f"риг {rig['id']}: {what}: слой {sid} другого размера, чем холст")
        if wob.get("thread"):
            check(wob["thread"]["sprite_id"] in sprites, f"риг {rig['id']}: нитка: нет спрайта {wob['thread']['sprite_id']}")
    seg = rig.get("segmented")
    if seg:
        for key in ("head", "body", "tail"):
            check(seg[key]["sprite_id"] in sprites, f"риг {rig['id']}: сегмент {key}: нет спрайта {seg[key]['sprite_id']}")

backgrounds = {b["id"]: b for b in [load(f"backgrounds/{p.name}") for p in sorted((DATA / "backgrounds").glob("*.json"))]}
for bg in backgrounds.values():
    for layer in bg["layers"]:
        check(layer["sprite_id"] in sprites, f"фон {bg['id']}: нет спрайта {layer['sprite_id']}")
        sp = sprites.get(layer["sprite_id"])
        if sp:
            check(sp["category"] == "backgrounds", f"фон {bg['id']}: слой {layer['name']} не из категории backgrounds")
            check(sp["frame_width"] >= 16, f"фон {bg['id']}: слой {layer['name']} слишком узкий для тайлинга")

for path in sorted((DATA / "levels").glob("*.json")):
    lv = json.loads(path.read_text(encoding="utf-8"))
    n = lv["id"]
    check(lv["tile_size"] == tileset["tile_size"], f"{n}: tile_size не совпадает с tiles.json")
    check(lv.get("background_id") is None or lv["background_id"] in backgrounds, f"{n}: неизвестный фон {lv.get('background_id')}")
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
