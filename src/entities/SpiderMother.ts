import { Container } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { EnemyDef, EnemySpawnDef, RigDef, SpawnsDef } from '../data/types.ts';
import type { Particles } from '../effects/Particles.ts';
import { FlexBody } from './FlexBody.ts';
import type { ShadowSpec } from '../effects/Shadows.ts';
import type { Hittable, HitCircle } from './Hittable.ts';
import { HitReaction } from './HitReaction.ts';
import type { Spider } from './Spider.ts';
import { ThreadRope } from './ThreadRope.ts';

// ---- Лапки шатаются: цепочка костей (FlexBody), поворот у корня + плавный изгиб к кончику; по две несоизмеримые синусоиды
const ROOT_SWING = 0.06; // рад: размах поворота у корня лапки
const BEND_SWING = 0.3; // рад: размах изгиба, накопленного к кончику
const WOBBLE_FREQ: [number, number] = [0.8, 1.5]; // Гц: диапазон частот лапок
const TWITCH_CHANCE = 0.25; // 1/с: как часто какая-нибудь лапка вздрагивает
const TWITCH_SIZE = 0.22; // рад: вздрагивание (плавное, не рывок)
const TWITCH_FOLLOW = 7; // 1/с

// ---- Подвес на нитке: маятник (нитка) + тело, которое запаздывает за ниткой, + пружинка вдоль нитки
const GRAVITY = 620; // px/с²: ниже реальной — качание плавное и неторопливое
const ROPE_DAMPING = 0.5; // 1/с: затухание маятника
const WIND = 0.03; // рад/с²: лёгкий «сквозняк» — паучиха никогда не замирает совсем
const BODY_SPRING = 55; // 1/с²: тело тянется к направлению нитки
const BODY_DAMPING = 5.5; // 1/с: запаздывает и чуть перелетает (колеблется как подвешенная игрушка)
const DIP_SPRING = 90; // пружинка нитки (растяжение вдоль)
const DIP_DAMPING = 5;
const DEFAULT_ANCHOR_ROW = -2; // ряд тайлов, где закреплён верх нитки, если не задан в уровне

// ---- Плевок: вдох (тело сжимается, лапки поджимаются, сок засасывается в пасть) -> выстрел (выброс, пружинящий перелёт, лапки
// раскрываются, брызги, отдача раскачивает нитку) -> отдышка
const WINDUP_TIME = 0.85;
const RECOIL_TIME = 0.9;
const INHALE_SCALE = 0.91; // во сколько раз сжимается тело на вдохе
const SPIT_KICK = 3.0; // 1/с: рывок масштаба при выстреле (пружина даёт перелёт)
const CURL = 0.55; // рад: на сколько лапки поджимаются на вдохе (в сторону тела)
const FLARE = 10; // рад/с: рывок лапок наружу при выстреле
const SCALE_SPRING = 140;
const SCALE_DAMPING = 9;
const CURL_SPRING = 60;
const CURL_DAMPING = 6;
const RECOIL_TILT = 0.38; // рад/с: насколько отдача раскачивает нитку
const RECOIL_DIP = 55; // px/с: рывок вдоль нитки
const SPIT_SPEED_X: [number, number] = [30, 95]; // px/с по горизонтали (знак случайный)
const SPIT_SPEED_Y: [number, number] = [-45, 70]; // px/с по вертикали (вверх — минус): рот снизу, паучки вылетают вниз и в стороны
const HIT_RADIUS = 20; // px: круг попадания вокруг тела
const HIT_SWING = 0.45; // рад/с: насколько удар раскачивает нитку
const RETRY_TIME = 1.5; // с: если плюнуть нельзя (слишком много паучков) — подождать
const RELEASE_DIST = 40; // px: паучок вылетел за такой радиус от центра матки — его можно перекладывать на передний слой
const RELEASE_TIME = 0.3; // с: ...и не раньше, чем через столько после вылета

const GOO = [0x56f436, 0x22d04c, 0xb9ff97, 0x9667f2, 0xc095fc];

interface Vec {
  x: number;
  y: number;
}

interface Limb {
  index: number; // номер лапки в сетке FlexBody
  phase: number;
  freq: number;
  rootSwing: number;
  bendSwing: number;
  curlSign: 1 | -1; // знак поворота «в сторону тела»
  curl: number; // текущее поджатие (пружина), рад
  curlVel: number;
  twitch: number; // текущее вздрагивание, рад
  twitchTarget: number;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const ease = (x: number) => x * x * (3 - 2 * x);

/**
 * Паучиха-матка. Висит на нитке (рисуется под тайлами) и физично качается как маятник; лапки шатаются. Время от времени
 * выплёвывает паучков — «сочно»: вдох (сжатие, лапки поджимаются, сок засасывается в пасть), выстрел (пружинящий перелёт тела,
 * лапки раскрываются, брызги, отдача раскачивает нитку), паучок вылетает изо рта ПОД маткой по слоям и выходит вперёд, когда
 * отлетит. Сам паучок создаётся снаружи (spawnBaby).
 */
export class SpiderMother implements Hittable {
  /** Корень в мировых координатах (0, 0): слой паучков под маткой, сама матка с ниткой. */
  public readonly container = new Container();

  private readonly babyLayer = new Container(); // паучки, только что вылетевшие: рисуются ниже матки
  private readonly swing = new Container(); // у верхнего конца нитки, вращается как маятник
  private readonly hang = new Container(); // у нижнего конца нитки, вращается тело
  private readonly bodyHolder = new Container();
  private readonly thread: ThreadRope | null;
  private readonly flex: FlexBody;
  private readonly limbs: Limb[] = [];
  private readonly react: HitReaction;

  private readonly bodyOffset: Vec; // центр тела относительно точки привязки
  private readonly mouth: Vec; // пасть относительно точки привязки
  private readonly spawns: SpawnsDef;
  private readonly babies: Spider[] = []; // все живые паучки этой матки
  private readonly launching: Spider[] = []; // те, что ещё рисуются ниже матки

  // Маятник
  private readonly anchor: Vec; // верх нитки (мир)
  private readonly length: number; // длина нитки в покое
  private theta = (Math.random() - 0.5) * 0.08; // угол нитки от вертикали, рад
  private omega = 0;
  private psi = 0; // абсолютный угол тела
  private psiVel = 0;
  private dip = 0; // растяжение нитки вдоль
  private dipVel = 0;

  private time = Math.random() * 10;
  private state: 'idle' | 'windup' | 'recoil' = 'idle';
  private stateTime = 0;
  private nextSpit: number;
  private scaleX = 1;
  private scaleVel = 0;
  private suckTimer = 0;

  constructor(
    def: EnemyDef, spawn: EnemySpawnDef, tileSize: number, rig: RigDef, sprites: SpriteLibrary,
    private readonly fx: Particles,
    private readonly spawnBaby: (x: number, y: number, vx: number, vy: number) => Spider | null,
    private readonly releaseBaby: (baby: Spider) => void
  ) {
    const wob = rig.wobbler;
    if (!wob) throw new Error(`[SpiderMother] в риге "${rig.id}" нет блока wobbler`);
    if (!def.spawns) throw new Error(`[SpiderMother] у врага "${def.id}" нет блока spawns`);
    this.spawns = def.spawns;
    const attach = wob.thread?.attach ?? { x: rig.anchor.x, y: 0 };
    this.bodyOffset = { x: rig.anchor.x - attach.x, y: rig.anchor.y - attach.y };
    this.mouth = { x: wob.mouth.x - attach.x, y: wob.mouth.y - attach.y };
    this.nextSpit = rand(this.spawns.interval_seconds[0], this.spawns.interval_seconds[1]) * 0.5;

    // Нитка: от закрепления сверху до точки привязки; длина — по расстоянию от якоря до привязки в покое
    const restAttach = { x: spawn.x * tileSize + attach.x, y: spawn.y * tileSize + attach.y };
    this.anchor = { x: restAttach.x, y: (spawn.anchor_y ?? DEFAULT_ANCHOR_ROW) * tileSize };
    this.length = Math.max(20, restAttach.y - this.anchor.y);
    if (wob.thread) {
      // лёгкая нитка (verlet): чуть длиннее прямой, звенья случайно отражены; рисуется в мировых координатах под телом
      const tex = sprites.texture(wob.thread.sprite_id);
      this.thread = new ThreadRope(tex, wob.thread.width_center ?? tex.width / 2, this.anchor, restAttach);
      this.container.addChild(this.thread.container);
    } else {
      this.thread = null;
    }
    this.swing.addChild(this.hang);

    // Тело и лапки — одна сетка со скиннингом: лапки ведёт цепочка костей, основание приклеено к телу
    this.flex = new FlexBody(
      sprites.imageData(wob.sprite_id), sprites.texture(wob.sprite_id),
      wob.limbs.map((l) => ({ mask: sprites.imageData(l.sprite_id), root: l.root, bones: l.bones ?? 6 })),
      rig.anchor
    );
    this.bodyHolder.position.set(this.bodyOffset.x, this.bodyOffset.y);
    this.bodyHolder.addChild(this.flex.container);
    this.hang.addChild(this.bodyHolder);

    this.react = new HitReaction(this.swing);
    this.container.addChild(this.swing); // под ней добавлены: нитка (выше) и слой паучков (самый нижний)
    this.container.addChildAt(this.babyLayer, 0);

    wob.limbs.forEach((l, i) => {
      // в какую сторону поворачивать лапку, чтобы она поджималась к телу (знак векторного произведения оси и направления на центр)
      const axis = this.flex.limbAxis(i);
      const cross = Math.cos(axis) * (rig.anchor.y - l.root.y) - Math.sin(axis) * (rig.anchor.x - l.root.x);
      this.limbs.push({
        index: i,
        phase: Math.random() * Math.PI * 2,
        freq: rand(WOBBLE_FREQ[0], WOBBLE_FREQ[1]),
        rootSwing: ROOT_SWING * rand(0.7, 1.2),
        bendSwing: BEND_SWING * rand(0.7, 1.2),
        curlSign: cross >= 0 ? 1 : -1,
        curl: 0,
        curlVel: 0,
        twitch: 0,
        twitchTarget: 0
      });
    });

    this.psi = this.theta;
    this.pose(0);
  }

  // ---------- Геометрия подвеса ----------

  private get hangLength(): number {
    return this.length + this.dip;
  }

  /** Точка привязки (нижний конец нитки) в мире. */
  private attachWorld(): Vec {
    const L = this.hangLength;
    return { x: this.anchor.x - Math.sin(this.theta) * L, y: this.anchor.y + Math.cos(this.theta) * L };
  }

  /** Точка тела, заданная относительно точки привязки (в покое), в мире — с учётом наклона тела. */
  private bodyPoint(local: Vec): Vec {
    const a = this.attachWorld();
    const c = Math.cos(this.psi);
    const s = Math.sin(this.psi);
    return { x: a.x + local.x * c - local.y * s, y: a.y + local.x * s + local.y * c };
  }

  private get aliveBabies(): number {
    for (let i = this.babies.length - 1; i >= 0; i--) {
      if (this.babies[i].expired) this.babies.splice(i, 1);
    }
    return this.babies.length;
  }

  // ---------- Обновление ----------

  public hitCircles(): HitCircle[] {
    const c = this.bodyPoint(this.bodyOffset);
    return [{ x: c.x, y: c.y, r: HIT_RADIUS }];
  }

  /** Тень висящей паучихи на полу под ней: далеко — бледная и узкая, ближе — темнее. */
  public shadowSpec(): ShadowSpec {
    const c = this.bodyPoint(this.bodyOffset);
    return { mode: 'drop', x: c.x, y: c.y + 16, w: 34, strength: 0.7, maxDist: 260 };
  }

  /** Удар: белая вспышка, нитку и тело раскачивает по направлению удара. */
  public onHit(dirX: number): void {
    this.react.trigger(dirX, 0);
    const sign = dirX >= 0 ? 1 : -1;
    this.omega -= sign * HIT_SWING; // удар вправо отталкивает тело вправо: нитка уходит от вертикали в ту же сторону
    this.psiVel -= sign * HIT_SWING * 2;
    this.dipVel += RECOIL_DIP * 0.5;
  }

  public update(dt: number): void {
    dt = Math.min(dt, 1 / 30);
    this.react.update(dt);
    this.time += dt;
    this.stateTime += dt;

    this.updateState(dt);
    this.updatePhysics(dt);
    this.pose(dt);
    this.updateBabies();
  }

  private updateState(dt: number): void {
    switch (this.state) {
      case 'idle':
        this.nextSpit -= dt;
        if (this.nextSpit <= 0) {
          if (this.aliveBabies >= this.spawns.max_alive) {
            this.nextSpit = RETRY_TIME;
          } else {
            this.state = 'windup';
            this.stateTime = 0;
            this.suckTimer = 0;
          }
        }
        break;
      case 'windup': {
        this.suckTimer -= dt;
        const charge = Math.min(1, this.stateTime / WINDUP_TIME);
        if (this.suckTimer <= 0) {
          this.suckTimer = 0.035 - 0.02 * charge; // всасывание учащается
          this.inhaleParticles(charge);
        }
        if (this.stateTime >= WINDUP_TIME) this.spit();
        break;
      }
      case 'recoil':
        if (this.stateTime >= RECOIL_TIME) {
          this.state = 'idle';
          this.nextSpit = rand(this.spawns.interval_seconds[0], this.spawns.interval_seconds[1]);
        }
        break;
    }
  }

  /** Маятник нитки + запаздывающее тело + пружинка вдоль нитки + пружина масштаба. */
  private updatePhysics(dt: number): void {
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / steps;
    const charge = this.state === 'windup' ? ease(Math.min(1, this.stateTime / WINDUP_TIME)) : 0;
    const scaleTarget = this.state === 'windup' ? 1 - (1 - INHALE_SCALE) * charge : 1;
    for (let i = 0; i < steps; i++) {
      const L = this.hangLength;
      const wind = WIND * (Math.sin(this.time * 0.63) + 0.6 * Math.sin(this.time * 1.31 + 1.7));
      this.omega += (-(GRAVITY / L) * Math.sin(this.theta) - ROPE_DAMPING * this.omega + wind) * h;
      this.theta += this.omega * h;

      this.psiVel += (-BODY_SPRING * (this.psi - this.theta) - BODY_DAMPING * this.psiVel) * h;
      this.psi += this.psiVel * h;

      this.dipVel += (-DIP_SPRING * this.dip - DIP_DAMPING * this.dipVel) * h;
      this.dip += this.dipVel * h;

      this.scaleVel += (-SCALE_SPRING * (this.scaleX - scaleTarget) - SCALE_DAMPING * this.scaleVel) * h;
      this.scaleX += this.scaleVel * h;

      for (const l of this.limbs) {
        const curlTarget = this.state === 'windup' ? CURL * charge : 0;
        l.curlVel += (-CURL_SPRING * (l.curl - curlTarget) - CURL_DAMPING * l.curlVel) * h;
        l.curl += l.curlVel * h;
      }
    }
  }

  /** Выстрел: паучок вылетает изо рта; тело «выдыхает» пружинящим перелётом, лапки раскрываются, брызги, отдача качает нитку. */
  private spit(): void {
    const sign = Math.random() < 0.5 ? -1 : 1;
    // паучок не отстаёт от качающейся матки: берём скорость пасти из маятника
    const L = this.hangLength;
    const vx = sign * rand(SPIT_SPEED_X[0], SPIT_SPEED_X[1]) - this.omega * L * Math.cos(this.theta) * 0.7;
    const vy = rand(SPIT_SPEED_Y[0], SPIT_SPEED_Y[1]);
    const mouth = this.bodyPoint(this.mouth);
    const baby = this.spawnBaby(mouth.x, mouth.y, vx, vy);
    if (baby) {
      this.babies.push(baby);
      this.launching.push(baby);
      this.babyLayer.addChild(baby.container); // ниже матки по слоям
    }

    this.splash(mouth, Math.atan2(vy, vx));

    this.state = 'recoil';
    this.stateTime = 0;
    // «выдох»: цель масштаба — 1, но с рывком вперёд: пружина даёт упругий перелёт и затухающие колебания
    this.scaleVel += SPIT_KICK;
    for (const l of this.limbs) l.curlVel -= FLARE * rand(0.7, 1.2); // лапки раскрываются наружу и пружинят обратно
    // отдача: нитку качнуло против выстрела, тело дёрнуло вдоль нитки
    this.omega += sign * RECOIL_TILT;
    this.psiVel += sign * RECOIL_TILT * 2.2;
    this.dipVel += RECOIL_DIP;
  }

  /** Вдох: капли сока и искры слетаются к пасти. */
  private inhaleParticles(charge: number): void {
    const mouth = this.bodyPoint(this.mouth);
    const n = 1 + (charge > 0.5 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = rand(16, 30);
      const life = rand(0.2, 0.32);
      this.fx.emit(
        mouth.x + Math.cos(a) * r, mouth.y + Math.sin(a) * r, (-Math.cos(a) * r) / life, (-Math.sin(a) * r) / life,
        GOO[Math.floor(Math.random() * GOO.length)], life, rand(1, 2), { grow: 0.4 }
      );
    }
    if (charge > 0.6) {
      // набухает «сгусток» в пасти
      this.fx.emit(mouth.x + rand(-2, 2), mouth.y + rand(-2, 2), 0, 0, 0xb9ff97, 0.12, 2 + charge * 3, { grow: 0.5 });
    }
  }

  /** Брызги при выстреле: конус сока по направлению вылета, вспышка и кольцо. */
  private splash(mouth: Vec, angle: number): void {
    this.fx.burst(mouth.x, mouth.y, {
      count: 26, colors: GOO, speed: [60, 210], angle, spread: 0.55, life: [0.3, 0.7], size: [1, 3], gravity: 260, drag: 1.5, grow: 0.5
    });
    this.fx.burst(mouth.x, mouth.y, {
      count: 12, colors: [0xffffff, 0xb9ff97], speed: [90, 140], life: [0.12, 0.22], size: [1, 2], drag: 7, grow: 0.3
    });
    for (let i = 0; i < 3; i++) {
      this.fx.emit(mouth.x, mouth.y, 0, 0, 0xffffff, 0.1 + i * 0.03, 8 - i * 2, { grow: 0.2 }); // вспышка во рту
    }
  }

  /** Вылетевшие паучки сперва ниже матки; когда отлетели — на передний слой (поверх тайлов). */
  private updateBabies(): void {
    if (this.launching.length === 0) return;
    const c = this.bodyPoint(this.bodyOffset);
    for (let i = this.launching.length - 1; i >= 0; i--) {
      const b = this.launching[i];
      const p = b.airPos;
      const clear = b.airTime > RELEASE_TIME && Math.hypot(p.x - c.x, p.y - c.y) > RELEASE_DIST;
      if (b.expired || !b.airborne || clear) {
        this.releaseBaby(b);
        this.launching.splice(i, 1);
      }
    }
  }

  // ---------- Поза ----------

  private pose(dt: number): void {
    const charge = this.state === 'windup' ? ease(Math.min(1, this.stateTime / WINDUP_TIME)) : 0;
    const speedUp = 1 + 1.2 * charge;
    const swingUp = 1 + 0.6 * charge;
    const tremble = charge * charge; // перед выстрелом лапки мелко дрожат

    for (const l of this.limbs) {
      l.phase += Math.PI * 2 * l.freq * speedUp * dt;
      if (Math.random() < TWITCH_CHANCE * dt) l.twitchTarget = (Math.random() < 0.5 ? -1 : 1) * TWITCH_SIZE * rand(0.5, 1);
      l.twitchTarget *= Math.exp(-2.5 * dt);
      l.twitch += (l.twitchTarget - l.twitch) * (1 - Math.exp(-TWITCH_FOLLOW * dt));
      const a = Math.sin(l.phase) * 0.7 + Math.sin(l.phase * 1.7 + 1.3) * 0.3;
      const b = Math.sin(l.phase * 1.3 + 0.9) * 0.7 + Math.sin(l.phase * 2.3) * 0.3;
      const shiver = Math.sin(this.time * 38 + l.index * 2.1) * 0.025 * tremble;
      const curl = l.curl * l.curlSign;
      this.flex.setPose(
        l.index,
        (a * l.rootSwing + l.twitch * 0.4) * swingUp + curl * 0.35 + shiver,
        (b * l.bendSwing + l.twitch) * swingUp + curl * 0.9
      );
    }
    this.flex.commit();

    // нитка и тело
    this.swing.position.set(this.anchor.x, this.anchor.y);
    this.swing.rotation = this.theta;
    this.hang.position.set(0, this.hangLength);
    this.hang.rotation = this.psi - this.theta;
    this.thread?.update(dt, this.anchor, this.attachWorld()); // нижний конец ведёт тело; он прячется под телом

    // тело: сжатие/выброс; ширина и высота компенсируют друг друга (объём «сохраняется»)
    const sx = this.scaleX;
    this.bodyHolder.scale.set(sx, 1 + (1 - sx) * 0.55);
  }
}
