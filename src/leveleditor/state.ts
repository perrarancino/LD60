import type { EnemyDef, EnemySpawnDef, LevelDef, LevelObjectDef, RoomDef, ThreadPlaceDef, TileDef } from '../data/types.ts';
import type { DecorKind, ObjectKind, PlaceAnchor, PlaceSnap, ThreadKind } from '../world/placeables.ts';
import { deleteLevel, saveLevel } from './api.ts';
import type { ProjectData } from './api.ts';
import { SpriteAtlas } from './assets.ts';
import {
  canonXf, clone, finalizeLevel, getXform, inBounds, isXfIdentity, newRoomId, normalizeRoom, resizeLevel, ROOM_COLORS, roomSet, roomsAt, setTile, setXform,
  tileIdAt, xfMirrorH, xfMirrorV, xfRotate
} from './model.ts';
import type { CanonXf, Xf } from './model.ts';

export type ToolId = 'select' | 'brush' | 'eraser' | 'rect' | 'fill' | 'pick' | 'decor' | 'thread' | 'mob' | 'object' | 'spawn' | 'room';
export type RoomMode = 'brush' | 'erase' | 'rect' | 'flood';

export type Selection =
  | { kind: 'none' }
  | { kind: 'tiles'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'decor' | 'thread' | 'enemy' | 'object' | 'terminal'; index: number }
  | { kind: 'spawn' };

export interface View {
  zoom: number;
  panX: number; // мировой px в левом верхнем углу холста
  panY: number;
}

export interface Hover {
  wx: number; // мир, px (дробный)
  wy: number;
  cx: number; // клетка
  cy: number;
  inside: boolean; // курсор над холстом
}

export interface TileClip {
  w: number;
  h: number;
  tiles: (string | null)[];
  xf: (CanonXf | undefined)[];
}

type Channel = 'doc' | 'sel' | 'tool' | 'view' | 'status' | 'project';

/** Куда ставится объект/декор: привязка к полу/потолку и шаг по x (см. data/objects/placeables.json). */
export interface Placement {
  anchor: PlaceAnchor;
  snap: PlaceSnap;
}

const HISTORY_LIMIT = 100;

/**
 * Состояние редактора: открытый уровень (LevelDef как есть), вид, инструмент, выделение, история. Все правки уровня идут через методы
 * этого класса — каждая записывается в историю (Ctrl+Z) и помечает уровень несохранённым.
 */
export class Editor {
  public readonly atlas: SpriteAtlas;
  public def!: LevelDef;
  public filename = '';
  public dirty = false;

  public view: View = { zoom: 1, panX: 0, panY: 0 };
  public hover: Hover = { wx: 0, wy: 0, cx: 0, cy: 0, inside: false };

  public tool: ToolId = 'brush';
  public brushTile: string | null = null;
  public brushXf: CanonXf = { flip_x: false, rot: 0 };
  public placeFlipX = false;
  public placeFlipY = false;
  public armedDecor: DecorKind | null = null;
  public armedThread: ThreadKind | null = null;
  public armedEnemy: { def: EnemyDef; sprite_id: string } | null = null;
  public armedObject: ObjectKind | null = null;
  public roomMode: RoomMode = 'brush';
  public activeRoom: string | null = null;
  public selection: Selection = { kind: 'none' };
  public clipboard: TileClip | null = null;

  // отображение
  public show = { grid: true, fog: false, rooms: true, collisions: false, decor: true, entities: true, background: true, labels: true };

  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private readonly listeners = new Map<Channel, Set<() => void>>();
  private status = '';
  private statusError = false;

  constructor(public project: ProjectData) {
    this.atlas = new SpriteAtlas(project.sprites.sprites);
  }

  // ---------- События ----------

  public on(channel: Channel, fn: () => void): void {
    if (!this.listeners.has(channel)) this.listeners.set(channel, new Set());
    this.listeners.get(channel)!.add(fn);
  }

  /** Растёт при каждой правке уровня: по нему кэшируется то, что дорого считать (раскладка автодекора). */
  public rev = 0;

  public emit(channel: Channel): void {
    if (channel === 'doc') this.rev++;
    for (const fn of this.listeners.get(channel) ?? []) fn();
  }

  public get statusText(): { text: string; error: boolean } {
    return { text: this.status, error: this.statusError };
  }

  public setStatus(text: string, error = false): void {
    this.status = text;
    this.statusError = error;
    this.emit('status');
  }

  // ---------- Справочники ----------

  public get ts(): number {
    return this.def.tile_size;
  }

  public tileDef(id: string | null): TileDef | undefined {
    return id ? this.project.tiles.tiles.find((t) => t.id === id) : undefined;
  }

  public isSolid(cx: number, cy: number): boolean {
    if (cx < 0 || cx >= this.def.width) return true;
    if (cy < 0 || cy >= this.def.height) return false;
    return !!this.tileDef(tileIdAt(this.def, cx, cy))?.solid;
  }

  public enemyDef(id: string): EnemyDef | undefined {
    return this.project.enemies.find((e) => e.id === id);
  }

  public decorKind(spriteId: string): DecorKind | undefined {
    return this.project.placeables.decor.find((d) => d.sprite_id === spriteId);
  }

  public objectKind(type: string): ObjectKind | undefined {
    return this.project.placeables.objects.find((o) => o.type === type);
  }

  public threadKind(kind: string): ThreadKind | undefined {
    return this.project.placeables.threads.find((t) => t.kind === kind);
  }

  public get rooms(): RoomDef[] {
    return this.def.rooms ?? [];
  }

  public room(id: string | null): RoomDef | undefined {
    return id ? this.rooms.find((r) => r.id === id) : undefined;
  }

  public roomColor(room: RoomDef): string {
    return room.color ?? ROOM_COLORS[Math.max(0, this.rooms.indexOf(room)) % ROOM_COLORS.length];
  }

  /** Id других уровней (для дверей). */
  public levelIds(): string[] {
    return this.project.levels.map((l) => l.data.id);
  }

  public levelById(id: string): LevelDef | undefined {
    if (id === this.def.id) return this.def;
    return this.project.levels.find((l) => l.data.id === id)?.data;
  }

  // ---------- Уровень: открытие, создание, сохранение ----------

  public openLevel(filename: string): void {
    const entry = this.project.levels.find((l) => l.filename === filename);
    if (!entry) return;
    this.def = clone(entry.data);
    this.filename = filename;
    this.dirty = false;
    this.undoStack = [];
    this.redoStack = [];
    this.selection = { kind: 'none' };
    this.activeRoom = this.def.rooms?.[0]?.id ?? null;
    if (!this.brushTile) this.brushTile = this.project.tiles.tiles.find((t) => t.solid && !t.slope)?.id ?? null;
    this.emit('doc');
    this.emit('sel');
    this.fitView();
  }

  public createLevel(def: LevelDef): void {
    const filename = `${def.id}.json`;
    this.project.levels.push({ filename, data: clone(def) });
    this.openLevel(filename);
    this.dirty = true;
    this.emit('project');
  }

  public async save(): Promise<boolean> {
    const out = clone(this.def);
    finalizeLevel(out);
    try {
      const res = await saveLevel(this.filename, out);
      const entry = this.project.levels.find((l) => l.filename === this.filename);
      if (entry) entry.data = clone(out);
      this.filename = res.filename;
      this.def = out;
      this.dirty = false;
      if (this.activeRoom && !this.room(this.activeRoom)) this.activeRoom = this.rooms[0]?.id ?? null;
      this.setStatus(`Сохранено: data/levels/${res.filename}`);
      this.emit('doc');
      return true;
    } catch (e) {
      this.setStatus(`Не удалось сохранить: ${(e as Error).message}`, true);
      // сервер редактора не ответил (закрыт exe?): не теряем работу — предлагаем скачать файл уровня
      if (confirm(`Не удалось сохранить на диск (${(e as Error).message}).
Возможно, закрыт LD60Editor.exe — запустите его снова.

Скачать уровень файлом, чтобы не потерять правки?`)) {
        const url = URL.createObjectURL(new Blob([`${JSON.stringify(out, null, 2)}
`], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = this.filename || `${out.id}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }
      return false;
    }
  }

  public async deleteCurrentLevel(): Promise<void> {
    const name = this.filename;
    try {
      await deleteLevel(name);
    } catch (e) {
      this.setStatus(`Не удалось удалить: ${(e as Error).message}`, true);
      return;
    }
    this.project.levels = this.project.levels.filter((l) => l.filename !== name);
    this.emit('project');
    const next = this.project.levels[0];
    if (next) this.openLevel(next.filename);
  }

  // ---------- История ----------

  /** Вызывать перед правкой: запоминает состояние для Ctrl+Z. */
  public beginEdit(): void {
    const snap = JSON.stringify(this.def);
    if (this.undoStack[this.undoStack.length - 1] !== snap) this.undoStack.push(snap);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Вызывать после правки. */
  public endEdit(): void {
    this.dirty = true;
    this.emit('doc');
  }

  /** Правка одним действием: begin -> fn -> end. */
  public edit(fn: () => void): void {
    this.beginEdit();
    fn();
    this.endEdit();
  }

  public undo(): void {
    const snap = this.undoStack.pop();
    if (!snap) return;
    this.redoStack.push(JSON.stringify(this.def));
    this.def = JSON.parse(snap) as LevelDef;
    this.afterHistory();
  }

  public redo(): void {
    const snap = this.redoStack.pop();
    if (!snap) return;
    this.undoStack.push(JSON.stringify(this.def));
    this.def = JSON.parse(snap) as LevelDef;
    this.afterHistory();
  }

  private afterHistory(): void {
    this.dirty = true;
    this.selection = { kind: 'none' };
    if (this.activeRoom && !this.room(this.activeRoom)) this.activeRoom = this.rooms[0]?.id ?? null;
    this.emit('doc');
    this.emit('sel');
  }

  public get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  public get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  // ---------- Вид ----------

  public canvasSize = { w: 800, h: 600 };

  public fitView(): void {
    const { w, h } = this.canvasSize;
    const pw = this.def.width * this.ts;
    const ph = this.def.height * this.ts;
    const zoom = Math.max(0.1, Math.min(4, Math.min((w - 40) / pw, (h - 40) / ph)));
    this.view = { zoom, panX: -(w / zoom - pw) / 2, panY: -(h / zoom - ph) / 2 };
    this.emit('view');
  }

  public zoomAt(factor: number, sx: number, sy: number): void {
    const v = this.view;
    const wx = sx / v.zoom + v.panX;
    const wy = sy / v.zoom + v.panY;
    const zoom = Math.max(0.1, Math.min(16, v.zoom * factor));
    this.view = { zoom, panX: wx - sx / zoom, panY: wy - sy / zoom };
    this.emit('view');
  }

  public screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: sx / this.view.zoom + this.view.panX, y: sy / this.view.zoom + this.view.panY };
  }

  // ---------- Инструменты и преобразования ----------

  public setTool(tool: ToolId): void {
    this.tool = tool;
    this.emit('tool');
  }

  public setSelection(sel: Selection): void {
    this.selection = sel;
    this.emit('sel');
  }

  /** Повернуть/отразить то, что сейчас «в руке» или выделено: кисть тайла, выбранный объект или блок тайлов. */
  public transform(op: 'flipH' | 'flipV' | 'rotate'): void {
    const sel = this.selection;
    if (sel.kind === 'tiles') {
      this.transformTiles(op, sel);
      return;
    }
    if (sel.kind === 'decor' || sel.kind === 'object') {
      const item = (sel.kind === 'decor' ? this.def.decor : this.def.objects)?.[sel.index];
      if (!item) return;
      this.edit(() => {
        if (op === 'flipH') item.flip_x = !item.flip_x || undefined;
        else if (op === 'flipV' && sel.kind === 'decor') (item as { flip_y?: boolean }).flip_y = !(item as { flip_y?: boolean }).flip_y || undefined;
        if (!item.flip_x) delete item.flip_x;
        if (sel.kind === 'decor' && !(item as { flip_y?: boolean }).flip_y) delete (item as { flip_y?: boolean }).flip_y;
      });
      return;
    }
    // иначе — кисть и «флажки» следующей установки
    if (this.tool === 'decor' || this.tool === 'object') {
      if (op === 'flipH') this.placeFlipX = !this.placeFlipX;
      else if (op === 'flipV') this.placeFlipY = !this.placeFlipY;
      this.emit('tool');
      return;
    }
    this.brushXf = op === 'flipH' ? xfMirrorH(this.brushXf) : op === 'flipV' ? xfMirrorV(this.brushXf) : xfRotate(this.brushXf);
    this.emit('tool');
  }

  private transformTiles(op: 'flipH' | 'flipV' | 'rotate', r: { x0: number; y0: number; x1: number; y1: number }): void {
    this.edit(() => {
      for (let y = r.y0; y <= r.y1; y++) {
        for (let x = r.x0; x <= r.x1; x++) {
          if (!tileIdAt(this.def, x, y)) continue;
          const cur = getXform(this.def, x, y);
          setXform(this.def, x, y, op === 'flipH' ? xfMirrorH(cur) : op === 'flipV' ? xfMirrorV(cur) : xfRotate(cur));
        }
      }
    });
  }

  /** Зеркалит блок целиком (раскладка плюс каждый тайл) по горизонтали или вертикали. */
  public mirrorBlock(axis: 'h' | 'v'): void {
    const s = this.selection;
    if (s.kind !== 'tiles') return;
    const clip = this.readTiles(s.x0, s.y0, s.x1, s.y1);
    this.edit(() => {
      for (let y = 0; y < clip.h; y++) {
        for (let x = 0; x < clip.w; x++) {
          const sx = axis === 'h' ? clip.w - 1 - x : x;
          const sy = axis === 'v' ? clip.h - 1 - y : y;
          const src = sy * clip.w + sx;
          const id = clip.tiles[src];
          setTile(this.def, s.x0 + x, s.y0 + y, id);
          const xf = clip.xf[src];
          setXform(this.def, s.x0 + x, s.y0 + y, id ? (axis === 'h' ? xfMirrorH(xf) : xfMirrorV(xf)) : undefined);
        }
      }
    });
  }

  // ---------- Тайлы ----------

  public readTiles(x0: number, y0: number, x1: number, y1: number): TileClip {
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const tiles: (string | null)[] = [];
    const xf: (CanonXf | undefined)[] = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        tiles.push(tileIdAt(this.def, x, y));
        const t = getXform(this.def, x, y);
        xf.push(t ? canonXf(t) : undefined);
      }
    }
    return { w, h, tiles, xf };
  }

  public copySelection(): void {
    const s = this.selection;
    if (s.kind !== 'tiles') return;
    this.clipboard = this.readTiles(s.x0, s.y0, s.x1, s.y1);
    this.setStatus(`Скопировано: ${this.clipboard.w}×${this.clipboard.h}`);
  }

  public paste(cx: number, cy: number): void {
    const c = this.clipboard;
    if (!c) return;
    this.edit(() => {
      for (let y = 0; y < c.h; y++) {
        for (let x = 0; x < c.w; x++) {
          const i = y * c.w + x;
          if (!inBounds(this.def, cx + x, cy + y)) continue;
          setTile(this.def, cx + x, cy + y, c.tiles[i]);
          setXform(this.def, cx + x, cy + y, c.tiles[i] ? c.xf[i] : undefined);
        }
      }
    });
    this.setSelection({ kind: 'tiles', x0: cx, y0: cy, x1: Math.min(this.def.width - 1, cx + c.w - 1), y1: Math.min(this.def.height - 1, cy + c.h - 1) });
  }

  public clearSelectionTiles(): void {
    const s = this.selection;
    if (s.kind !== 'tiles') return;
    this.edit(() => {
      for (let y = s.y0; y <= s.y1; y++) {
        for (let x = s.x0; x <= s.x1; x++) {
          setTile(this.def, x, y, null);
          setXform(this.def, x, y, undefined);
        }
      }
    });
  }

  /** Кладёт кисть в клетку (без записи в историю: вызывающий сам begin/endEdit). */
  public paintCell(cx: number, cy: number, erase: boolean): boolean {
    if (!inBounds(this.def, cx, cy)) return false;
    const id = erase ? null : this.brushTile;
    const before = tileIdAt(this.def, cx, cy);
    const beforeXf = getXform(this.def, cx, cy);
    if (before === id && (id === null || (isXfIdentity(beforeXf) ? isXfIdentity(this.brushXf) : sameXf(beforeXf, this.brushXf)))) return false;
    setTile(this.def, cx, cy, id);
    setXform(this.def, cx, cy, id ? this.brushXf : undefined);
    return true;
  }

  /** Заливка связной области одинаковых клеток. */
  public floodTiles(cx: number, cy: number, erase: boolean): void {
    if (!inBounds(this.def, cx, cy)) return;
    const target = tileIdAt(this.def, cx, cy);
    const targetXf = getXform(this.def, cx, cy);
    const id = erase ? null : this.brushTile;
    if (target === id && !id) return;
    const seen = new Set<number>();
    const stack = [[cx, cy]];
    const W = this.def.width;
    this.beginEdit();
    while (stack.length) {
      const [x, y] = stack.pop()!;
      if (!inBounds(this.def, x, y) || seen.has(y * W + x)) continue;
      if (tileIdAt(this.def, x, y) !== target || !sameXf(getXform(this.def, x, y), targetXf)) continue;
      seen.add(y * W + x);
      setTile(this.def, x, y, id);
      setXform(this.def, x, y, id ? this.brushXf : undefined);
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
    this.endEdit();
  }

  // ---------- Привязка размещаемого ----------

  /** Верхняя грань твёрдой поверхности под точкой (px). Курсор в твёрдой клетке — поднимается к её верху. */
  public floorY(wx: number, wy: number): number {
    const ts = this.ts;
    const cx = Math.floor(wx / ts);
    let cy = Math.floor(wy / ts);
    if (cy < 0) cy = 0;
    if (this.isSolid(cx, cy)) {
      while (cy > 0 && this.isSolid(cx, cy - 1)) cy--;
      return cy * ts;
    }
    for (let k = 0; k < 60 && cy + k < this.def.height; k++) if (this.isSolid(cx, cy + k)) return (cy + k) * ts;
    return this.def.height * ts;
  }

  /** Нижняя грань твёрдой поверхности над точкой (потолок). */
  public ceilingY(wx: number, wy: number): number {
    const ts = this.ts;
    const cx = Math.floor(wx / ts);
    let cy = Math.floor(wy / ts);
    if (this.isSolid(cx, cy)) {
      while (cy < this.def.height - 1 && this.isSolid(cx, cy + 1)) cy++;
      return (cy + 1) * ts;
    }
    for (let k = 0; k < 60 && cy - k >= 0; k++) if (this.isSolid(cx, cy - k)) return (cy - k + 1) * ts;
    return 0;
  }

  /** Куда встанет точка привязки объекта (px) с учётом его свойств. free (Alt) — без привязки, просто на пиксель. */
  public snapPoint(p: Placement, wx: number, wy: number, free = false): { x: number; y: number } {
    const ts = this.ts;
    let x = Math.round(wx);
    if (!free) {
      if (p.snap === 'tile') x = Math.floor(wx / ts) * ts + ts / 2;
      else if (p.snap === 'half') x = Math.round(wx / (ts / 2)) * (ts / 2);
    }
    let y = Math.round(wy);
    if (!free && p.anchor === 'floor') y = this.floorY(wx, wy);
    else if (!free && p.anchor === 'ceiling') y = this.ceilingY(wx, wy);
    return { x, y };
  }

  // ---------- Декор, нитки, объекты, враги ----------

  public placeDecor(kind: DecorKind, x: number, y: number): void {
    this.beginEdit();
    const d: NonNullable<LevelDef['decor']>[number] = { sprite_id: kind.sprite_id, x: x / this.ts, y: y / this.ts, layer: kind.layer ?? 'front' };
    if (this.placeFlipX) d.flip_x = true;
    if (this.placeFlipY) d.flip_y = true;
    (this.def.decor ??= []).push(d);
    this.endEdit();
    this.setSelection({ kind: 'decor', index: this.def.decor.length - 1 });
  }

  public placeThread(kind: ThreadKind, x: number, y: number, size?: number): ThreadPlaceDef {
    const t: ThreadPlaceDef = { kind: kind.kind, x, y };
    if (kind.kind === 'vine') {
      t.pieces = size ?? kind.defaults?.pieces ?? 3;
      t.bead = kind.defaults?.bead ?? true;
    } else {
      t.length = size ?? kind.defaults?.length ?? 160;
      t.swing = kind.defaults?.swing ?? 10;
      t.bead = kind.defaults?.bead ?? true;
    }
    return t;
  }

  public uniqueObjectId(type: string): string {
    const ids = new Set((this.def.objects ?? []).map((o) => o.id));
    let n = 1;
    while (ids.has(`${type}_${n}`)) n++;
    return `${type}_${n}`;
  }

  public placeObject(kind: ObjectKind, x: number, y: number): void {
    this.beginEdit();
    if (kind.store === 'terminals') {
      const ts = this.ts;
      (this.def.terminals ??= []).push({ sprite_id: kind.sprite_id, x: Math.floor(x / ts), y: Math.round(y / ts) - 1 });
      this.endEdit();
      this.setSelection({ kind: 'terminal', index: this.def.terminals.length - 1 });
      return;
    }
    const obj: LevelObjectDef = { id: this.uniqueObjectId(kind.type), type: kind.type, x, y };
    if (this.placeFlipX && kind.flip) obj.flip_x = true;
    const props: Record<string, string | number | boolean> = {};
    for (const p of kind.props ?? []) if (p.default !== undefined && p.default !== '') props[p.key] = p.default;
    if (Object.keys(props).length) obj.props = props;
    (this.def.objects ??= []).push(obj);
    this.endEdit();
    this.setSelection({ kind: 'object', index: this.def.objects.length - 1 });
  }

  /** Поверхность, на которой стоит враг в клетке: пол, иначе стена/потолок рядом. */
  public autoSurface(cx: number, cy: number): EnemySpawnDef['surface'] {
    if (this.isSolid(cx, cy + 1)) return 'floor';
    if (this.isSolid(cx + 1, cy)) return 'wall_right';
    if (this.isSolid(cx - 1, cy)) return 'wall_left';
    if (this.isSolid(cx, cy - 1)) return 'ceiling';
    return 'floor';
  }

  public placeEnemy(cx: number, cy: number): void {
    const a = this.armedEnemy;
    if (!a) return;
    this.beginEdit();
    const spawn: EnemySpawnDef = { enemy_id: a.def.id, sprite_id: a.sprite_id, x: cx, y: cy };
    if (a.def.behavior_type === 'crawler') spawn.surface = this.autoSurface(cx, cy);
    if (a.def.behavior_type === 'spawner') spawn.anchor_y = -2;
    this.def.enemies.push(spawn);
    this.endEdit();
    this.setSelection({ kind: 'enemy', index: this.def.enemies.length - 1 });
  }

  public setSpawn(cx: number, cy: number): void {
    this.edit(() => {
      this.def.player_spawn = { x: cx, y: cy };
    });
    this.setSelection({ kind: 'spawn' });
  }

  public deleteSelection(): void {
    const s = this.selection;
    if (s.kind === 'none' || s.kind === 'spawn') return;
    if (s.kind === 'tiles') {
      this.clearSelectionTiles();
      return;
    }
    const list = this.listFor(s.kind);
    if (!list || !list[s.index]) return;
    this.edit(() => {
      list.splice(s.index, 1);
    });
    this.setSelection({ kind: 'none' });
  }

  public duplicateSelection(): void {
    const s = this.selection;
    if (s.kind === 'none' || s.kind === 'spawn' || s.kind === 'tiles') return;
    const list = this.listFor(s.kind) as Record<string, unknown>[] | undefined;
    const src = list?.[s.index];
    if (!list || !src) return;
    const copy = clone(src);
    const shift = s.kind === 'object' || s.kind === 'thread' ? 16 : 1;
    if (typeof copy.x === 'number') copy.x += shift;
    if (s.kind === 'object') copy.id = this.uniqueObjectId(String(copy.type));
    this.edit(() => {
      list.push(copy);
    });
    this.setSelection({ kind: s.kind, index: list.length - 1 });
  }

  public listFor(kind: 'decor' | 'thread' | 'enemy' | 'object' | 'terminal'): unknown[] | undefined {
    switch (kind) {
      case 'decor': return this.def.decor;
      case 'thread': return this.def.threads;
      case 'enemy': return this.def.enemies;
      case 'object': return this.def.objects;
      case 'terminal': return this.def.terminals;
    }
  }

  // ---------- Комнаты ----------

  public addRoom(name?: string): RoomDef {
    const room: RoomDef = { id: newRoomId(this.def), name: name ?? `Комната ${this.rooms.length + 1}`, x: 0, y: 0, width: 0, height: 0, mask: [] };
    this.beginEdit();
    (this.def.rooms ??= []).push(room);
    if (this.def.fog === undefined) this.def.fog = true;
    this.endEdit();
    this.activeRoom = room.id;
    this.emit('sel');
    return room;
  }

  public deleteRoom(id: string): void {
    this.edit(() => {
      this.def.rooms = this.rooms.filter((r) => r.id !== id);
      if (!this.def.rooms.length) delete this.def.rooms;
      for (const e of this.def.enemies) if (e.room === id) delete e.room;
    });
    if (this.activeRoom === id) this.activeRoom = this.rooms[0]?.id ?? null;
    this.emit('sel');
  }

  /** Красит клетку в активную комнату (on) или стирает её оттуда. */
  public paintRoomCell(cx: number, cy: number, on: boolean): void {
    const room = this.room(this.activeRoom);
    if (!room || !inBounds(this.def, cx, cy)) return;
    roomSet(room, cx, cy, on);
  }

  public finishRoomPaint(): void {
    const room = this.room(this.activeRoom);
    if (room && room.mask && room.mask.length && !normalizeRoom(room)) {
      room.width = 0;
      room.height = 0;
      room.mask = [];
    }
  }

  /**
   * Заливка комнаты: от клетки (cx, cy) по свободному пространству (не твёрдые клетки) — всё помещение, плюс кольцо стен вокруг него,
   * чтобы стены тоже были видны в комнате. Слишком большая область (открытое пространство) отклоняется.
   */
  public floodRoom(cx: number, cy: number, limit = 6000): boolean {
    const room = this.room(this.activeRoom);
    if (!room || !inBounds(this.def, cx, cy) || this.isSolid(cx, cy)) return false;
    const W = this.def.width;
    const air = new Set<number>();
    const stack = [cy * W + cx];
    while (stack.length) {
      const i = stack.pop()!;
      if (air.has(i)) continue;
      const x = i % W;
      const y = Math.floor(i / W);
      if (!inBounds(this.def, x, y) || this.isSolid(x, y)) continue;
      air.add(i);
      if (air.size > limit) return false;
      stack.push(i + 1, i - 1, i + W, i - W);
    }
    this.beginEdit();
    const cells = new Set<number>(air);
    for (const i of air) {
      const x = i % W;
      const y = Math.floor(i / W);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (inBounds(this.def, x + dx, y + dy) && this.isSolid(x + dx, y + dy)) cells.add((y + dy) * W + x + dx);
        }
      }
    }
    for (const i of cells) roomSet(room, i % W, Math.floor(i / W), true);
    this.endEdit();
    return true;
  }

  // ---------- Уровень: размер ----------

  public resize(left: number, top: number, right: number, bottom: number): void {
    this.edit(() => resizeLevel(this.def, left, top, right, bottom));
  }

  // ---------- Игра ----------

  /** Адрес игры с этим уровнем (свежий с диска) и, если задана, точкой старта. */
  public playUrl(spawn?: { x: number; y: number }): string {
    const q = new URLSearchParams({ level: this.def.id, live: '1' });
    if (spawn) q.set('spawn', `${spawn.x},${spawn.y}`);
    return `/index.html?${q.toString()}`;
  }

  /** Комнаты под клеткой (для подсказок). */
  public roomsAtCell(cx: number, cy: number): RoomDef[] {
    return roomsAt(this.def, cx, cy);
  }
}

function sameXf(a: Xf | undefined, b: Xf | undefined): boolean {
  const x = canonXf(a);
  const y = canonXf(b);
  return x.flip_x === y.flip_x && x.rot === y.rot;
}
