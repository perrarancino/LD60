import { Container, Graphics } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { DecorZoneDef, LevelDef, Slope, TileSetDef } from '../data/types.ts';
import { objectSpriteIds } from './placeables.ts';
import { cellKey, tileVisual, transformSlope, xformMap, xformSteps } from './tileRules.ts';
import { THREAD_SPRITE, Webs } from './Webs.ts';
import type { Actor } from './Webs.ts';

const SPRITE_TRANSISTORS = ['deco_transistor', 'deco_transistor2'];

/** Детерминированный генератор: раскладка автодекора одинакова при каждом запуске. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Уровень-сетка из тайлов (data/levels/*.json): строит спрайты тайлов и отвечает на вопросы о твёрдости клеток.
 * Координаты клеток — в тайлах, ряд 0 — верхний. Декор (куллер, транзисторы, паутина) — без коллизий.
 *
 * Слои (снизу вверх, добавляет владелец): backLayer (декор «за тайлами» и лианы под ними) -> container (тайлы) ->
 * frontLayer (декор поверх тайлов: паутина, транзисторы).
 */
const CHUNK = 8; // клеток в стороне чанка тайлов

export class Level {
  public readonly tileSize: number;
  public readonly widthTiles: number;
  public readonly heightTiles: number;
  public readonly container = new Container(); // тайлы: разбиты на чанки CHUNK×CHUNK клеток, невидимые прячутся (cull)
  private readonly chunks = new Map<number, Container>();
  private chunkCols = 0;
  public readonly backLayer = new Container();
  public readonly frontLayer = new Container();
  public readonly def: LevelDef;

  private solid: boolean[][] = [];
  private slopes: (Slope | undefined)[][] = [];
  private readonly reserved = new Set<string>(); // «ряд:колонка» клеток, где уже стоит декор (автодекор там не ставится)
  private readonly webs: Webs;

  /** Id спрайтов, нужных уровню (тайлы, декор, зоны) — для предзагрузки. */
  public static spriteIds(def: LevelDef, tileset: TileSetDef): string[] {
    const used = new Set(Object.values(def.legend).filter((v): v is string => v !== null));
    const zones = def.zones ?? [];
    return [
      ...tileset.tiles.filter((t) => used.has(t.id)).flatMap((t) => (t.fill_sprite_id ? [t.sprite_id, t.fill_sprite_id] : [t.sprite_id])),
      ...(def.decor ?? []).map((d) => d.sprite_id),
      ...(zones.some((z) => z.kind === 'transistors') ? SPRITE_TRANSISTORS : []),
      ...(def.objects ?? []).flatMap((o) => objectSpriteIds(o)),
      THREAD_SPRITE
    ];
  }

  constructor(def: LevelDef, tileset: TileSetDef, sprites: SpriteLibrary) {
    if (def.tile_size !== tileset.tile_size) {
      throw new Error(`[Level] tile_size уровня (${def.tile_size}) != tiles.json (${tileset.tile_size})`);
    }
    this.def = def;
    this.tileSize = def.tile_size;
    this.widthTiles = def.width;
    this.chunkCols = Math.ceil(def.width / CHUNK);
    this.heightTiles = def.height;

    const tilesById = new Map(tileset.tiles.map((t) => [t.id, t]));
    const tileAt = (cx: number, cy: number) => {
      const tileId = def.legend[def.rows[cy]?.[cx]];
      return tileId ? tilesById.get(tileId) : undefined;
    };
    const xforms = xformMap(def.tile_xform);
    const env = { tileAt, solidAt: (cx: number, cy: number) => this.solid[cy]?.[cx] ?? false };
    const ts = this.tileSize;
    for (let cy = 0; cy < def.height; cy++) {
      this.solid[cy] = [];
      this.slopes[cy] = [];
      for (let cx = 0; cx < def.width; cx++) {
        const ch = def.rows[cy][cx];
        const tileId = def.legend[ch];
        if (tileId === undefined) throw new Error(`[Level] символ "${ch}" (${cx},${cy}) нет в legend`);
        const tile = tileId ? tilesById.get(tileId) : undefined;
        if (tileId && !tile) throw new Error(`[Level] неизвестный тайл "${tileId}"`);

        const xf = xforms.get(cellKey(cx, cy));
        const slope = tile?.slope ? transformSlope(tile.slope, xf) : undefined; // поворот и отражение переставляют скос
        this.solid[cy][cx] = !!tile?.solid;
        this.slopes[cy][cx] = slope;
        if (!tile) continue;

        const look = tileVisual(tile, cx, cy, env);
        const sprite = sprites.createSprite(look.sprite_id, look.frame);
        const ox = cx * ts;
        const oy = cy * ts;
        if (xf) {
          // отражения и поворот вокруг центра клетки
          const st = xformSteps(xf);
          sprite.anchor.set(0.5);
          sprite.position.set(ox + ts / 2, oy + ts / 2);
          sprite.scale.set(st.sx, st.sy);
          sprite.rotation = (st.quarter * Math.PI) / 2;
        } else {
          sprite.position.set(ox, oy);
        }

        if (!slope) {
          this.chunk(cx, cy).addChild(sprite);
          continue;
        }
        // Скос: рисунок обрезается треугольником маски (в мировых координатах клетки)
        const mask = new Graphics();
        mask.beginPath();
        if (slope === 'up_right') mask.poly([ox, oy + ts, ox + ts, oy + ts, ox + ts, oy]);
        else if (slope === 'up_left') mask.poly([ox, oy, ox, oy + ts, ox + ts, oy + ts]);
        else if (slope === 'ceil_right') mask.poly([ox, oy, ox + ts, oy, ox + ts, oy + ts]);
        else mask.poly([ox, oy, ox + ts, oy, ox, oy + ts]);
        mask.fill({ color: 0xffffff });
        sprite.mask = mask;
        this.chunk(cx, cy).addChild(mask);

        if (!tile.id.includes('step')) {
          // Линия дорожки по диагонали
          const edge = new Graphics();
          edge.setStrokeStyle({ width: 2, color: 0x4ade80, alpha: 0.9 });
          if (slope === 'up_right' || slope === 'ceil_left') edge.moveTo(ox, oy + ts).lineTo(ox + ts, oy);
          else edge.moveTo(ox, oy).lineTo(ox + ts, oy + ts);
          edge.stroke();
          this.chunk(cx, cy).addChild(edge);
        }
        this.chunk(cx, cy).addChild(sprite);
      }
    }

    // Декор, заданный вручную: точка привязки спрайта (origin из реестра) — в (x, y) тайлов
    for (const d of def.decor ?? []) {
      this.placeDecor(sprites, d.sprite_id, d.x, d.y, d.layer === 'back' ? this.backLayer : this.frontLayer, d.flip_x, d.flip_y);
      // колонки, которые декор занимает по ширине на своём ряду: автодекор (транзисторы) в них не ставим — ничего не пересекается
      const def = sprites.def(d.sprite_id);
      const left = Math.floor((d.x * this.tileSize - def.frame_width * def.origin.x) / this.tileSize);
      const right = Math.floor((d.x * this.tileSize + def.frame_width * (1 - def.origin.x) - 1) / this.tileSize);
      for (let cx = left; cx <= right; cx++) this.reserved.add(`${Math.round(d.y)}:${cx}`);
    }

    // Висящая паутина (нитка паучихи): лианы под тайлами и длинные нитки с неба — по зонам; лежит под тайлами (корни спрятаны)
    this.webs = new Webs(sprites, this.tileSize, def.width, def.height, (cx, cy) => this.solid[cy][cx]);
    this.backLayer.addChild(this.webs.back);
    (def.zones ?? []).forEach((zone, i) => {
      if (zone.kind === 'webs') this.webs.addZone(zone, i);
      else this.fillTransistors(sprites, zone, i);
    });
    // Нитки, поставленные вручную на конкретные пиксели
    for (const t of def.threads ?? []) this.webs.addThread(t);
  }

  /** Ставит спрайт декора (без коллизии). */
  private placeDecor(sprites: SpriteLibrary, id: string, tx: number, ty: number, layer: Container, flipX = false, flipY = false): void {
    const sprite = sprites.createSprite(id);
    sprite.position.set(Math.round(tx * this.tileSize), Math.round(ty * this.tileSize));
    if (flipX || flipY) sprite.scale.set(flipX ? -1 : 1, flipY ? -1 : 1); // отражение вокруг точки привязки
    layer.addChild(sprite);
  }

  /** Зона транзисторов: на верхних гранях твёрдых клеток, случайно, но детерминированно (по density). */
  private fillTransistors(sprites: SpriteLibrary, zone: DecorZoneDef, index: number): void {
    const rand = mulberry32(index * 9973 + 101);
    const density = zone.density ?? 0.5;
    const spawn = this.def.player_spawn;
    for (let cy = Math.max(0, zone.y0); cy <= Math.min(this.heightTiles - 1, zone.y1); cy++) {
      for (let cx = Math.max(0, zone.x0); cx <= Math.min(this.widthTiles - 1, zone.x1); cx++) {
        const roll = rand();
        const pick = rand();
        if (!this.solid[cy][cx] || (cy > 0 && this.solid[cy - 1][cx]) || roll >= density) continue;
        if (this.reserved.has(`${cy}:${cx}`)) continue; // здесь уже стоит другой декор
        if (Math.abs(cx - spawn.x) <= 1 && cy === spawn.y + 1) continue; // не на месте появления героя
        this.placeDecor(sprites, SPRITE_TRANSISTORS[pick < 0.5 ? 0 : 1], cx + 0.5, cy, this.frontLayer);
      }
    }
  }

  /** Анимация декора; camLeft..camRight — видимый диапазон по x (мир), actors — кто задевает лианы. */
  /** Контейнер-чанк для клетки: тайлы одной области лежат вместе, чтобы прятать целиком. */
  private chunk(cx: number, cy: number): Container {
    const key = Math.floor(cy / CHUNK) * this.chunkCols + Math.floor(cx / CHUNK);
    let c = this.chunks.get(key);
    if (!c) {
      c = new Container();
      this.chunks.set(key, c);
      this.container.addChild(c);
    }
    return c;
  }

  /**
   * Показывает только чанки тайлов, попавшие в область (мировые px, с запасом): остальные не рисуются ни в кадре, ни в проходах света
   * (на большой карте это тысячи спрайтов, которые раньше обходились при каждой отрисовке мира).
   */
  public cull(left: number, right: number, top: number, bottom: number): void {
    const size = CHUNK * this.tileSize;
    for (const [key, c] of this.chunks) {
      const col = key % this.chunkCols;
      const row = Math.floor(key / this.chunkCols);
      const x0 = col * size;
      const y0 = row * size;
      c.visible = x0 + size > left && x0 < right && y0 + size > top && y0 < bottom;
    }
  }

  public update(dt: number, camLeft: number, camRight: number, actors: readonly Actor[]): void {
    this.webs.update(dt, camLeft, camRight, actors);
  }

  public get pixelWidth(): number {
    return this.widthTiles * this.tileSize;
  }

  public get pixelHeight(): number {
    return this.heightTiles * this.tileSize;
  }

  /** Клетка твёрдая? За левой/правой границей и над уровнем — стена, под уровнем — пустота. */
  public isSolid(cx: number, cy: number): boolean {
    if (cx < 0 || cx >= this.widthTiles) return true;
    if (cy < 0 || cy >= this.heightTiles) return false;
    return this.solid[cy][cx];
  }

  /** Получить скос клетки, если он есть */
  public getSlope(cx: number, cy: number): Slope | undefined {
    if (cx < 0 || cx >= this.widthTiles || cy < 0 || cy >= this.heightTiles) return undefined;
    return this.slopes[cy]?.[cx];
  }

  /** Субпиксельная проверка твёрдости с учётом диагональных 45° скосов */
  public isSolidAtPixel(px: number, py: number): boolean {
    const cx = Math.floor(px / this.tileSize);
    const cy = Math.floor(py / this.tileSize);
    if (cx < 0 || cx >= this.widthTiles) return true;
    if (cy < 0) return true;
    if (cy >= this.heightTiles) return false;
    if (!this.solid[cy]?.[cx]) return false;

    const slope = this.slopes[cy]?.[cx];
    if (!slope) return true;

    const lx = (px - cx * this.tileSize) / this.tileSize;
    const ly = (py - cy * this.tileSize) / this.tileSize;
    if (slope === 'up_right') return ly >= 1 - lx;
    if (slope === 'up_left') return ly >= lx;
    if (slope === 'ceil_right') return ly <= lx;
    if (slope === 'ceil_left') return ly <= 1 - lx;
    return true;
  }

  /** Находит все допустимые клетки пола внутри заданной зоны (для спавна мобов строго на полу) */
  public findFloorPositionsInZone(zone: { x: number; y: number; width: number; height: number }): Array<{ x: number; y: number }> {
    const floors: Array<{ x: number; y: number }> = [];
    const x0 = Math.max(0, zone.x);
    const x1 = Math.min(this.widthTiles - 1, zone.x + zone.width - 1);
    const y0 = Math.max(0, zone.y);
    const y1 = Math.min(this.heightTiles - 1, zone.y + zone.height - 1);

    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        // Клетка пола: твёрдая клетка, над которой пустота
        if (this.isSolid(cx, cy) && (cy === 0 || !this.isSolid(cx, cy - 1))) {
          // Игрок/моб стоит в клетке cy - 1 над блоком cy
          floors.push({ x: cx, y: cy - 1 });
        }
      }
    }
    return floors;
  }
}
