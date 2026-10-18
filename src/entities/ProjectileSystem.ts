import { Container, Graphics, Sprite } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { Level } from '../world/Level.ts';
import type { Hittable } from './Hittable.ts';
import type { Particles } from '../effects/Particles.ts';
import { CraftingSystem } from '../systems/CraftingSystem.ts';

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

interface LightningArc {
  points: { x: number; y: number }[];
  life: number;
  maxLife: number;
  color: number;
}

interface VortexZone {
  x: number;
  y: number;
  dirX: number;
  dirY: number;
  radius: number;
  life: number;
  maxLife: number;
  level: number;
  tickTimer: number;
}

const BULLET_SPEED = 320;
const BULLET_SPARKS = [0xffffff, 0xf6ad55, 0xed8936];
const SHOCK_SPARKS = [0x67e8f9, 0x38bdf8, 0xffffff];

export class ProjectileSystem {
  public readonly container = new Container();
  private readonly gfx = new Graphics();

  private bullets: GearBullet[] = [];
  private arcs: LightningArc[] = [];
  private vortex: VortexZone | null = null;

  // Очередь для серийной стрельбы (ур2 = 2 шестерни, ур3 = 3 шестерни)
  private burstRemaining = 0;
  private burstInterval = 0.08;
  private burstTimer = 0;
  private burstOrigin = { x: 0, y: 0, dirX: 1, dirY: 0 };

  private cooldown = 0;

  constructor(
    private readonly sprites: SpriteLibrary,
    private readonly fx: Particles,
    private readonly onDamage: (target: Hittable, x: number, y: number, dirX: number, part?: number, customDmg?: number) => void
  ) {
    this.container.addChild(this.gfx);
  }

  /**
   * Запуск спец-атаки на ПКМ в зависимости от активной руки и её уровня
   */
  public triggerSpecialAttack(
    fromX: number,
    fromY: number,
    aimX: number,
    aimY: number,
    hittables: Iterable<Hittable>,
    level: Level
  ): boolean {
    if (this.cooldown > 0) return false;

    const crafting = CraftingSystem.get();
    const arm = crafting.activeParts.arms;
    const armType = arm.type;
    const armLevel = Math.max(1, arm.level);

    let dx = aimX - fromX;
    let dy = aimY - fromY;
    let len = Math.hypot(dx, dy);
    if (len < 1) { dx = 1; dy = 0; len = 1; }
    const dirX = dx / len;
    const dirY = dy / len;

    const cdMult = crafting.getAttackSpeedMultiplier();

    if (armType === 'standard') {
      // Стандартная рука: бросок шестеренки bullet1
      // ур1: 1 шт, ур2: 2 шт подряд, ур3: 3 шт подряд
      this.fireGear(fromX, fromY, dirX, dirY);
      if (armLevel > 1) {
        this.burstRemaining = armLevel - 1;
        this.burstTimer = this.burstInterval;
        this.burstOrigin = { x: fromX, y: fromY, dirX, dirY };
      }
      this.cooldown = 0.35 * cdMult;
      return true;
    }

    if (armType === 'wire') {
      // Проводная рука: удар током на расстоянии
      // ур1: базовая дистанция ~150px
      // ур2: ~240px + 1 рикошет от стен
      // ур3: ~340px + до 2 рикошетов от стен
      const maxDist = armLevel === 1 ? 150 : armLevel === 2 ? 240 : 340;
      const maxBounces = armLevel - 1;
      this.fireShock(fromX, fromY, dirX, dirY, maxDist, maxBounces, hittables, level);
      this.cooldown = 0.45 * cdMult;
      return true;
    }

    if (armType === 'disc') {
      // Дисковая рука: дисковый вихрь
      // ур1: притягивает и слегка режет
      // ур2: сильнее притягивает, режет и отталкивает
      // ур3: мощный дисковый вихрь, сильная резка и взрывное отталкивание с уроном
      this.vortex = {
        x: fromX,
        y: fromY,
        dirX,
        dirY,
        radius: 70 + armLevel * 25,
        life: 0.6,
        maxLife: 0.6,
        level: armLevel,
        tickTimer: 0
      };
      this.cooldown = 0.7 * cdMult;
      return true;
    }

    return false;
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

  private fireShock(
    startX: number,
    startY: number,
    dirX: number,
    dirY: number,
    maxDist: number,
    bouncesLeft: number,
    hittables: Iterable<Hittable>,
    level: Level
  ): void {
    const points: { x: number; y: number }[] = [{ x: startX, y: startY }];
    let curX = startX;
    let curY = startY;
    let curDirX = dirX;
    let curDirY = dirY;
    let remainingDist = maxDist;
    const ts = level.tileSize;
    const hitEnemies = new Set<Hittable>();

    for (let bounce = 0; bounce <= bouncesLeft; bounce++) {
      let step = 0;
      let hitWall = false;
      let wallNormalX = 0;
      let wallNormalY = 0;

      while (step < remainingDist) {
        step += 8;
        const testX = curX + curDirX * 8;
        const testY = curY + curDirY * 8;

        // Проверка тайлов
        const tileX = Math.floor(testX / ts);
        const tileY = Math.floor(testY / ts);
        if (level.isSolid(tileX, tileY)) {
          hitWall = true;
          // Определение нормали стены
          const prevTileX = Math.floor(curX / ts);
          const prevTileY = Math.floor(curY / ts);
          if (tileX !== prevTileX) wallNormalX = prevTileX < tileX ? -1 : 1;
          if (tileY !== prevTileY) wallNormalY = prevTileY < tileY ? -1 : 1;
          curX = testX;
          curY = testY;
          break;
        }

        curX = testX;
        curY = testY;

        // Проверка врагов по пути молнии
        for (const h of hittables) {
          if (hitEnemies.has(h)) continue;
          for (const c of h.hitCircles()) {
            if (Math.hypot(c.x - curX, c.y - curY) <= c.r + 8) {
              hitEnemies.add(h);
              h.onHit(curDirX, curDirY, c.part);
              this.onDamage(h, curX, curY, curDirX, c.part, 12 + bounce * 3);
              this.fx.burst(curX, curY, {
                count: 8, colors: SHOCK_SPARKS, speed: [50, 140], spread: Math.PI * 2, life: [0.15, 0.3], size: [1, 2]
              });
            }
          }
        }
      }

      points.push({ x: curX, y: curY });
      remainingDist -= step;

      if (!hitWall || remainingDist <= 10) break;

      // Отражение вектора от стены
      if (wallNormalX !== 0) curDirX = -curDirX;
      if (wallNormalY !== 0) curDirY = -curDirY;

      this.fx.burst(curX, curY, {
        count: 6, colors: SHOCK_SPARKS, speed: [60, 120], spread: Math.PI, life: [0.15, 0.25], size: [1, 2]
      });
    }

    this.arcs.push({
      points,
      life: 0.12,
      maxLife: 0.12,
      color: 0x38bdf8
    });
  }

  public update(dt: number, level: Level, hittables: Iterable<Hittable>, playerPos: { x: number; y: number }): void {
    this.cooldown = Math.max(0, this.cooldown - dt);

    // Серийная стрельба
    if (this.burstRemaining > 0) {
      this.burstTimer -= dt;
      if (this.burstTimer <= 0) {
        this.burstTimer = this.burstInterval;
        this.burstRemaining--;
        this.fireGear(playerPos.x, playerPos.y, this.burstOrigin.dirX, this.burstOrigin.dirY);
      }
    }

    // Обновление пуль-шестеренок
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

      // Проверка столкновения со стенами
      const tileX = Math.floor(b.x / ts);
      const tileY = Math.floor(b.y / ts);
      if (level.isSolid(tileX, tileY)) {
        this.fx.burst(b.x, b.y, {
          count: 6, colors: BULLET_SPARKS, speed: [40, 110], spread: Math.PI * 2, life: [0.12, 0.25], size: [1, 2]
        });
        b.sprite.destroy();
        this.bullets.splice(i, 1);
        continue;
      }

      // Проверка попадания во врагов
      let hit = false;
      for (const h of hittables) {
        for (const c of h.hitCircles()) {
          const dist = Math.hypot(c.x - b.x, c.y - b.y);
          if (dist <= c.r + 5) {
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

    // Обновление дискового вихря
    if (this.vortex) {
      const v = this.vortex;
      v.x = playerPos.x;
      v.y = playerPos.y;
      v.life -= dt;
      v.tickTimer -= dt;

      // Притягивание врагов к игроку
      for (const h of hittables) {
        for (const c of h.hitCircles()) {
          const dx = v.x - c.x;
          const dy = v.y - c.y;
          const dist = Math.hypot(dx, dy);
          if (dist < v.radius && dist > 10) {
            const pullForce = (1 - dist / v.radius) * (180 + v.level * 80) * dt;
            const pullX = (dx / dist) * pullForce;
            const pullY = (dy / dist) * pullForce;
            // Смещение врага к игроку
            h.onHit(pullX, pullY, c.part);

            if (v.tickTimer <= 0) {
              const tickDamage = v.level === 1 ? 3 : v.level === 2 ? 6 : 9;
              this.onDamage(h, c.x, c.y, Math.sign(dx), c.part, tickDamage);
              this.fx.burst(c.x, c.y, {
                count: 3, colors: [0xa855f7, 0xec4899], speed: [30, 70], spread: Math.PI * 2, life: [0.1, 0.2], size: [1, 2]
              });
            }
          }
        }
      }

      if (v.tickTimer <= 0) v.tickTimer = 0.15;

      // Завершение вихря: отталкивание на ур2 и ур3
      if (v.life <= 0) {
        if (v.level >= 2) {
          const pushForce = v.level === 3 ? 240 : 160;
          for (const h of hittables) {
            for (const c of h.hitCircles()) {
              const dx = c.x - v.x;
              const dy = c.y - v.y;
              const dist = Math.hypot(dx, dy);
              if (dist < v.radius) {
                const nx = (dx / Math.max(1, dist)) * pushForce;
                const ny = (dy / Math.max(1, dist)) * pushForce;
                h.onHit(nx, ny, c.part);
                if (v.level === 3) {
                  // Ударный урон при отталкивании на ур3
                  this.onDamage(h, c.x, c.y, Math.sign(nx), c.part, 20);
                }
              }
            }
          }
          this.fx.burst(v.x, v.y, {
            count: 16, colors: [0xa855f7, 0x06b6d4, 0xffffff], speed: [80, 200], spread: Math.PI * 2, life: [0.2, 0.4], size: [1, 2]
          });
        }
        this.vortex = null;
      }
    }

    // Отрисовка графики молний и вихрей
    this.renderGfx(dt);
  }

  private renderGfx(dt: number): void {
    const g = this.gfx;
    g.clear();

    // Отрисовка электрических дуг
    for (let i = this.arcs.length - 1; i >= 0; i--) {
      const arc = this.arcs[i];
      arc.life -= dt;
      if (arc.life <= 0) {
        this.arcs.splice(i, 1);
        continue;
      }

      const alpha = arc.life / arc.maxLife;
      g.setStrokeStyle({ width: 2, color: arc.color, alpha });

      for (let p = 0; p < arc.points.length - 1; p++) {
        const p1 = arc.points[p];
        const p2 = arc.points[p + 1];
        // Добавление легкого зигзага для эффекта молнии
        const midX = (p1.x + p2.x) / 2 + (Math.random() * 8 - 4);
        const midY = (p1.y + p2.y) / 2 + (Math.random() * 8 - 4);
        g.moveTo(p1.x, p1.y);
        g.lineTo(midX, midY);
        g.lineTo(p2.x, p2.y);
      }
      g.stroke();
    }

    // Отрисовка вихря дисковой руки
    if (this.vortex) {
      const v = this.vortex;
      const progress = 1 - v.life / v.maxLife;
      const pulseR = v.radius * (0.8 + 0.2 * Math.sin(progress * 20));
      g.setStrokeStyle({ width: 1.5, color: 0xc084fc, alpha: 0.6 });
      g.circle(v.x, v.y, pulseR);
      g.stroke();

      // Спиральные линии вихря
      const spirals = 4;
      for (let s = 0; s < spirals; s++) {
        const baseAngle = (s * Math.PI * 2) / spirals + progress * 15;
        g.setStrokeStyle({ width: 1, color: 0x38bdf8, alpha: 0.45 });
        g.moveTo(v.x, v.y);
        const ex = v.x + Math.cos(baseAngle) * pulseR;
        const ey = v.y + Math.sin(baseAngle) * pulseR;
        g.lineTo(ex, ey);
        g.stroke();
      }
    }
  }

  public clear(): void {
    for (const b of this.bullets) b.sprite.destroy();
    this.bullets = [];
    this.arcs = [];
    this.vortex = null;
    this.gfx.clear();
  }
}
