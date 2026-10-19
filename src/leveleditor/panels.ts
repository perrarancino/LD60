import type { EnemyDef, EnemySpawnDef, LevelObjectDef } from '../data/types.ts';
import type { DecorKind, ObjectKind, PropDef } from '../world/placeables.ts';
import { checkbox, clear, field, h, numberInput, select, textInput } from './dom.ts';
import { canonXf, roomCellCount, roomsAt } from './model.ts';
import type { Editor, RoomMode } from './state.ts';

type Tab = 'tiles' | 'decor' | 'threads' | 'mobs' | 'objects' | 'rooms' | 'level';

const TABS: Array<[Tab, string]> = [
  ['tiles', 'Тайлы'],
  ['decor', 'Декор'],
  ['threads', 'Нити'],
  ['mobs', 'Мобы'],
  ['objects', 'Объекты'],
  ['rooms', 'Комнаты'],
  ['level', 'Уровень']
];

/** Фолбэк для декор-спрайтов, которых нет в каталоге: свободно на любой пиксель, поверх тайлов. */
function fallbackDecor(id: string): DecorKind {
  return { sprite_id: id, label: id, group: 'Прочее', anchor: 'free', snap: 'pixel', layer: 'front', flip: true };
}

/**
 * Правая колонка редактора: вкладки палитр (что ставить) и инспектор (свойства выбранного). Перерисовывается по событиям Editor;
 * палитры не пересобираются на каждую правку тайлов.
 */
export class Panels {
  private tab: Tab = 'tiles';
  private readonly tabsEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly inspectorEl: HTMLElement;
  private pending = false;
  private lastKey = '';

  constructor(private readonly ed: Editor, root: HTMLElement) {
    this.tabsEl = h('nav', { class: 'tabs' });
    this.bodyEl = h('div', { class: 'tab-body' });
    this.inspectorEl = h('div', { class: 'inspector' });
    root.append(this.tabsEl, this.bodyEl, this.inspectorEl);
    for (const ch of ['doc', 'sel', 'tool', 'project'] as const) ed.on(ch, () => this.schedule());
    ed.atlas.onLoad = () => {
      this.lastKey = '';
      this.schedule();
      ed.emit('view');
    };
    this.renderTabs();
    this.schedule();
  }

  public showTab(tab: Tab): void {
    this.tab = tab;
    this.lastKey = '';
    this.renderTabs();
    this.schedule();
  }

  private schedule(): void {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.renderBody();
      this.renderInspector();
    });
  }

  private renderTabs(): void {
    clear(this.tabsEl);
    for (const [id, label] of TABS) {
      this.tabsEl.append(h('button', { class: `tab${id === this.tab ? ' active' : ''}`, onclick: () => this.showTab(id) }, label));
    }
  }

  // ---------- Тело вкладки ----------

  private renderBody(): void {
    const ed = this.ed;
    // палитры не зависят от правок тайлов: пересобираем, только когда изменилось то, что они показывают
    const dataTabs: Tab[] = ['rooms', 'level'];
    const key = dataTabs.includes(this.tab)
      ? ''
      : `${this.tab}|${ed.brushTile}|${JSON.stringify(ed.brushXf)}|${ed.armedDecor?.sprite_id}|${ed.armedThread?.kind}|${ed.armedEnemy?.sprite_id}|${ed.armedObject?.type}|${ed.tool}|${ed.placeFlipX}${ed.placeFlipY}|${JSON.stringify(ed.selection)}|${ed.def.decor?.length}|${ed.def.threads?.length}|${ed.def.enemies.length}|${ed.def.objects?.length}|${ed.def.terminals?.length}|${this.tab === 'tiles' ? 0 : ed.rev}`;
    if (key && key === this.lastKey) return;
    this.lastKey = key;
    clear(this.bodyEl);
    switch (this.tab) {
      case 'tiles': this.bodyEl.append(this.tilesPanel()); break;
      case 'decor': this.bodyEl.append(this.decorPanel()); break;
      case 'threads': this.bodyEl.append(this.threadsPanel()); break;
      case 'mobs': this.bodyEl.append(this.mobsPanel()); break;
      case 'objects': this.bodyEl.append(this.objectsPanel()); break;
      case 'rooms': this.bodyEl.append(this.roomsPanel()); break;
      case 'level': this.bodyEl.append(this.levelPanel()); break;
    }
  }

  private thumb(id: string, frame = 0, cls = 'thumb'): HTMLElement {
    const url = this.ed.atlas.thumb(id, frame);
    return url ? h('img', { class: cls, src: url, alt: id }) : h('div', { class: `${cls} empty` });
  }

  private palItem(active: boolean, title: string, thumb: HTMLElement, label: string, onclick: () => void): HTMLElement {
    return h('button', { class: `pal-item${active ? ' active' : ''}`, title, onclick }, thumb, h('span', {}, label));
  }

  /** Список всего расставленного данного вида: выбрать строкой, удалить по одному или все сразу. */
  private placedList(kind: 'decor' | 'thread' | 'enemy' | 'object'): HTMLElement {
    const ed = this.ed;
    const def = ed.def;
    const rows: Array<{ kind: 'decor' | 'thread' | 'enemy' | 'object' | 'terminal'; index: number; label: string }> = [];
    if (kind === 'decor') (def.decor ?? []).forEach((d, i) => rows.push({ kind: 'decor', index: i, label: `${ed.decorKind(d.sprite_id)?.label ?? d.sprite_id} · ${Math.round(d.x * ed.ts)}, ${Math.round(d.y * ed.ts)}` }));
    if (kind === 'thread') (def.threads ?? []).forEach((t, i) => rows.push({ kind: 'thread', index: i, label: `${t.kind === 'vine' ? 'Лиана' : 'Нитка с неба'} · ${Math.round(t.x)}, ${Math.round(t.y)}` }));
    if (kind === 'enemy') def.enemies.forEach((e, i) => rows.push({ kind: 'enemy', index: i, label: `${ed.enemyDef(e.enemy_id)?.display_name ?? e.enemy_id} · клетка ${e.x}, ${e.y}` }));
    if (kind === 'object') {
      (def.objects ?? []).forEach((o, i) => rows.push({ kind: 'object', index: i, label: `${ed.objectKind(o.type)?.label ?? o.type} (${o.id})` }));
      (def.terminals ?? []).forEach((t, i) => rows.push({ kind: 'terminal', index: i, label: `Терминал · клетка ${t.x}, ${t.y}` }));
    }
    const wrap = h('div', {});
    wrap.append(h('h4', {}, `Расставлено: ${rows.length}`));
    if (!rows.length) {
      wrap.append(h('p', { class: 'hint' }, 'Пока ничего. Правая кнопка на карте удаляет предмет под курсором, Ctrl+клик — выбирает.'));
      return wrap;
    }
    const list = h('div', { class: 'placed-list' });
    const sel = ed.selection;
    for (const r of rows) {
      const active = sel.kind === r.kind && 'index' in sel && sel.index === r.index;
      list.append(h('div', { class: `placed-row${active ? ' active' : ''}`, onclick: () => ed.setSelection({ kind: r.kind, index: r.index }) },
        h('span', { title: r.label }, r.label),
        h('button', { class: 'btn small', title: 'Удалить', onclick: (e: Event) => {
          e.stopPropagation();
          ed.setSelection({ kind: r.kind, index: r.index });
          ed.deleteSelection();
        } }, '🗑')));
    }
    wrap.append(list, h('div', { class: 'btn-row' },
      h('button', { class: 'btn danger', onclick: () => { if (confirm(`Удалить всё из списка (${rows.length})?`)) ed.deleteAllOf(kind); } }, '🗑 Удалить все')));
    return wrap;
  }

  // ---------- Тайлы ----------

  private tilesPanel(): HTMLElement {
    const ed = this.ed;
    const wrap = h('div', { class: 'panel' });
    wrap.append(h('h3', {}, 'Тайлы'));
    const grid = h('div', { class: 'pal-grid' });
    for (const tile of ed.project.tiles.tiles) {
      const frame = tile.top_frames ? tile.top_frames[0] : tile.loop_frames ? 1 : 0;
      grid.append(this.palItem(ed.brushTile === tile.id && ed.tool !== 'eraser', `${tile.display_name ?? tile.id}${tile.slope ? ' (скос)' : ''}`, this.thumb(tile.sprite_id, frame), tile.display_name?.replace(/\s*\(.*\)/, '') ?? tile.id, () => {
        ed.brushTile = tile.id;
        if (!['brush', 'rect', 'fill'].includes(ed.tool)) ed.setTool('brush');
        else ed.emit('tool');
      }));
    }
    wrap.append(grid);

    const c = canonXf(ed.brushXf);
    wrap.append(
      h('h3', {}, 'Отражение и поворот'),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', title: 'Отразить по горизонтали (X)', onclick: () => ed.transform('flipH') }, '⇆ Гориз.'),
        h('button', { class: 'btn', title: 'Отразить по вертикали (Y)', onclick: () => ed.transform('flipV') }, '⇅ Верт.'),
        h('button', { class: 'btn', title: 'Повернуть на 90° (R)', onclick: () => ed.transform('rotate') }, '↻ 90°'),
        h('button', { class: 'btn', title: 'Сбросить', onclick: () => { ed.brushXf = { flip_x: false, rot: 0 }; ed.emit('tool'); } }, '✕')
      ),
      h('p', { class: 'hint' }, `Кисть: ${c.flip_x ? 'отражён по горизонтали, ' : ''}поворот ${c.rot}°. Клавиши X, Y, R меняют кисть; когда выделен блок тайлов или предмет — его самого.`)
    );
    return wrap;
  }

  // ---------- Декор ----------

  private decorKinds(): DecorKind[] {
    const ed = this.ed;
    const cat = ed.project.placeables;
    const have = new Set(cat.decor.map((d) => d.sprite_id));
    const objSprites = new Set(cat.objects.map((o) => o.sprite_id));
    const extra = ed.atlas.all().filter((s) => s.category === 'decor' && !have.has(s.id) && !objSprites.has(s.id)).map((s) => fallbackDecor(s.id));
    return [...cat.decor, ...extra];
  }

  private decorPanel(): HTMLElement {
    const ed = this.ed;
    const wrap = h('div', { class: 'panel' });
    wrap.append(h('h3', {}, 'Декор'));
    const groups = new Map<string, DecorKind[]>();
    for (const k of this.decorKinds()) {
      const g = k.group ?? 'Прочее';
      groups.set(g, [...(groups.get(g) ?? []), k]);
    }
    for (const [name, list] of groups) {
      wrap.append(h('h4', {}, name));
      const grid = h('div', { class: 'pal-grid' });
      for (const k of list) {
        grid.append(this.palItem(ed.tool === 'decor' && ed.armedDecor?.sprite_id === k.sprite_id, `${k.label}: ${anchorText(k)}`, this.thumb(k.sprite_id), k.label, () => {
          ed.armedDecor = k;
          ed.setTool('decor');
        }));
      }
      wrap.append(grid);
    }
    const k = ed.armedDecor;
    wrap.append(this.placedList('decor'));
    wrap.append(
      h('div', { class: 'btn-row' },
        h('button', { class: `btn${ed.placeFlipX ? ' on' : ''}`, onclick: () => ed.transform('flipH') }, '⇆ Отразить'),
        h('button', { class: `btn${ed.placeFlipY ? ' on' : ''}`, onclick: () => ed.transform('flipV') }, '⇅ Перевернуть')
      ),
      h('p', { class: 'hint' }, k
        ? `${k.label}: ${anchorText(k)}. Alt при установке — без привязки, на любой пиксель. Правая кнопка — удалить предмет под курсором.`
        : 'Выберите декор и кликните на карте. Каждый предмет знает свою привязку: стоит на полу, висит под потолком или встаёт куда угодно с точностью до пикселя.')
    );
    return wrap;
  }

  // ---------- Нити ----------

  private threadsPanel(): HTMLElement {
    const ed = this.ed;
    const wrap = h('div', { class: 'panel' });
    wrap.append(h('h3', {}, 'Нитки (по пикселям)'));
    for (const k of ed.project.placeables.threads) {
      wrap.append(h('button', { class: `pal-wide${ed.tool === 'thread' && ed.armedThread?.kind === k.kind ? ' active' : ''}`, onclick: () => { ed.armedThread = k; ed.setTool('thread'); } },
        this.thumb(k.sprite_id, 0, 'thumb small'),
        h('span', {}, h('b', {}, k.label), h('br'), h('small', {}, k.hint ?? ''))));
    }
    wrap.append(h('p', { class: 'hint' }, 'Лиана цепляется строго по сетке — к нижним пикселям тайла над курсором (Alt — свободно). Нитка с неба — на любой пиксель. Зажмите и потяните вниз — длина задаётся протяжкой. ПКМ — удалить нитку под курсором, Ctrl+клик — выбрать для правки.'));
    wrap.append(this.placedList('thread'));
    return wrap;
  }

  // ---------- Мобы ----------

  private mobsPanel(): HTMLElement {
    const ed = this.ed;
    const wrap = h('div', { class: 'panel' });
    wrap.append(h('h3', {}, 'Мобы и боссы'));
    const placeable = ed.project.enemies.filter((e) => e.sprite_variants.length > 0);
    const groups: Array<[string, EnemyDef[]]> = [
      ['Мобы', placeable.filter((e) => e.behavior_type !== 'flying_worm')],
      ['Боссы', placeable.filter((e) => e.behavior_type === 'flying_worm')]
    ];
    for (const [title, list] of groups) {
      if (!list.length) continue;
      wrap.append(h('h4', {}, title));
      const grid = h('div', { class: 'pal-grid' });
      for (const e of list) {
        for (const v of e.sprite_variants) {
          const active = ed.tool === 'mob' && ed.armedEnemy?.def.id === e.id && ed.armedEnemy.sprite_id === v;
          grid.append(this.palItem(active, `${e.display_name} — ${e.behavior_type}`, this.thumb(v), e.sprite_variants.length > 1 ? `${shortName(e)} ${e.sprite_variants.indexOf(v) + 1}` : shortName(e), () => {
            ed.armedEnemy = { def: e, sprite_id: v };
            ed.setTool('mob');
          }));
        }
      }
      wrap.append(grid);
    }
    const a = ed.armedEnemy;
    wrap.append(h('p', { class: 'hint' }, a
      ? `${a.def.display_name}: HP ${a.def.stats.max_health}, урон касанием ${a.def.stats.contact_damage}. Моб замечает героя и атакует только в своей комнате (определяется по клетке; можно задать вручную в «Свойствах»).`
      : 'Выберите моба и кликните по клетке. Ползающие (пауки) сами выберут пол, стену или потолок; остальное — в «Свойствах».'));
    wrap.append(this.placedList('enemy'));
    const outside = ed.rooms.length ? ed.def.enemies.filter((e) => !e.room && roomsAt(ed.def, e.x, e.y).length === 0) : [];
    if (outside.length) wrap.append(h('p', { class: 'warn' }, `⚠ Мобов вне комнат: ${outside.length}. Они будут нападать без ограничений — поставьте их внутрь комнаты.`));
    return wrap;
  }

  // ---------- Объекты ----------

  private objectsPanel(): HTMLElement {
    const ed = this.ed;
    const wrap = h('div', { class: 'panel' });
    wrap.append(h('h3', {}, 'Объекты'));
    const groups = new Map<string, ObjectKind[]>();
    for (const k of ed.project.placeables.objects) groups.set(k.group ?? 'Прочее', [...(groups.get(k.group ?? 'Прочее') ?? []), k]);
    for (const [name, list] of groups) {
      wrap.append(h('h4', {}, name));
      const grid = h('div', { class: 'pal-grid' });
      for (const k of list) {
        const frame = 0;
        grid.append(this.palItem(ed.tool === 'object' && ed.armedObject?.type === k.type, `${k.label}: ${anchorText(k)}${k.hint ? `\n${k.hint}` : ''}`, this.thumb(k.sprite_id, frame), k.label, () => {
          ed.armedObject = k;
          ed.setTool('object');
        }));
      }
      wrap.append(grid);
    }
    wrap.append(
      h('h4', {}, 'Старт героя'),
      h('button', { class: `pal-wide${ed.tool === 'spawn' ? ' active' : ''}`, onclick: () => ed.setTool('spawn') }, h('span', {}, h('b', {}, '🏁 Точка появления героя'), h('br'), h('small', {}, `Сейчас: клетка ${ed.def.player_spawn.x}, ${ed.def.player_spawn.y}`)))
    );
    wrap.append(this.placedList('object'));
    const k = ed.armedObject;
    wrap.append(h('p', { class: 'hint' }, k?.hint ?? 'Дверь ведёт к другой двери — этого уровня или другого. Батарейка — квестовый предмет, подставка принимает её и ставит флаг, который открывает запертую дверь.'));
    return wrap;
  }

  // ---------- Комнаты ----------

  private roomsPanel(): HTMLElement {
    const ed = this.ed;
    const wrap = h('div', { class: 'panel' });
    wrap.append(h('h3', {}, 'Комнаты (границы уровней)'));
    wrap.append(h('p', { class: 'hint' }, 'Закрасьте клетки, из которых состоит комната (вместе со стенами вокруг). В игре герой видит только ту комнату, где стоит, — всё остальное чёрное (туман войны). Мобы и боссы нападают на героя только в своей комнате.'));

    const fogOn = !!ed.def.fog;
    const fogMode = typeof ed.def.fog === 'object' ? ed.def.fog.mode ?? 'current' : 'current';
    wrap.append(
      field('Туман войны', checkbox(fogOn, (v) => ed.edit(() => { if (v) ed.def.fog = fogMode === 'explored' ? { mode: 'explored' } : true; else delete ed.def.fog; })), 'Включить скрытие всего, что вне комнаты героя'),
      field('Режим', select(fogMode, [['current', 'Только текущая комната'], ['explored', 'Текущая + посещённые']], (v) => ed.edit(() => { ed.def.fog = v === 'explored' ? { mode: 'explored' } : true; }))),
      field('Предпросмотр тумана', checkbox(ed.show.fog, (v) => { ed.show.fog = v; ed.emit('view'); }), 'Показать на карте, что видно из активной комнаты')
    );

    wrap.append(h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onclick: () => { ed.addRoom(); ed.setTool('room'); } }, '+ Новая комната')));
    const list = h('div', { class: 'room-list' });
    for (const room of ed.rooms) {
      const active = room.id === ed.activeRoom;
      const color = ed.roomColor(room);
      list.append(h('div', { class: `room-row${active ? ' active' : ''}`, onclick: () => { ed.activeRoom = room.id; ed.setTool('room'); } },
        h('input', {
          type: 'color', value: color, title: 'Цвет комнаты в редакторе',
          onchange: (e: Event) => ed.edit(() => { room.color = (e.target as HTMLInputElement).value; }),
          onclick: (e: Event) => e.stopPropagation()
        }),
        h('input', { class: 'room-name', type: 'text', value: room.name, onclick: (e: Event) => e.stopPropagation(), onchange: (e: Event) => ed.edit(() => { room.name = (e.target as HTMLInputElement).value; }) }),
        h('small', {}, `${roomCellCount(room)} кл.`),
        h('button', { class: 'btn small', title: 'Удалить комнату', onclick: (e: Event) => { e.stopPropagation(); ed.deleteRoom(room.id); } }, '🗑')));
    }
    if (!ed.rooms.length) list.append(h('p', { class: 'hint' }, 'Комнат пока нет.'));
    wrap.append(list);

    const modes: Array<[RoomMode, string, string]> = [
      ['brush', '✏ Кисть', 'Закрашивать клетки комнаты (правая кнопка — стирать)'],
      ['erase', '🧽 Ластик', 'Убирать клетки из комнаты'],
      ['rect', '▭ Область', 'Прямоугольник (правая кнопка — убрать область)'],
      ['flood', '🪣 Залить помещение', 'Клик внутри помещения: заливает всё свободное пространство и кольцо стен вокруг него']
    ];
    wrap.append(h('h4', {}, 'Режим закраски'));
    wrap.append(h('div', { class: 'btn-row wrap' }, ...modes.map(([m, label, tip]) => h('button', { class: `btn${ed.roomMode === m && ed.tool === 'room' ? ' on' : ''}`, title: tip, onclick: () => { ed.roomMode = m; ed.setTool('room'); } }, label))));

    // двери и мобы вне комнат
    const outside = ed.rooms.length ? ed.def.enemies.filter((e) => !e.room && roomsAt(ed.def, e.x, e.y).length === 0) : [];
    if (outside.length) wrap.append(h('p', { class: 'warn' }, `⚠ Мобов вне комнат: ${outside.length}`));
    if (ed.def.fog && !ed.rooms.length) wrap.append(h('p', { class: 'warn' }, '⚠ Туман включён, но комнат нет — игра покажет всё чёрным. Нарисуйте хотя бы одну комнату.'));
    return wrap;
  }

  // ---------- Уровень ----------

  private levelPanel(): HTMLElement {
    const ed = this.ed;
    const def = ed.def;
    const wrap = h('div', { class: 'panel' });
    wrap.append(h('h3', {}, 'Свойства уровня'));
    wrap.append(
      field('Id (файл)', h('input', { type: 'text', value: def.id, disabled: true })),
      field('Название', textInput(def.display_name ?? '', (v) => ed.edit(() => { def.display_name = v; }))),
      field('Фон', select(def.background_id ?? '', [['', '(нет)'], ...ed.project.backgrounds.map((b): [string, string] => [b.id, b.id])], (v) => ed.edit(() => { if (v) def.background_id = v; else delete def.background_id; }))),
      field('Герой входит в броне', select(String(def.start_armor ?? 0), [['0', 'без брони'], ['1', 'модель 1'], ['2', 'модель 2 (синяя)']], (v) => ed.edit(() => { if (Number(v)) def.start_armor = Number(v); else delete def.start_armor; }))),
      field('Клавиша перехода (1–9)', numberInput(def.debug_key ?? 0, (v) => ed.edit(() => { if (v >= 1 && v <= 9) def.debug_key = v; else delete def.debug_key; }), { min: 0, max: 9 }), 'Отладка: клавиша в игре, переключающая на этот уровень. 0 — нет'),
      field('Свет: кромка', colorField(def.light?.rim_color, (v) => ed.edit(() => { def.light = { ...def.light, rim_color: v }; }))),
      field('Свет: туман у пола', colorField(def.light?.fog_color, (v) => ed.edit(() => { def.light = { ...def.light, fog_color: v }; })))
    );

    wrap.append(h('h3', {}, `Размер: ${def.width} × ${def.height} клеток`));
    const grow = { left: 0, top: 0, right: 0, bottom: 0 };
    const row = h('div', { class: 'grow-grid' });
    const addNum = (label: string, key: keyof typeof grow) => {
      row.append(h('label', { class: 'field mini' }, h('span', { class: 'field-label' }, label), numberInput(0, (v) => { grow[key] = v; })));
    };
    addNum('Слева', 'left');
    addNum('Сверху', 'top');
    addNum('Справа', 'right');
    addNum('Снизу', 'bottom');
    wrap.append(row, h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => ed.resize(grow.left, grow.top, grow.right, grow.bottom) }, 'Изменить размер')),
      h('p', { class: 'hint' }, 'Число — сколько клеток добавить с этой стороны (минус — обрезать). Всё содержимое сдвигается вместе с картой.'));

    wrap.append(h('h3', {}, 'Опасная зона'), h('div', { class: 'btn-row' },
      h('button', { class: 'btn danger', onclick: () => { if (confirm(`Удалить уровень «${def.id}» (файл data/levels/${ed.filename})?`)) void ed.deleteCurrentLevel(); } }, '🗑 Удалить уровень')));
    return wrap;
  }

  // ---------- Инспектор ----------

  private renderInspector(): void {
    const ed = this.ed;
    clear(this.inspectorEl);
    const s = ed.selection;
    const box = h('div', { class: 'panel' });
    this.inspectorEl.append(box);
    if (s.kind === 'none') {
      box.append(h('h3', {}, 'Свойства'), h('p', { class: 'hint' }, 'Ничего не выбрано. Инструмент «Выбор» (V) — клик по предмету, враг, объекту, нитке; рамкой — блок тайлов.'));
      return;
    }
    if (s.kind === 'tiles') {
      this.tilesInspector(box, s);
      return;
    }
    if (s.kind === 'spawn') {
      box.append(h('h3', {}, 'Старт героя'),
        field('Клетка X', numberInput(ed.def.player_spawn.x, (v) => ed.edit(() => { ed.def.player_spawn.x = v; }))),
        field('Клетка Y', numberInput(ed.def.player_spawn.y, (v) => ed.edit(() => { ed.def.player_spawn.y = v; }))));
      return;
    }
    const ts = ed.ts;
    const actions = h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onclick: () => ed.duplicateSelection() }, '⧉ Дубль'),
      h('button', { class: 'btn danger', onclick: () => ed.deleteSelection() }, '🗑 Удалить'));
    switch (s.kind) {
      case 'decor': {
        const d = ed.def.decor?.[s.index];
        if (!d) return;
        box.append(h('h3', {}, `Декор: ${d.sprite_id}`),
          field('X, px', numberInput(Math.round(d.x * ts), (v) => ed.edit(() => { d.x = v / ts; }))),
          field('Y, px', numberInput(Math.round(d.y * ts), (v) => ed.edit(() => { d.y = v / ts; }))),
          field('Слой', select(d.layer ?? 'front', [['front', 'Перед тайлами'], ['back', 'За тайлами']], (v) => ed.edit(() => { d.layer = v as 'back' | 'front'; }))),
          field('Отразить по гор.', checkbox(!!d.flip_x, (v) => ed.edit(() => { if (v) d.flip_x = true; else delete d.flip_x; }))),
          field('Отразить по верт.', checkbox(!!d.flip_y, (v) => ed.edit(() => { if (v) d.flip_y = true; else delete d.flip_y; }))),
          actions);
        break;
      }
      case 'thread': {
        const t = ed.def.threads?.[s.index];
        if (!t) return;
        box.append(h('h3', {}, t.kind === 'vine' ? 'Лиана' : 'Нитка с неба'),
          field('X, px', numberInput(t.x, (v) => ed.edit(() => { t.x = Math.round(v); }))),
          field('Y (точка закрепления), px', numberInput(t.y, (v) => ed.edit(() => { t.y = Math.round(v); }))));
        if (t.kind === 'vine') box.append(field('Звеньев (по 14 px)', numberInput(t.pieces ?? 3, (v) => ed.edit(() => { t.pieces = Math.max(1, Math.min(12, Math.round(v))); }), { min: 1, max: 12 })));
        else box.append(
          field('Длина, px', numberInput(t.length ?? 160, (v) => ed.edit(() => { t.length = Math.max(16, Math.round(v)); }), { min: 16 })),
          field('Размах качания, px', numberInput(t.swing ?? 10, (v) => ed.edit(() => { t.swing = Math.max(0, v); }), { min: 0 })));
        box.append(field('Капля на конце', checkbox(t.bead ?? true, (v) => ed.edit(() => { t.bead = v; }))), actions);
        break;
      }
      case 'enemy': {
        const e = ed.def.enemies[s.index];
        if (!e) return;
        box.append(this.enemyInspector(e), actions);
        break;
      }
      case 'object': {
        const o = ed.def.objects?.[s.index];
        if (!o) return;
        box.append(...this.objectInspector(o), actions);
        break;
      }
      case 'terminal': {
        const t = ed.def.terminals?.[s.index];
        if (!t) return;
        box.append(h('h3', {}, `Терминал брони: ${t.sprite_id}`),
          field('Клетка X', numberInput(t.x, (v) => ed.edit(() => { t.x = Math.round(v); }))),
          field('Клетка Y', numberInput(t.y, (v) => ed.edit(() => { t.y = Math.round(v); }))),
          actions);
        break;
      }
    }
  }

  private tilesInspector(box: HTMLElement, s: { x0: number; y0: number; x1: number; y1: number }): void {
    const ed = this.ed;
    box.append(
      h('h3', {}, `Выделено тайлов: ${s.x1 - s.x0 + 1} × ${s.y1 - s.y0 + 1}`),
      h('div', { class: 'btn-row wrap' },
        h('button', { class: 'btn', title: 'Каждый тайл отразить на месте (X)', onclick: () => ed.transform('flipH') }, '⇆ Тайлы'),
        h('button', { class: 'btn', title: 'Каждый тайл перевернуть на месте (Y)', onclick: () => ed.transform('flipV') }, '⇅ Тайлы'),
        h('button', { class: 'btn', title: 'Каждый тайл повернуть на 90° (R)', onclick: () => ed.transform('rotate') }, '↻ Тайлы'),
        h('button', { class: 'btn', title: 'Зеркало всего блока: раскладка и тайлы', onclick: () => ed.mirrorBlock('h') }, '⇆ Блок'),
        h('button', { class: 'btn', title: 'Зеркало всего блока вертикально', onclick: () => ed.mirrorBlock('v') }, '⇅ Блок')),
      h('div', { class: 'btn-row wrap' },
        h('button', { class: 'btn', title: 'Копировать (Ctrl+C)', onclick: () => ed.copySelection() }, '⧉ Копировать'),
        h('button', { class: 'btn', title: 'Вставить в клетку под курсором (Ctrl+V)', disabled: !ed.clipboard, onclick: () => ed.paste(ed.hover.cx, ed.hover.cy) }, '📋 Вставить'),
        h('button', { class: 'btn danger', onclick: () => ed.clearSelectionTiles() }, '🗑 Очистить')),
      h('p', { class: 'hint' }, 'Блок целиком: «⇆ Блок» зеркалит и раскладку, и каждый тайл. «Тайлы» — только повернуть/отразить сами тайлы на месте.'));
  }

  private enemyInspector(e: EnemySpawnDef): HTMLElement {
    const ed = this.ed;
    const def = ed.enemyDef(e.enemy_id);
    const wrap = h('div', {});
    wrap.append(h('h3', {}, def?.display_name ?? e.enemy_id));
    if (def && def.sprite_variants.length > 1) {
      wrap.append(field('Внешность', select(e.sprite_id, def.sprite_variants.map((v): [string, string] => [v, v]), (v) => ed.edit(() => { e.sprite_id = v; }))));
    }
    wrap.append(
      field('Клетка X', numberInput(e.x, (v) => ed.edit(() => { e.x = Math.round(v); }))),
      field('Клетка Y', numberInput(e.y, (v) => ed.edit(() => { e.y = Math.round(v); })))
    );
    if (def?.behavior_type === 'crawler') {
      wrap.append(field('Поверхность', select(e.surface ?? 'floor', [['floor', 'Пол'], ['ceiling', 'Потолок'], ['wall_left', 'Стена слева'], ['wall_right', 'Стена справа']], (v) => ed.edit(() => { e.surface = v as EnemySpawnDef['surface']; }))));
    }
    if (def?.behavior_type === 'spawner') {
      wrap.append(field('Верх нитки (ряд)', numberInput(e.anchor_y ?? -2, (v) => ed.edit(() => { e.anchor_y = Math.round(v); }))));
    }
    if (def?.behavior_type === 'burrower') {
      wrap.append(field('Длина (звеньев)', numberInput(e.length ?? 4, (v) => ed.edit(() => { e.length = Math.max(3, Math.min(5, Math.round(v))); }), { min: 3, max: 5 })));
    }
    if (def?.behavior_type === 'flying_worm') {
      wrap.append(field('Длина (звеньев)', numberInput(e.length ?? 10, (v) => ed.edit(() => { e.length = Math.max(3, Math.round(v)); }), { min: 3 })));
    }
    if (ed.rooms.length) {
      const auto = roomsAt(ed.def, e.x, e.y)[0];
      wrap.append(field('Комната-дом', select(e.room ?? '', [['', auto ? `авто: ${auto.name}` : 'авто: вне комнат'], ...ed.rooms.map((r): [string, string] => [r.id, r.name])], (v) => ed.edit(() => { if (v) e.room = v; else delete e.room; })),
        'Моб замечает героя и атакует только пока герой в этой комнате'));
    }
    return wrap;
  }

  private objectInspector(o: LevelObjectDef): HTMLElement[] {
    const ed = this.ed;
    const kind = ed.objectKind(o.type);
    const out: HTMLElement[] = [h('h3', {}, kind?.label ?? o.type)];
    out.push(
      field('Id', textInput(o.id, (v) => ed.edit(() => {
        const next = v.trim().replace(/\s+/g, '_');
        if (!next || (ed.def.objects ?? []).some((p) => p !== o && p.id === next)) return;
        for (const p of ed.def.objects ?? []) if (p.props?.to_door === o.id && !p.props.to_level) p.props.to_door = next; // ссылки на эту дверь
        o.id = next;
      }), 'Уникален на уровне; на него ссылаются двери и сохранения')),
      field('X, px', numberInput(o.x, (v) => ed.edit(() => { o.x = Math.round(v); }))),
      field('Y, px (низ предмета)', numberInput(o.y, (v) => ed.edit(() => { o.y = Math.round(v); })))
    );
    if (kind?.flip) out.push(field('Отразить', checkbox(!!o.flip_x, (v) => ed.edit(() => { if (v) o.flip_x = true; else delete o.flip_x; }))));
    for (const p of kind?.props ?? []) out.push(this.propField(o, p));
    if (kind?.hint) out.push(h('p', { class: 'hint' }, kind.hint));
    return out;
  }

  private propField(o: LevelObjectDef, p: PropDef): HTMLElement {
    const ed = this.ed;
    const cur = o.props?.[p.key];
    const set = (v: string | number | boolean | undefined) => ed.edit(() => {
      const props = (o.props ??= {});
      if (v === undefined || v === '' || v === false) delete props[p.key];
      else props[p.key] = v;
      if (!Object.keys(props).length) delete o.props;
    });
    switch (p.kind) {
      case 'bool': return field(p.label, checkbox(!!cur, (v) => set(v)));
      case 'number': return field(p.label, numberInput(Number(cur ?? p.default ?? 0), (v) => set(v)));
      case 'select': return field(p.label, select(String(cur ?? p.default ?? ''), (p.options ?? []).map((v): [string, string] => [v, v]), (v) => set(v)));
      case 'item': return field(p.label, select(String(cur ?? ''), [['', '(нет)'], ...ed.project.placeables.items.map((i): [string, string] => [i.id, i.label])], (v) => set(v)));
      case 'level': return field(p.label, select(String(cur ?? ''), [['', '(этот уровень)'], ...ed.levelIds().filter((id) => id !== ed.def.id).map((id): [string, string] => [id, id])], (v) => set(v)));
      case 'door': {
        const target = ed.levelById(String(o.props?.to_level ?? '') || ed.def.id);
        const doors = (target?.objects ?? []).filter((d) => d !== o && ed.objectKind(d.type)?.behavior === 'door').map((d): [string, string] => [d.id, d.id]);
        return field(p.label, select(String(cur ?? ''), [['', '(не выбрана)'], ...doors], (v) => set(v)), 'Дверь, в которую попадёт герой');
      }
      default: return field(p.label, textInput(String(cur ?? ''), (v) => set(v)));
    }
  }
}

function anchorText(k: { anchor: string; snap: string; layer?: string }): string {
  const a = { floor: 'встаёт на пол', ceiling: 'вешается под потолок', free: 'ставится на любой пиксель' }[k.anchor] ?? k.anchor;
  const s = { pixel: 'шаг — пиксель', half: 'шаг — полклетки', tile: 'по центру клетки' }[k.snap] ?? k.snap;
  return `${a}, ${s}`;
}

function shortName(e: EnemyDef): string {
  return e.display_name.length > 14 ? e.id : e.display_name;
}

function colorField(value: string | undefined, onChange: (v: string) => void): HTMLElement {
  const input = h('input', { type: 'color', value: value ?? '#22d04c' }) as HTMLInputElement;
  input.addEventListener('change', () => onChange(input.value));
  return input;
}

