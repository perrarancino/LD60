import type { AnimatedSprite } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { EnemyDef, EnemySpawnDef, HitboxDef, SpriteDef } from '../data/types.ts';
import type { Level } from '../world/Level.ts';
import { Body } from './Body.ts';
import type { Hittable, HitCircle } from './Hittable.ts';
import { HitReaction } from './HitReaction.ts';
import type { Leash } from '../world/Rooms.ts';

const KNOCKBACK = 140; // px/с: отдача от удара (вид)
const KNOCK_PUSH = 70; // px/с: отдача телу
const GRAVITY = 850; // px/с²
const SIGHT = 230; // px: на таком расстоянии замечает героя
const SEE_HEIGHT = 110; // px: и на такой разнице высот
const LEDGE_PROBE = 4; // px: проверка земли впереди
const CHASE_BOOST = 1.5; // во сколько раз быстрее ходит за героем (патрульный)
const JUMP = 300; // px/с: обычный прыжок (≈ 53 px вверх)
const JUMP_UP = 400; // px/с: прыжок на уступ повыше (≈ 94 px)
const LEAP_MAX_VX = 200; // px/с: потолок скорости по горизонтали в прыжке на героя
const LEAP_RANGE = 175; // px: с такого расстояния прыгает на героя
const WINDUP = 0.3; // с: приседает перед прыжком на героя
const SQUASH_RATE = 12; // 1/с: возврат формы после приседания и приземления
const DRAW_FACING = -1; // куда смотрит рисунок (−1 — влево)

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Обычный наземный враг с физикой (Body): ходит и прыгает. «Прыгун» скачет, замечает героя, приседает и бросается на него дугой;
 * «патрульный» ходит туда-сюда, заметив героя — бежит к нему, перепрыгивает стенки и провалы, взбирается на уступ, а вблизи прыгает на героя.
 * Урон героя — контактный (его проверяет игра по кругам попадания).
 */
export class Enemy implements Hittable {
  public readonly sprite: AnimatedSprite;
  public leash: Leash | null = null;
  /** Ноги героя (мир): враг, заметивший его, идёт или прыгает на него. */
  public hero: (() => { x: number; y: number } | null) | null = null;

  private readonly body = new Body();
  private readonly spriteDef: SpriteDef;
  private readonly hitbox: HitboxDef;
  private readonly react: HitReaction;
  private readonly speed: number;
  private readonly jumper: boolean;
  private facing: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
  private state: 'ground' | 'windup' | 'air' = 'ground';
  private stateT = 0;
  private leapCd = rand(0.4, 1.6);
  private hopT = rand(0.4, 1.4);
  private squash = 0; // >0 — приплюснут (присел / приземлился), <0 — вытянут (прыжок)

  constructor(public readonly def: EnemyDef, spawn: EnemySpawnDef, tileSize: number, sprites: SpriteLibrary, private readonly level: Level) {
    if (!def.sprite_variants.includes(spawn.sprite_id)) {
      throw new Error(`[Enemy] спрайт "${spawn.sprite_id}" не входит в sprite_variants врага "${def.id}"`);
    }
    this.sprite = sprites.createAnimated(spawn.sprite_id);
    this.spriteDef = sprites.def(spawn.sprite_id);
    const sd = this.spriteDef;
    this.hitbox = sd.hitbox ?? { offset_x: 0, offset_y: 0, width: sd.frame_width, height: sd.frame_height };
    this.speed = def.stats.movement_speed;
    this.jumper = def.behavior_type === 'jumper';
    // Ноги — на нижней границе клетки спавна
    this.body.setHitbox({ ...sd, hitbox: this.hitbox }, this.mirrored());
    this.body.x = (spawn.x + 0.5) * tileSize;
    this.body.y = (spawn.y + 1) * tileSize;
    this.react = new HitReaction(this.sprite);
    this.applyView();
  }

  private mirrored(): boolean {
    return this.facing !== DRAW_FACING;
  }

  private setFacing(f: 1 | -1): void {
    if (f === this.facing) return;
    this.facing = f;
    this.body.setHitbox({ ...this.spriteDef, hitbox: this.hitbox }, this.mirrored());
  }

  private inRoom(x: number, y: number): boolean {
    return !this.leash || this.leash.contains(x, y);
  }

  private groundAhead(dir: number): boolean {
    const b = this.body;
    const ts = this.level.tileSize;
    return this.level.isSolid(Math.floor((b.x + dir * (b.hitWidth / 2 + LEDGE_PROBE)) / ts), Math.floor((b.y + 3) / ts));
  }

  /** Герой в пределах зрения (и в одной комнате с врагом). */
  private heroNear(): { x: number; y: number } | null {
    if (this.leash && !this.leash.hero()) return null;
    const h = this.hero?.() ?? null;
    if (!h) return null;
    return Math.abs(h.x - this.body.x) < SIGHT && Math.abs(h.y - this.body.y) < SEE_HEIGHT ? h : null;
  }

  /** Прыжок: вертикальная скорость vy, горизонтальная vx; враг в воздухе не управляется до приземления. */
  private jump(vy: number, vx: number): void {
    const b = this.body;
    b.vy = -vy;
    b.vx = vx;
    if (vx !== 0) this.setFacing(vx > 0 ? 1 : -1);
    this.state = 'air';
    this.stateT = 0;
    this.squash = -0.3;
  }

  public update(dt: number): void {
    dt = Math.min(dt, 1 / 30);
    this.react.update(dt);
    const b = this.body;
    this.leapCd -= dt;
    this.stateT += dt;
    this.squash += (0 - this.squash) * (1 - Math.exp(-SQUASH_RATE * dt));
    const hero = this.heroNear();

    if (this.state === 'air') {
      if (b.grounded && this.stateT > 0.12) {
        this.state = 'ground';
        this.squash = 0.35; // приземление: приплюснут
        this.leapCd = rand(1.0, 2.0);
        this.hopT = rand(0.3, 0.8);
      }
    } else if (this.state === 'windup') {
      b.vx *= Math.exp(-20 * dt);
      this.squash = Math.max(this.squash, 0.4 * Math.min(1, this.stateT / WINDUP));
      if (hero) this.setFacing(hero.x > b.x ? 1 : -1);
      if (this.stateT >= WINDUP) {
        const h = hero ?? { x: b.x + this.facing * 80, y: b.y };
        const flight = (2 * JUMP) / GRAVITY;
        this.jump(JUMP, clamp((h.x - b.x) / flight, -LEAP_MAX_VX, LEAP_MAX_VX));
      }
    } else if (b.grounded) {
      this.updateGround(dt, hero);
    }

    b.vy += GRAVITY * dt;
    const oldX = b.x;
    b.move(dt, this.level);
    if (this.leash && !this.inRoom(b.x, b.y - 4)) {
      b.x = oldX;
      b.vx = -b.vx * 0.5;
    }
    this.applyView();
  }

  private updateGround(dt: number, hero: { x: number; y: number } | null): void {
    const b = this.body;
    this.hopT -= dt;
    const dx = hero ? hero.x - b.x : 0;
    const dist = Math.abs(dx);
    const above = hero ? b.y - hero.y : 0; // >0 — герой выше

    // Прыжок на героя: присел и бросился (прыгун — охотнее)
    if (hero && this.leapCd <= 0 && dist > 28 && dist < LEAP_RANGE && Math.abs(above) < 60) {
      this.state = 'windup';
      this.stateT = 0;
      this.setFacing(dx > 0 ? 1 : -1);
      return;
    }
    // Герой на уступе повыше — запрыгиваем
    if (hero && this.leapCd <= 0 && above > 36 && dist < 120) {
      this.jump(JUMP_UP, clamp(dx * 1.2, -LEAP_MAX_VX, LEAP_MAX_VX));
      this.leapCd = rand(1.2, 2.2);
      return;
    }

    if (this.jumper) {
      // прыгун: на месте не стоит — подскакивает, к герою (если заметил) или в случайную сторону
      b.vx *= Math.exp(-14 * dt);
      if (this.hopT <= 0) {
        let dir: 1 | -1 = hero ? (dx > 0 ? 1 : -1) : Math.random() < 0.65 ? this.facing : ((-this.facing) as 1 | -1);
        if (b.blockedX === dir || !this.inRoom(b.x + dir * 40, b.y - 4)) dir = (-dir) as 1 | -1;
        this.jump(rand(190, 250), dir * rand(60, 110) * (hero ? 1.4 : 1));
        this.hopT = rand(0.6, 1.6) * (hero ? 0.55 : 1);
      }
      return;
    }

    // патрульный: ходит; заметил героя — идёт на него быстрее
    let want = this.facing;
    let speed = this.speed * 0.55;
    if (hero) {
      if (dist > 8) want = dx > 0 ? 1 : -1;
      speed = this.speed * CHASE_BOOST * 0.7;
    }
    const blocked = b.blockedX === want || !this.groundAhead(want) || !this.inRoom(b.x + want * (b.hitWidth / 2 + LEDGE_PROBE), b.y - 4);
    if (blocked) {
      if (hero && dist > 20 && this.leapCd <= 0) {
        // стенка или провал на пути к герою — перепрыгиваем
        this.jump(JUMP_UP, want * Math.max(90, speed));
        this.leapCd = rand(0.8, 1.6);
        return;
      }
      if (!hero) want = (-want) as 1 | -1; // патруль: разворот
      else speed = 0;
    }
    if (speed > 0) this.setFacing(want as 1 | -1);
    b.vx += (want * speed - b.vx) * (1 - Math.exp(-14 * dt));
  }

  private applyView(): void {
    const b = this.body;
    this.sprite.position.set(b.x + this.react.x, b.y + this.react.y);
    const sq = this.squash;
    this.sprite.scale.set(this.facing * DRAW_FACING * (1 + 0.25 * sq), 1 - 0.3 * sq);
  }

  /** Хитбокс, покрытый кругами по вертикали (враги высокие и узкие). */
  public hitCircles(): HitCircle[] {
    const b = this.body;
    const w = b.right - b.left;
    const h = b.bottom - b.top;
    const r = Math.min(w, h) / 2;
    const cx = (b.left + b.right) / 2 + this.react.x;
    const top = b.top + this.react.y;
    const circles: HitCircle[] = [];
    const span = Math.max(0, h - 2 * r);
    const n = Math.max(1, Math.ceil(span / r) + 1);
    for (let i = 0; i < n; i++) {
      circles.push({ x: cx, y: top + r + (n === 1 ? span / 2 : (span * i) / (n - 1)), r });
    }
    return circles;
  }

  public onHit(dirX: number, dirY: number): void {
    this.react.trigger(dirX, dirY, KNOCKBACK);
    this.body.vx += dirX * KNOCK_PUSH;
  }
}
