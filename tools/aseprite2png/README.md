# aseprite2png

Конвертер `.aseprite` → `.png` на Python. Aseprite устанавливать не нужно (формат читается напрямую).

- **1 кадр** → обычный PNG.
- **Анимация** (несколько кадров) → PNG-лист из тайлов одного размера + `<имя>.json`
  (размер кадра, число кадров, колонки/строки, длительности в мс, теги анимаций).

## Установка

```bash
pip install -r tools/aseprite2png/requirements.txt
```

## Использование

```bash
# один или несколько файлов
python tools/aseprite2png/aseprite2png.py char.aseprite transistoid.aseprite

# целая папка, свой каталог вывода
python tools/aseprite2png/aseprite2png.py ~/Downloads -o assets/sprites

# лист анимации в несколько строк (по 4 кадра в строке)
python tools/aseprite2png/aseprite2png.py boss.aseprite --columns 4
```

Флаг `-r` обходит подпапки и повторяет их структуру в папке вывода
(так собирается весь `assets/source/` → `assets/sprites/`, см. `npm run sprites`).

По умолчанию результат кладётся в `assets/sprites/`. Флаг `--no-json` отключает запись JSON.

## Экспорт по слоям (`--layers`)

```bash
python tools/aseprite2png/aseprite2png.py assets/source/player/player.aseprite --layers -o assets/sprites/player
```

Кроме обычного PNG каждый слой сохраняется отдельным PNG **на полном холсте** (части лежат в тех же координатах, что и в
Aseprite — склеив их в точке (0,0), получите исходную картинку): `<имя>_layers/<слой>.png`.
Рядом пишется `<имя>.layers.json` — порядок слоёв снизу вверх и bbox каждого. Для анимаций слой экспортируется листом кадров.
Так готовятся части тела для процедурного рига (`data/rigs/`).

## Поддержка

Цвет RGBA / Grayscale / Indexed, слои и группы (видимость, прозрачность), linked cels, теги.
Режимы наложения: normal, multiply, screen, darken, lighten, addition, subtract
(остальные заменяются на normal с предупреждением). Tilemap-слои пропускаются.
