import { Container, Sprite, Texture } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { Level } from '../world/Level.ts';
import type { Hittable } from './Hittable.ts';
import type { Particles } from '../effects/Particles.ts';
import { Armor } from '../systems/ArmorSystem.ts';

interface GearBullet {
  sprite: Sprite;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  damage: number;
  rotationSpeed: number;
  bounces: number; // сколько раз уже отскочила от стен и пола
  hits: Set<Hittable>; // кого уже задела: каждого один раз за полёт
}

const GEAR_COUNT = 3; // шестерёнок за бросок
const GEAR_SPREAD = 0.2; // рад: веер между шестерёнками
const GEAR_SPEED = 300;
const GEAR_GRAVITY = 520; // px/с²
const GEAR_BOUNCE = 0.62; // доля скорости после отскока
const GEAR_MAX_BOUNCES = 4;
const GEAR_LIFE = 2.6; // с
const GEAR_DAMAGE = 8;
const GEAR_RADIUS = 5; // px: радиус попадания
const BULLET_SPARKS = [0xffffff, 0xf6ad55, 0xed8936];
const GEAR_COOLDOWN = 0.4; // с: пауза между бросками (множится на скорость атаки от брони головы)

/** Пиксельная медная шестерёнка 13x13: восемь зубцов, отверстие, свет сверху-слева. Рисуется один раз. */
function makeGearTexture(): Texture {
  const N = 13;
  const c = document.createElement('canvas');
  c.width = N;
  c.height = N;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(N, N);
  const shade = [0x6a3504, 0x905700, 0xb77c00, 0xdda31c, 0xfbc53d, 0xffe5aa];
  const cx = (N - 1) / 2;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = x - cx;
      const dy = y - cx;
      const r = Math.hypot(dx, dy);
      const a = Math.atan2(dy, dx);
      const tooth = Math.cos(a * 8) > 0.15 ? 1.7 : 0;
      if (r > 4.3 + tooth || r < 1.6) continue;
      const light = -(dx + dy) / (r + 1); // свет сверху-слева
      const k = r > 4.3 ? 1 : Math.max(0, Math.min(4, Math.round(2 + light * 2 + (r > 3 ? 0.4 : 0))));
      const col = shade[Math.max(0, Math.min(5, k + (r > 4.3 ? 0 : 0)))];
      const o = (y * N + x) * 4;
      img.data[o] = (col >> 16) & 255;
      img.data[o + 1] = (col >> 8) & 255;
      img.data[o + 2] = col & 255;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = Texture.from(c);
  t.source.scaleMode = 'nearest';
  return t;
}

/**
 * Снаряды героя — три медные шестерёнки веером (ПКМ у медных рук): физичные — летят по дуге под гравитацией, крутятся, отскакивают от пола и стен,
 * бьют каждого врага один раз и летят дальше. Каждый бросок тратит энергию (Armor.gearCost): энергия копится сама и растёт от брони головы.
 * Луч молнии (ПКМ у синих рук) — отдельная система (effects/Lightning.ts).
 */
export class ProjectileSystem {
  public readonly container = new Container();

  private bullets: GearBullet[] = [];
  private cooldown = 0;
  private readonly gearTexture = makeGearTexture();

  constructor(
    _sprites: SpriteLibrary,
    private readonly fx: Particles,
    private readonly onDamage: (target: Hittable, x: number, y: number, dirX: number, part?: number, customDmg?: number) => void
  ) {}

  /** Можно ли запускать бросок: перезарядка прошла и хватает энергии (шкала мигает, если нет). */
  public get ready(): boolean {
    return this.cooldown <= 0;
  }

  /** Бросок шестерёнки из точки (fromX, fromY) в сторону (aimX, aimY): тратит энергию. false — не хватило энергии или идёт перезарядка. */
  public triggerSpecialAttack(
    fromX: number,
    fromY: number,
    aimX: number,
    aimY: number,
    _hittables: Iterable<Hittable>,
    _level: Level
  ): boolean {
    if (this.cooldown > 0) return false;
    const armor = Armor.get();
    if (!armor.spend(armor.gearCost)) return false;

    let dx = aimX - fromX;
    let dy = aimY - fromY;
    let len = Math.hypot(dx, dy);
    if (len < 1) { dx = 1; dy = 0; len = 1; }
    this.fireGear(fromX, fromY, dx / len, dy / len);
    this.cooldown = GEAR_COOLDOWN * armor.attackCooldownMult;
    return true;
  }

  /** Веер из GEAR_COUNT шестерёнок вокруг направления броска. */
  private fireGear(x: number, y: number, dirX: number, dirY: number): void {
    const base = Math.atan2(dirY, dirX);
    for (let k = 0; k < GEAR_COUNT; k++) {
      const a = base + (k - (GEAR_COUNT - 1) / 2) * GEAR_SPREAD + (Math.random() - 0.5) * 0.06;
      const speed = GEAR_SPEED * (0.92 + Math.random() * 0.16);
      const sprite = new Sprite(this.gearTexture);
      sprite.anchor.set(0.5);
      sprite.position.set(x, y);
      this.container.addChild(sprite);
      this.bullets.push({
        sprite, x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, life: GEAR_LIFE, damage: GEAR_DAMAGE,
        rotationSpeed: (Math.random() < 0.5 ? 1 : -1) * (12 + Math.random() * 8), bounces: 0, hits: new Set()
      });
    }
    this.fx.burst(x, y, {
      count: 6, colors: BULLET_SPARKS, speed: [40, 100], angle: Math.atan2(dirY, dirX), spread: 0.5, life: [0.1, 0.2], size: [1, 2]
    });
  }

  public update(dt: number, level: Level, hittables: Iterable<Hittable>, _playerPos: { x: number; y: number }): void {
    this.cooldown = Math.max(0, this.cooldown - dt);

    const ts = level.tileSize;
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.life -= dt;
      if (b.life <= 0) {
        b.sprite.destroy();
        this.bullets.splice(i, 1);
        continue;
      }

      // физика: гравитация, шаг по осям, отскок от тайлов
      b.vy += GEAR_GRAVITY * dt;
      const nx = b.x + b.vx * dt;
      if (level.isSolid(Math.floor(nx / ts), Math.floor(b.y / ts))) {
        b.vx = -b.vx * GEAR_BOUNCE;
        this.bounceFx(b);
      } else {
        b.x = nx;
      }
      const ny = b.y + b.vy * dt;
      if (level.isSolid(Math.floor(b.x / ts), Math.floor(ny / ts))) {
        b.vy = -b.vy * GEAR_BOUNCE;
        b.vx *= 0.9;
        if (Math.abs(b.vy) < 40) b.vy = 0;
        this.bounceFx(b);
      } else {
        b.y = ny;
      }
      if (b.bounces > GEAR_MAX_BOUNCES) {
        b.sprite.destroy();
        this.bullets.splice(i, 1);
        continue;
      }
      b.sprite.rotation += b.rotationSpeed * dt * (Math.abs(b.vx) + Math.abs(b.vy) > 60 ? 1 : 0.2);
      b.sprite.position.set(Math.round(b.x), Math.round(b.y));

      // Попадание во врагов: каждого один раз, шестерёнка отскакивает и летит дальше
      for (const h of hittables) {
        if (b.hits.has(h)) continue;
        let done = false;
        for (const c of h.hitCircles()) {
          if (Math.hypot(c.x - b.x, c.y - b.y) <= c.r + GEAR_RADIUS) {
            const dirX = Math.sign(b.vx) || 1;
            const dirY = Math.sign(b.vy) || 0;
            b.hits.add(h);
            h.onHit(dirX, dirY, c.part);
            this.onDamage(h, b.x, b.y, dirX, c.part, b.damage);
            this.fx.burst(b.x, b.y, {
              count: 8, colors: BULLET_SPARKS, speed: [60, 150], angle: Math.atan2(b.vy, b.vx), spread: 0.6, life: [0.15, 0.3], size: [1, 2]
            });
            b.vx = -b.vx * 0.5;
            b.vy = -Math.abs(b.vy) * 0.6 - 60;
            b.bounces++;
            done = true;
            break;
          }
        }
        if (done) break;
      }
    }
  }

  private bounceFx(b: GearBullet): void {
    b.bounces++;
    this.fx.burst(b.x, b.y, { count: 4, colors: BULLET_SPARKS, speed: [30, 90], spread: Math.PI * 2, life: [0.1, 0.2], size: [1, 2] });
  }

  public clear(): void {
    for (const b of this.bullets) b.sprite.destroy();
    this.bullets = [];
  }
}
