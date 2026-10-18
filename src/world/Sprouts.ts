import { Container, Sprite } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';

export const SPROUT_SPRITE = 'deco_sprout';

const PER_CELL: [number, number] = [2, 3]; // сколько отростков под одной клеткой (от, до)
const HIDDEN = 1; // px: корень отростка спрятан под тайлом (слой рисуется под тайлами)
const SWAY_AMOUNT = 0.3; // рад: размах наклона (низ отростка уходит на 2–3 px)
const SWAY_SPEED: [number, number] = [1.1, 1.9]; // рад/с
const GUST_SPEED = 0.45; // рад/с: общая «волна» ветра по уровню — соседние отростки качаются согласованно
const GUST_WAVELENGTH = 0.012; // рад/px: фаза волны вдоль уровня
const VIEW_MARGIN = 24; // px: за краем обзора отростки не обновляются

/** Детерминированный генератор (одинаковая раскладка при каждом запуске). */
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

interface Sprout {
  sprite: Sprite;
  x: number;
  phase: number;
  speed: number;
  amount: number;
}

/**
 * Отростки паутины под тайлами — маленькие «лианы», свисающие с нижней грани любой твёрдой клетки, под которой пусто.
 * Все отростки — спрайты одной текстуры в одном контейнере (одна пачка отрисовки); качаются наклоном (skew) вокруг корня,
 * который приклеен к тайлу и не отрывается. Обновляются только те, что в обзоре (список отсортирован по x — двоичный поиск):
 * на кадр — десятки sin(), без аллокаций.
 */
export class Sprouts {
  public readonly container = new Container();
  private readonly sprouts: Sprout[] = [];
  private time = 0;

  constructor(
    sprites: SpriteLibrary, tileSize: number, width: number, height: number, isSolid: (cx: number, cy: number) => boolean
  ) {
    for (let cy = 0; cy < height - 1; cy++) {
      for (let cx = 0; cx < width; cx++) {
        if (!isSolid(cx, cy) || isSolid(cx, cy + 1)) continue; // нужна твёрдая клетка с пустотой снизу
        const rand = mulberry32(cx * 7919 + cy * 104729 + 17);
        const n = PER_CELL[0] + Math.floor(rand() * (PER_CELL[1] - PER_CELL[0] + 1));
        for (let k = 0; k < n; k++) {
          const sprite = sprites.createSprite(SPROUT_SPRITE);
          // равномерные слоты вдоль грани со сдвигом, чтобы не было «гребёнки»
          const x = cx * tileSize + ((k + 0.5) / n) * tileSize + (rand() - 0.5) * 5;
          sprite.position.set(Math.round(x), (cy + 1) * tileSize - HIDDEN);
          if (rand() < 0.5) sprite.scale.x = -1;
          this.container.addChild(sprite);
          this.sprouts.push({
            sprite, x, phase: rand() * Math.PI * 2,
            speed: SWAY_SPEED[0] + rand() * (SWAY_SPEED[1] - SWAY_SPEED[0]),
            amount: SWAY_AMOUNT * (0.6 + rand() * 0.6)
          });
        }
      }
    }
    this.sprouts.sort((a, b) => a.x - b.x);
  }

  /** camLeft..camRight — видимый диапазон по x (мир). */
  public update(dt: number, camLeft: number, camRight: number): void {
    this.time += dt;
    const list = this.sprouts;
    // первый отросток в обзоре — двоичным поиском
    let lo = 0;
    let hi = list.length;
    const left = camLeft - VIEW_MARGIN;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].x < left) lo = mid + 1; else hi = mid;
    }
    const right = camRight + VIEW_MARGIN;
    for (let i = lo; i < list.length && list[i].x <= right; i++) {
      const s = list[i];
      const gust = 0.65 + 0.35 * Math.sin(this.time * GUST_SPEED + s.x * GUST_WAVELENGTH);
      s.sprite.skew.x = s.amount * gust * Math.sin(this.time * s.speed + s.phase);
    }
  }
}
