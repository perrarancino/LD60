import { Container, Graphics, GraphicsContext } from 'pixi.js';
import type { Level } from '../world/Level.ts';

const contexts = new WeakMap<Level, GraphicsContext>(); // геометрия маски — одна на уровень, её делят все черви

/**
 * Прячет всё, что оказалось в твёрдых клетках (и за границей уровня) в container: инвертированная маска из прямоугольников.
 * Так червь, ушедший в блок, не просвечивает сквозь углы тайлов. Контейнер при этом рисуется под тайлами.
 * Геометрия маски строится один раз на уровень (общий GraphicsContext), у каждого контейнера свой лишь Graphics.
 */
export function applySolidMask(container: Container, level: Level): void {
  let ctx = contexts.get(level);
  if (!ctx) {
    ctx = buildContext(level);
    contexts.set(level, ctx);
  }
  const mask = new Graphics(ctx);
  container.addChild(mask);
  container.setMask({ mask, inverse: true });
}

function buildContext(level: Level): GraphicsContext {
  const ts = level.tileSize;
  const W = level.widthTiles;
  const H = level.heightTiles;
  const big = 4096;
  const mask = new GraphicsContext();
  // замкнутый мир: за границами уровня тоже «твёрдо»
  mask.rect(-big, -big, W * ts + 2 * big, big).rect(-big, H * ts, W * ts + 2 * big, big);
  mask.rect(-big, 0, big, H * ts).rect(W * ts, 0, big, H * ts);
  for (let cy = 0; cy < H; cy++) {
    for (let cx = 0; cx < W; cx++) {
      if (!level.isSolid(cx, cy)) continue;
      let run = 1; // клетки подряд в ряду — одним прямоугольником
      while (cx + run < W && level.isSolid(cx + run, cy)) run++;
      mask.rect(cx * ts, cy * ts, run * ts, ts);
      cx += run - 1;
    }
  }
  mask.fill(0xffffff);
  return mask;
}
