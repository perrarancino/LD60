import './style.css';
import { loadProject } from './api.ts';
import { clear, field, h, numberInput, select, textInput } from './dom.ts';
import { newLevel } from './model.ts';
import { Panels } from './panels.ts';
import { pickEntity, render } from './render.ts';
import { Editor } from './state.ts';
import { CONTENT_LAYERS, TOOL_KINDS } from './state.ts';
import type { LayerKey, ToolId } from './state.ts';
import { isTyping, Tools } from './tools.ts';

interface ToolButton {
  id: ToolId;
  key: string;
  icon: string;
  label: string;
  tab: 'tiles' | 'decor' | 'mobs' | 'objects' | 'rooms' | null;
  hint: string; // подсказка в строке состояния
}

const TOOLS: ToolButton[] = [
  { id: 'select', key: 'V', icon: '⬚', label: 'Выбор', tab: null, hint: 'Клик — выбрать · перетащить — двигать · рамка — блок тайлов · Delete — удалить · стрелки — сдвиг' },
  { id: 'brush', key: 'B', icon: '✏', label: 'Кисть', tab: 'tiles', hint: 'ЛКМ — рисовать · СКМ — стереть · Shift — линия · X / Y / R — отразить, повернуть' },
  { id: 'eraser', key: 'E', icon: '⌫', label: 'Ластик', tab: 'tiles', hint: 'ЛКМ — стереть тайл' },
  { id: 'rect', key: 'U', icon: '▭', label: 'Прямоугольник', tab: 'tiles', hint: 'Протяжка — залить прямоугольник · Shift — только рамка · СКМ — стереть' },
  { id: 'fill', key: 'G', icon: '◧', label: 'Заливка', tab: 'tiles', hint: 'Клик — залить связную область' },
  { id: 'pick', key: 'I', icon: '⌖', label: 'Пипетка', tab: 'tiles', hint: 'Клик — взять тайл с карты' },
  { id: 'decor', key: 'D', icon: '❀', label: 'Декор', tab: 'decor', hint: 'Клик — поставить · Alt — без привязки · СКМ или Delete — удалить под курсором · Ctrl+клик — выбрать · X / Y — отразить' },
  { id: 'thread', key: 'N', icon: '𝄞', label: 'Нитки', tab: 'decor', hint: 'Клик — закрепить (лиана — по сетке) · протяжка вниз — длина · Alt — свободно · СКМ или Delete — удалить' },
  { id: 'mob', key: 'M', icon: '☠', label: 'Мобы', tab: 'mobs', hint: 'Клик — поставить в клетку · СКМ или Delete — удалить под курсором · Ctrl+клик — выбрать · волны — во вкладке' },
  { id: 'object', key: 'O', icon: '⌂', label: 'Объекты', tab: 'objects', hint: 'Клик — поставить · СКМ или Delete — удалить под курсором · Ctrl+клик — выбрать' },
  { id: 'spawn', key: 'S', icon: '⚑', label: 'Старт героя', tab: 'objects', hint: 'Клик — поставить точку появления героя' },
  { id: 'room', key: 'K', icon: '▦', label: 'Комнаты', tab: 'rooms', hint: 'ЛКМ — закрасить комнату · СКМ — стереть · режимы — во вкладке «Комнаты»' }
];

async function start(): Promise<void> {
  const app = document.getElementById('app')!;
  let project;
  try {
    project = await loadProject();
  } catch (e) {
    app.append(h('div', { class: 'fatal' }, h('h2', {}, 'Не удалось загрузить проект'), h('p', {}, String((e as Error).message)), h('p', {}, 'Редактор нужно открывать через LD60Editor.exe или `npm run editor` — они отдают файлы проекта.')));
    return;
  }

  const ed = new Editor(project);
  ed.atlas.preloadAll();
  clear(app);

  // ---- каркас
  const topbar = h('header', { class: 'topbar' });
  const toolbar = h('aside', { class: 'toolbar' });
  const canvas = h('canvas', { id: 'canvas' }) as HTMLCanvasElement;
  const stage = h('div', { class: 'stage' }, canvas);
  const side = h('aside', { class: 'side' });
  const statusbar = h('footer', { class: 'statusbar' });
  app.append(topbar, h('div', { class: 'main' }, toolbar, stage, side), statusbar);

  const panels = new Panels(ed, side);
  const ctx = canvas.getContext('2d')!;

  // ---- холст и отрисовка
  let queued = false;
  const redraw = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      render(ctx, canvas, ed, tools.overlay);
    });
  };
  const resizeCanvas = () => {
    canvas.width = stage.clientWidth;
    canvas.height = stage.clientHeight;
    ed.canvasSize = { w: canvas.width, h: canvas.height };
    redraw();
  };
  new ResizeObserver(resizeCanvas).observe(stage);
  const tools = new Tools(ed, canvas, redraw);
  ed.atlas.onLoad = (() => {
    const prev = ed.atlas.onLoad;
    return () => {
      prev();
      redraw();
    };
  })();
  for (const ch of ['doc', 'view', 'sel', 'tool'] as const) ed.on(ch, redraw);

  // ---- верхняя панель
  const levelSelect = h('select', { class: 'level-select' }) as HTMLSelectElement;
  levelSelect.addEventListener('change', () => {
    if (ed.dirty && !confirm('В уровне есть несохранённые правки. Открыть другой уровень без сохранения?')) {
      levelSelect.value = ed.filename;
      return;
    }
    ed.openLevel(levelSelect.value);
  });
  const dirtyMark = h('span', { class: 'dirty' }, '');
  const btn = (label: string, title: string, onclick: () => void, cls = '') => h('button', { class: `btn ${cls}`.trim(), title, onclick }, label);
  const undoBtn = btn('↩', 'Отмена (Ctrl+Z)', () => ed.undo(), 'icon');
  const redoBtn = btn('↪', 'Повтор (Ctrl+Y)', () => ed.redo(), 'icon');
  const saveBtn = btn('💾', 'Сохранить уровень (Ctrl+S или Enter)', () => void ed.save(), 'primary icon');
  const zoomLabel = h('span', { class: 'zoom-label' }, '100%');

  // ---- «Вид»: что показывать. Скрытое не рисуется и не выбирается мышью — чтобы не мешало
  const VIEW_OPTIONS: Array<[LayerKey, string]> = [
    ['grid', 'Сетка'],
    ['rooms', 'Контуры комнат'],
    ['fog', 'Предпросмотр тумана'],
    ['collisions', 'Коллизии'],
    ['labels', 'Подписи'],
    ['background', 'Цвет фона']
  ];
  const viewMenu = h('div', { class: 'layers-menu' });
  viewMenu.style.display = 'none';
  const viewBtn = h('button', { class: 'btn', title: 'Вид и слои', onclick: (e: Event) => {
    e.stopPropagation();
    viewMenu.style.display = viewMenu.style.display === 'none' ? 'block' : 'none';
    const r = viewBtn.getBoundingClientRect();
    viewMenu.style.top = `${r.bottom + 4}px`;
    viewMenu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 290))}px`;
    renderView();
  } }, '👁 Вид');
  function checkRow(key: LayerKey, label: string, solo = false): HTMLElement {
    const cb = h('input', { type: 'checkbox', checked: ed.show[key] }) as HTMLInputElement;
    cb.addEventListener('change', () => { ed.show[key] = cb.checked; ed.emit('view'); });
    return h('label', { class: 'layer-row' }, cb, h('span', {}, label),
      solo ? h('button', { class: 'btn small', title: 'Показать только этот слой (и тайлы)', onclick: (e: Event) => {
        e.preventDefault();
        for (const [k] of CONTENT_LAYERS) ed.show[k] = k === key || k === 'tiles';
        ed.emit('view');
      } }, 'solo') : null);
  }
  function renderView(): void {
    clear(viewMenu);
    viewMenu.append(h('div', { class: 'layers-title' }, 'Слои'));
    for (const [key, label] of CONTENT_LAYERS) viewMenu.append(checkRow(key, label, true));
    viewMenu.append(h('div', { class: 'layers-head' },
      h('button', { class: 'btn small', onclick: () => { for (const [k] of CONTENT_LAYERS) ed.show[k] = true; ed.emit('view'); } }, 'Все'),
      h('button', { class: 'btn small', onclick: () => { for (const [k] of CONTENT_LAYERS) ed.show[k] = k === 'tiles'; ed.emit('view'); } }, 'Только тайлы')));
    viewMenu.append(h('div', { class: 'layers-title' }, 'Показывать'));
    for (const [key, label] of VIEW_OPTIONS) viewMenu.append(checkRow(key, label));
  }
  document.addEventListener('click', (e) => {
    if (!viewMenu.contains(e.target as Node)) viewMenu.style.display = 'none';
  });
  document.body.append(viewMenu);
  ed.on('view', () => { if (viewMenu.style.display !== 'none') renderView(); });

  topbar.append(
    h('div', { class: 'brand' }, h('b', {}, 'LD60')),
    levelSelect,
    btn('+', 'Новый уровень', () => openNewLevelDialog(), 'icon'),
    saveBtn, dirtyMark, undoBtn, redoBtn,
    h('span', { class: 'sep' }),
    btn('⇆', 'Отразить (X): кисть, выбранное или блок тайлов', () => ed.transform('flipH'), 'icon'),
    btn('⇅', 'Перевернуть (Y)', () => ed.transform('flipV'), 'icon'),
    btn('↻', 'Повернуть на 90° (R)', () => ed.transform('rotate'), 'icon'),
    h('span', { class: 'sep' }),
    btn('▶', 'Играть: сохранить и запустить этот уровень с нуля (P)', () => void play(false), 'success icon'),
    btn('▶⌖', 'Играть с клетки под курсором (Shift+P)', () => void play(true), 'success'),
    h('span', { class: 'sep' }),
    viewBtn,
    h('span', { class: 'sep' }),
    btn('−', 'Уменьшить', () => ed.zoomAt(1 / 1.25, canvas.width / 2, canvas.height / 2), 'icon'),
    zoomLabel,
    btn('+', 'Увеличить', () => ed.zoomAt(1.25, canvas.width / 2, canvas.height / 2), 'icon'),
    btn('⛶', 'Показать весь уровень (Home)', () => ed.fitView(), 'icon')
  );

  function sync(): void {
    undoBtn.disabled = !ed.canUndo;
    redoBtn.disabled = !ed.canRedo;
    dirtyMark.textContent = ed.dirty ? '●' : '';
    dirtyMark.title = ed.dirty ? 'Есть несохранённые правки' : '';
    zoomLabel.textContent = `${Math.round(ed.view.zoom * 100)}%`;
    document.title = `${ed.dirty ? '● ' : ''}${ed.def?.display_name ?? ed.def?.id ?? ''} — Редактор LD60`;
  }

  function fillLevels(): void {
    clear(levelSelect);
    for (const l of ed.project.levels) levelSelect.append(h('option', { value: l.filename, selected: l.filename === ed.filename }, l.data.display_name && l.data.display_name !== l.data.id ? `${l.data.display_name} · ${l.data.id}` : l.data.id));
    levelSelect.value = ed.filename;
  }

  // ---- левая панель инструментов
  const toolEls = new Map<ToolId, HTMLElement>();
  for (const t of TOOLS) {
    const el = h('button', { class: 'tool', title: `${t.label} [${t.key}]`, onclick: () => chooseTool(t.id) }, h('span', { class: 'ico' }, t.icon), h('span', { class: 'key' }, t.key));
    toolEls.set(t.id, el);
    toolbar.append(el);
  }
  function chooseTool(id: ToolId): void {
    // инструмент работает со своим слоем — если он был скрыт, показываем
    const need: Partial<Record<ToolId, LayerKey[]>> = {
      brush: ['tiles'], eraser: ['tiles'], rect: ['tiles'], fill: ['tiles'], decor: ['decorBack', 'decorFront'], thread: ['threads'], mob: ['enemies'], object: ['objects'], spawn: ['spawn']
    };
    for (const k of need[id] ?? []) ed.show[k] = true;
    // инструмент расстановки без выбранного предмета берёт первый из каталога
    if (id === 'decor' && !ed.armedDecor) ed.armedDecor = ed.project.placeables.decor[0] ?? null;
    if (id === 'thread' && !ed.armedThread) ed.armedThread = ed.project.placeables.threads[0] ?? null;
    if (id === 'object' && !ed.armedObject) ed.armedObject = ed.project.placeables.objects[0] ?? null;
    if (id === 'mob' && !ed.armedEnemy) {
      const first = ed.project.enemies.find((e) => e.sprite_variants.length && !['flying_worm', 'flying_bird', 'crab_boss'].includes(e.behavior_type));
      if (first) ed.armedEnemy = { def: first, sprite_id: first.sprite_variants[0] };
    }
    ed.setTool(id);
    const tab = TOOLS.find((t) => t.id === id)?.tab;
    if (tab) panels.showTab(tab);
  }
  ed.on('tool', () => {
    for (const [id, el] of toolEls) el.classList.toggle('active', id === ed.tool);
    canvas.style.cursor = ed.tool === 'select' ? 'default' : 'crosshair';
  });

  // ---- строка состояния: сообщение (5 с), потом подсказка по текущему инструменту
  let lastText = '';
  let lastAt = 0;
  const renderStatus = () => {
    const s = ed.statusText;
    if (s.text !== lastText) {
      lastText = s.text;
      lastAt = performance.now();
      setTimeout(renderStatus, 5200);
    }
    const fresh = !!s.text && performance.now() - lastAt < 5000;
    const hint = TOOLS.find((t) => t.id === ed.tool)?.hint ?? '';
    const hv = ed.hover;
    const rooms = hv.inside ? ed.roomsAtCell(hv.cx, hv.cy).map((r) => r.location ? `${r.name} [Лока ${r.location}]` : r.name).join(', ') : '';
    clear(statusbar);
    statusbar.append(
      h('span', { class: fresh && s.error ? 'err' : '' }, fresh ? s.text : hint),
      h('span', { class: 'right' }, hv.inside ? `${hv.cx}, ${hv.cy} · ${Math.round(hv.wx)}, ${Math.round(hv.wy)}${rooms ? ` · ${rooms}` : ''}` : '')
    );
  };
  ed.on('status', renderStatus);
  ed.on('tool', renderStatus);
  for (const ch of ['doc', 'view', 'tool', 'project'] as const) ed.on(ch, sync);
  ed.on('project', fillLevels);
  ed.on('doc', () => {
    if (levelSelect.value !== ed.filename) fillLevels();
  });

  // ---- игра
  async function play(fromCursor: boolean): Promise<void> {
    if (ed.dirty && !(await ed.save())) return;
    const spawn = fromCursor && ed.hover.inside ? { x: ed.hover.cx, y: ed.hover.cy } : undefined;
    window.open(ed.playUrl(spawn), 'ld60-game');
  }

  // ---- новый уровень
  function openNewLevelDialog(): void {
    const dlg = h('dialog', { class: 'dialog' }) as HTMLDialogElement;
    let id = 'loc5';
    let name = 'Новая локация';
    let w = 40;
    let hgt = 20;
    let tile = ed.project.tiles.tiles.find((t) => t.solid && !t.slope)?.id ?? '';
    let bg = '';
    const err = h('p', { class: 'warn' });
    dlg.append(
      h('h3', {}, 'Новый уровень'),
      field('Id (латиница, имя файла)', textInput(id, (v) => { id = v.trim(); })),
      field('Название', textInput(name, (v) => { name = v; })),
      field('Ширина (клетки)', numberInput(w, (v) => { w = Math.max(8, Math.min(400, v)); })),
      field('Высота (клетки)', numberInput(hgt, (v) => { hgt = Math.max(6, Math.min(200, v)); })),
      field('Тайл пола', select(tile, ed.project.tiles.tiles.filter((t) => t.solid).map((t): [string, string] => [t.id, t.display_name ?? t.id]), (v) => { tile = v; })),
      field('Фон', select(bg, [['', '(нет)'], ...ed.project.backgrounds.map((b): [string, string] => [b.id, b.id])], (v) => { bg = v; })),
      err,
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn primary', onclick: () => {
          if (!/^[a-z0-9_]+$/i.test(id)) { err.textContent = 'Id: только латиница, цифры и _'; return; }
          if (ed.levelIds().includes(id)) { err.textContent = 'Уровень с таким id уже есть'; return; }
          const def = newLevel(id, name, tile || null, w, hgt, ed.project.tiles.tile_size);
          if (bg) def.background_id = bg;
          dlg.close();
          ed.createLevel(def);
          void ed.save();
        } }, 'Создать'),
        h('button', { class: 'btn', onclick: () => dlg.close() }, 'Отмена'))
    );
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  }

  // ---- клавиатура
  window.addEventListener('keydown', (e) => {
    tools.setModifiers(e.altKey);
    redraw();
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const active = document.activeElement as HTMLElement | null;
    // Сохранение, отмена и повтор — глобальные: работают, даже когда фокус в поле ввода (поле сначала фиксирует значение)
    if (ctrl && k === 's') { e.preventDefault(); active?.blur(); void ed.save(); return; }
    if (ctrl && k === 'z') { e.preventDefault(); active?.blur(); if (e.shiftKey) ed.redo(); else ed.undo(); return; }
    if (ctrl && k === 'y') { e.preventDefault(); active?.blur(); ed.redo(); return; }
    if (e.key === 'Enter' && !ctrl && !e.altKey && !e.shiftKey && !document.querySelector('dialog[open]')) {
      e.preventDefault();
      active?.blur();
      void ed.save();
      return;
    }
    if (isTyping(e)) return;
    if (ctrl && k === 'c') { e.preventDefault(); ed.copySelection(); return; }
    if (ctrl && k === 'v') { e.preventDefault(); ed.paste(ed.hover.cx, ed.hover.cy); return; }
    if (ctrl && k === 'd') { e.preventDefault(); ed.duplicateSelection(); return; }
    if (ctrl || e.altKey) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      // Ничего не выбрано — удаляем то, что под курсором (в инструментах расстановки — только свою категорию)
      if (ed.selection.kind === 'none' && ed.hover.inside) {
        const kinds = ed.tool === 'select' ? undefined : TOOL_KINDS[ed.tool];
        const hit = ed.tool === 'select' || kinds ? pickEntity(ed, ed.hover.wx, ed.hover.wy, kinds) : null;
        if (hit && hit.kind !== 'spawn') {
          ed.setSelection({ kind: hit.kind, index: hit.index });
          ed.deleteSelection();
          return;
        }
      }
      ed.deleteSelection();
      return;
    }
    if (e.key === 'Escape') { ed.setSelection({ kind: 'none' }); if (ed.tool !== 'select') chooseTool('select'); return; }
    if (e.key === 'Home') { ed.fitView(); return; }
    if (e.key === '+' || e.key === '=') { ed.zoomAt(1.25, canvas.width / 2, canvas.height / 2); return; }
    if (e.key === '-') { ed.zoomAt(1 / 1.25, canvas.width / 2, canvas.height / 2); return; }
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[e.key]) { e.preventDefault(); tools.nudge(arrows[e.key][0], arrows[e.key][1], e.shiftKey); return; }
    if (k === 'x') { ed.transform('flipH'); return; }
    if (k === 'y') { ed.transform('flipV'); return; }
    if (k === 'r') { ed.transform('rotate'); return; }
    if (k === 'f') { ed.show.fog = !ed.show.fog; sync(); ed.emit('view'); return; }
    if (k === 'p') { void play(e.shiftKey); return; }
    const tool = TOOLS.find((t) => t.key.toLowerCase() === k);
    if (tool) chooseTool(tool.id);
  });
  window.addEventListener('keyup', (e) => {
    tools.setModifiers(e.altKey);
    redraw();
  });
  window.addEventListener('beforeunload', (e) => {
    if (ed.dirty) e.preventDefault();
  });

  // ---- старт
  resizeCanvas();
  const wanted = new URLSearchParams(location.search).get('level');
  const first = project.levels.find((l) => l.data.id === wanted) ?? project.levels[0];
  if (!first) {
    ed.setStatus('В data/levels нет уровней — создайте новый.', true);
    openNewLevelDialog();
    return;
  }
  ed.openLevel(first.filename);
  fillLevels();
  chooseTool('brush');
  sync();
  ed.setStatus(`Открыт ${first.filename}. Колесо — масштаб, ПКМ или пробел — двигать карту, СКМ — стереть.`);
  (window as unknown as { __editor: Editor }).__editor = ed;
}

void start();
