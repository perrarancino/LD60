import { Texture } from 'pixi.js';
import { pal } from '../core/Palette.ts';

/** Рампа голого шасси (тёмный -> светлый): серый «металлолом» без брони, цвета палитры проекта. */
const BARE = [pal('steel', 1), pal('steel', 2), pal('steel', 3), pal('steel', 4), pal('steel', 6)];

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
 * Голое шасси: рисунок части, перекрашенный в серую рампу по яркости (детали сохраняются), светлая кромка сверху-слева и тёмный край снизу-справа.
 * Форма (прозрачность) не меняется — по ней режутся руки-канаты.
 */
export function bareImage(src: ImageData): ImageData {
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
      let idx = Math.min(3, Math.floor(t * 4));
      if (!opaque(x, y - 1) || !opaque(x - 1, y)) idx = 4;
      else if (!opaque(x, y + 1) || !opaque(x + 1, y)) idx = 0;
      const c = BARE[idx];
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
