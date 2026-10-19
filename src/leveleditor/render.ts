import type { EnemySpawnDef, LevelDef, Slope } from '../data/types.ts';
import { cellKey, tileVisual, transformSlope, xformMap } from '../world/tileRules.ts';
import type { Editor } from './state.ts';
import { canonXf, roomHas, tileIdAt } from './model.ts';
import type { RoomDef } from '../data/types.ts';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const THREAD_SPRITE = 'enemy_spider_thread';
const THREAD_CENTER_X = 5;
const VINE_PIECE = 14;

// ---------- Геометрия сущностей (общая для рисования и выбора мышью) ----------

interface SpriteSpot {
  id: string;
  x: number;
  y: number;
  flipX?: boolean;
  flipY?: boolean;
}

/** Где и каким спрайтом рисуется враг (по тем же правилам привязки, что в игре: ноги — на низ клетки, летающие — в центр клетки). */
export function enemySpot(ed: Editor, e: EnemySpawnDef): SpriteSpot {
  const ts = ed.ts;
  const def = ed.enemyDef(e.enemy_id);
  const sd = ed.atlas.def(e.sprite_id);
  if (def?.behavior_type === 'spawner') return { id: e.sprite_id, x: e.x * ts + (sd ? sd.frame_width * sd.origin.x : 0), y: e.y * ts + (sd ? sd.frame_height * sd.origin.y : 0) };
  const centred = def?.behavior_type === 'flying_worm' || (sd && sd.origin.y < 0.9);
  return { id: e.sprite_id, x: (e.x + 0.5) * ts, y: centred ? (e.y + 0.5) * ts : (e.y + 1) * ts };
}

function spriteBox(ed: Editor, s: SpriteSpot): Box {
  const sd = ed.atlas.def(s.id);
  if (!sd) return { x: s.x - 12, y: s.y - 24, w: 24, h: 24 };
  return { x: s.x - sd.frame_width * sd.origin.x, y: s.y - sd.frame_height * sd.origin.y, w: sd.frame_width, h: sd.frame_height };
}

export function selectionBox(ed: Editor): Box | null {
  const s = ed.selection;
  const ts = ed.ts;
  switch (s.kind) {
    case 'tiles': return { x: s.x0 * ts, y: s.y0 * ts, w: (s.x1 - s.x0 + 1) * ts, h: (s.y1 - s.y0 + 1) * ts };
    case 'spawn': return { x: ed.def.player_spawn.x * ts, y: ed.def.player_spawn.y * ts, w: ts, h: ts };
    case 'none': return null;
    default: return entityBox(ed, s.kind, s.index);
  }
}

export function entityBox(ed: Editor, kind: 'decor' | 'thread' | 'enemy' | 'object' | 'terminal', index: number): Box | null {
  const ts = ed.ts;
  const def = ed.def;
  switch (kind) {
    case 'decor': {
      const d = def.decor?.[index];
      return d ? spriteBox(ed, { id: d.sprite_id, x: d.x * ts, y: d.y * ts }) : null;
    }
    case 'object': {
      const o = def.objects?.[index];
      const k = o && ed.objectKind(o.type);
      return o && k ? spriteBox(ed, { id: objectSprite(ed, o), x: o.x, y: o.y }) : o ? { x: o.x - 12, y: o.y - 24, w: 24, h: 24 } : null;
    }
    case 'terminal': {
      const t = def.terminals?.[index];
      return t ? spriteBox(ed, { id: t.sprite_id, x: (t.x + 0.5) * ts, y: (t.y + 1) * ts }) : null;
    }
    case 'enemy': {
      const e = def.enemies[index];
      return e ? spriteBox(ed, enemySpot(ed, e)) : null;
    }
    case 'thread': {
      const t = def.threads?.[index];
      if (!t) return null;
      const len = t.kind === 'vine' ? (t.pieces ?? 3) * VINE_PIECE : (t.length ?? 160);
      return { x: t.x - 5, y: t.y, w: 10, h: len };
    }
  }
}

/** Спрайт объекта: предмет-подбор рисуется своим спрайтом из каталога предметов. */
function objectSprite(ed: Editor, o: NonNullable<LevelDef['objects']>[number]): string {
  const k = ed.objectKind(o.type);
  if (k?.behavior === 'pickup') {
    const item = ed.project.placeables.items.find((i) => i.id === o.props?.item);
    if (item) return item.sprite_id;
  }
  return k?.sprite_id ?? '';
}

type EntityKind = 'decor' | 'thread' | 'enemy' | 'object' | 'terminal';

/**
 * Что под курсором: самое верхнее по порядку отрисовки. only — искать только предметы этих видов (инструмент расстановки трогает
 * только свою категорию); скрытые слои не выбираются.
 */
export function pickEntity(ed: Editor, wx: number, wy: number, only?: readonly EntityKind[]): { kind: EntityKind | 'spawn'; index: number } | null {
  const inside = (b: Box | null, pad = 0) => !!b && wx >= b.x - pad && wx <= b.x + b.w + pad && wy >= b.y - pad && wy <= b.y + b.h + pad;
  const def = ed.def;
  const ts = ed.ts;
  const allow = (k: EntityKind) => (!only || only.includes(k));
  const sp = def.player_spawn;
  if (!only && ed.visible('spawn') && wx >= sp.x * ts && wx <= (sp.x + 1) * ts && wy >= sp.y * ts && wy <= (sp.y + 1) * ts) return { kind: 'spawn', index: 0 };
  const scan = (kind: EntityKind, count: number, pad = 0) => {
    for (let i = count - 1; i >= 0; i--) if (ed.visible(kind, i) && inside(entityBox(ed, kind, i), Math.max(pad, pad ? 8 / ed.view.zoom : 0))) return { kind, index: i };
    return null;
  };
  return (allow('enemy') ? scan('enemy', def.enemies.length) : null)
    ?? (allow('object') ? scan('object', def.objects?.length ?? 0) : null)
    ?? (allow('terminal') ? scan('terminal', def.terminals?.length ?? 0) : null)
    ?? (allow('thread') ? scan('thread', def.threads?.length ?? 0, 3) : null)
    ?? (allow('decor') ? scan('decor', def.decor?.length ?? 0) : null);
}

// ---------- Рисование ----------

type Overlay = (ctx: CanvasRenderingContext2D, ed: Editor) => void;

export function render(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, ed: Editor, overlay: Overlay): void {
  const def = ed.def;
  const { zoom, panX, panY } = ed.view;
  const ts = ed.ts;
  const W = canvas.width;
  const H = canvas.height;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#0b0f17';
  ctx.fillRect(0, 0, W, H);
  ctx.setTransform(zoom, 0, 0, zoom, -panX * zoom, -panY * zoom);
  ctx.imageSmoothingEnabled = false;

  const x0 = Math.max(0, Math.floor(panX / ts));
  const y0 = Math.max(0, Math.floor(panY / ts));
  const x1 = Math.min(def.width - 1, Math.ceil((panX + W / zoom) / ts));
  const y1 = Math.min(def.height - 1, Math.ceil((panY + H / zoom) / ts));

  // фон уровня: цвет неба из параллакс-фона
  const bg = def.background_id ? ed.project.backgrounds.find((b) => b.id === def.background_id) : undefined;
  ctx.fillStyle = ed.show.background && bg ? bg.sky_color : '#121826';
  ctx.fillRect(0, 0, def.width * ts, def.height * ts);

  if (ed.show.decorBack) drawDecor(ctx, ed, 'back');
  if (ed.show.tiles) drawTiles(ctx, ed, x0, y0, x1, y1);
  if (ed.show.threads) drawThreads(ctx, ed);
  if (ed.show.decorFront) drawDecor(ctx, ed, 'front');
  if (ed.show.enemies) drawSpawnZones(ctx, ed);
  if (ed.show.objects) drawObjects(ctx, ed);
  if (ed.show.rooms) drawRooms(ctx, ed, x0, y0, x1, y1);
  if (ed.show.collisions) drawCollisions(ctx, ed, x0, y0, x1, y1);
  if (ed.show.enemies) drawEnemies(ctx, ed);
  if (ed.show.spawn) drawSpawn(ctx, ed);
  if (ed.show.fog) drawFogPreview(ctx, ed, x0, y0, x1, y1);
  if (ed.show.grid && zoom >= 0.35) drawGrid(ctx, ed, x0, y0, x1, y1);

  // рамка уровня
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 2 / zoom;
  ctx.strokeRect(0, 0, def.width * ts, def.height * ts);

  drawSelection(ctx, ed);
  overlay(ctx, ed);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** Старые зоны появления мобов (spawn_zones): рамка и подпись — в игре мобы раскладываются по полу внутри. */
function drawSpawnZones(ctx: CanvasRenderingContext2D, ed: Editor): void {
  const ts = ed.ts;
  for (const z of ed.def.spawn_zones ?? []) {
    ctx.strokeStyle = 'rgba(248, 113, 113, 0.8)';
    ctx.fillStyle = 'rgba(248, 113, 113, 0.08)';
    ctx.lineWidth = 2 / ed.view.zoom;
    ctx.setLineDash([6, 4]);
    ctx.fillRect(z.x * ts, z.y * ts, z.width * ts, z.height * ts);
    ctx.strokeRect(z.x * ts, z.y * ts, z.width * ts, z.height * ts);
    ctx.setLineDash([]);
    ctx.fillStyle = '#f87171';
    ctx.font = '10px monospace';
    ctx.fillText(`${z.name ?? z.id}: ${z.enemy_id} ×${z.count}`, z.x * ts + 4, z.y * ts + 12);
    const sprite = z.sprite_id ?? ed.enemyDef(z.enemy_id)?.sprite_variants[0];
    if (sprite) ed.atlas.draw(ctx, sprite, 0, z.x * ts + ts / 2, (z.y + z.height) * ts, { alpha: 0.5 });
  }
}

function drawTiles(ctx: CanvasRenderingContext2D, ed: Editor, x0: number, y0: number, x1: number, y1: number): void {
  const def = ed.def;
  const ts = ed.ts;
  const xforms = xformMap(def.tile_xform);
  const tileAt = (cx: number, cy: number) => ed.tileDef(tileIdAt(def, cx, cy));
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      const tile = tileAt(cx, cy);
      if (!tile) continue;
      const xf = xforms.get(cellKey(cx, cy));
      const look = tileVisual(tile);
      const c = xf ? canonXf(xf) : undefined;
      if (tile.slope) {
        const slope = transformSlope(tile.slope, xf);
        ctx.save();
        ctx.beginPath();
        slopePath(ctx, slope, cx * ts, cy * ts, ts);
        ctx.clip();
        ed.atlas.drawTile(ctx, look.sprite_id, look.frame, cx * ts, cy * ts, ts, c);
        ctx.restore();
        ctx.strokeStyle = 'rgba(74, 222, 128, 0.9)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        diagonal(ctx, slope, cx * ts, cy * ts, ts);
        ctx.stroke();
      } else {
        ed.atlas.drawTile(ctx, look.sprite_id, look.frame, cx * ts, cy * ts, ts, c);
      }
    }
  }
}

function slopePath(ctx: CanvasRenderingContext2D, slope: Slope, ox: number, oy: number, ts: number): void {
  if (slope === 'up_right') poly(ctx, [[ox, oy + ts], [ox + ts, oy + ts], [ox + ts, oy]]);
  else if (slope === 'up_left') poly(ctx, [[ox, oy], [ox, oy + ts], [ox + ts, oy + ts]]);
  else if (slope === 'ceil_right') poly(ctx, [[ox, oy], [ox + ts, oy], [ox + ts, oy + ts]]);
  else poly(ctx, [[ox, oy], [ox + ts, oy], [ox, oy + ts]]);
}

function diagonal(ctx: CanvasRenderingContext2D, slope: Slope, ox: number, oy: number, ts: number): void {
  if (slope === 'up_right' || slope === 'ceil_left') {
    ctx.moveTo(ox, oy + ts);
    ctx.lineTo(ox + ts, oy);
  } else {
    ctx.moveTo(ox, oy);
    ctx.lineTo(ox + ts, oy + ts);
  }
}

function poly(ctx: CanvasRenderingContext2D, pts: number[][]): void {
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}

function drawDecor(ctx: CanvasRenderingContext2D, ed: Editor, layer: 'back' | 'front'): void {
  const ts = ed.ts;
  for (const d of ed.def.decor ?? []) {
    if ((d.layer === 'back' ? 'back' : 'front') !== layer) continue;
    ed.atlas.draw(ctx, d.sprite_id, 0, Math.round(d.x * ts), Math.round(d.y * ts), { flipX: d.flip_x, flipY: d.flip_y });
  }
}

/** Нитки: звенья спрайта нитки вдоль отрезка (качание в редакторе не показывается). */
export function drawThread(ctx: CanvasRenderingContext2D, ed: Editor, kind: string, x: number, y: number, size: number, alpha = 1): void {
  const len = kind === 'vine' ? size * VINE_PIECE : size;
  const pieces = Math.max(1, Math.ceil(len / VINE_PIECE));
  const sd = ed.atlas.def(THREAD_SPRITE);
  for (let i = 0; i < pieces; i++) {
    const py = y + i * VINE_PIECE;
    if (sd) ed.atlas.draw(ctx, THREAD_SPRITE, 0, x - THREAD_CENTER_X, py, { alpha });
    else {
      ctx.fillStyle = '#a5f3fc';
      ctx.fillRect(x - 1, py, 2, VINE_PIECE);
    }
  }
  ctx.fillStyle = kind === 'sky' ? '#7dd3fc' : '#eaffff';
  ctx.fillRect(x - 1, y + len - 1, 3, 3);
  // точка закрепления
  ctx.strokeStyle = kind === 'sky' ? '#38bdf8' : '#4ade80';
  ctx.lineWidth = 1;
  ctx.strokeRect(x - 2.5, y - 2.5, 5, 5);
}

function drawThreads(ctx: CanvasRenderingContext2D, ed: Editor): void {
  for (const t of ed.def.threads ?? []) drawThread(ctx, ed, t.kind, t.x, t.y, t.kind === 'vine' ? t.pieces ?? 3 : t.length ?? 160);
}

function drawObjects(ctx: CanvasRenderingContext2D, ed: Editor): void {
  const ts = ed.ts;
  for (const t of ed.def.terminals ?? []) ed.atlas.draw(ctx, t.sprite_id, 0, (t.x + 0.5) * ts, (t.y + 1) * ts);
  for (const o of ed.def.objects ?? []) {
    const k = ed.objectKind(o.type);
    ed.atlas.draw(ctx, objectSprite(ed, o), 0, o.x, o.y, { flipX: o.flip_x });
    if (k?.overlay) ed.atlas.draw(ctx, k.overlay.sprite_id, 0, o.x + k.overlay.x * (o.flip_x ? -1 : 1), o.y + k.overlay.y, { alpha: 0.5 });
    if (ed.show.labels) {
      ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
      const label = o.id;
      ctx.font = '9px monospace';
      const w = ctx.measureText(label).width + 4;
      ctx.fillRect(o.x - w / 2, o.y + 2, w, 11);
      ctx.fillStyle = k?.behavior === 'door' ? '#fbbf24' : '#a5f3fc';
      ctx.fillText(label, o.x - w / 2 + 2, o.y + 11);
      // связь двери с её парой на этом уровне
      if (k?.behavior === 'door' && o.props?.to_door && !o.props.to_level) {
        const to = ed.def.objects?.find((p) => p.id === o.props!.to_door);
        if (to) {
          ctx.strokeStyle = 'rgba(251, 191, 36, 0.7)';
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.moveTo(o.x, o.y - 24);
          ctx.lineTo(to.x, to.y - 24);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }
  }
}

function drawEnemies(ctx: CanvasRenderingContext2D, ed: Editor): void {
  const ts = ed.ts;
  for (const e of ed.def.enemies) {
    const spot = enemySpot(ed, e);
    const def = ed.enemyDef(e.enemy_id);
    if (def?.behavior_type === 'spawner') {
      // нитка паучихи от закрепления над уровнем
      ctx.strokeStyle = 'rgba(207, 250, 254, 0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(spot.x, (e.anchor_y ?? -2) * ts);
      ctx.lineTo(spot.x, spot.y);
      ctx.stroke();
    }
    ed.atlas.draw(ctx, spot.id, 0, spot.x, spot.y);
    const b = spriteBox(ed, spot);
    ctx.strokeStyle = 'rgba(248, 113, 113, 0.55)';
    ctx.lineWidth = 1;
    ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
    if (e.surface && e.surface !== 'floor') {
      ctx.fillStyle = '#f87171';
      ctx.font = '9px monospace';
      ctx.fillText({ ceiling: '▲ потолок', wall_left: '◀ стена', wall_right: 'стена ▶' }[e.surface] ?? e.surface, b.x, b.y - 2);
    }
    // привязка к комнате
    if (ed.show.rooms && ed.rooms.length) {
      const room = e.room ? ed.room(e.room) : ed.roomsAtCell(e.x, e.y)[0];
      if (room) {
        ctx.strokeStyle = ed.roomColor(room);
        ctx.lineWidth = 2;
        ctx.setLineDash([3, 3]);
        ctx.strokeRect(e.x * ts + 2, e.y * ts + 2, ts - 4, ts - 4);
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = '#f97316';
        ctx.font = 'bold 10px monospace';
        ctx.fillText('!нет комнаты', b.x, b.y + b.h + 10);
      }
    }
  }
}

function drawSpawn(ctx: CanvasRenderingContext2D, ed: Editor): void {
  const ts = ed.ts;
  const s = ed.def.player_spawn;
  const cx = (s.x + 0.5) * ts;
  ctx.fillStyle = 'rgba(74, 222, 128, 0.25)';
  ctx.strokeStyle = '#4ade80';
  ctx.lineWidth = 2;
  ctx.fillRect(s.x * ts, s.y * ts, ts, ts);
  ctx.strokeRect(s.x * ts + 1, s.y * ts + 1, ts - 2, ts - 2);
  // фигурка героя: голова и тело
  ctx.fillStyle = '#4ade80';
  ctx.fillRect(cx - 4, (s.y + 1) * ts - 28, 8, 8);
  ctx.fillRect(cx - 6, (s.y + 1) * ts - 20, 12, 14);
  ctx.font = 'bold 9px monospace';
  ctx.fillText('СТАРТ', cx - 16, s.y * ts - 3);
}

function drawRooms(ctx: CanvasRenderingContext2D, ed: Editor, x0: number, y0: number, x1: number, y1: number): void {
  const ts = ed.ts;
  const rooms = ed.rooms;
  const painting = ed.tool === 'room';
  for (const room of rooms) {
    const color = ed.roomColor(room);
    const active = room.id === ed.activeRoom;
    const rx0 = Math.max(x0, room.x);
    const ry0 = Math.max(y0, room.y);
    const rx1 = Math.min(x1, room.x + room.width - 1);
    const ry1 = Math.min(y1, room.y + room.height - 1);
    ctx.fillStyle = hexAlpha(color, active && painting ? 0.3 : 0.14);
    for (let cy = ry0; cy <= ry1; cy++) {
      for (let cx = rx0; cx <= rx1; cx++) if (roomHas(room, cx, cy)) ctx.fillRect(cx * ts, cy * ts, ts, ts);
    }
    // контур: стороны клеток, у которых сосед не в комнате
    ctx.strokeStyle = color;
    ctx.lineWidth = active ? 3 : 2;
    ctx.beginPath();
    for (let cy = ry0; cy <= ry1; cy++) {
      for (let cx = rx0; cx <= rx1; cx++) {
        if (!roomHas(room, cx, cy)) continue;
        const px = cx * ts;
        const py = cy * ts;
        if (!roomHas(room, cx - 1, cy)) { ctx.moveTo(px, py); ctx.lineTo(px, py + ts); }
        if (!roomHas(room, cx + 1, cy)) { ctx.moveTo(px + ts, py); ctx.lineTo(px + ts, py + ts); }
        if (!roomHas(room, cx, cy - 1)) { ctx.moveTo(px, py); ctx.lineTo(px + ts, py); }
        if (!roomHas(room, cx, cy + 1)) { ctx.moveTo(px, py + ts); ctx.lineTo(px + ts, py + ts); }
      }
    }
    ctx.stroke();
    if (ed.show.labels && room.width > 0) drawRoomLabel(ctx, room, ts, color);
  }
}

function drawRoomLabel(ctx: CanvasRenderingContext2D, room: RoomDef, ts: number, color: string): void {
  // подпись у первой клетки комнаты сверху-слева
  let lx = -1;
  let ly = -1;
  for (let cy = room.y; cy < room.y + room.height && ly < 0; cy++) {
    for (let cx = room.x; cx < room.x + room.width; cx++) if (roomHas(room, cx, cy)) { lx = cx; ly = cy; break; }
  }
  if (lx < 0) return;
  const labelText = room.location ? `[Лока ${room.location}] ${room.name}` : room.name;
  ctx.font = 'bold 11px sans-serif';
  const w = ctx.measureText(labelText).width + 8;
  ctx.fillStyle = 'rgba(11, 15, 23, 0.85)';
  ctx.fillRect(lx * ts + 3, ly * ts + 3, w, 16);
  ctx.fillStyle = color;
  ctx.fillText(labelText, lx * ts + 7, ly * ts + 15);
}

function hexAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Предпросмотр тумана: видна только активная комната (как видит её герой внутри), остальное — чёрное. */
function drawFogPreview(ctx: CanvasRenderingContext2D, ed: Editor, x0: number, y0: number, x1: number, y1: number): void {
  const ts = ed.ts;
  const room = ed.room(ed.activeRoom);
  ctx.fillStyle = '#000';
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      const open = !!room && roomHas(room, cx, cy);
      if (!open) ctx.fillRect(cx * ts, cy * ts, ts, ts);
    }
  }
}

function drawCollisions(ctx: CanvasRenderingContext2D, ed: Editor, x0: number, y0: number, x1: number, y1: number): void {
  const ts = ed.ts;
  ctx.strokeStyle = 'rgba(248, 113, 113, 0.8)';
  ctx.lineWidth = 1;
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) if (ed.isSolid(cx, cy)) ctx.strokeRect(cx * ts + 0.5, cy * ts + 0.5, ts - 1, ts - 1);
  }
}

function drawGrid(ctx: CanvasRenderingContext2D, ed: Editor, x0: number, y0: number, x1: number, y1: number): void {
  const ts = ed.ts;
  const z = ed.view.zoom;
  ctx.lineWidth = 1 / z;
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)';
  for (let cx = x0; cx <= x1 + 1; cx++) { ctx.moveTo(cx * ts, y0 * ts); ctx.lineTo(cx * ts, (y1 + 1) * ts); }
  for (let cy = y0; cy <= y1 + 1; cy++) { ctx.moveTo(x0 * ts, cy * ts); ctx.lineTo((x1 + 1) * ts, cy * ts); }
  ctx.stroke();
  // каждая 8-я линия ярче
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.3)';
  for (let cx = Math.ceil(x0 / 8) * 8; cx <= x1 + 1; cx += 8) { ctx.moveTo(cx * ts, y0 * ts); ctx.lineTo(cx * ts, (y1 + 1) * ts); }
  for (let cy = Math.ceil(y0 / 8) * 8; cy <= y1 + 1; cy += 8) { ctx.moveTo(x0 * ts, cy * ts); ctx.lineTo((x1 + 1) * ts, cy * ts); }
  ctx.stroke();
}

function drawSelection(ctx: CanvasRenderingContext2D, ed: Editor): void {
  const b = selectionBox(ed);
  if (!b) return;
  const z = ed.view.zoom;
  ctx.strokeStyle = '#fbbf24';
  ctx.lineWidth = 2 / z;
  ctx.setLineDash([6 / z, 4 / z]);
  ctx.strokeRect(b.x, b.y, b.w, b.h);
  ctx.setLineDash([]);
  if (ed.selection.kind === 'tiles') {
    ctx.fillStyle = 'rgba(251, 191, 36, 0.12)';
    ctx.fillRect(b.x, b.y, b.w, b.h);
  }
}
