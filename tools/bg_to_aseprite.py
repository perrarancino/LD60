"""
Слои параллакс-фона (assets/sprites/backgrounds/<имя>_layers/Layer_N.png + порядок и имена слоёв из data/backgrounds/<id>.json) -> один .aseprite со слоями.
Слои идут снизу вверх (от дальнего к ближнему), как в игре. Использование:  python tools/bg_to_aseprite.py bg_loc2 [выход.aseprite]
"""
import json
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from png2aseprite import write_aseprite  # noqa: E402


def main():
    bg_id = sys.argv[1] if len(sys.argv) > 1 else 'bg_loc2'
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, 'assets', 'source', 'backgrounds', f'{bg_id}.aseprite')
    bg = json.load(open(os.path.join(ROOT, 'data', 'backgrounds', f'{bg_id}.json'), encoding='utf-8'))
    sprites = {s['id']: s for s in json.load(open(os.path.join(ROOT, 'data', 'sprites', 'sprites.json'), encoding='utf-8'))['sprites']}
    layers = []
    size = None
    for l in bg['layers']:
        sp = sprites[l['sprite_id']]
        img = Image.open(os.path.join(ROOT, 'assets', 'sprites', sp['image'])).convert('RGBA')
        size = size or img.size
        layers.append((l['name'], img))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    write_aseprite(out, size[0], size[1], layers)
    print('ok:', out, size, [n for n, _ in layers])


if __name__ == '__main__':
    main()
