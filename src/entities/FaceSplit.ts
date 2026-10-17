import { Texture } from 'pixi.js';

/**
 * Режет слой головы на «череп» и «лицо»: пиксели цветов featureColors (глаза, брови, рот) уходят в отдельную текстуру,
 * а дырки в черепе закрашиваются цветом ближайшей кожи. Лицо можно сдвигать по черепу — так голова «смотрит» на курсор
 * без перерисовки (глаза и черты уезжают в сторону взгляда).
 */
export function splitFace(img: ImageData, featureColors: string[]): { skull: Texture; face: Texture } {
  const { width: w, height: h, data } = img;
  const feat = featureColors.map((c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]);
  const isFeature = new Uint8Array(w * h);
  const color = new Uint8ClampedArray(w * h * 4); // цвета черепа (после закраски)
  const filled = new Uint8Array(w * h);
  const queue: number[] = [];

  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2], a = data[i * 4 + 3];
    if (a === 0) continue;
    if (feat.some((f) => f[0] === r && f[1] === g && f[2] === b)) {
      isFeature[i] = 1;
    } else {
      color.set([r, g, b, a], i * 4);
      filled[i] = 1;
      queue.push(i);
    }
  }

  // Закраска дырок: волна от кожи в стороны (4-связность) — каждая дырка берёт цвет ближайшей кожи
  for (let qi = 0; qi < queue.length; qi++) {
    const i = queue[qi];
    const x = i % w;
    const y = (i - x) / w;
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (isFeature[j] && !filled[j]) {
        color.set(color.subarray(i * 4, i * 4 + 4), j * 4);
        filled[j] = 1;
        queue.push(j);
      }
    }
  }

  const make = (pixels: Uint8ClampedArray): Texture => {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    const out = ctx.createImageData(w, h);
    out.data.set(pixels);
    ctx.putImageData(out, 0, 0);
    const texture = Texture.from(canvas);
    texture.source.scaleMode = 'nearest';
    return texture;
  };

  const face = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (isFeature[i]) face.set(data.subarray(i * 4, i * 4 + 4), i * 4);
  }
  return { skull: make(color), face: make(face) };
}
