import { Container, Sprite } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { Particles } from '../effects/Particles.ts';
import { pal } from '../core/Palette.ts';
import type { Level } from '../world/Level.ts';
import { HitReaction } from './HitReaction.ts';
import type { HitCircle, Hittable } from './Hittable.ts';

const HIT_RADIUS = 8; // px: круг попадания птички (кулак толщиной 6 px — попасть легко)
const HERO_RADIUS = 7; // px: на таком расстоянии от тела героя птичка его клюёт
const LAUNCH_TIME = 0.4; // с: первые мгновения птичка летит туда, куда её выпустили, и только потом берёт героя на прицел
const WOBBLE = 38; // px/с: боковое «виляние» — траектория не прямая, а птичья
const FLAP_RATE = 26; // рад/с: взмахи (сжатие рисунка по ширине)
const FEATHERS = [pal('cobalt', 5), pal('cobalt', 6), pal('cobalt', 7), pal('gold', 5)];

interface Vec {
  x: number;
  y: number;
}

/** Тело героя для проверки клевка: прямоугольник в мировых координатах. */
export interface HeroRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface BossBirdOpts {
  speed: number; // px/с
  turn: number; // рад/с: как круто разворачивается в сторону героя
  life: number; // с: через столько птичка рассыпается
  damage: number;
  /** Клевок: (x, y, сторона отбрасывания, урон) -> засчитан ли урон. Засчитанный клевок рассыпает птичку; незасчитанный (герой неуязвим) — она летит дальше. */
  onPeck: (x: number, y: number, dirX: number, damage: number) => boolean;
}

/**
 * Птичка, которую выпускает босс-птица: вылетает веером, потом гонится за героем с ограниченной скоростью поворота
 * (петляет, чуть виляя), клюёт при касании и рассыпается; врезалась в тайл — тоже. Бьётся с одного удара (здоровье задаёт игра).
 */
export class BossBird implements Hittable {
  public readonly container = new Container();
  /** Рассыпалась сама (клюнула, врезалась, вышел срок): игра убирает её из списков. */
  public expired = false;

  private readonly sprite: Sprite;
  private readonly react: HitReaction;
  private pos: Vec;
  private heading: number;
  private age = 0;
  private readonly seed = Math.random() * 10;

  constructor(
    sprites: SpriteLibrary, spriteId: string, private readonly level: Level, x: number, y: number, angle: number,
    private readonly opts: BossBirdOpts,
    private readonly target: () => Vec | null, // куда летит (грудь героя)
    private readonly hero: () => HeroRect,
    private readonly fx: Particles
  ) {
    this.sprite = sprites.createSprite(spriteId);
    this.container.addChild(this.sprite);
    this.pos = { x, y };
    this.heading = angle;
    this.react = new HitReaction(this.sprite);
    this.apply();
  }

  public hitCircles(): HitCircle[] {
    return [{ x: this.pos.x, y: this.pos.y, r: HIT_RADIUS }];
  }

  public onHit(): void {
    this.react.trigger(0, 0);
  }

  /** Рассыпаться пёрышками (клевок, стена, срок жизни, гибель босса); игра подберёт флаг expired. */
  public burst(count = 8): void {
    if (this.expired) return;
    this.expired = true;
    this.fx.burst(this.pos.x, this.pos.y, { count, colors: FEATHERS, speed: [30, 120], life: [0.2, 0.5], size: [1, 2], gravity: 90, drag: 2 });
  }

  public update(dt: number): void {
    if (this.expired) return;
    dt = Math.min(dt, 1 / 30);
    this.age += dt;
    if (this.age >= this.opts.life) {
      this.burst(6);
      return;
    }

    // курс: сначала по инерции выстрела, потом поворот к герою не быстрее turn
    const t = this.target();
    if (t && this.age > LAUNCH_TIME) {
      const want = Math.atan2(t.y - this.pos.y, t.x - this.pos.x);
      const d = Math.atan2(Math.sin(want - this.heading), Math.cos(want - this.heading));
      const max = this.opts.turn * dt;
      this.heading += Math.max(-max, Math.min(max, d));
    }
    // разгон: из точки выпуска вылетает быстро и сбавляет до рабочей скорости
    const launch = Math.max(0, 1 - this.age / LAUNCH_TIME);
    const speed = this.opts.speed * (1 + 0.6 * launch);
    const wob = Math.sin(this.age * 7 + this.seed) * WOBBLE * Math.min(1, this.age / 0.8);
    const nx = this.pos.x + Math.cos(this.heading) * speed * dt - Math.sin(this.heading) * wob * dt;
    const ny = this.pos.y + Math.sin(this.heading) * speed * dt + Math.cos(this.heading) * wob * dt;

    const ts = this.level.tileSize;
    if (this.level.isSolid(Math.floor(nx / ts), Math.floor(ny / ts))) {
      this.pos = { x: nx, y: ny };
      this.burst(6);
      return;
    }
    this.pos = { x: nx, y: ny };

    // клевок: птичка у тела героя
    const h = this.hero();
    const cx = Math.max(h.left, Math.min(this.pos.x, h.right));
    const cy = Math.max(h.top, Math.min(this.pos.y, h.bottom));
    if (Math.hypot(this.pos.x - cx, this.pos.y - cy) <= HERO_RADIUS) {
      if (this.opts.onPeck(this.pos.x, this.pos.y, Math.cos(this.heading) >= 0 ? 1 : -1, this.opts.damage)) {
        this.burst(8);
        return;
      }
    }
    this.apply();
    this.react.update(dt);
  }

  /** Рисунок: клювом по курсу (в рисунке клюв смотрит вверх), крылья — сжатие по ширине. */
  private apply(): void {
    this.container.position.set(Math.round(this.pos.x), Math.round(this.pos.y));
    this.container.rotation = this.heading + Math.PI / 2;
    this.sprite.scale.x = 1 - 0.3 * Math.abs(Math.sin(this.age * FLAP_RATE + this.seed));
  }
}
