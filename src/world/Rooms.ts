import { Graphics } from 'pixi.js';
import type { FogDef, RoomDef } from '../data/types.ts';

interface Vec {
  x: number;
  y: number;
}

/**
 * Привязка моба к комнате: он замечает героя и атакует только пока герой в той же комнате и не выходит за её клетки.
 * contains — точка (мир, px) внутри комнаты; hero — герой сейчас в этой комнате; center — куда возвращаться, если вылетел за границу.
 */
export interface Leash {
  readonly id: string;
  readonly center: Vec;
  contains(x: number, y: number): boolean;
  hero(): boolean;
}

/** Клетка комнаты в маске: "#" (и "1"). */
const filled = (ch: string | undefined) => ch === '#' || ch === '1';

/**
 * Комнаты уровня (level.rooms): какие клетки кому принадлежат, в какой комнате сейчас герой (current) и привязки мобов.
 * Комната без маски — весь свой прямоугольник; комнаты могут перекрываться (проём между ними принадлежит обеим).
 */
export class RoomMap {
  public readonly defs: RoomDef[];
  /** Комнаты, в которых сейчас стоит герой (при выходе за все комнаты остаются прежние). */
  public readonly current = new Set<number>();
  /** Комнаты, где герой уже был. */
  public readonly visited = new Set<number>();
  private readonly first: Int16Array; // для клетки: индекс первой комнаты или -1
  private readonly extra = new Map<number, number[]>(); // клетки, принадлежащие нескольким комнатам: остальные индексы
  private readonly leashes = new Map<number, Leash>();

  constructor(defs: readonly RoomDef[] | undefined, public readonly tileSize: number, public readonly width: number, public readonly height: number) {
    this.defs = [...(defs ?? [])];
    this.first = new Int16Array(width * height).fill(-1);
    this.defs.forEach((room, index) => {
      for (let cy = Math.max(0, room.y); cy < Math.min(height, room.y + room.height); cy++) {
        for (let cx = Math.max(0, room.x); cx < Math.min(width, room.x + room.width); cx++) {
          if (room.mask && !filled(room.mask[cy - room.y]?.[cx - room.x])) continue;
          const i = cy * width + cx;
          if (this.first[i] < 0) this.first[i] = index;
          else this.extra.set(i, [...(this.extra.get(i) ?? []), index]);
        }
      }
    });
  }

  public get any(): boolean {
    return this.defs.length > 0;
  }

  /** Индексы комнат, которым принадлежит клетка. */
  public roomsAt(cx: number, cy: number): number[] {
    if (cx < 0 || cy < 0 || cx >= this.width || cy >= this.height) return [];
    const i = cy * this.width + cx;
    const f = this.first[i];
    if (f < 0) return [];
    const more = this.extra.get(i);
    return more ? [f, ...more] : [f];
  }

  public cellInRoom(room: number, cx: number, cy: number): boolean {
    if (cx < 0 || cy < 0 || cx >= this.width || cy >= this.height) return false;
    const i = cy * this.width + cx;
    return this.first[i] === room || (this.extra.get(i)?.includes(room) ?? false);
  }

  /** Индекс комнаты по id (-1 — нет такой). */
  public indexOf(id: string): number {
    return this.defs.findIndex((r) => r.id === id);
  }

  /** Комната-«дом» для клетки: явно заданная по id или та, в которой клетка лежит (null — вне комнат). */
  public homeOf(cx: number, cy: number, explicitId?: string): number | null {
    if (explicitId) {
      const idx = this.indexOf(explicitId);
      if (idx >= 0) return idx;
    }
    const at = this.roomsAt(cx, cy);
    return at.length ? at[0] : null;
  }

  /** Герой в клетке (cx, cy): обновляет current. Вне всех комнат — остаётся прежнее (нет мигания на стыках). Возвращает true, если набор сменился. */
  public updateHero(cx: number, cy: number): boolean {
    const at = this.roomsAt(cx, cy);
    if (at.length === 0) return false;
    const same = at.length === this.current.size && at.every((r) => this.current.has(r));
    if (same) return false;
    this.current.clear();
    for (const r of at) {
      this.current.add(r);
      this.visited.add(r);
    }
    return true;
  }

  /** Привязка к комнате с индексом room (одна на комнату, общая для всех её мобов). */
  public leash(room: number): Leash {
    let l = this.leashes.get(room);
    if (!l) {
      const def = this.defs[room];
      const ts = this.tileSize;
      const center = this.centerOf(room);
      l = {
        id: def.id,
        center,
        contains: (x, y) => this.cellInRoom(room, Math.floor(x / ts), Math.floor(y / ts)),
        hero: () => this.current.has(room)
      };
      this.leashes.set(room, l);
    }
    return l;
  }

  /** Середина комнаты: ближайшая к центру тяжести клетка комнаты (px). */
  private centerOf(room: number): Vec {
    const def = this.defs[room];
    let sx = 0;
    let sy = 0;
    let n = 0;
    const cells: Vec[] = [];
    for (let cy = def.y; cy < def.y + def.height; cy++) {
      for (let cx = def.x; cx < def.x + def.width; cx++) {
        if (!this.cellInRoom(room, cx, cy)) continue;
        sx += cx;
        sy += cy;
        n++;
        cells.push({ x: cx, y: cy });
      }
    }
    const ts = this.tileSize;
    if (n === 0) return { x: (def.x + def.width / 2) * ts, y: (def.y + def.height / 2) * ts };
    const mx = sx / n;
    const my = sy / n;
    let best = cells[0];
    for (const c of cells) if (Math.hypot(c.x - mx, c.y - my) < Math.hypot(best.x - mx, best.y - my)) best = c;
    return { x: (best.x + 0.5) * ts, y: (best.y + 0.5) * ts };
  }
}

const FADE_TIME = 0.3; // с: плавное открытие и закрытие комнаты
const FOG_COLOR = 0x000000;

/**
 * Туман войны: клетки вне комнаты героя закрашены чёрным (кроме посещённых в режиме explored). Рисуется в мировых координатах —
 * контейнер владельца двигается вместе с камерой; рисуются только клетки в обзоре.
 */
export class Fog {
  public readonly container = new Graphics();
  private readonly mode: 'current' | 'explored';
  private readonly vis: Float32Array; // 0..1 по комнатам: насколько комната сейчас открыта
  private ready = false;

  constructor(private readonly rooms: RoomMap, fog: FogDef | boolean | undefined) {
    this.mode = typeof fog === 'object' && fog?.mode === 'explored' ? 'explored' : 'current';
    this.vis = new Float32Array(rooms.defs.length);
  }

  /** Туман включён: у уровня есть комнаты и поле fog не выключено. */
  public static enabled(fog: FogDef | boolean | undefined, rooms: RoomMap): boolean {
    return rooms.any && !!fog;
  }

  /** Обновляет открытость комнат и перерисовывает туман в области обзора (мир, px). */
  public update(dt: number, camLeft: number, camTop: number, viewW: number, viewH: number): void {
    const rooms = this.rooms;
    for (let i = 0; i < this.vis.length; i++) {
      const open = rooms.current.has(i) || (this.mode === 'explored' && rooms.visited.has(i));
      if (!this.ready) this.vis[i] = open ? 1 : 0;
      else this.vis[i] = Math.max(0, Math.min(1, this.vis[i] + (open ? dt : -dt) / FADE_TIME));
    }
    this.ready = true;

    const ts = rooms.tileSize;
    const g = this.container;
    g.clear();
    const x0 = Math.max(0, Math.floor(camLeft / ts) - 1);
    const x1 = Math.min(rooms.width - 1, Math.ceil((camLeft + viewW) / ts) + 1);
    const y0 = Math.max(0, Math.floor(camTop / ts) - 1);
    const y1 = Math.min(rooms.height - 1, Math.ceil((camTop + viewH) / ts) + 1);
    // за краями уровня (камера у стены и т.п.) — тоже чёрное
    this.coverOutside(g, camLeft, camTop, viewW, viewH, x0, y0, x1, y1);
    for (let cy = y0; cy <= y1; cy++) {
      let runStart = x0;
      let runAlpha = this.alphaAt(x0, cy);
      for (let cx = x0 + 1; cx <= x1 + 1; cx++) {
        const a = cx <= x1 ? this.alphaAt(cx, cy) : -1;
        if (a === runAlpha) continue;
        if (runAlpha > 0.004) g.rect(runStart * ts, cy * ts, (cx - runStart) * ts, ts).fill({ color: FOG_COLOR, alpha: runAlpha });
        runStart = cx;
        runAlpha = a;
      }
    }
  }

  /** Чёрная рамка за пределами сетки уровня, если камера туда заглядывает. */
  private coverOutside(g: Graphics, camLeft: number, camTop: number, viewW: number, viewH: number, x0: number, y0: number, x1: number, y1: number): void {
    const ts = this.rooms.tileSize;
    const left = camLeft - ts;
    const top = camTop - ts;
    const right = camLeft + viewW + ts;
    const bottom = camTop + viewH + ts;
    const gx0 = x0 * ts;
    const gy0 = y0 * ts;
    const gx1 = (x1 + 1) * ts;
    const gy1 = (y1 + 1) * ts;
    if (left < gx0) g.rect(left, top, gx0 - left, bottom - top).fill({ color: FOG_COLOR });
    if (right > gx1) g.rect(gx1, top, right - gx1, bottom - top).fill({ color: FOG_COLOR });
    if (top < gy0) g.rect(gx0, top, gx1 - gx0, gy0 - top).fill({ color: FOG_COLOR });
    if (bottom > gy1) g.rect(gx0, gy1, gx1 - gx0, bottom - gy1).fill({ color: FOG_COLOR });
  }

  /** Непрозрачность тумана в клетке: 1 — чёрная, 0 — видно. */
  private alphaAt(cx: number, cy: number): number {
    let open = 0;
    for (const r of this.rooms.roomsAt(cx, cy)) if (this.vis[r] > open) open = this.vis[r];
    return Math.round((1 - open) * 32) / 32;
  }
}
