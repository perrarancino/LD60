import { Container, FillGradient, Graphics, Sprite, Texture, TilingSprite } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { BackgroundDef } from '../data/types.ts';

interface Layer {
  sprite: TilingSprite;
  parallaxX: number;
  parallaxY: number;
  driftX: number; // собственный дрейф слоя, px/с
  height: number; // высота слоя на экране, виртуальные px
}

interface Star {
  sprite: Sprite;
  x: number; // позиция в «мире» звёздного неба, px
  y: number;
  speed: number; // скорость мерцания
  phase: number;
  base: number; // базовая яркость
}

interface Mote {
  sprite: Sprite;
  armH: Sprite; // «лучики» вокруг частицы (пиксельное свечение-крестик)
  armV: Sprite;
  x: number;
  y: number;
  vy: number; // подъём, px/с
  sway: number; // амплитуда качания, px
  swaySpeed: number;
  phase: number;
}

interface Meteor {
  head: Sprite;
  tail: Sprite[];
  x: number;
  y: number;
  vx: number;
  vy: number;
  t: number;
  life: number;
}

const rng = (seed: number) => () => {
  // mulberry32: детерминированный генератор, чтобы звёзды не «перетасовывались» при изменении окна
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const TAIL_SEGMENTS = 9;

/**
 * Параллакс-фон из зацикленных по горизонтали слоёв (data/backgrounds/*.json) + «живое» небо:
 *  - градиент неба сверху, мерцающие звёзды и редкие падающие звёзды;
 *  - собственный дрейф слоёв-дымки (туман медленно плывёт сам по себе);
 *  - всплывающие светящиеся частицы-«биты» перед дальними слоями.
 * Каждый слой сдвигается на долю сдвига камеры: дальние почти стоят, ближние идут почти вместе с миром.
 * По вертикали слои стоят на «земле» (низ уровня + ground_offset) в нижней точке камеры и слегка «плывут» при подъёме камеры;
 * то, что слои не закрывают сверху, закрашено градиентом неба.
 */
export class ParallaxBackground {
  public readonly container = new Container();

  private sky = new Graphics();
  private starLayer = new Container();
  private meteorLayer = new Container();
  private layerLayer = new Container();
  private moteLayer = new Container();

  private layers: Layer[] = [];
  private stars: Star[] = [];
  private motes: Mote[] = [];
  private meteor: Meteor | null = null;
  private nextMeteorIn: number;
  private random = rng(1337);

  private viewW = 0;
  private viewH = 0;
  private skyBottom = 0; // до какой высоты экрана небо свободно от слоёв
  private time = 0;

  /** Спрайты слоёв должны быть уже загружены (SpriteLibrary.load). */
  public static spriteIds(def: BackgroundDef): string[] {
    return def.layers.map((l) => l.sprite_id);
  }

  constructor(private readonly def: BackgroundDef, sprites: SpriteLibrary) {
    this.container.addChild(this.sky, this.starLayer, this.meteorLayer, this.layerLayer, this.moteLayer);
    for (const l of def.layers) {
      const texture = sprites.texture(l.sprite_id);
      const sprite = new TilingSprite({ texture, width: 1, height: texture.height * def.scale });
      sprite.tileScale.set(def.scale);
      this.layerLayer.addChild(sprite);
      this.layers.push({
        sprite, parallaxX: l.parallax_x, parallaxY: l.parallax_y, driftX: l.drift_x ?? 0, height: texture.height * def.scale
      });
    }
    const fx = def.effects?.shooting_stars;
    this.nextMeteorIn = fx ? this.random() * (fx.max_interval - fx.min_interval) + fx.min_interval : Infinity;
  }

  /** Размер видимой области (виртуальные px) изменился. */
  public resize(viewW: number, viewH: number): void {
    this.viewW = viewW;
    this.viewH = viewH;
    for (const l of this.layers) l.sprite.width = viewW;

    // Небо: градиент от верха к sky_color у горизонта (там, где начинаются слои)
    const maxLayerH = Math.max(...this.layers.map((l) => l.height));
    this.skyBottom = Math.max(32, viewH - maxLayerH - (this.def.ground_offset ?? 0));
    const top = this.def.effects?.sky_top_color ?? this.def.sky_color;
    const end = Math.min(1, (this.skyBottom + maxLayerH * 0.35) / viewH);
    const gradient = new FillGradient({
      type: 'linear',
      start: { x: 0, y: 0 },
      end: { x: 0, y: 1 },
      colorStops: [
        { offset: 0, color: top },
        { offset: end, color: this.def.sky_color },
        { offset: 1, color: this.def.sky_color }
      ],
      textureSpace: 'local'
    });
    this.sky.clear().rect(0, 0, viewW, viewH).fill(gradient);

    this.buildStars();
    this.buildMotes();
  }

  private buildStars(): void {
    this.starLayer.removeChildren().forEach((c) => c.destroy());
    this.stars = [];
    const fx = this.def.effects?.stars;
    if (!fx) return;
    const rand = rng(7);
    const area = this.skyBottom + 50; // звёзды видны и сквозь полупрозрачную дымку над горизонтом
    const count = Math.round(this.viewW * area * fx.density);
    for (let i = 0; i < count; i++) {
      const sprite = new Sprite(Texture.WHITE);
      const size = rand() < 0.12 ? 2 : 1;
      sprite.width = sprite.height = size;
      sprite.tint = fx.colors[Math.floor(rand() * fx.colors.length)];
      this.starLayer.addChild(sprite);
      this.stars.push({
        sprite, x: rand() * this.viewW, y: rand() * area,
        speed: 0.6 + rand() * 2.2, phase: rand() * Math.PI * 2, base: 0.3 + rand() * 0.7
      });
    }
  }

  private buildMotes(): void {
    this.moteLayer.removeChildren().forEach((c) => c.destroy());
    this.motes = [];
    const fx = this.def.effects?.motes;
    if (!fx) return;
    const rand = rng(21);
    const count = Math.round(this.viewW * this.viewH * fx.density);
    for (let i = 0; i < count; i++) {
      const color = fx.colors[Math.floor(rand() * fx.colors.length)];
      const size = rand() < 0.35 ? 3 : 2;
      const mk = (w: number, h: number) => {
        const sp = new Sprite(Texture.WHITE);
        sp.width = w;
        sp.height = h;
        sp.tint = color;
        sp.blendMode = 'add'; // свечение складывается с фоном
        return sp;
      };
      const sprite = mk(size, size);
      const armH = mk(size + 4, 1);
      const armV = mk(1, size + 4);
      this.moteLayer.addChild(armH, armV, sprite);
      this.motes.push({
        sprite, armH, armV, x: rand() * this.viewW, y: rand() * this.viewH, vy: 4 + rand() * 12,
        sway: 2 + rand() * 6, swaySpeed: 0.4 + rand() * 1.1, phase: rand() * Math.PI * 2
      });
    }
  }

  /**
   * @param camX, camY положение камеры в мире (левый верхний угол видимой области)
   * @param maxCamY положение камеры, когда она внизу уровня: там слои стоят на земле
   * @param pixelScale физических пикселей на виртуальный — сдвиги выравниваются по ним, чтобы пиксели не «плыли»
   * @param dt шаг времени, с (0 — только пересчитать положения)
   */
  public update(camX: number, camY: number, maxCamY: number, pixelScale: number, dt = 0): void {
    this.time += dt;
    const snap = (v: number) => Math.round(v * pixelScale) / pixelScale;

    for (const l of this.layers) {
      l.sprite.tilePosition.x = snap(-camX * l.parallaxX + l.driftX * this.time);
      l.sprite.y = snap(this.viewH - l.height - (this.def.ground_offset ?? 0) + (maxCamY - camY) * l.parallaxY);
    }

    const starFx = this.def.effects?.stars;
    if (starFx) {
      const w = this.viewW;
      for (const s of this.stars) {
        const x = (((s.x - camX * starFx.parallax) % w) + w) % w;
        s.sprite.position.set(Math.floor(x), Math.floor(s.y - (camY - maxCamY) * starFx.parallax * 0.5 + 0));
        // мерцание: плавное, у части звёзд — резкие вспышки
        const tw = 0.5 + 0.5 * Math.sin(this.time * s.speed + s.phase);
        s.sprite.alpha = s.base * (0.25 + 0.75 * tw * tw);
      }
    }

    this.updateMeteor(dt);
    this.updateMotes(dt, camX, camY - maxCamY);
  }

  private updateMotes(dt: number, camX: number, camDy: number): void {
    const fx = this.def.effects?.motes;
    if (!fx) return;
    const w = this.viewW;
    const top = this.viewH * 0.45; // частицы живут в нижней части экрана (над землёй), выше — только небо
    for (const m of this.motes) {
      m.y -= m.vy * dt;
      if (m.y < top) { m.y = this.viewH + this.random() * 20; m.x = this.random() * w; }
      const x = (((m.x + Math.sin(this.time * m.swaySpeed + m.phase) * m.sway - camX * fx.parallax) % w) + w) % w;
      const px = Math.floor(x);
      const py = Math.floor(m.y - camDy * 0.1);
      m.sprite.position.set(px, py);
      const sz = m.sprite.width;
      m.armH.position.set(px - 2, py + Math.floor(sz / 2));
      m.armV.position.set(px + Math.floor(sz / 2), py - 2);
      // пульс + плавное появление у нижнего края и затухание у верхнего
      const edge = Math.min(1, (this.viewH - m.y) / 24, (m.y - top) / 40);
      const pulse = 0.55 + 0.45 * Math.sin(this.time * 1.8 + m.phase * 3);
      const a = Math.max(0, edge) * pulse;
      m.sprite.alpha = a;
      m.armH.alpha = m.armV.alpha = a * 0.4;
    }
  }

  private updateMeteor(dt: number): void {
    const fx = this.def.effects?.shooting_stars;
    if (!fx) return;
    if (!this.meteor) {
      this.nextMeteorIn -= dt;
      if (this.nextMeteorIn > 0 || this.viewW === 0) return;
      this.spawnMeteor(fx.color);
      return;
    }
    const m = this.meteor;
    m.t += dt;
    m.x += m.vx * dt;
    m.y += m.vy * dt;
    const k = m.t / m.life;
    const fade = Math.sin(Math.PI * Math.min(1, k)); // вспыхивает и гаснет
    m.head.position.set(Math.floor(m.x), Math.floor(m.y));
    m.head.alpha = fade;
    const len = Math.hypot(m.vx, m.vy);
    for (let i = 0; i < m.tail.length; i++) {
      const back = (i + 1) * 3.2;
      m.tail[i].position.set(Math.floor(m.x - (m.vx / len) * back), Math.floor(m.y - (m.vy / len) * back));
      m.tail[i].alpha = fade * (1 - (i + 1) / (m.tail.length + 1)) * 0.8;
    }
    if (k >= 1) {
      this.meteorLayer.removeChildren().forEach((c) => c.destroy());
      this.meteor = null;
      this.nextMeteorIn = this.random() * (fx.max_interval - fx.min_interval) + fx.min_interval;
    }
  }

  private spawnMeteor(color: string): void {
    const make = (size: number) => {
      const s = new Sprite(Texture.WHITE);
      s.width = s.height = size;
      s.tint = color;
      this.meteorLayer.addChild(s);
      return s;
    };
    const tail: Sprite[] = [];
    for (let i = 0; i < TAIL_SEGMENTS; i++) tail.push(make(1));
    const head = make(2);
    const dir = this.random() < 0.5 ? 1 : -1; // летит вправо-вниз или влево-вниз
    const speed = 170 + this.random() * 90;
    const angle = 0.35 + this.random() * 0.3;
    this.meteor = {
      head, tail,
      x: dir > 0 ? this.random() * this.viewW * 0.5 : this.viewW * (0.5 + this.random() * 0.5),
      y: this.random() * this.skyBottom * 0.5,
      vx: dir * Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      t: 0, life: 0.9 + this.random() * 0.5
    };
  }
}
