import { Container, Graphics } from 'pixi.js';
import type { Level } from '../world/Level.ts';

/**
 * Прячет всё, что оказалось в твёрдых клетках (и за границей уровня) в container: инвертированная маска из прямоугольников.
 * Так червь, ушедший в блок, не просвечивает сквозь углы тайлов. Контейнер при этом рисуется под тайлами.
 */
export function applySolidMask(container: Container, level: Level): void {
  const ts = level.tileSize;
  const W = level.widthTiles;
  const H = level.heightTiles;
  const big = 4096;
  const mask = new Graphics();
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
  container.addChild(mask);
  container.setMask({ mask, inverse: true });
}
