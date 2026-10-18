import { Container } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { DecorZoneDef, LevelDef, TileSetDef } from '../data/types.ts';
import type { SolidBox } from '../entities/Hittable.ts';
import { SPROUT_SPRITE, Sprouts } from './Sprouts.ts';

const SPRITE_TRANSISTORS = ['deco_transistor', 'deco_transistor2'];
const SPRITE_WEBS = ['deco_web_tile', 'deco_web_hang'];

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
 * Координаты клеток — в тайлах, ряд 0 — верхний.
 *
 * Слои (снизу вверх, добавляет владелец): backLayer (декор «за тайлами» и отростки паутины под ними) -> container (тайлы) ->
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
  /** Неподвижные твёрдые коробки декора (транзисторы): герой встаёт на них так же, как на врагов. */
  public readonly staticSolids: SolidBox[] = [];

  private solid: boolean[][] = [];
  private readonly sprouts: Sprouts;

  /** Id спрайтов, нужных уровню (тайлы, декор, зоны, отростки) — для предзагрузки. */
  public static spriteIds(def: LevelDef, tileset: TileSetDef): string[] {
    const used = new Set(Object.values(def.legend).filter((v): v is string => v !== null));
    const zones = def.zones ?? [];
    return [
      ...tileset.tiles.filter((t) => used.has(t.id)).map((t) => t.sprite_id),
      ...(def.decor ?? []).map((d) => d.sprite_id),
      ...(zones.some((z) => z.kind === 'transistors') ? SPRITE_TRANSISTORS : []),
      ...(zones.some((z) => z.kind === 'webs') ? SPRITE_WEBS : []),
      SPROUT_SPRITE
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
      for (const [cx, cy, w, h] of d.solid_cells ?? []) {
        for (let y = cy; y < cy + h; y++) for (let x = cx; x < cx + w; x++) if (this.solid[y]?.[x] !== undefined) this.solid[y][x] = true;
      }
      this.placeDecor(sprites, d.sprite_id, d.x, d.y, d.layer === 'back' ? this.backLayer : this.frontLayer, !!d.solid);
    }
    // Зоны автодекора
    (def.zones ?? []).forEach((zone, i) => this.fillZone(sprites, zone, i));

    // Отростки паутины под тайлами (лежат в слое под тайлами: корни спрятаны)
    this.sprouts = new Sprouts(sprites, this.tileSize, def.width, def.height, (cx, cy) => this.solid[cy][cx]);
    this.backLayer.addChild(this.sprouts.container);
  }

  /** Ставит спрайт декора; solid — на хитбокс спрайта (из sprites.json) можно встать. */
  private placeDecor(sprites: SpriteLibrary, id: string, tx: number, ty: number, layer: Container, solid: boolean): void {
    const ts = this.tileSize;
    const sprite = sprites.createSprite(id);
    const x = Math.round(tx * ts);
    const y = Math.round(ty * ts);
    sprite.position.set(x, y);
    layer.addChild(sprite);
    const def = sprites.def(id);
    if (solid && def.hitbox) {
      const hb = def.hitbox;
      this.staticSolids.push({
        key: sprite,
        x: x - def.frame_width * def.origin.x + hb.offset_x,
        y: y - def.frame_height * def.origin.y + hb.offset_y,
        w: hb.width,
        h: hb.height
      });
    }
  }

  /**
   * Автодекор зоны. transistors: на верхней грани твёрдых клеток (стоят и твёрдые). webs: поверх твёрдых клеток с открытой гранью
   * и в углах (пустая клетка над полом у стены). Выбор клеток случайный, но детерминированный, число — по density.
   */
  private fillZone(sprites: SpriteLibrary, zone: DecorZoneDef, index: number): void {
    const rand = mulberry32(index * 9973 + 101);
    const density = zone.density ?? 0.5;
    const spawn = this.def.player_spawn;
    const solid = (cx: number, cy: number) => cx >= 0 && cx < this.widthTiles && cy >= 0 && cy < this.heightTiles && this.solid[cy][cx];
    const free = (cx: number, cy: number) => cx >= 0 && cx < this.widthTiles && cy >= 0 && cy < this.heightTiles && !this.solid[cy][cx];
    for (let cy = Math.max(0, zone.y0); cy <= Math.min(this.heightTiles - 1, zone.y1); cy++) {
      for (let cx = Math.max(0, zone.x0); cx <= Math.min(this.widthTiles - 1, zone.x1); cx++) {
        const roll = rand();
        const pick = rand();
        if (zone.kind === 'transistors') {
          if (!solid(cx, cy) || !free(cx, cy - 1) || roll >= density) continue;
          if (Math.abs(cx - spawn.x) <= 1 && cy === spawn.y + 1) continue; // не на месте появления героя
          const id = SPRITE_TRANSISTORS[pick < 0.5 ? 0 : 1];
          this.placeDecor(sprites, id, cx + 0.5, cy, this.frontLayer, true);
        } else if (solid(cx, cy)) {
          const exposed = free(cx, cy - 1) || free(cx, cy + 1) || free(cx - 1, cy) || free(cx + 1, cy);
          if (exposed && roll < density) this.placeDecor(sprites, SPRITE_WEBS[pick < 0.5 ? 0 : 1], cx, cy, this.frontLayer, false);
        } else if (solid(cx, cy + 1) && (solid(cx - 1, cy) || solid(cx + 1, cy)) && roll < density * 0.7) {
          this.placeDecor(sprites, SPRITE_WEBS[0], cx, cy, this.frontLayer, false); // паутина в углу
        }
      }
    }
  }

  /** Анимация декора; camLeft..camRight — видимый диапазон по x (мир). */
  public update(dt: number, camLeft: number, camRight: number): void {
    this.sprouts.update(dt, camLeft, camRight);
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
}
