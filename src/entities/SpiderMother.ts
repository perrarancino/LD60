import { Container, Sprite } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { EnemyDef, EnemySpawnDef, RigDef, SpawnsDef } from '../data/types.ts';
import { FlexLimb } from './FlexLimb.ts';
import type { Spider } from './Spider.ts';

// ---- Лапки шатаются: цепочка костей (FlexLimb), поворот у корня + плавный изгиб к кончику; по две несоизмеримые синусоиды
const ROOT_SWING = 0.06; // рад: размах поворота у корня лапки
const BEND_SWING = 0.22; // рад: размах изгиба, накопленного к кончику
const WOBBLE_FREQ: [number, number] = [0.8, 1.5]; // Гц: диапазон частот лапок (медленно — пиксели не «рябят»)
const TWITCH_CHANCE = 0.25; // 1/с: как часто какая-нибудь лапка вздрагивает
const TWITCH_SIZE = 0.22; // рад: вздрагивание (плавное, не рывок)
const TWITCH_FOLLOW = 7; // 1/с: как быстро лапка приходит к вздрагиванию и возвращается

// ---- Дыхание тела: шаг в целый пиксель (без дробных сдвигов спрайта — пиксели не мерцают)
const BREATH_RATE = 0.5; // Гц

// ---- Плевок: набирает воздух (раздувается, лапки напрягаются) -> выстрел (сжатие) -> отдышка
const WINDUP_TIME = 0.9;
const RECOIL_TIME = 0.45;
const SPIT_SPEED_X: [number, number] = [25, 85]; // px/с по горизонтали (знак случайный)
const SPIT_SPEED_Y: [number, number] = [-120, -30]; // px/с по вертикали (вверх — минус)
const RETRY_TIME = 1.5; // с: если плюнуть нельзя (слишком много паучков) — подождать

interface Vec {
  x: number;
  y: number;
}

interface Limb {
  bones: FlexLimb;
  phase: number;
  freq: number;
  rootSwing: number;
  bendSwing: number;
  twitch: number; // текущее вздрагивание, рад (плавно следует за целью)
  twitchTarget: number; // цель вздрагивания, рад (после события сама стремится к нулю)
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/**
 * Паучиха-матка. Сидит на фоне (рисуется под тайлами), шатает лапками, дышит и время от времени выплёвывает паучков:
 * раздувается, выстреливает паучка изо рта и «выдыхает». Тело и лапки собраны из частей (tools/aseprite2png/split_limbs.py).
 * Сам паучок создаётся снаружи (spawnBaby): матка только говорит, откуда и с какой скоростью он вылетает.
 */
export class SpiderMother {
  public readonly container = new Container();

  private readonly bodyHolder = new Container();
  private readonly limbs: Limb[] = [];
  private readonly mouth: Vec; // точка плевка относительно центра
  private readonly spawns: SpawnsDef;
  private readonly babies: Spider[] = [];

  private time = Math.random() * 10;
  private state: 'idle' | 'windup' | 'recoil' = 'idle';
  private stateTime = 0;
  private nextSpit: number;
  private squash = 0; // 0..1: сжатие после выстрела (затухает)

  constructor(
    def: EnemyDef, spawn: EnemySpawnDef, tileSize: number, rig: RigDef, sprites: SpriteLibrary,
    private readonly spawnBaby: (x: number, y: number, vx: number, vy: number) => Spider | null
  ) {
    const wob = rig.wobbler;
    if (!wob) throw new Error(`[SpiderMother] в риге "${rig.id}" нет блока wobbler`);
    if (!def.spawns) throw new Error(`[SpiderMother] у врага "${def.id}" нет блока spawns`);
    this.spawns = def.spawns;
    this.mouth = { x: wob.mouth.x - rig.anchor.x, y: wob.mouth.y - rig.anchor.y };
    this.nextSpit = rand(this.spawns.interval_seconds[0], this.spawns.interval_seconds[1]) * 0.5;

    // Лапки — под телом; каждая — цепочка костей, режется из целого слоя
    for (const l of wob.limbs) {
      const bones = new FlexLimb(sprites.imageData(l.sprite_id), l.root, l.bones ?? 6);
      bones.container.position.set(l.root.x - rig.anchor.x, l.root.y - rig.anchor.y);
      this.container.addChild(bones.container);
      this.limbs.push({
        bones,
        phase: Math.random() * Math.PI * 2,
        freq: rand(WOBBLE_FREQ[0], WOBBLE_FREQ[1]),
        rootSwing: ROOT_SWING * rand(0.7, 1.2),
        bendSwing: BEND_SWING * rand(0.7, 1.2),
        twitch: 0,
        twitchTarget: 0
      });
    }

    const body: Sprite = sprites.createSprite(wob.body_sprite_id);
    body.pivot.set(rig.anchor.x, rig.anchor.y);
    this.bodyHolder.addChild(body);
    this.container.addChild(this.bodyHolder);

    // Занимает блок тайлов размера холста (64x64 — 2x2 тайла): (x, y) — левый верхний тайл, центр — посередине
    this.container.position.set(
      spawn.x * tileSize + rig.canvas.width / 2, spawn.y * tileSize + rig.canvas.height / 2
    );
    this.animate(0);
  }

  private get aliveBabies(): number {
    for (let i = this.babies.length - 1; i >= 0; i--) {
      if (this.babies[i].expired) this.babies.splice(i, 1);
    }
    return this.babies.length;
  }

  public update(dt: number): void {
    dt = Math.min(dt, 1 / 30);
    this.time += dt;
    this.stateTime += dt;
    this.squash = Math.max(0, this.squash - dt / RECOIL_TIME);

    switch (this.state) {
      case 'idle':
        this.nextSpit -= dt;
        if (this.nextSpit <= 0) {
          if (this.aliveBabies >= this.spawns.max_alive) {
            this.nextSpit = RETRY_TIME;
          } else {
            this.state = 'windup';
            this.stateTime = 0;
          }
        }
        break;
      case 'windup':
        if (this.stateTime >= WINDUP_TIME) this.spit();
        break;
      case 'recoil':
        if (this.stateTime >= RECOIL_TIME) {
          this.state = 'idle';
          this.nextSpit = rand(this.spawns.interval_seconds[0], this.spawns.interval_seconds[1]);
        }
        break;
    }
    this.animate(dt);
  }

  /** Выстрел: паучок вылетает изо рта по дуге в случайную сторону. */
  private spit(): void {
    const sign = Math.random() < 0.5 ? -1 : 1;
    const baby = this.spawnBaby(
      this.container.x + this.mouth.x, this.container.y + this.mouth.y,
      sign * rand(SPIT_SPEED_X[0], SPIT_SPEED_X[1]), rand(SPIT_SPEED_Y[0], SPIT_SPEED_Y[1])
    );
    if (baby) this.babies.push(baby);
    this.state = 'recoil';
    this.stateTime = 0;
    this.squash = 1;
    for (const l of this.limbs) l.twitchTarget = (Math.random() < 0.5 ? -1 : 1) * TWITCH_SIZE; // лапки вздрагивают от выстрела
  }

  private animate(dt: number): void {
    // напряжение перед плевком: лапки качаются чаще и сильнее
    const tension = this.state === 'windup' ? Math.min(1, this.stateTime / WINDUP_TIME) : 0;
    const speedUp = 1 + 1.2 * tension;
    const swingUp = 1 + 0.6 * tension;

    for (const l of this.limbs) {
      l.phase += Math.PI * 2 * l.freq * speedUp * dt;
      if (Math.random() < TWITCH_CHANCE * dt) l.twitchTarget = (Math.random() < 0.5 ? -1 : 1) * TWITCH_SIZE * rand(0.5, 1);
      l.twitchTarget *= Math.exp(-2.5 * dt); // вздрагивание само затухает
      l.twitch += (l.twitchTarget - l.twitch) * (1 - Math.exp(-TWITCH_FOLLOW * dt)); // плавно, без рывков
      const a = Math.sin(l.phase) * 0.7 + Math.sin(l.phase * 1.7 + 1.3) * 0.3;
      const b = Math.sin(l.phase * 1.3 + 0.9) * 0.7 + Math.sin(l.phase * 2.3) * 0.3;
      l.bones.setPose((a * l.rootSwing + l.twitch * 0.4) * swingUp, (b * l.bendSwing + l.twitch) * swingUp);
    }

    // Тело: дышит шагом в целый пиксель; перед плевком раздувается, после — сжимается. Масштаб кратен 1/64 (целые
    // пиксели размера 64x64) — иначе края спрайта мерцают.
    const breath = Math.round(0.8 * Math.sin(this.time * Math.PI * 2 * BREATH_RATE));
    const inflate = tension * 0.08;
    const q = (v: number) => Math.round(v * 64) / 64;
    this.bodyHolder.scale.set(q(1 + inflate - 0.09 * this.squash), q(1 + inflate * 0.6 + 0.05 * this.squash));
    this.bodyHolder.position.set(0, breath);
  }
}
