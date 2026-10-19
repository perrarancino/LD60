import { Texture } from 'pixi.js';
import { pal, type Ramp } from '../core/Palette.ts';

/** Рампа цветов брони по ступеням (тёмный -> светлый), цвета палитры проекта. Ступень 1 бронзовая, 2 серебряная, 3 золотая, 4 синяя. */
const RAMPS: number[][] = [
  [pal('gold', 1), pal('gold', 2), pal('gold', 3), pal('gold', 4), pal('ember', 5)], // бронза
  [pal('steel', 1), pal('steel', 3), pal('steel', 4), pal('steel', 5), pal('steel', 7)], // серебро
  [pal('gold', 3), pal('gold', 4), pal('gold', 5), pal('gold', 6), pal('gold', 7)], // золото
  [pal('cobalt', 2), pal('cobalt', 3), pal('cobalt', 4), pal('electric', 5), pal('electric', 7)] // синяя
];
export const TIER_COLOR: Record<number, number> = { 1: pal('gold', 4), 2: pal('steel', 5), 3: pal('gold', 6), 4: pal('cobalt', 5) };
export type { Ramp };

/** Пиксели части тела из текстуры (кадр целиком). */
export function textureImage(tex: Texture): ImageData {
  const fr = tex.frame;
  const canvas = document.createElement('canvas');
  canvas.width = fr.width;
  canvas.height = fr.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(tex.source.resource as CanvasImageSource, fr.x, fr.y, fr.width, fr.height, 0, 0, fr.width, fr.height);
  return ctx.getImageData(0, 0, fr.width, fr.height);
}

/**
 * «Броня» части: те же пиксели, перекрашенные в рампу ступени по яркости рисунка (детали рисунка сохраняются), с блестящей кромкой
 * (светлый край сверху-слева) и тёмным краем снизу-справа — как металлическая пластина. Форма (прозрачность) не меняется — по ней режутся руки-канаты.
 */
export function armorImage(src: ImageData, tier: number): ImageData {
  const ramp = RAMPS[Math.max(0, Math.min(RAMPS.length - 1, tier - 1))];
  const { width: w, height: h, data } = src;
  const out = new ImageData(w, h);
  const lum: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (data[i * 4 + 3] === 0) continue;
    lum.push(0.3 * data[i * 4] + 0.59 * data[i * 4 + 1] + 0.11 * data[i * 4 + 2]);
  }
  lum.sort((a, b) => a - b);
  const lo = lum.length ? lum[Math.floor(lum.length * 0.05)] : 0;
  const hi = lum.length ? lum[Math.floor(lum.length * 0.95)] : 1;
  const opaque = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && data[(y * w + x) * 4 + 3] > 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] === 0) continue;
      const l = 0.3 * data[i] + 0.59 * data[i + 1] + 0.11 * data[i + 2];
      const t = Math.max(0, Math.min(1, (l - lo) / Math.max(1, hi - lo)));
      let idx = Math.min(3, Math.floor(t * 4)); // 0..3: тёмный — светлый, 4 оставлен для кромки
      if (!opaque(x, y - 1) || !opaque(x - 1, y)) idx = 4; // светлая кромка сверху-слева
      else if (!opaque(x, y + 1) || !opaque(x + 1, y)) idx = 0; // тёмный край снизу-справа
      else if (((x + y * 2) % 11 === 0) && idx < 3) idx += 1; // редкие блики: пластины
      const c = ramp[idx];
      out.data[i] = (c >> 16) & 255;
      out.data[i + 1] = (c >> 8) & 255;
      out.data[i + 2] = c & 255;
      out.data[i + 3] = data[i + 3];
    }
  }
  return out;
}

/** Текстура из пикселей (ближайший сосед — пиксель-арт). */
export function imageTexture(img: ImageData): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  canvas.getContext('2d')!.putImageData(img, 0, 0);
  const tex = Texture.from(canvas);
  tex.source.scaleMode = 'nearest';
  return tex;
}
