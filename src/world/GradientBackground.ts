import { Container, Sprite, Texture } from 'pixi.js';
import type { BackgroundDef } from '../data/types.ts';

const STEPS = 128; // высота текстуры градиента (растягивается с интерполяцией — переход плавный, без полос)

const rgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/**
 * Фон-градиент (data/backgrounds/*.json, поле gradient): вертикальный градиент по цветовым остановкам, один на локацию; без параллакса,
 * стоит на экране. Смена фонов при входе в другую локацию плавная (главный цикл смешивает прозрачность). Интерфейс как у остальных фонов.
 */
export class GradientBackground {
  public readonly container = new Container();
  private readonly sprite: Sprite;

  constructor(def: BackgroundDef) {
    const g = def.gradient;
    if (!g || g.length < 2) throw new Error(`[GradientBackground] у фона "${def.id}" нет градиента (gradient: минимум две остановки)`);
    const stops = g.map((s) => ({ at: s.at, c: rgb(s.color) })).sort((a, b) => a.at - b.at);
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = STEPS;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(1, STEPS);
    for (let y = 0; y < STEPS; y++) {
      const t = y / (STEPS - 1);
      let i = 0;
      while (i < stops.length - 2 && t > stops[i + 1].at) i++;
      const a = stops[i];
      const b = stops[i + 1];
      const k = Math.max(0, Math.min(1, (t - a.at) / Math.max(1e-6, b.at - a.at)));
      const e = k * k * (3 - 2 * k); // плавный переход между остановками
      for (let ch = 0; ch < 3; ch++) img.data[y * 4 + ch] = Math.round(a.c[ch] + (b.c[ch] - a.c[ch]) * e);
      img.data[y * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const texture = Texture.from(canvas);
    texture.source.scaleMode = 'linear';
    this.sprite = new Sprite(texture);
    this.container.addChild(this.sprite);
  }

  public resize(viewW: number, viewH: number): void {
    this.sprite.width = viewW;
    this.sprite.height = viewH;
  }

  /** Градиент стоит на месте. */
  public update(_camX: number, _camY: number, _worldBottom: number, _pixelScale: number): void {
    // без параллакса
  }
}
