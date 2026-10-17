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

По умолчанию результат кладётся в `assets/sprites/`. Флаг `--no-json` отключает запись JSON.

## Поддержка

Цвет RGBA / Grayscale / Indexed, слои и группы (видимость, прозрачность), linked cels, теги.
Режимы наложения: normal, multiply, screen, darken, lighten, addition, subtract
(остальные заменяются на normal с предупреждением). Tilemap-слои пропускаются.
