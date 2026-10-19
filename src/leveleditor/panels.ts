import type { EnemyDef, EnemySpawnDef, LevelObjectDef, TileDef } from '../data/types.ts';
import type { DecorKind, ObjectKind, PropDef } from '../world/placeables.ts';
import { checkbox, clear, field, h, numberInput, select, textInput } from './dom.ts';
import { canonXf, roomCellCount, roomsAt } from './model.ts';
import type { Editor, RoomMode } from './state.ts';

export type Tab = 'tiles' | 'decor' | 'mobs' | 'objects' | 'rooms' | 'level';

const TABS: Array<[Tab, string]> = [
  ['tiles', 'Тайлы'],
  ['decor', 'Декор'],
  ['mobs', 'Мобы'],
  ['objects', 'Объекты'],
  ['rooms', 'Комнаты'],
  ['level', 'Уровень']
];

type PlacedKind = 'decor' | 'thread' | 'enemy' | 'object' | 'terminal';

/** Фолбэк для декор-спрайтов, которых нет в каталоге: свободно на любой пиксель, поверх тайлов. */
function fallbackDecor(id: string): DecorKind {
  return { sprite_id: id, label: id, group: 'Прочее', anchor: 'free', snap: 'pixel', layer: 'front', flip: true };
}

/**
 * Правая колонка редактора: вкладки палитр (что ставить) и инспектор (свойства выбранного). Текста минимум: подсказки по
 * инструменту показывает строка состояния, а не абзацы в панелях. Палитры не пересобираются на каждую правку тайлов.
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

  private group(title: string, items: HTMLElement[]): HTMLElement {
    return h('div', { class: 'group' }, h('div', { class: 'group-title' }, title), h('div', { class: 'pal-grid' }, ...items));
  }

  /** Расставленное: свёрнутый список (выбрать, удалить) и «удалить все». */
  private placedList(kinds: Array<'decor' | 'thread' | 'enemy' | 'object'>): HTMLElement {
    const ed = this.ed;
    const def = ed.def;
    const rows: Array<{ kind: PlacedKind; index: number; label: string }> = [];
    for (const kind of kinds) {
      if (kind === 'decor') (def.decor ?? []).forEach((d, i) => rows.push({ kind: 'decor', index: i, label: `${ed.decorKind(d.sprite_id)?.label ?? d.sprite_id} · ${Math.round(d.x * ed.ts)}, ${Math.round(d.y * ed.ts)}` }));
      if (kind === 'thread') (def.threads ?? []).forEach((t, i) => rows.push({ kind: 'thread', index: i, label: `${t.kind === 'vine' ? 'Лиана' : 'Нитка'} · ${Math.round(t.x)}, ${Math.round(t.y)}` }));
      if (kind === 'enemy') def.enemies.forEach((e, i) => rows.push({ kind: 'enemy', index: i, label: `${ed.enemyDef(e.enemy_id)?.display_name ?? e.enemy_id} · ${e.x}, ${e.y}` }));
      if (kind === 'object') {
        (def.objects ?? []).forEach((o, i) => rows.push({ kind: 'object', index: i, label: `${ed.objectKind(o.type)?.label ?? o.type} · ${o.id}` }));
        (def.terminals ?? []).forEach((t, i) => rows.push({ kind: 'terminal', index: i, label: `Терминал · ${t.x}, ${t.y}` }));
      }
    }
    const sel = ed.selection;
    const open = rows.some((r) => sel.kind === r.kind && 'index' in sel && sel.index === r.index);
    const box = h('details', { class: 'placed', open }, h('summary', {}, `Расставлено · ${rows.length}`));
    if (!rows.length) return box;
    const list = h('div', { class: 'placed-list' });
    for (const r of rows) {
      const active = sel.kind === r.kind && 'index' in sel && sel.index === r.index;
      list.append(h('div', { class: `placed-row${active ? ' active' : ''}`, onclick: () => ed.setSelection({ kind: r.kind, index: r.index }) },
        h('span', { title: r.label }, r.label),
        h('button', { class: 'btn small', title: 'Удалить', onclick: (e: Event) => {
          e.stopPropagation();
          ed.setSelection({ kind: r.kind, index: r.index });
          ed.deleteSelection();
        } }, '✕')));
    }
    box.append(list, h('button', { class: 'btn small danger', onclick: () => { if (confirm(`Удалить всё (${rows.length})?`)) for (const k of kinds) ed.deleteAllOf(k); } }, 'Удалить все'));
    return box;
  }

  // ---------- Тайлы ----------

  private tilesPanel(): HTMLElement {
    const ed = this.ed;
    const wrap = h('div', { class: 'panel' });
    const groups = new Map<string, TileDef[]>();
    for (const t of ed.project.tiles.tiles) groups.set(t.group ?? 'Тайлы', [...(groups.get(t.group ?? 'Тайлы') ?? []), t]);
    for (const [name, list] of groups) {
      wrap.append(this.group(name, list.map((tile) => this.palItem(
        ed.brushTile === tile.id && ed.tool !== 'eraser', `${tile.display_name ?? tile.id}${tile.slope ? ' (скос)' : ''}`,
        this.thumb(tile.sprite_id, tile.frame ?? 0), tile.display_name?.replace(/^[^:]+:\s*/, '') ?? tile.id,
        () => {
          ed.brushTile = tile.id;
          if (!['brush', 'rect', 'fill'].includes(ed.tool)) ed.setTool('brush');
          else ed.emit('tool');
        }))));
    }
    const c = canonXf(ed.brushXf);
    wrap.append(h('div', { class: 'btn-row' },
      h('button', { class: 'btn', title: 'Отразить по горизонтали (X)', onclick: () => ed.transform('flipH') }, '⇆'),
      h('button', { class: 'btn', title: 'Отразить по вертикали (Y)', onclick: () => ed.transform('flipV') }, '⇅'),
      h('button', { class: 'btn', title: 'Повернуть на 90° (R)', onclick: () => ed.transform('rotate') }, '↻'),
      h('button', { class: 'btn', title: 'Сбросить', onclick: () => { ed.brushXf = { flip_x: false, rot: 0 }; ed.emit('tool'); } }, '✕'),
      h('small', {}, `${c.flip_x ? '⇆ ' : ''}${c.rot}°`)));
    return wrap;
  }

  // ---------- Декор и нитки ----------

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
    const groups = new Map<string, DecorKind[]>();
    for (const k of this.decorKinds()) groups.set(k.group ?? 'Прочее', [...(groups.get(k.group ?? 'Прочее') ?? []), k]);
    for (const [name, list] of groups) {
      wrap.append(this.group(name, list.map((k) => this.palItem(ed.tool === 'decor' && ed.armedDecor?.sprite_id === k.sprite_id, `${k.label}: ${anchorText(k)}`, this.thumb(k.sprite_id), k.label, () => {
        ed.armedDecor = k;
        ed.setTool('decor');
      }))));
    }
    wrap.append(this.group('Нитки', ed.project.placeables.threads.map((k) => this.palItem(ed.tool === 'thread' && ed.armedThread?.kind === k.kind, `${k.label}: ${k.hint ?? ''}`, this.thumb(k.sprite_id), k.label, () => {
      ed.armedThread = k;
      ed.setTool('thread');
    }))));
    wrap.append(h('div', { class: 'btn-row' },
      h('button', { class: `btn${ed.placeFlipX ? ' on' : ''}`, title: 'Отразить по горизонтали (X)', onclick: () => ed.transform('flipH') }, '⇆'),
      h('button', { class: `btn${ed.placeFlipY ? ' on' : ''}`, title: 'Отразить по вертикали (Y)', onclick: () => ed.transform('flipV') }, '⇅')));
    wrap.append(this.placedList(['decor', 'thread']));
    return wrap;
  }

  // ---------- Мобы ----------

  private mobsPanel(): HTMLElement {
    const ed = this.ed;
    const wrap = h('div', { class: 'panel' });
    const placeable = ed.project.enemies.filter((e) => e.sprite_variants.length > 0);
    const groups: Array<[string, EnemyDef[]]> = [
      ['Мобы', placeable.filter((e) => e.behavior_type !== 'flying_worm')],
      ['Боссы', placeable.filter((e) => e.behavior_type === 'flying_worm')]
    ];
    for (const [title, list] of groups) {
      if (!list.length) continue;
      const items: HTMLElement[] = [];
      for (const e of list) {
        for (const v of e.sprite_variants) {
          const active = ed.tool === 'mob' && ed.armedEnemy?.def.id === e.id && ed.armedEnemy.sprite_id === v;
          items.push(this.palItem(active, `${e.display_name} — HP ${e.stats.max_health}, урон ${e.stats.contact_damage}`, this.thumb(v), e.sprite_variants.length > 1 ? `${shortName(e)} ${e.sprite_variants.indexOf(v) + 1}` : shortName(e), () => {
            ed.armedEnemy = { def: e, sprite_id: v };
            ed.setTool('mob');
          }));
        }
      }
      wrap.append(this.group(title, items));
    }
    const outside = ed.rooms.length ? ed.def.enemies.filter((e) => !e.room && roomsAt(ed.def, e.x, e.y).length === 0) : [];
    if (outside.length) wrap.append(h('p', { class: 'warn' }, `Вне комнат: ${outside.length}`));
    wrap.append(this.placedList(['enemy']));
    return wrap;
  }

  // ---------- Объекты ----------

  private objectsPanel(): HTMLElement {
    const ed = this.ed;
    const wrap = h('div', { class: 'panel' });
    const groups = new Map<string, ObjectKind[]>();
    for (const k of ed.project.placeables.objects) groups.set(k.group ?? 'Прочее', [...(groups.get(k.group ?? 'Прочее') ?? []), k]);
    for (const [name, list] of groups) {
      wrap.append(this.group(name, list.map((k) => this.palItem(ed.tool === 'object' && ed.armedObject?.type === k.type, `${k.label}${k.hint ? `\n${k.hint}` : ''}`, this.thumb(k.sprite_id), k.label, () => {
        ed.armedObject = k;
        ed.setTool('object');
      }))));
    }
    wrap.append(h('button', { class: `pal-wide${ed.tool === 'spawn' ? ' active' : ''}`, onclick: () => ed.setTool('spawn') }, h('span', {}, '⚑ Старт героя')));
    wrap.append(this.placedList(['object']));
    return wrap;
  }

  // ---------- Комнаты ----------

  private roomsPanel(): HTMLElement {
    const ed = this.ed;
    const wrap = h('div', { class: 'panel' });
    const fogOn = !!ed.def.fog;
    const fogMode = typeof ed.def.fog === 'object' ? ed.def.fog.mode ?? 'current' : 'current';
    wrap.append(field('Туман войны', checkbox(fogOn, (v) => ed.edit(() => { if (v) ed.def.fog = fogMode === 'explored' ? { mode: 'explored' } : true; else delete ed.def.fog; })), 'Вне комнаты героя мир чёрный'));
    if (fogOn) wrap.append(field('Открытые', select(fogMode, [['current', 'только текущая'], ['explored', 'и посещённые']], (v) => ed.edit(() => { ed.def.fog = v === 'explored' ? { mode: 'explored' } : true; }))));

    const list = h('div', { class: 'room-list' });
    for (const room of ed.rooms) {
      const active = room.id === ed.activeRoom;
      list.append(h('div', { class: `room-row${active ? ' active' : ''}`, onclick: () => { ed.activeRoom = room.id; ed.setTool('room'); } },
        h('input', {
          type: 'color', value: ed.roomColor(room), title: 'Цвет',
          onchange: (e: Event) => ed.edit(() => { room.color = (e.target as HTMLInputElement).value; }),
          onclick: (e: Event) => e.stopPropagation()
        }),
        h('input', { class: 'room-name', type: 'text', value: room.name, onclick: (e: Event) => e.stopPropagation(), onchange: (e: Event) => ed.edit(() => { room.name = (e.target as HTMLInputElement).value; }) }),
        h('small', {}, String(roomCellCount(room))),
        h('button', { class: 'btn small', title: 'Удалить комнату', onclick: (e: Event) => { e.stopPropagation(); ed.deleteRoom(room.id); } }, '✕')));
    }
    wrap.append(list, h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onclick: () => { ed.addRoom(); ed.setTool('room'); } }, '+ Комната')));

    const modes: Array<[RoomMode, string, string]> = [
      ['brush', '✏', 'Кисть (ПКМ — стереть)'],
      ['erase', '⌫', 'Ластик'],
      ['rect', '▭', 'Область'],
      ['flood', '◧', 'Залить помещение: клик внутри — всё свободное место и стены вокруг']
    ];
    wrap.append(h('div', { class: 'btn-row' }, ...modes.map(([m, label, tip]) => h('button', { class: `btn${ed.roomMode === m && ed.tool === 'room' ? ' on' : ''}`, title: tip, onclick: () => { ed.roomMode = m; ed.setTool('room'); } }, label)),
      h('button', { class: `btn${ed.show.fog ? ' on' : ''}`, title: 'Предпросмотр тумана (F)', onclick: () => { ed.show.fog = !ed.show.fog; ed.emit('view'); ed.emit('tool'); } }, '☁')));

    const outside = ed.rooms.length ? ed.def.enemies.filter((e) => !e.room && roomsAt(ed.def, e.x, e.y).length === 0) : [];
    if (outside.length) wrap.append(h('p', { class: 'warn' }, `Мобов вне комнат: ${outside.length}`));
    if (fogOn && !ed.rooms.length) wrap.append(h('p', { class: 'warn' }, 'Туман включён, а комнат нет — игра покажет чёрный экран'));
    return wrap;
  }

  // ---------- Уровень ----------

  private levelPanel(): HTMLElement {
    const ed = this.ed;
    const def = ed.def;
    const wrap = h('div', { class: 'panel' });
    wrap.append(
      field('Название', textInput(def.display_name ?? '', (v) => ed.edit(() => { def.display_name = v; }))),
      field('Фон', select(def.background_id ?? '', [['', '—'], ...ed.project.backgrounds.map((b): [string, string] => [b.id, b.id])], (v) => ed.edit(() => { if (v) def.background_id = v; else delete def.background_id; }))),
      field('Броня на входе', select(String(def.start_armor ?? 0), [['0', 'нет'], ['1', 'модель 1'], ['2', 'модель 2']], (v) => ed.edit(() => { if (Number(v)) def.start_armor = Number(v); else delete def.start_armor; }))),
      field('Клавиша 1–9', numberInput(def.debug_key ?? 0, (v) => ed.edit(() => { if (v >= 1 && v <= 9) def.debug_key = v; else delete def.debug_key; }), { min: 0, max: 9 }), 'Переход на этот уровень в игре. 0 — нет'),
      field('Свет: кромка', colorField(def.light?.rim_color, (v) => ed.edit(() => { def.light = { ...def.light, rim_color: v }; }))),
      field('Свет: туман', colorField(def.light?.fog_color, (v) => ed.edit(() => { def.light = { ...def.light, fog_color: v }; })))
    );

    const grow = { left: 0, top: 0, right: 0, bottom: 0 };
    const row = h('div', { class: 'grow-grid' });
    const addNum = (label: string, key: keyof typeof grow) => {
      row.append(h('label', { class: 'field mini' }, h('span', { class: 'field-label' }, label), numberInput(0, (v) => { grow[key] = v; })));
    };
    addNum('←', 'left');
    addNum('↑', 'top');
    addNum('→', 'right');
    addNum('↓', 'bottom');
    wrap.append(h('div', { class: 'group-title' }, `Размер ${def.width} × ${def.height}`), row,
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', title: '+ добавить клетки с этой стороны, − обрезать', onclick: () => ed.resize(grow.left, grow.top, grow.right, grow.bottom) }, 'Изменить'),
        h('button', { class: 'btn danger', onclick: () => { if (confirm(`Удалить уровень «${def.id}» (data/levels/${ed.filename})?`)) void ed.deleteCurrentLevel(); } }, 'Удалить уровень')));
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
      this.inspectorEl.classList.add('empty');
      return;
    }
    this.inspectorEl.classList.remove('empty');
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
      h('button', { class: 'btn', onclick: () => ed.duplicateSelection() }, 'Дубль'),
      h('button', { class: 'btn danger', onclick: () => ed.deleteSelection() }, 'Удалить'));
    switch (s.kind) {
      case 'decor': {
        const d = ed.def.decor?.[s.index];
        if (!d) return;
        box.append(h('h3', {}, ed.decorKind(d.sprite_id)?.label ?? d.sprite_id),
          field('X, px', numberInput(Math.round(d.x * ts), (v) => ed.edit(() => { d.x = v / ts; }))),
          field('Y, px', numberInput(Math.round(d.y * ts), (v) => ed.edit(() => { d.y = v / ts; }))),
          field('Слой', select(d.layer ?? 'front', [['front', 'перед тайлами'], ['back', 'за тайлами']], (v) => ed.edit(() => { d.layer = v as 'back' | 'front'; }))),
          field('Отразить ⇆', checkbox(!!d.flip_x, (v) => ed.edit(() => { if (v) d.flip_x = true; else delete d.flip_x; }))),
          field('Отразить ⇅', checkbox(!!d.flip_y, (v) => ed.edit(() => { if (v) d.flip_y = true; else delete d.flip_y; }))),
          actions);
        break;
      }
      case 'thread': {
        const t = ed.def.threads?.[s.index];
        if (!t) return;
        box.append(h('h3', {}, t.kind === 'vine' ? 'Лиана' : 'Нитка с неба'),
          field('X, px', numberInput(t.x, (v) => ed.edit(() => { t.x = Math.round(v); }))),
          field('Y, px', numberInput(t.y, (v) => ed.edit(() => { t.y = Math.round(v); }))));
        if (t.kind === 'vine') box.append(field('Звеньев', numberInput(t.pieces ?? 3, (v) => ed.edit(() => { t.pieces = Math.max(1, Math.min(12, Math.round(v))); }), { min: 1, max: 12 })));
        else box.append(
          field('Длина, px', numberInput(t.length ?? 160, (v) => ed.edit(() => { t.length = Math.max(16, Math.round(v)); }), { min: 16 })),
          field('Качание, px', numberInput(t.swing ?? 10, (v) => ed.edit(() => { t.swing = Math.max(0, v); }), { min: 0 })));
        box.append(field('Капля', checkbox(t.bead ?? true, (v) => ed.edit(() => { t.bead = v; }))), actions);
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
        box.append(h('h3', {}, 'Терминал брони'),
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
      h('h3', {}, `Блок ${s.x1 - s.x0 + 1} × ${s.y1 - s.y0 + 1}`),
      h('div', { class: 'btn-row wrap' },
        h('button', { class: 'btn', title: 'Отразить каждый тайл (X)', onclick: () => ed.transform('flipH') }, '⇆'),
        h('button', { class: 'btn', title: 'Перевернуть каждый тайл (Y)', onclick: () => ed.transform('flipV') }, '⇅'),
        h('button', { class: 'btn', title: 'Повернуть каждый тайл (R)', onclick: () => ed.transform('rotate') }, '↻'),
        h('button', { class: 'btn', title: 'Зеркало всего блока по горизонтали', onclick: () => ed.mirrorBlock('h') }, '▤⇆'),
        h('button', { class: 'btn', title: 'Зеркало всего блока по вертикали', onclick: () => ed.mirrorBlock('v') }, '▤⇅')),
      h('div', { class: 'btn-row wrap' },
        h('button', { class: 'btn', title: 'Копировать (Ctrl+C)', onclick: () => ed.copySelection() }, 'Копировать'),
        h('button', { class: 'btn', title: 'Вставить под курсором (Ctrl+V)', disabled: !ed.clipboard, onclick: () => ed.paste(ed.hover.cx, ed.hover.cy) }, 'Вставить'),
        h('button', { class: 'btn danger', onclick: () => ed.clearSelectionTiles() }, 'Очистить')));
  }

  private enemyInspector(e: EnemySpawnDef): HTMLElement {
    const ed = this.ed;
    const def = ed.enemyDef(e.enemy_id);
    const wrap = h('div', {});
    wrap.append(h('h3', {}, def?.display_name ?? e.enemy_id));
    if (def && def.sprite_variants.length > 1) {
      wrap.append(field('Вид', select(e.sprite_id, def.sprite_variants.map((v): [string, string] => [v, v]), (v) => ed.edit(() => { e.sprite_id = v; }))));
    }
    wrap.append(
      field('Клетка X', numberInput(e.x, (v) => ed.edit(() => { e.x = Math.round(v); }))),
      field('Клетка Y', numberInput(e.y, (v) => ed.edit(() => { e.y = Math.round(v); })))
    );
    if (def?.behavior_type === 'crawler') {
      wrap.append(field('Поверхность', select(e.surface ?? 'floor', [['floor', 'пол'], ['ceiling', 'потолок'], ['wall_left', 'стена слева'], ['wall_right', 'стена справа']], (v) => ed.edit(() => { e.surface = v as EnemySpawnDef['surface']; }))));
    }
    if (def?.behavior_type === 'spawner') {
      wrap.append(field('Верх нитки, ряд', numberInput(e.anchor_y ?? -2, (v) => ed.edit(() => { e.anchor_y = Math.round(v); }))));
    }
    if (def?.behavior_type === 'burrower') {
      wrap.append(field('Длина', numberInput(e.length ?? 4, (v) => ed.edit(() => { e.length = Math.max(3, Math.min(5, Math.round(v))); }), { min: 3, max: 5 })));
    }
    if (def?.behavior_type === 'flying_worm') {
      wrap.append(field('Длина', numberInput(e.length ?? 10, (v) => ed.edit(() => { e.length = Math.max(3, Math.round(v)); }), { min: 3 })));
    }
    if (ed.rooms.length) {
      const auto = roomsAt(ed.def, e.x, e.y)[0];
      wrap.append(field('Комната', select(e.room ?? '', [['', auto ? `авто · ${auto.name}` : 'авто · вне комнат'], ...ed.rooms.map((r): [string, string] => [r.id, r.name])], (v) => ed.edit(() => { if (v) e.room = v; else delete e.room; })),
        'Моб нападает, только пока герой в этой комнате'));
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
      }), 'Уникален на уровне; на него ссылаются двери')),
      field('X, px', numberInput(o.x, (v) => ed.edit(() => { o.x = Math.round(v); }))),
      field('Y, px', numberInput(o.y, (v) => ed.edit(() => { o.y = Math.round(v); })))
    );
    if (kind?.flip) out.push(field('Отразить ⇆', checkbox(!!o.flip_x, (v) => ed.edit(() => { if (v) o.flip_x = true; else delete o.flip_x; }))));
    for (const p of kind?.props ?? []) out.push(this.propField(o, p));
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
      case 'item': return field(p.label, select(String(cur ?? ''), [['', '—'], ...ed.project.placeables.items.map((i): [string, string] => [i.id, i.label])], (v) => set(v)));
      case 'level': return field(p.label, select(String(cur ?? ''), [['', 'этот уровень'], ...ed.levelIds().filter((id) => id !== ed.def.id).map((id): [string, string] => [id, id])], (v) => set(v)));
      case 'door': {
        const target = ed.levelById(String(o.props?.to_level ?? '') || ed.def.id);
        const doors = (target?.objects ?? []).filter((d) => d !== o && ed.objectKind(d.type)?.behavior === 'door').map((d): [string, string] => [d.id, d.id]);
        return field(p.label, select(String(cur ?? ''), [['', '—'], ...doors], (v) => set(v)));
      }
      default: return field(p.label, textInput(String(cur ?? ''), (v) => set(v)));
    }
  }
}

function anchorText(k: { anchor: string; snap: string }): string {
  const a = { floor: 'на пол', ceiling: 'под потолок', free: 'куда угодно' }[k.anchor] ?? k.anchor;
  const s = { pixel: 'по пикселям', half: 'через полклетки', tile: 'по клеткам' }[k.snap] ?? k.snap;
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
