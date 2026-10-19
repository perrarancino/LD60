import { TOOL_KINDS } from './state.ts';
import type { Editor, Placement, ToolId } from './state.ts';
import { drawThread, enemySpot, entityBox, pickEntity, selectionBox } from './render.ts';
import { inBounds } from './model.ts';

type Drag =
  | { kind: 'pan'; sx: number; sy: number; panX: number; panY: number }
  | { kind: 'paint'; erase: boolean; lastX: number; lastY: number }
  | { kind: 'rect'; erase: boolean; x0: number; y0: number }
  | { kind: 'selrect'; x0: number; y0: number }
  | { kind: 'move'; grabX: number; grabY: number; moved: boolean }
  | { kind: 'thread'; x: number; y: number; rawY: number }
  | { kind: 'room'; erase: boolean; lastX: number; lastY: number }
  | { kind: 'roomrect'; erase: boolean; x0: number; y0: number };

const TILE_TOOLS: ToolId[] = ['brush', 'eraser', 'rect', 'fill', 'pick'];

/**
 * Мышь и клавиатура на холсте: что делает каждый инструмент. Правки уровня идут через Editor (история, события);
 * здесь только разбор жестов, привязка к сетке/полу и рисование подсказок (призрак ставимого предмета).
 */
export class Tools {
  private drag: Drag | null = null;
  private space = false;
  private lastPaint: { x: number; y: number } | null = null;

  constructor(private readonly ed: Editor, private readonly canvas: HTMLCanvasElement, private readonly redraw: () => void) {
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    window.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointerleave', () => {
      this.ed.hover.inside = false;
      this.redraw();
    });
    canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !isTyping(e)) {
        this.space = true;
        this.canvas.style.cursor = 'grab';
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.space = false;
        this.canvas.style.cursor = this.ed.tool === 'select' ? 'default' : 'crosshair';
      }
    });
  }

  // ---------- Координаты ----------

  private point(e: PointerEvent | WheelEvent): { sx: number; sy: number; wx: number; wy: number; cx: number; cy: number } {
    const r = this.canvas.getBoundingClientRect();
    const sx = ((e.clientX - r.left) * this.canvas.width) / r.width;
    const sy = ((e.clientY - r.top) * this.canvas.height) / r.height;
    const w = this.ed.screenToWorld(sx, sy);
    const ts = this.ed.ts;
    return { sx, sy, wx: w.x, wy: w.y, cx: Math.floor(w.x / ts), cy: Math.floor(w.y / ts) };
  }

  private setHover(p: { wx: number; wy: number; cx: number; cy: number }, inside: boolean): void {
    this.ed.hover = { wx: p.wx, wy: p.wy, cx: p.cx, cy: p.cy, inside };
    this.ed.emit('status');
  }

  // ---------- Колесо ----------

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    const p = this.point(e);
    if (e.ctrlKey || e.metaKey || !e.shiftKey) {
      this.ed.zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, p.sx, p.sy);
    } else {
      const v = this.ed.view;
      this.ed.view = { ...v, panX: v.panX + e.deltaY / v.zoom };
      this.ed.emit('view');
    }
    this.redraw();
  }

  // ---------- Нажатие ----------

  private down(e: PointerEvent): void {
    const ed = this.ed;
    const p = this.point(e);
    this.canvas.setPointerCapture(e.pointerId);
    this.setHover(p, true);

    if (e.button === 2 || (e.button === 0 && this.space)) {
      this.drag = { kind: 'pan', sx: p.sx, sy: p.sy, panX: ed.view.panX, panY: ed.view.panY };
      this.canvas.style.cursor = 'grabbing';
      return;
    }
    const erase = e.button === 1;
    const tool = ed.tool;

    if (erase && !TILE_TOOLS.includes(tool) && tool !== 'room') {
      // средняя кнопка в инструментах расстановки — удалить то, что под курсором
      const hit = pickEntity(ed, p.wx, p.wy, TOOL_KINDS[tool]);
      if (hit && hit.kind !== 'spawn') {
        ed.setSelection({ kind: hit.kind, index: hit.index });
        ed.deleteSelection();
      }
      this.redraw();
      return;
    }
    if (e.button !== 0 && !erase) return;

    // Ctrl+клик в инструменте расстановки — выбрать уже стоящий предмет своей категории (двигать, править, Delete) вместо новой установки
    if (e.ctrlKey && !erase && TOOL_KINDS[tool]) {
      this.downSelect(p, TOOL_KINDS[tool]);
      this.redraw();
      return;
    }

    switch (tool) {
      case 'brush':
      case 'eraser': {
        const er = erase || tool === 'eraser';
        ed.beginEdit();
        // с Shift — прямая линия от последней нарисованной клетки
        if (e.shiftKey && this.lastPaint) this.line(this.lastPaint.x, this.lastPaint.y, p.cx, p.cy, (x, y) => ed.paintCell(x, y, er));
        else ed.paintCell(p.cx, p.cy, er);
        this.lastPaint = { x: p.cx, y: p.cy };
        ed.emit('doc');
        this.drag = { kind: 'paint', erase: er, lastX: p.cx, lastY: p.cy };
        break;
      }
      case 'rect':
        this.drag = { kind: 'rect', erase, x0: p.cx, y0: p.cy };
        break;
      case 'fill':
        ed.floodTiles(p.cx, p.cy, erase);
        break;
      case 'pick': {
        const id = ed.def.legend[ed.def.rows[p.cy]?.[p.cx] ?? '.'] ?? null;
        if (id) {
          ed.brushTile = id;
          const xf = ed.def.tile_xform?.find((t) => t.x === p.cx && t.y === p.cy);
          ed.brushXf = { flip_x: !!xf?.flip_x, rot: xf?.rot ?? 0 };
          ed.setTool('brush');
        }
        break;
      }
      case 'select':
        this.downSelect(p);
        break;
      case 'decor':
        if (ed.armedDecor) {
          const at = ed.snapPoint(placementOf(ed.armedDecor), p.wx, p.wy, e.altKey);
          ed.placeDecor(ed.armedDecor, at.x, at.y);
        }
        break;
      case 'object':
        if (ed.armedObject) {
          const at = ed.snapPoint(placementOf(ed.armedObject), p.wx, p.wy, e.altKey);
          ed.placeObject(ed.armedObject, at.x, at.y);
        }
        break;
      case 'thread':
        if (ed.armedThread) {
          // лиана цепляется по сетке к нижней грани тайла, нитка с неба — на пиксель (Alt — без привязки)
          const at = ed.snapPoint(threadPlacement(ed.armedThread), p.wx, p.wy, e.altKey);
          this.drag = { kind: 'thread', x: at.x, y: at.y, rawY: Math.round(p.wy) };
        }
        break;
      case 'mob':
        if (ed.armedEnemy) ed.placeEnemy(p.cx, p.cy);
        break;
      case 'spawn':
        if (inBounds(ed.def, p.cx, p.cy)) ed.setSpawn(p.cx, p.cy);
        break;
      case 'room':
        this.downRoom(p, erase);
        break;
    }
    this.redraw();
  }

  private downSelect(p: { wx: number; wy: number; cx: number; cy: number }, only?: Parameters<typeof pickEntity>[3]): void {
    const ed = this.ed;
    const hit = pickEntity(ed, p.wx, p.wy, only);
    if (hit) {
      ed.setSelection(hit.kind === 'spawn' ? { kind: 'spawn' } : { kind: hit.kind, index: hit.index });
      const b = selectionBox(ed);
      // сдвиг точки захвата: сущность не прыгает центром под курсор
      this.drag = { kind: 'move', grabX: b ? p.wx - (b.x + b.w / 2) : 0, grabY: b ? p.wy - (b.y + b.h / 2) : 0, moved: false };
      return;
    }
    const s = ed.selection;
    if (s.kind === 'tiles' && p.cx >= s.x0 && p.cx <= s.x1 && p.cy >= s.y0 && p.cy <= s.y1) return; // клик внутри выделения — оставить
    ed.setSelection({ kind: 'none' });
    this.drag = { kind: 'selrect', x0: p.cx, y0: p.cy };
  }

  private downRoom(p: { cx: number; cy: number }, erase: boolean): void {
    const ed = this.ed;
    if (!ed.room(ed.activeRoom)) {
      ed.setStatus('Сначала создайте комнату на вкладке «Комнаты».', true);
      return;
    }
    if (ed.roomMode === 'flood') {
      if (erase) return;
      if (!ed.floodRoom(p.cx, p.cy)) ed.setStatus('Не получилось залить: клетка в стене или помещение открыто (слишком большое). Замкните стены или рисуйте кистью.', true);
      return;
    }
    if (ed.roomMode === 'rect') {
      this.drag = { kind: 'roomrect', erase: erase || false, x0: p.cx, y0: p.cy };
      return;
    }
    const er = erase || ed.roomMode === 'erase';
    ed.beginEdit();
    ed.paintRoomCell(p.cx, p.cy, !er);
    ed.emit('doc');
    this.drag = { kind: 'room', erase: er, lastX: p.cx, lastY: p.cy };
  }

  // ---------- Движение ----------

  private move(e: PointerEvent): void {
    const ed = this.ed;
    const p = this.point(e);
    this.setHover(p, true);
    const d = this.drag;
    if (!d) {
      this.redraw();
      return;
    }
    switch (d.kind) {
      case 'pan': {
        const z = ed.view.zoom;
        ed.view = { ...ed.view, panX: d.panX - (p.sx - d.sx) / z, panY: d.panY - (p.sy - d.sy) / z };
        ed.emit('view');
        break;
      }
      case 'paint':
        this.line(d.lastX, d.lastY, p.cx, p.cy, (x, y) => ed.paintCell(x, y, d.erase));
        this.lastPaint = { x: p.cx, y: p.cy };
        d.lastX = p.cx;
        d.lastY = p.cy;
        ed.emit('doc');
        break;
      case 'room':
        this.line(d.lastX, d.lastY, p.cx, p.cy, (x, y) => ed.paintRoomCell(x, y, !d.erase));
        d.lastX = p.cx;
        d.lastY = p.cy;
        ed.emit('doc');
        break;
      case 'move':
        this.moveSelection(p, e.altKey, d);
        break;
      default:
        break;
    }
    this.redraw();
  }

  private line(x0: number, y0: number, x1: number, y1: number, fn: (x: number, y: number) => unknown): void {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= n; i++) fn(Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n));
  }

  private moveSelection(p: { wx: number; wy: number; cx: number; cy: number }, free: boolean, d: Extract<Drag, { kind: 'move' }>): void {
    const ed = this.ed;
    const s = ed.selection;
    const ts = ed.ts;
    if (s.kind === 'none' || s.kind === 'tiles') return;
    if (!d.moved) {
      ed.beginEdit();
      d.moved = true;
    }
    // центр сущности — под курсором с учётом точки захвата; привязка считается от самой точки курсора
    const wx = p.wx - d.grabX;
    const wy = p.wy - d.grabY;
    switch (s.kind) {
      case 'spawn':
        ed.def.player_spawn = { x: Math.max(0, Math.min(ed.def.width - 1, p.cx)), y: Math.max(0, Math.min(ed.def.height - 1, p.cy)) };
        break;
      case 'enemy': {
        const e = ed.def.enemies[s.index];
        if (e) {
          e.x = p.cx;
          e.y = p.cy;
        }
        break;
      }
      case 'terminal': {
        const t = ed.def.terminals?.[s.index];
        if (t) {
          const at = ed.snapPoint({ anchor: 'floor', snap: 'tile' }, p.wx, p.wy, free);
          t.x = Math.floor(at.x / ts);
          t.y = Math.round(at.y / ts) - 1;
        }
        break;
      }
      case 'decor': {
        const dec = ed.def.decor?.[s.index];
        if (dec) {
          const kind = ed.decorKind(dec.sprite_id);
          const at = ed.snapPoint(kind ? placementOf(kind) : { anchor: 'free', snap: 'pixel' }, p.wx, p.wy, free);
          dec.x = at.x / ts;
          dec.y = at.y / ts;
        }
        break;
      }
      case 'object': {
        const o = ed.def.objects?.[s.index];
        const kind = o && ed.objectKind(o.type);
        if (o) {
          const at = ed.snapPoint(kind ? placementOf(kind) : { anchor: 'free', snap: 'pixel' }, p.wx, p.wy, free);
          o.x = at.x;
          o.y = at.y;
        }
        break;
      }
      case 'thread': {
        const t = ed.def.threads?.[s.index];
        if (t) {
          const kind = ed.threadKind(t.kind);
          if (kind?.anchor === 'ceiling') {
            // лиана переезжает по сетке: к нижней грани тайла над курсором
            const at = ed.snapPoint(threadPlacement(kind), p.wx, p.wy, free);
            t.x = at.x;
            t.y = at.y;
          } else {
            t.x = Math.round(wx);
            t.y = Math.round(wy - (entityBox(ed, 'thread', s.index)?.h ?? 0) / 2);
          }
        }
        break;
      }
    }
    ed.dirty = true;
    ed.emit('doc');
  }

  // ---------- Отпускание ----------

  private up(e: PointerEvent): void {
    const ed = this.ed;
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.canvas.style.cursor = this.space ? 'grab' : (ed.tool === 'select' ? 'default' : 'crosshair');
    const p = this.point(e);
    switch (d.kind) {
      case 'paint':
        ed.endEdit();
        break;
      case 'room':
        ed.finishRoomPaint();
        ed.endEdit();
        break;
      case 'rect': {
        const r = rectOf(d.x0, d.y0, p.cx, p.cy);
        ed.beginEdit();
        const hollow = e.shiftKey;
        for (let y = r.y0; y <= r.y1; y++) {
          for (let x = r.x0; x <= r.x1; x++) {
            if (hollow && x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1) continue;
            ed.paintCell(x, y, d.erase);
          }
        }
        ed.endEdit();
        break;
      }
      case 'roomrect': {
        const r = rectOf(d.x0, d.y0, p.cx, p.cy);
        ed.beginEdit();
        for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) ed.paintRoomCell(x, y, !d.erase);
        ed.finishRoomPaint();
        ed.endEdit();
        break;
      }
      case 'selrect': {
        const r = rectOf(d.x0, d.y0, p.cx, p.cy);
        const x0 = Math.max(0, r.x0);
        const y0 = Math.max(0, r.y0);
        const x1 = Math.min(ed.def.width - 1, r.x1);
        const y1 = Math.min(ed.def.height - 1, r.y1);
        if (x1 >= x0 && y1 >= y0) ed.setSelection({ kind: 'tiles', x0, y0, x1, y1 });
        break;
      }
      case 'move':
        if (d.moved) ed.endEdit();
        break;
      case 'thread': {
        const kind = ed.armedThread;
        if (!kind) break;
        const dy = Math.max(0, Math.round(p.wy) - d.rawY);
        const dragged = dy > 6;
        const size = dragged ? (kind.kind === 'vine' ? Math.max(1, Math.round(dy / 14)) : Math.max(16, dy)) : undefined;
        ed.beginEdit();
        (ed.def.threads ??= []).push(ed.placeThread(kind, d.x, d.y, size));
        ed.endEdit();
        ed.setSelection({ kind: 'thread', index: ed.def.threads.length - 1 });
        break;
      }
      case 'pan':
        break;
    }
    this.redraw();
  }

  // ---------- Клавиатура ----------

  /** Сдвиг выбранного стрелками: объекты/декор/нитки — на пиксель (Shift — на 8), враги и старт — на клетку. */
  public nudge(dx: number, dy: number, big: boolean): void {
    const ed = this.ed;
    const s = ed.selection;
    const ts = ed.ts;
    const step = big ? 8 : 1;
    if (s.kind === 'none') return;
    ed.edit(() => {
      switch (s.kind) {
        case 'spawn':
          ed.def.player_spawn = { x: ed.def.player_spawn.x + dx, y: ed.def.player_spawn.y + dy };
          break;
        case 'enemy': {
          const e = ed.def.enemies[s.index];
          if (e) {
            e.x += dx;
            e.y += dy;
          }
          break;
        }
        case 'terminal': {
          const t = ed.def.terminals?.[s.index];
          if (t) {
            t.x += dx;
            t.y += dy;
          }
          break;
        }
        case 'decor': {
          const d = ed.def.decor?.[s.index];
          if (d) {
            d.x += (dx * step) / ts;
            d.y += (dy * step) / ts;
          }
          break;
        }
        case 'object': {
          const o = ed.def.objects?.[s.index];
          if (o) {
            o.x += dx * step;
            o.y += dy * step;
          }
          break;
        }
        case 'thread': {
          const t = ed.def.threads?.[s.index];
          if (t) {
            t.x += dx * step;
            t.y += dy * step;
          }
          break;
        }
        case 'tiles':
          break;
      }
    });
  }

  // ---------- Подсказки на холсте ----------

  public overlay = (ctx: CanvasRenderingContext2D, ed: Editor): void => {
    const z = ed.view.zoom;
    const ts = ed.ts;
    const h = ed.hover;
    const d = this.drag;

    if (d?.kind === 'rect' || d?.kind === 'roomrect' || d?.kind === 'selrect') {
      const r = rectOf(d.x0, d.y0, h.cx, h.cy);
      ctx.strokeStyle = d.kind === 'selrect' ? '#fbbf24' : d.kind === 'roomrect' ? '#38bdf8' : d.erase ? '#f87171' : '#4ade80';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.lineWidth = 2 / z;
      ctx.fillRect(r.x0 * ts, r.y0 * ts, (r.x1 - r.x0 + 1) * ts, (r.y1 - r.y0 + 1) * ts);
      ctx.strokeRect(r.x0 * ts, r.y0 * ts, (r.x1 - r.x0 + 1) * ts, (r.y1 - r.y0 + 1) * ts);
    }
    if (!h.inside || d?.kind === 'pan') return;

    const cellOutline = (color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2 / z;
      ctx.strokeRect(h.cx * ts, h.cy * ts, ts, ts);
    };
    switch (ed.tool) {
      case 'brush':
        if (ed.brushTile) {
          const tile = ed.tileDef(ed.brushTile);
          if (tile) {
            ed.atlas.drawTile(ctx, tile.sprite_id, tile.frame ?? 0, h.cx * ts, h.cy * ts, ts, ed.brushXf, 0.65);
          }
        }
        cellOutline('#4ade80');
        break;
      case 'eraser':
        cellOutline('#f87171');
        break;
      case 'rect':
      case 'fill':
      case 'pick':
      case 'spawn':
      case 'room':
        cellOutline(ed.tool === 'room' ? '#38bdf8' : '#4ade80');
        break;
      case 'decor':
        if (ed.armedDecor) this.ghostSprite(ctx, ed.armedDecor.sprite_id, ed.snapPoint(placementOf(ed.armedDecor), h.wx, h.wy, this.altHeld), ed.placeFlipX, ed.placeFlipY);
        break;
      case 'object':
        if (ed.armedObject) {
          const k = ed.armedObject;
          const at = ed.snapPoint(placementOf(k), h.wx, h.wy, this.altHeld);
          this.ghostSprite(ctx, k.sprite_id, at, !!k.flip && ed.placeFlipX, false);
        }
        break;
      case 'mob':
        if (ed.armedEnemy) {
          const spot = enemySpot(ed, { enemy_id: ed.armedEnemy.def.id, sprite_id: ed.armedEnemy.sprite_id, x: h.cx, y: h.cy });
          ctx.globalAlpha = 0.7;
          ed.atlas.draw(ctx, spot.id, 0, spot.x, spot.y);
          ctx.globalAlpha = 1;
          cellOutline('#f87171');
        }
        break;
      case 'thread':
        if (ed.armedThread) {
          const k = ed.armedThread;
          const t = d?.kind === 'thread' ? d : null;
          const snapped = ed.snapPoint(threadPlacement(k), h.wx, h.wy, this.altHeld);
          const x = t ? t.x : snapped.x;
          const y = t ? t.y : snapped.y;
          let size = k.kind === 'vine' ? k.defaults?.pieces ?? 3 : k.defaults?.length ?? 160;
          if (t) {
            const dy = Math.max(0, Math.round(h.wy) - t.rawY);
            if (dy > 6) size = k.kind === 'vine' ? Math.max(1, Math.round(dy / 14)) : Math.max(16, dy);
          }
          ctx.globalAlpha = 0.75;
          drawThread(ctx, ed, k.kind, x, y, size);
          ctx.globalAlpha = 1;
        }
        break;
      default:
        break;
    }
  };

  private get altHeld(): boolean {
    return this.alt;
  }

  private alt = false;

  public setModifiers(alt: boolean): void {
    this.alt = alt;
  }

  private ghostSprite(ctx: CanvasRenderingContext2D, id: string, at: { x: number; y: number }, flipX: boolean, flipY: boolean): void {
    this.ed.atlas.draw(ctx, id, 0, at.x, at.y, { flipX, flipY, alpha: 0.65 });
    // точка привязки: перекрестие
    const z = this.ed.view.zoom;
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 1 / z;
    ctx.beginPath();
    ctx.moveTo(at.x - 6 / z, at.y);
    ctx.lineTo(at.x + 6 / z, at.y);
    ctx.moveTo(at.x, at.y - 6 / z);
    ctx.lineTo(at.x, at.y + 6 / z);
    ctx.stroke();
  }
}

/** Привязка нитки из каталога: лиана — к потолку по сетке, нитка с неба — на пиксель. */
export function threadPlacement(k: { anchor?: Placement['anchor']; snap?: Placement['snap'] }): Placement {
  return { anchor: k.anchor ?? 'free', snap: k.snap ?? 'pixel' };
}

export function placementOf(k: { anchor: Placement['anchor']; snap: Placement['snap'] }): Placement {
  return { anchor: k.anchor, snap: k.snap };
}

function rectOf(x0: number, y0: number, x1: number, y1: number): { x0: number; y0: number; x1: number; y1: number } {
  return { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
}

export function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}
