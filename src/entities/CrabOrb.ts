import { Container, Sprite } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { Particles } from '../effects/Particles.ts';
import { pal } from '../core/Palette.ts';
import type { Level } from '../world/Level.ts';
import type { HeroRect } from './BossBird.ts';
import { HitReaction } from './HitReaction.ts';
import type { HitCircle, Hittable } from './Hittable.ts';

const GRAVITY = 900; // px/с²
const LIFE = 18; // с: катится не дольше (если так и не столкнулся с парой)
const TOUCH_COOLDOWN = 0.9; // с: пауза между ударами шара по герою
const SHARDS = [pal('gold', 4), pal('gold', 5), pal('gold', 6), pal('gold', 7), pal('virus', 5), pal('virus', 6)];

/**
 * Золотой шар краба. Сначала его держит клешня (hold — растёт из точки), потом его швыряют (release): он катится по полу, вращаясь, отскакивает
 * от стен и ломается, столкнувшись с шаром, катящимся навстречу (это решает игра — CrabOrb.collide). Бьёт героя при касании; удар кулака его разбивает.
 */
export class CrabOrb implements Hittable {
  public readonly container = new Container();
  /** Рассыпался (столкновение, удар кулака, срок жизни, гибель босса): игра убирает его из списков. */
  public expired = false;

  public readonly radius: number;
  public held = true;
  public vx = 0;
  public vy = 0;
  public x: number;
  public y: number;

  private readonly sprite: Sprite;
  private readonly react: HitReaction;
  private age = 0;
  private touchCd = 0;
  private spin = 0;
  private scale = 0;

  constructor(
    sprites: SpriteLibrary, spriteId: string, radius: number, private readonly level: Level, x: number, y: number,
    private readonly hero: () => HeroRect,
    /** Шар задел героя: (сторона отбрасывания) -> засчитан ли урон. */
    private readonly onTouch: (dirX: number) => void,
    private readonly fx: Particles
  ) {
    this.radius = radius;
    this.x = x;
    this.y = y;
    this.sprite = sprites.createSprite(spriteId);
    this.container.addChild(this.sprite);
    this.react = new HitReaction(this.sprite);
    this.apply();
  }

  /** Шар в клешне: стоит в точке, размер от 0 до 1. */
  public hold(x: number, y: number, scale: number): void {
    this.x = x;
    this.y = y;
    this.scale = scale;
    this.apply();
  }

  /** Бросок: скорость (vx, vy); дальше катится сам. */
  public release(vx: number, vy: number): void {
    this.held = false;
    this.scale = 1;
    this.vx = vx;
    this.vy = vy;
  }

  public hitCircles(): HitCircle[] {
    return this.held ? [] : [{ x: this.x, y: this.y, r: this.radius + 2 }];
  }

  public onHit(): void {
    this.react.trigger(0, 0);
  }

  /** Рассыпаться золотыми осколками. */
  public burst(): void {
    if (this.expired) return;
    this.expired = true;
    this.fx.burst(this.x, this.y, { count: 26, colors: SHARDS, speed: [50, 200], spread: Math.PI * 2, life: [0.3, 0.8], size: [1, 3], gravity: 260, drag: 1.5 });
    this.fx.burst(this.x, this.y, { count: 10, colors: [pal('gold', 7), pal('virus', 7)], speed: [20, 90], spread: Math.PI * 2, life: [0.15, 0.35], size: [2, 3], drag: 4 });
  }

  public update(dt: number): void {
    if (this.expired) return;
    dt = Math.min(dt, 1 / 30);
    this.react.update(dt);
    if (this.held) return;
    this.age += dt;
    this.touchCd = Math.max(0, this.touchCd - dt);
    if (this.age > LIFE) {
      this.burst();
      return;
    }
    const ts = this.level.tileSize;
    const r = this.radius;
    // по горизонтали: в стену — отскок
    const dir = Math.sign(this.vx);
    const nx = this.x + this.vx * dt;
    if (dir !== 0 && this.level.isSolidAtPixel(nx + dir * r, this.y - 2)) {
      this.vx = -this.vx;
    } else {
      this.x = nx;
    }
    // по вертикали: падает на пол и катится по нему (скатывается с краёв)
    this.vy += GRAVITY * dt;
    const ny = this.y + this.vy * dt;
    if (this.vy >= 0 && (this.level.isSolidAtPixel(this.x, ny + r) || this.level.isSolidAtPixel(this.x - r * 0.6, ny + r) || this.level.isSolidAtPixel(this.x + r * 0.6, ny + r))) {
      const row = Math.floor((ny + r) / ts);
      this.y = row * ts - r;
      if (this.vy > 220) this.vy = -this.vy * 0.28; // небольшой отскок после падения
      else this.vy = 0;
    } else {
      this.y = ny;
    }
    this.spin += (this.vx / r) * dt;

    // касание героя
    const h = this.hero();
    const cx = Math.max(h.left, Math.min(this.x, h.right));
    const cy = Math.max(h.top, Math.min(this.y, h.bottom));
    if (this.touchCd <= 0 && Math.hypot(this.x - cx, this.y - cy) <= r) {
      this.touchCd = TOUCH_COOLDOWN;
      this.onTouch(this.x < (h.left + h.right) / 2 ? 1 : -1);
    }
    this.apply();
  }

  private apply(): void {
    this.container.position.set(Math.round(this.x), Math.round(this.y));
    this.sprite.rotation = this.spin;
    const s = this.held ? Math.max(0.05, this.scale) : 1;
    this.sprite.scale.set(s);
  }

  /** Два шара катятся навстречу друг другу и сошлись — оба ломаются. Возвращает true, если столкнулись. */
  public static collide(a: CrabOrb, b: CrabOrb): boolean {
    if (a.expired || b.expired || a.held || b.held) return false;
    if (Math.sign(a.vx) === Math.sign(b.vx)) return false; // в одну сторону — не сталкиваются
    if (Math.hypot(a.x - b.x, a.y - b.y) > a.radius + b.radius) return false;
    a.burst();
    b.burst();
    return true;
  }
}
