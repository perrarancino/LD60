import type { Container } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { EnemyDef, EnemySpawnDef, RigDef } from '../data/types.ts';
import type { Particles } from '../effects/Particles.ts';
import type { Level } from '../world/Level.ts';
import { Body } from './Body.ts';
import { HitReaction } from './HitReaction.ts';
import type { HitCircle, Hittable } from './Hittable.ts';
import { PlayerRig } from './PlayerRig.ts';

const GRAVITY = 850; // px/с²
const SIGHT = 260; // px: на таком расстоянии по горизонтали замечает героя
const SEE_HEIGHT = 110; // px: и по высоте
const DASH_SPEED = 340; // px/с: молниеносный рывок
const DASH_TIME = 0.32; // с
const DASH_RANGE: [number, number] = [70, 230]; // px: дальность до героя, на которой рывок возможен
const DASH_COOLDOWN: [number, number] = [1.6, 3.2]; // с
const JUMP_VY = -300; // px/с: прыжок через ступеньку
const STOP_NEAR = 36; // px: ближе к герою не подбегает
const SPARKS = [0x3db8ff, 0xa8e6ff, 0xffffff]; // искры рывка

interface Vec {
  x: number;
  y: number;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/**
 * Молниеносный чубрик — гуманоид той же сборки, что и герой (PlayerRig): шагающие ноги, руки-канаты, голова и глаза следят за
 * героем. Бродит по полу туда-обратно, заметив героя — бежит к нему и время от времени делает молниеносный рывок с синими искрами.
 * Ступеньки в один тайл перепрыгивает.
 */
export class Humanoid implements Hittable {
  public readonly container: Container;

  private readonly body = new Body();
  private readonly rig: PlayerRig;
  private readonly react: HitReaction;
  private readonly speed: number;
  private readonly spriteDef;

  private facing: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
  private dir: 1 | -1 = this.facing;
  private dashT = 0;
  private dashDir: 1 | -1 = 1;
  private dashCd = rand(DASH_COOLDOWN[0], DASH_COOLDOWN[1]);
  private trailT = 0;

  constructor(
    def: EnemyDef, spawn: EnemySpawnDef, private readonly level: Level, rigDef: RigDef, sprites: SpriteLibrary,
    private readonly target: () => Vec | null, private readonly fx: Particles | null = null
  ) {
    this.speed = def.stats.movement_speed;
    this.spriteDef = sprites.def(spawn.sprite_id);
    this.rig = new PlayerRig(rigDef, sprites);
    this.container = this.rig.container;
    this.react = new HitReaction(this.container);
    this.body.setHitbox(this.spriteDef, false);
    const ts = level.tileSize;
    this.body.x = (spawn.x + 0.5) * ts;
    this.body.y = (spawn.y + 1) * ts;
    this.container.position.set(this.body.x, this.body.y);
  }

  // ---------- Бой ----------

  public hitCircles(): HitCircle[] {
    const b = this.body;
    return [{ x: b.x, y: b.y - 24, r: 13 }, { x: b.x, y: b.y - 45, r: 11 }];
  }

  public onHit(): void {
    this.react.trigger(0, 0);
  }

  // ---------- Мир ----------

  private groundAhead(dir: number): boolean {
    const b = this.body;
    const ts = this.level.tileSize;
    return this.level.isSolid(Math.floor((b.x + dir * (b.hitWidth / 2 + 4)) / ts), Math.floor((b.y + 3) / ts));
  }

  // ---------- Обновление ----------

  public update(dt: number): void {
    dt = Math.min(dt, 1 / 30);
    this.react.update(dt);
    const b = this.body;
    const hero = this.target();
    const near = hero && Math.abs(hero.x - b.x) < SIGHT && Math.abs(hero.y - b.y) < SEE_HEIGHT ? hero : null;

    this.dashCd -= dt;
    let want: number;
    if (this.dashT > 0) {
      // молниеносный рывок: по прямой, пока не кончится время или не упрётся
      this.dashT -= dt;
      want = this.dashDir * DASH_SPEED;
      this.trail(dt);
      if (b.blockedX === this.dashDir) this.dashT = 0;
    } else if (near) {
      const dx = near.x - b.x;
      const dir: 1 | -1 = dx > 0 ? 1 : -1;
      const dist = Math.abs(dx);
      if (this.dashCd <= 0 && dist > DASH_RANGE[0] && dist < DASH_RANGE[1] && b.grounded && this.groundAhead(dir)) {
        this.dashT = DASH_TIME;
        this.dashDir = dir;
        this.dashCd = rand(DASH_COOLDOWN[0], DASH_COOLDOWN[1]);
        this.sparks(true);
      }
      want = dist > STOP_NEAR && (b.grounded ? this.groundAhead(dir) : true) ? dir * this.speed : 0;
      this.dir = dir;
    } else {
      // бродит: у края и стены разворачивается
      if (b.blockedX === this.dir || (b.grounded && !this.groundAhead(this.dir))) this.dir = (-this.dir) as 1 | -1;
      want = this.dir * this.speed * 0.5;
    }
    if (want !== 0) this.facing = want > 0 ? 1 : -1;

    const accel = this.dashT > 0 ? 40 : 12;
    b.vx += (want - b.vx) * (1 - Math.exp(-accel * dt));
    if (b.blockedX !== 0 && b.grounded && this.dashT <= 0) b.vy = JUMP_VY; // ступенька — прыжок
    b.vy += GRAVITY * dt;
    b.move(dt, this.level);

    this.container.position.set(b.x, b.y);
    this.rig.update(dt, {
      bodyX: b.x, bodyY: b.y, vx: b.vx, vy: b.vy, facing: this.facing, grounded: b.grounded,
      aimX: hero ? hero.x : b.x + this.facing * 100, aimY: hero ? hero.y - 30 : b.y - 40,
      climb: null, kick: null, wall: 0, wallX: 0
    });
  }

  private trail(dt: number): void {
    this.trailT -= dt;
    if (this.trailT > 0) return;
    this.trailT = 0.03;
    this.sparks(false);
  }

  private sparks(burst: boolean): void {
    if (!this.fx) return;
    const b = this.body;
    this.fx.burst(b.x - this.dashDir * 4, b.y - (burst ? 26 : 12 + Math.random() * 28), {
      count: burst ? 14 : 3, colors: SPARKS, speed: burst ? [60, 190] : [20, 70], life: burst ? [0.15, 0.4] : [0.1, 0.25], size: [1, 2],
      angle: this.dashDir > 0 ? Math.PI : 0, spread: burst ? 1.6 : 0.8, drag: 4
    });
  }
}
