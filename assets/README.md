# Ассеты

```
assets/
├── source/            # ИСХОДНИКИ (.aseprite) — редактируем только их
│   ├── player/        #   player.aseprite            — робот-герой (64x64)
│   ├── enemies/       #   transistoid_purple/amber   — обычные враги (32x32, 3 кадра)
│   ├── bosses/
│   ├── tiles/         #   platform_block.aseprite    — блок-платформа (32x32)
│   ├── items/         #   запчасти, резисторы
│   ├── effects/       #   искры, взрывы, частицы
│   ├── ui/
│   └── backgrounds/
├── sprites/           # ГЕНЕРИРУЕМОЕ (png + json) — руками не правим
│   └── (те же категории)
└── audio/
    ├── music/
    └── sfx/
```

## Части тела героя (процедурный риг)

`assets/source/player/player.aseprite` состоит из слоёв `Head, ALL (торс), Fhand/Bhand (руки), Fleg/Bleg (ноги)`.
`npm run sprites` экспортирует их в `assets/sprites/player/player_layers/*.png` (все на холсте 64x64).
Из частей риг собирается кодом (`src/entities/PlayerRig.ts`), точки вращения и порядок — в `data/rigs/player_rig.json`.
Руки — физичные канаты (`src/entities/RopeLimb.ts`): слой режется кодом на сегменты вдоль оси плечо→кисть, поведение — verlet-цепочка;
число сегментов — поле `rope.segments` у части-руки в риге.

## Правила

- Категория (подпапка) одинакова в `source/` и `sprites/` и совпадает с полем `category` в реестре спрайтов.
- Один файл `.aseprite` = один спрайт. Имя файла: `snake_case`, для вариантов врага — суффикс (`transistoid_purple`).
- Статичный файл → один PNG. Анимация → PNG-лист из кадров в одну строку (+ `.json` с длительностями кадров).
- Игровой код не знает путей к файлам: всё идёт через `id` спрайта из [`data/sprites/sprites.json`](../data/sprites/sprites.json).

## Как добавить спрайт

1. Положить `.aseprite` в `assets/source/<категория>/`.
2. `npm run sprites` — пересобрать PNG в `assets/sprites/` (нужен Python + Pillow, см. `tools/aseprite2png`).
3. Добавить запись в `data/sprites/sprites.json` (размер кадра, хитбокс, анимации).
4. `python tools/validate_data.py` — проверить, что данные и файлы согласованы.
