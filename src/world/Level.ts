import { Container } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { LevelDef, TileSetDef } from '../data/types.ts';
import { SPROUT_SPRITE, Sprouts } from './Sprouts.ts';

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

  private solid: boolean[][] = [];
  private readonly sprouts: Sprouts;

  /** Id спрайтов, нужных уровню (тайлы, декор, отростки) — для предзагрузки. */
  public static spriteIds(def: LevelDef, tileset: TileSetDef): string[] {
    const used = new Set(Object.values(def.legend).filter((v): v is string => v !== null));
    return [
      ...tileset.tiles.filter((t) => used.has(t.id)).map((t) => t.sprite_id),
      ...(def.decor ?? []).map((d) => d.sprite_id),
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
      let runStart = 0; // начало текущего ряда одинаковых тайлов (для зацикленных кадров)
      for (let cx = 0; cx < def.width; cx++) {
        const ch = def.rows[cy][cx];
        const tileId = def.legend[ch];
        if (tileId === undefined) throw new Error(`[Level] символ "${ch}" (${cx},${cy}) нет в legend`);
        const tile = tileId ? tilesById.get(tileId) : undefined;
        if (tileId && !tile) throw new Error(`[Level] неизвестный тайл "${tileId}"`);

        this.solid[cy][cx] = !!tile?.solid;
        if (cx === 0 || tileAt(cx - 1, cy) !== tile) runStart = cx;
        if (tile) {
          // Зацикленные кадры: ряд из нескольких тайлов идёт 0, 1, 2, 0, 1, 2… с начала ряда; одиночный тайл (стенка) — по колонке
          let frame = 0;
          if (tile.loop_frames) {
            const alone = (cx === 0 || tileAt(cx - 1, cy) !== tile) && (cx === def.width - 1 || tileAt(cx + 1, cy) !== tile);
            frame = (alone ? cx : cx - runStart) % tile.loop_frames;
          }
          const sprite = sprites.createSprite(tile.sprite_id, frame);
          sprite.position.set(cx * this.tileSize, cy * this.tileSize);
          this.container.addChild(sprite);
        }
      }
    }

    // Декор: точка привязки спрайта (origin из реестра) — в (x, y) тайлов
    for (const d of def.decor ?? []) {
      const sprite = sprites.createSprite(d.sprite_id);
      sprite.position.set(Math.round(d.x * this.tileSize), Math.round(d.y * this.tileSize));
      (d.layer === 'back' ? this.backLayer : this.frontLayer).addChild(sprite);
    }

    // Отростки паутины под тайлами (лежат в слое под тайлами: корни спрятаны)
    this.sprouts = new Sprouts(sprites, this.tileSize, def.width, def.height, (cx, cy) => this.solid[cy][cx]);
    this.backLayer.addChild(this.sprouts.container);
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
