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
  hitAt: Map<Hittable, number>; // когда задела врага в последний раз (с жизни шестерёнки): катясь, бьёт каждого снова через GEAR_REHIT
  restT: number; // сколько уже почти стоит
}

const GEAR_COUNT = 3; // шестерёнок за бросок
const GEAR_SPREAD = 0.2; // рад: веер между шестерёнками
const GEAR_SPEED = 300;
const GEAR_GRAVITY = 520; // px/с²
const GEAR_BOUNCE = 0.5; // доля скорости после отскока от стены
const GEAR_FLOOR_BOUNCE = 0.38; // доля вертикальной скорости после удара об пол: быстро переходит в качение
const GEAR_ROLL_FRICTION = 0.5; // 1/с: торможение качения по полу (катится далеко)
const GEAR_REHIT = 0.28; // с: пауза, прежде чем катящаяся шестерёнка снова ударит того же врага
const GEAR_MAX_BOUNCES = 4;
const GEAR_LIFE = 5; // с
const GEAR_DAMAGE = 8;
const GEAR_RADIUS = 5; // px: радиус для физики (стены, пол, качение)
const GEAR_HIT_RADIUS = 6; // px: радиус попадания (примерно как у рисунка 13×13)
const BULLET_SPARKS = [0xffffff, 0xf6ad55, 0xed8936];
const GEAR_COOLDOWN = 0.4; // с: пауза между бросками (множится на скорость атаки от брони головы)

/**
 * Пересечение отрезка пути снаряда с кругом. Быстрый снаряд за кадр проходит несколько пикселей, поэтому проверять
 * только конечную точку нельзя: шестерёнка «проскакивала» сквозь мелких летающих врагов. Возвращает точку касания.
 */
function segmentHitsCircle(
  ax: number, ay: number, bx: number, by: number, cx: number, cy: number, r: number
): { x: number; y: number } | null {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / l2)) : 0;
  const x = ax + dx * t;
  const y = ay + dy * t;
  return Math.hypot(cx - x, cy - y) <= r ? { x, y } : null;
}

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
        rotationSpeed: (Math.random() < 0.5 ? 1 : -1) * (12 + Math.random() * 8), bounces: 0, hitAt: new Map(), restT: 0
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
      const prevX = b.x;
      const prevY = b.y;

      // физика: гравитация, шаг по осям, отскок от тайлов, качение по полу
      const onFloor = level.isSolid(Math.floor(b.x / ts), Math.floor((b.y + GEAR_RADIUS + 1) / ts));
      if (!onFloor || b.vy < 0) b.vy += GEAR_GRAVITY * dt;
      const nx = b.x + b.vx * dt;
      if (level.isSolid(Math.floor((nx + Math.sign(b.vx) * GEAR_RADIUS) / ts), Math.floor(b.y / ts))) {
        b.vx = -b.vx * GEAR_BOUNCE;
        this.bounceFx(b);
      } else {
        b.x = nx;
      }
      const ny = b.y + b.vy * dt;
      if (level.isSolid(Math.floor(b.x / ts), Math.floor((ny + (b.vy >= 0 ? 1 : -1) * GEAR_RADIUS) / ts))) {
        if (b.vy >= 0) {
          // пол: от сильного удара подскакивает, от слабого катится
          if (b.vy > 90) {
            b.vy = -b.vy * GEAR_FLOOR_BOUNCE;
            this.bounceFx(b);
          } else {
            b.vy = 0;
            b.y = Math.floor((ny + GEAR_RADIUS) / ts) * ts - GEAR_RADIUS;
          }
        } else {
          b.vy = -b.vy * GEAR_BOUNCE; // потолок
          this.bounceFx(b);
        }
      } else {
        b.y = ny;
      }
      if (onFloor && b.vy >= 0) {
        b.vx *= Math.exp(-GEAR_ROLL_FRICTION * dt);
        if (Math.abs(b.vx) < 14) b.restT += dt;
        else b.restT = 0;
        if (b.restT > 0.5) {
          b.sprite.destroy();
          this.bullets.splice(i, 1);
          continue;
        }
      }
      if (b.bounces > GEAR_MAX_BOUNCES + 6) {
        b.sprite.destroy();
        this.bullets.splice(i, 1);
        continue;
      }
      // качение — вращение по скорости (без проскальзывания), в воздухе — по инерции
      b.sprite.rotation += (onFloor ? b.vx / (GEAR_RADIUS + 1) : b.rotationSpeed) * dt;
      b.sprite.position.set(Math.round(b.x), Math.round(b.y));

      // Попадание во врагов: проверяем весь путь за кадр (prev -> текущая точка), чтобы быстрая шестерёнка
      // не пролетала сквозь врага. Катящаяся шестерёнка проходит сквозь и бьёт каждого снова через GEAR_REHIT.
      const now = GEAR_LIFE - b.life;
      for (const h of [...hittables]) { // копия: попадание может убить цель и изменить списки врагов
        const last = b.hitAt.get(h);
        if (last !== undefined && now - last < GEAR_REHIT) continue;
        let contact: { x: number; y: number } | null = null;
        let part: number | undefined;
        for (const c of h.hitCircles()) {
          contact = segmentHitsCircle(prevX, prevY, b.x, b.y, c.x, c.y, c.r + GEAR_HIT_RADIUS);
          if (contact) { part = c.part; break; }
        }
        if (!contact) continue;
        const dirX = Math.sign(b.vx) || 1;
        const dirY = Math.sign(b.vy) || 0;
        b.hitAt.set(h, now);
        h.onHit(dirX, dirY, part);
        this.onDamage(h, contact.x, contact.y, dirX, part, b.damage);
        this.fx.burst(contact.x, contact.y, {
          count: 7, colors: BULLET_SPARKS, speed: [60, 150], angle: Math.atan2(b.vy, b.vx), spread: 0.6, life: [0.15, 0.3], size: [1, 2]
        });
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
