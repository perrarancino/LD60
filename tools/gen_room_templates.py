"""Шаблоны комнат рогалика -> data/roguelike/room_templates.json.

Берёт готовые комнаты LOC1A..E и широкую арену loc2 (приводит к единому виду: '#' — твёрдое, '.' — воздух, обрезка по рамке)
и добавляет новые планировки, нарисованные здесь. Запуск: python tools/gen_room_templates.py
Двери (вход слева, выход справа) и мобов игра расставляет сама по полу найденной планировки.
"""
import json
import sys

sys.stdout.reconfigure(encoding='utf-8')

OUT = 'data/roguelike/room_templates.json'


def grid(w, h):
    g = [['.'] * w for _ in range(h)]
    for x in range(w):
        g[0][x] = '#'          # потолок
        g[h - 1][x] = '#'      # пол (2 ряда)
        g[h - 2][x] = '#'
    for y in range(h):
        g[y][0] = '#'          # стены
        g[y][w - 1] = '#'
    return g


def rect(g, x0, y0, x1, y1, ch='#'):
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            if 0 <= y < len(g) and 0 <= x < len(g[0]):
                g[y][x] = ch


def hole(g, x0, y0, x1, y1):
    rect(g, x0, y0, x1, y1, '.')


def rows(g):
    return [''.join(r) for r in g]


templates = []


def add(id_, name, g, tags=()):
    templates.append({'id': id_, 'name': name, 'tags': list(tags), 'rows': rows(g)})


# ---- старые комнаты: LOC1A..E и loc2 ----
def old(id_, name, path, tags=()):
    d = json.load(open(path, encoding='utf-8'))
    leg = d['legend']
    solid = {c for c, v in leg.items() if v}
    r = d['rows']
    xs = [x for row in r for x, c in enumerate(row) if c in solid]
    ys = [y for y, row in enumerate(r) if any(c in solid for c in row)]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    out = [''.join('#' if c in solid else '.' for c in row[x0:x1 + 1]) for row in r[y0:y1 + 1]]
    templates.append({'id': id_, 'name': name, 'tags': list(tags), 'rows': out})


old('hall_a', 'Зал: четыре полки', 'data/levels/LOC1A.json')
old('tall_b', 'Колодец', 'data/levels/LOC1B.json', ('tall',))
old('hall_c', 'Зал: уступы', 'data/levels/LOC1C.json')
old('bowl_d', 'Чаша', 'data/levels/LOC1D.json')
old('hall_e', 'Зал: мостки', 'data/levels/LOC1E.json')

# ---- новые планировки (площадки не выше 3 клеток над предыдущей: герой допрыгивает без брони) ----
g = grid(32, 15)       # три колонны с полками
for cx in (6, 15, 24):
    rect(g, cx, 11, cx + 1, 12)
    rect(g, cx - 2, 10, cx + 3, 10)
rect(g, 13, 7, 18, 7)
add('pillars', 'Колонны', g)

g = grid(34, 16)       # ярусы: центральный высокий, боковые низкие
rect(g, 12, 9, 21, 9)
rect(g, 3, 11, 8, 11)
rect(g, 25, 11, 30, 11)
rect(g, 15, 6, 18, 6)
add('tiers', 'Ярусы', g)

g = grid(34, 15)       # траншея посреди пола и платформа над ней
hole(g, 13, 13, 20, 13)
rect(g, 14, 10, 19, 10)
rect(g, 3, 10, 7, 10)
rect(g, 26, 10, 30, 10)
add('trench', 'Траншея', g)

g = grid(22, 24)       # вертикальная шахта: зигзаг полок (отскок от стен)
for i, y in enumerate(range(19, 3, -3)):
    if i % 2 == 0:
        rect(g, 1, y, 9, y)
    else:
        rect(g, 12, y, 20, y)
add('shaft', 'Шахта', g, ('tall',))

g = grid(38, 15)       # длинный мост под потолком и низкие островки
rect(g, 6, 8, 31, 8)
rect(g, 3, 10, 5, 10)
rect(g, 32, 10, 34, 10)
rect(g, 17, 10, 20, 10)
add('bridge', 'Мост', g, ('wide',))

g = grid(30, 16)       # шахматка: полки в шахматном порядке
for (x0, y) in [(3, 11), (11, 11), (19, 11), (7, 8), (15, 8), (23, 8), (11, 5), (19, 5)]:
    rect(g, x0, y, x0 + 4, y)
add('checker', 'Шахматка', g)

g = grid(28, 14)       # низкая клетка: сталактиты с потолка для потолочных пауков
for x in (5, 9, 14, 19, 23):
    rect(g, x, 1, x + 1, 3)
rect(g, 10, 9, 17, 9)
add('cage', 'Клетка', g)

g = grid(34, 16)       # зиккурат: ступени вверх к площадке в центре
rect(g, 8, 12, 25, 13)
rect(g, 12, 10, 21, 11)
rect(g, 15, 8, 18, 9)
add('ziggurat', 'Зиккурат', g)

g = grid(30, 15)       # две низкие башни по краям и мостик между ними
rect(g, 1, 10, 6, 12)
rect(g, 23, 10, 28, 12)
rect(g, 10, 8, 19, 8)
rect(g, 12, 10, 17, 10)
add('towers', 'Башни', g)

g = grid(56, 18)       # широкая арена: низкие ступени, средний ярус и высокая площадка
for (x0, x1, y) in [(5, 11, 13), (44, 50, 13), (16, 23, 13), (32, 39, 13), (10, 18, 10), (37, 45, 10), (23, 32, 10), (19, 36, 7)]:
    rect(g, x0, y, x1, y)
add('wide', 'Широкая арена', g, ('wide',))

json.dump({'$comment': 'Шаблоны комнат рогалика (tools/gen_room_templates.py). # — твёрдое, . — воздух.', 'templates': templates},
          open(OUT, 'w', encoding='utf-8', newline='\n'), ensure_ascii=False, indent=1)
print('шаблонов:', len(templates))
for t in templates:
    print('==', t['id'], len(t['rows'][0]), 'x', len(t['rows']))
    print('\n'.join(t['rows']))
