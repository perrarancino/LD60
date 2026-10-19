import { Container, Sprite } from 'pixi.js';
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
}

const BULLET_SPEED = 320;
const BULLET_SPARKS = [0xffffff, 0xf6ad55, 0xed8936];
const GEAR_COOLDOWN = 0.35; // с: пауза между бросками шестерёнки (множится на скорость атаки от брони головы)

/**
 * Снаряды героя — шестерёнки (ПКМ без брони на руках). Каждый бросок тратит энергию (Armor.gearCost): энергия копится сама и растёт от брони головы.
 * Луч молнии (ПКМ при броне на руках) — отдельная система (effects/Lightning.ts).
 */
export class ProjectileSystem {
  public readonly container = new Container();

  private bullets: GearBullet[] = [];
  private cooldown = 0;

  constructor(
    private readonly sprites: SpriteLibrary,
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

  private fireGear(x: number, y: number, dirX: number, dirY: number): void {
    const sprite = this.sprites.createSprite('bullet1');
    sprite.position.set(x, y);
    this.container.addChild(sprite);

    this.bullets.push({
      sprite,
      x,
      y,
      vx: dirX * BULLET_SPEED,
      vy: dirY * BULLET_SPEED,
      life: 1.8,
      damage: 10,
      rotationSpeed: (Math.random() < 0.5 ? 1 : -1) * (18 + Math.random() * 8)
    });

    this.fx.burst(x, y, {
      count: 5, colors: BULLET_SPARKS, speed: [40, 100], angle: Math.atan2(dirY, dirX), spread: 0.4, life: [0.1, 0.2], size: [1, 2]
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

      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.sprite.rotation += b.rotationSpeed * dt;
      b.sprite.position.set(b.x, b.y);

      // Столкновение со стенами
      if (level.isSolid(Math.floor(b.x / ts), Math.floor(b.y / ts))) {
        this.fx.burst(b.x, b.y, {
          count: 6, colors: BULLET_SPARKS, speed: [40, 110], spread: Math.PI * 2, life: [0.12, 0.25], size: [1, 2]
        });
        b.sprite.destroy();
        this.bullets.splice(i, 1);
        continue;
      }

      // Попадание во врагов
      let hit = false;
      for (const h of hittables) {
        for (const c of h.hitCircles()) {
          if (Math.hypot(c.x - b.x, c.y - b.y) <= c.r + 5) {
            const dirX = Math.sign(b.vx) || 1;
            const dirY = Math.sign(b.vy) || 0;
            h.onHit(dirX, dirY, c.part);
            this.onDamage(h, b.x, b.y, dirX, c.part, b.damage);
            this.fx.burst(b.x, b.y, {
              count: 9, colors: BULLET_SPARKS, speed: [60, 150], angle: Math.atan2(b.vy, b.vx), spread: 0.6, life: [0.15, 0.3], size: [1, 2]
            });
            hit = true;
            break;
          }
        }
        if (hit) break;
      }

      if (hit) {
        b.sprite.destroy();
        this.bullets.splice(i, 1);
      }
    }
  }

  public clear(): void {
    for (const b of this.bullets) b.sprite.destroy();
    this.bullets = [];
  }
}
