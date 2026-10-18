import { Container } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { DecorZoneDef, LevelDef, TileSetDef } from '../data/types.ts';
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
export class Level {
  public readonly tileSize: number;
  public readonly widthTiles: number;
  public readonly heightTiles: number;
  public readonly container = new Container();
  public readonly backLayer = new Container();
  public readonly frontLayer = new Container();
  public readonly def: LevelDef;

  private solid: boolean[][] = [];
  private readonly webs: Webs;

  /** Id спрайтов, нужных уровню (тайлы, декор, зоны) — для предзагрузки. */
  public static spriteIds(def: LevelDef, tileset: TileSetDef): string[] {
    const used = new Set(Object.values(def.legend).filter((v): v is string => v !== null));
    const zones = def.zones ?? [];
    return [
      ...tileset.tiles.filter((t) => used.has(t.id)).map((t) => t.sprite_id),
      ...(def.decor ?? []).map((d) => d.sprite_id),
      ...(zones.some((z) => z.kind === 'transistors') ? SPRITE_TRANSISTORS : []),
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
    this.heightTiles = def.height;

    const tilesById = new Map(tileset.tiles.map((t) => [t.id, t]));
    const tileAt = (cx: number, cy: number) => {
      const tileId = def.legend[def.rows[cy][cx]];
      return tileId ? tilesById.get(tileId) : undefined;
    };
    for (let cy = 0; cy < def.height; cy++) {
      this.solid[cy] = [];
      for (let cx = 0; cx < def.width; cx++) {
        const ch = def.rows[cy][cx];
        const tileId = def.legend[ch];
        if (tileId === undefined) throw new Error(`[Level] символ "${ch}" (${cx},${cy}) нет в legend`);
        const tile = tileId ? tilesById.get(tileId) : undefined;
        if (tileId && !tile) throw new Error(`[Level] неизвестный тайл "${tileId}"`);

        this.solid[cy][cx] = !!tile?.solid;
        if (tile) {
          // Платформа из трёх кадров: левый край (0), середина (1, повторяется), правый край (2). Одиночный тайл (стенка) — середина.
          let frame = 0;
          if (tile.loop_frames && tile.loop_frames >= 3) {
            const left = cx > 0 && tileAt(cx - 1, cy) === tile;
            const right = cx < def.width - 1 && tileAt(cx + 1, cy) === tile;
            frame = left && right ? 1 : right ? 0 : left ? tile.loop_frames - 1 : 1;
          }
          const sprite = sprites.createSprite(tile.sprite_id, frame);
          sprite.position.set(cx * this.tileSize, cy * this.tileSize);
          this.container.addChild(sprite);
        }
      }
    }

    // Декор, заданный вручную: точка привязки спрайта (origin из реестра) — в (x, y) тайлов
    for (const d of def.decor ?? []) {
      this.placeDecor(sprites, d.sprite_id, d.x, d.y, d.layer === 'back' ? this.backLayer : this.frontLayer);
    }

    // Висящая паутина (нитка паучихи): лианы под тайлами и длинные нитки с неба — по зонам; лежит под тайлами (корни спрятаны)
    this.webs = new Webs(sprites, this.tileSize, def.width, def.height, (cx, cy) => this.solid[cy][cx]);
    this.backLayer.addChild(this.webs.back);
    (def.zones ?? []).forEach((zone, i) => {
      if (zone.kind === 'webs') this.webs.addZone(zone, i);
      else this.fillTransistors(sprites, zone, i);
    });
  }

  /** Ставит спрайт декора (без коллизии). */
  private placeDecor(sprites: SpriteLibrary, id: string, tx: number, ty: number, layer: Container): void {
    const sprite = sprites.createSprite(id);
    sprite.position.set(Math.round(tx * this.tileSize), Math.round(ty * this.tileSize));
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
        if (Math.abs(cx - spawn.x) <= 1 && cy === spawn.y + 1) continue; // не на месте появления героя
        this.placeDecor(sprites, SPRITE_TRANSISTORS[pick < 0.5 ? 0 : 1], cx + 0.5, cy, this.frontLayer);
      }
    }
  }

  /** Анимация декора; camLeft..camRight — видимый диапазон по x (мир), actors — кто задевает лианы. */
  public update(dt: number, camLeft: number, camRight: number, actors: readonly Actor[]): void {
    this.webs.update(dt, camLeft, camRight, actors);
  }

  public get pixelWidth(): number {
    return this.widthTiles * this.tileSize;
  }

  public get pixelHeight(): number {
    return this.heightTiles * this.tileSize;
  }

  /**
   * Верх первой твёрдой клетки под точкой (x, y) в пределах maxDist вниз (мир, px) — поверхность, на которую ляжет тень; null — нет.
   * Начало ищется на 2 px выше точки: существо, стоящее на поверхности, не «проваливается» сквозь неё.
   */
  public groundBelow(x: number, y: number, maxDist: number): number | null {
    const ts = this.tileSize;
    const cx = Math.floor(x / ts);
    if (cx < 0 || cx >= this.widthTiles) return null;
    const limit = y + maxDist;
    for (let cy = Math.max(0, Math.floor((y - 2) / ts)); cy < this.heightTiles && cy * ts <= limit; cy++) {
      if (this.solid[cy][cx] && cy * ts >= y - 2) return cy * ts;
    }
    return null;
  }

  /** Клетка твёрдая? За левой/правой границей и над уровнем — стена, под уровнем — пустота. */
  public isSolid(cx: number, cy: number): boolean {
    if (cx < 0 || cx >= this.widthTiles) return true;
    if (cy < 0 || cy >= this.heightTiles) return false;
    return this.solid[cy][cx];
  }
}
