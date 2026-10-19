"""
Генератор спрайтов терминалов брони (по одному на локацию): киоск с экраном, клавиатурой и приёмником металлолома. Стиль локации:
loc1 — зелёная плата (рампа pcb) с фиолетовым акцентом (void); loc2 — синий корпус (cobalt) с бирюзовым экраном (electric) и золотым акцентом (gold).
Лист из 4 кадров 40x56 (мигает курсор и светодиод на антенне, по экрану бежит строка), точка привязки — низ по центру.
Запуск из корня проекта:  python tools/gen_terminals.py
Результат: assets/sprites/decor/terminal_loc1.png, terminal_loc2.png. Цвета — только из палитры проекта (assets/palettes/oldtech-vivid-72.gpl).
"""
import os
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gen_loc2_art import ROOT, C, Canvas  # noqa: E402

W, H = 40, 56
FRAMES = 4

STYLES = {
    'loc1': dict(
        body=C('pcb', 2), body_dark=C('pcb', 1), body_deep=C('pcb', 0), hi=C('pcb', 4), shade=C('pcb', 0),
        screen=C('pcb', 0), glow=C('pcb', 5), glow_hi=C('pcb', 7), glow_dim=C('pcb', 3),
        accent=C('void', 5), accent_hi=C('void', 7), accent_dim=C('void', 3), metal=C('steel', 3),
    ),
    'loc2': dict(
        body=C('cobalt', 2), body_dark=C('cobalt', 1), body_deep=C('cobalt', 0), hi=C('cobalt', 4), shade=C('cobalt', 0),
        screen=C('cobalt', 0), glow=C('electric', 5), glow_hi=C('electric', 7), glow_dim=C('electric', 3),
        accent=C('gold', 5), accent_hi=C('gold', 7), accent_dim=C('gold', 3), metal=C('steel', 3),
    ),
}


def terminal(style, frame):
    s = STYLES[style]
    cv = Canvas(W, H)
    # цоколь
    cv.rect(4, 50, 32, 6, s['body_dark'])
    cv.rect(4, 50, 32, 1, s['hi'])
    cv.rect(4, 55, 32, 1, s['shade'])
    # корпус: фаска светлая слева-сверху, тёмная справа-снизу
    cv.rect(7, 12, 26, 38, s['body'])
    cv.rect(7, 12, 26, 1, s['hi'])
    cv.rect(7, 12, 1, 38, s['hi'])
    cv.rect(32, 12, 1, 38, s['shade'])
    cv.rect(7, 49, 26, 1, s['shade'])
    # верхняя «крыша» и антенна
    cv.rect(9, 9, 22, 3, s['body_dark'])
    cv.rect(9, 9, 22, 1, s['hi'])
    cv.rect(19, 3, 2, 6, s['metal'])
    led = s['accent_hi'] if frame in (0, 1) else s['accent_dim']
    cv.rect(18, 1, 4, 3, led)
    # рамка экрана и экран
    cv.rect(10, 16, 20, 17, s['body_deep'])
    cv.rect(11, 17, 18, 15, s['screen'])
    cv.rect(11, 17, 18, 1, s['body_dark'])
    # строки на экране (текст — полосы разной длины)
    for k, ln in enumerate((12, 9, 13, 6)):
        col = s['glow'] if k != 1 else s['glow_dim']
        cv.rect(13, 19 + k * 3, ln, 1, col)
    # курсор мигает
    if frame in (0, 2):
        cv.rect(20, 28, 3, 2, s['glow_hi'])
    # бегущая строка: яркая полоса по экрану
    cv.rect(11, 18 + (frame * 4) % 14, 18, 1, s['glow_dim'])
    # блик на стекле
    cv.rect(12, 18, 3, 1, s['glow_hi'])
    # клавиатурная панель
    cv.rect(10, 35, 20, 8, s['body_dark'])
    cv.rect(10, 35, 20, 1, s['shade'])
    for r in range(2):
        for c in range(6):
            cv.rect(12 + c * 3, 37 + r * 3, 2, 2, s['accent_dim'] if (r + c) % 3 else s['metal'])
    cv.rect(12, 37, 2, 2, s['accent'])
    # приёмник металлолома: воронка с подсветкой
    cv.rect(12, 45, 16, 4, s['body_deep'])
    cv.rect(13, 46, 14, 2, s['screen'])
    cv.rect(13, 46, 14, 1, s['accent'] if frame != 3 else s['accent_hi'])
    cv.rect(12, 45, 16, 1, s['hi'])
    # боковые прорези
    for y in (20, 24, 28):
        cv.rect(8, y, 1, 2, s['shade'])
        cv.rect(31, y, 1, 2, s['shade'])
    return cv


def main():
    out = os.path.join(ROOT, 'assets', 'sprites', 'decor')
    os.makedirs(out, exist_ok=True)
    for style in STYLES:
        sheet = Image.new('RGBA', (W * FRAMES, H), (0, 0, 0, 0))
        for f in range(FRAMES):
            sheet.paste(terminal(style, f).image(), (f * W, 0))
        sheet.save(os.path.join(out, f'terminal_{style}.png'))
    print('ok: terminal_loc1.png, terminal_loc2.png')


if __name__ == '__main__':
    sys.exit(main())
