import { Container, Sprite } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { EnemyDef, EnemySpawnDef, FrameAnimationDef, FrameClipDef, RigDef } from '../data/types.ts';
import type { Level } from '../world/Level.ts';

// ---- Ползание по поверхностям
const BODY_FRONT = 9; // px: на таком расстоянии впереди центра проверяем стену (внутренний угол)
const WALL_PROBE_HEIGHT = 4; // px над поверхностью, на которой проверяем стену впереди
const EDGE_PROBE = 1.5; // px под поверхностью — проверка опоры под телом (внешний угол)
const EDGE_WRAP_DEPTH = 3; // px: на сколько паук «сползает» по грани за край
const FOLLOW_POS = 55; // 1/с: сглаживание видимой позиции (скругляет резкие переходы на углах)
const FOLLOW_ANGLE = 26; // 1/с: сглаживание поворота тела

// ---- Анимация
const SPRINT_BOOST = 1.7; // ускорение кадров хода у углов (паук «семенит»)
const WALK_THRESHOLD = 0.2; // при такой доле хода и выше играет клип walk, ниже — idle

// ---- Поведение: бег рывками с остановками
const RUN_TIME: [number, number] = [1.6, 4.2];
const PAUSE_TIME: [number, number] = [0.5, 1.3];

interface Vec {
  x: number;
  y: number;
}

interface Part {
  sprite: Sprite;
  base: Vec; // положение в позе из рисунка (системе тела, начало — якорь)
}

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const rand = (r: [number, number]) => r[0] + Math.random() * (r[1] - r[0]);

/**
 * Паук-ползун. Тело ползёт по любой поверхности тайлов — полу, стенам, потолку, огибая внутренние и внешние углы
 * (ориентация тела — одна из четырёх: нормаль n смотрит от поверхности).
 * Движение частей — ЗАГОТОВЛЕННАЯ покадровая анимация (data/animations/*.json): кадр = сдвиги слоёв рисунка в целых пикселях,
 * без поворотов и растяжения, поэтому пиксель-арт и размеры ног остаются ровно такими, как нарисованы.
 * Клип walk идёт со скоростью тела (кадров в секунду = скорость / px_per_frame), на остановке играет idle.
 */
export class Spider {
  public readonly container = new Container();

  private readonly bodyContainer = new Container();
  private readonly parts = new Map<string, Part>();

  // Истинное состояние: точка контакта S, нормаль n (от поверхности), направление движения t
  private s: Vec = { x: 0, y: 0 };
  private n: Vec = { x: 0, y: -1 };
  private t: Vec = { x: 1, y: 0 };

  // Видимое (сглаженное) состояние
  private visPos: Vec = { x: 0, y: 0 };
  private visAngle = 0;
  private mirror: 1 | -1 = 1;

  private readonly speed: number;
  private turnTimer: number;
  private cornerCooldown = 0;
  private sprint = 0; // время ускоренных кадров после угла

  // Поведение и анимация
  private move = 0; // 0..1: насколько паук сейчас бежит (плавно)
  private running = true;
  private stateTimer: number;
  private walkFrame = 0;
  private idleFrame = 0;
  private readonly walk: FrameClipDef;
  private readonly idle: FrameClipDef;

  constructor(
    def: EnemyDef, spawn: EnemySpawnDef, private readonly level: Level, rig: RigDef, anim: FrameAnimationDef,
    sprites: SpriteLibrary
  ) {
    const crawler = rig.crawler;
    if (!crawler) throw new Error(`[Spider] в риге "${rig.id}" нет блока crawler`);
    const walk = anim.clips.walk;
    const idle = anim.clips.idle;
    if (!walk || !idle) throw new Error(`[Spider] в анимации "${anim.id}" нужны клипы walk и idle`);
    this.walk = walk;
    this.idle = idle;

    this.speed = def.stats.movement_speed;
    this.turnTimer = 3 + Math.random() * 5;
    this.stateTimer = rand(RUN_TIME);

    this.container.addChild(this.bodyContainer);

    // Части: торс и голова, затем ноги (у каждой две фаланги — верхняя и нижняя). Все слои — полный холст 32x32
    const add = (key: string, spriteId: string): void => {
      const sprite = sprites.createSprite(spriteId);
      const base = { x: -rig.anchor.x, y: -rig.anchor.y };
      sprite.position.set(base.x, base.y);
      this.bodyContainer.addChild(sprite);
      this.parts.set(key, { sprite, base });
    };
    for (const p of rig.parts) add(p.name, p.sprite_id);
    for (const leg of crawler.legs) {
      add(`${leg.name}.upper`, leg.upper_sprite_id);
      add(`${leg.name}.lower`, leg.lower_sprite_id);
    }

    this.placeOnSurface(spawn, level.tileSize);
    this.visPos = { ...this.s };
    this.visAngle = this.targetAngle();
    this.mirror = this.targetMirror();
    this.applyTransform();
    this.applyFrame(this.idle.frames[0]);
  }

  /** Ставит паука на поверхность из спавна: пол (по умолчанию), потолок или стена слева/справа. */
  private placeOnSurface(spawn: EnemySpawnDef, ts: number): void {
    const surface = spawn.surface ?? 'floor';
    const dir = Math.random() < 0.5 ? 1 : -1;
    switch (surface) {
      case 'ceiling':
        this.s = { x: (spawn.x + 0.5) * ts, y: spawn.y * ts };
        this.n = { x: 0, y: 1 };
        this.t = { x: dir, y: 0 };
        break;
      case 'wall_right': // стена справа от клетки
        this.s = { x: (spawn.x + 1) * ts, y: (spawn.y + 0.5) * ts };
        this.n = { x: -1, y: 0 };
        this.t = { x: 0, y: dir };
        break;
      case 'wall_left': // стена слева от клетки
        this.s = { x: spawn.x * ts, y: (spawn.y + 0.5) * ts };
        this.n = { x: 1, y: 0 };
        this.t = { x: 0, y: dir };
        break;
      default:
        this.s = { x: (spawn.x + 0.5) * ts, y: (spawn.y + 1) * ts };
        this.n = { x: 0, y: -1 };
        this.t = { x: dir, y: 0 };
    }
  }

  // ---------- Мир ----------

  /** Твёрдая ли точка мира. Мир «замкнут»: за границами уровня тоже твёрдо (пол, потолок, стены). */
  private solid(x: number, y: number): boolean {
    const ts = this.level.tileSize;
    const cx = Math.floor(x / ts);
    const cy = Math.floor(y / ts);
    if (cy < 0 || cy >= this.level.heightTiles) return true;
    return this.level.isSolid(cx, cy);
  }

  /** Луч от точки в направлении dir до ближайшей твёрдой точки (шаг 0.5 px, уточнение бисекцией). null — не нашли. */
  private cast(from: Vec, dir: Vec, maxDist: number): Vec | null {
    if (this.solid(from.x, from.y)) return null; // старт внутри твёрдого
    let prev = 0;
    for (let d = 0.5; d <= maxDist; d += 0.5) {
      if (this.solid(from.x + dir.x * d, from.y + dir.y * d)) {
        let lo = prev;
        let hi = d;
        for (let i = 0; i < 5; i++) {
          const mid = (lo + hi) / 2;
          if (this.solid(from.x + dir.x * mid, from.y + dir.y * mid)) hi = mid; else lo = mid;
        }
        return { x: from.x + dir.x * lo, y: from.y + dir.y * lo };
      }
      prev = d;
    }
    return null;
  }

  // ---------- Преобразования ----------

  private targetAngle(): number {
    // локальный «вверх» (0,-1) должен смотреть вдоль нормали n: угол поворота = atan2(n.x, -n.y)
    return Math.atan2(this.n.x, -this.n.y);
  }

  private targetMirror(): 1 | -1 {
    // рисунок смотрит влево (голова слева), локальный +x = (cos, sin) угла тела; если идём вдоль +x — отражаем
    const a = this.targetAngle();
    return this.t.x * Math.cos(a) + this.t.y * Math.sin(a) > 0 ? -1 : 1;
  }

  private applyTransform(): void {
    this.container.position.set(this.visPos.x, this.visPos.y);
    this.container.rotation = this.visAngle;
    this.container.scale.x = this.mirror;
  }

  // ---------- Обновление ----------

  public update(dt: number): void {
    dt = Math.min(dt, 1 / 30);
    this.cornerCooldown -= dt;
    this.sprint -= dt;

    // Поведение: бежит рывками, замирает; иногда разворачивается
    this.stateTimer -= dt;
    if (this.stateTimer <= 0) {
      this.running = !this.running;
      this.stateTimer = this.running ? rand(RUN_TIME) : rand(PAUSE_TIME);
    }
    this.turnTimer -= dt;
    if (this.turnTimer <= 0) {
      this.t = { x: -this.t.x, y: -this.t.y };
      this.turnTimer = 4 + Math.random() * 6;
    }
    // плавный разгон и торможение
    this.move += ((this.running ? 1 : 0) - this.move) * (1 - Math.exp(-(this.running ? 9 : 14) * dt));
    const speedNow = this.speed * this.move;

    this.crawl(dt, speedNow);

    // Видимое состояние догоняет истинное: переходы на углах получаются скруглёнными
    const kp = 1 - Math.exp(-FOLLOW_POS * dt);
    this.visPos.x += (this.s.x - this.visPos.x) * kp;
    this.visPos.y += (this.s.y - this.visPos.y) * kp;
    this.visAngle += wrapAngle(this.targetAngle() - this.visAngle) * (1 - Math.exp(-FOLLOW_ANGLE * dt));
    this.mirror = this.targetMirror();
    this.applyTransform();

    this.animate(dt, speedNow);
  }

  /** Движение тела вдоль поверхности, огибание внутренних и внешних углов. */
  private crawl(dt: number, speedNow: number): void {
    const step = speedNow * dt;
    this.s = { x: this.s.x + this.t.x * step, y: this.s.y + this.t.y * step };

    if (this.cornerCooldown > 0) {
      this.snapToSurface();
      return;
    }

    // Внутренний угол: впереди стена — поворачиваем «на стену»
    const base = { x: this.s.x + this.n.x * WALL_PROBE_HEIGHT, y: this.s.y + this.n.y * WALL_PROBE_HEIGHT };
    const front = { x: base.x + this.t.x * BODY_FRONT, y: base.y + this.t.y * BODY_FRONT };
    if (this.solid(front.x, front.y)) {
      const wall = this.cast(base, this.t, BODY_FRONT + 2);
      const d = wall ? Math.hypot(wall.x - base.x, wall.y - base.y) : BODY_FRONT;
      // новая точка контакта — в углу, где поверхность упирается в стену
      this.s = { x: this.s.x + this.t.x * d, y: this.s.y + this.t.y * d };
      const oldN = this.n;
      this.n = { x: -this.t.x, y: -this.t.y };
      this.t = { x: oldN.x, y: oldN.y };
      this.cornerCooldown = 0.12;
      this.sprint = 0.25;
      this.snapToSurface();
      return;
    }

    // Внешний угол: центр потерял опору — оборачиваемся вокруг ребра
    const underCentre = { x: this.s.x - this.n.x * EDGE_PROBE, y: this.s.y - this.n.y * EDGE_PROBE };
    if (!this.solid(underCentre.x, underCentre.y)) {
      // откатываемся назад по поверхности до последней опоры — это и есть ребро
      let e = { x: this.s.x, y: this.s.y };
      for (let i = 0; i < 40; i++) {
        const probe = { x: e.x - this.n.x * EDGE_PROBE, y: e.y - this.n.y * EDGE_PROBE };
        if (this.solid(probe.x, probe.y)) break;
        e = { x: e.x - this.t.x * 0.5, y: e.y - this.t.y * 0.5 };
      }
      const oldN = this.n;
      const oldT = this.t;
      // новая поверхность — грань за ребром: нормаль смотрит туда, куда мы ползли, движение — «вниз» вдоль грани
      this.n = { x: oldT.x, y: oldT.y };
      this.t = { x: -oldN.x, y: -oldN.y };
      this.s = { x: e.x - oldN.x * EDGE_WRAP_DEPTH, y: e.y - oldN.y * EDGE_WRAP_DEPTH };
      this.cornerCooldown = 0.12;
      this.sprint = 0.25;
    }
    this.snapToSurface();
  }

  /** Прижимает точку контакта к поверхности (бегущий по тайлам паук всегда касается её). */
  private snapToSurface(): void {
    const up = 3;
    const start = { x: this.s.x + this.n.x * up, y: this.s.y + this.n.y * up };
    const hit = this.cast(start, { x: -this.n.x, y: -this.n.y }, up + 4);
    if (hit) this.s = hit;
  }

  // ---------- Анимация ----------

  /** Выбирает клип и кадр: ход — по пройденному пути, на месте — по времени. */
  private animate(dt: number, speedNow: number): void {
    if (this.move > WALK_THRESHOLD) {
      const rate = (speedNow / (this.walk.px_per_frame ?? 2)) * (this.sprint > 0 ? SPRINT_BOOST : 1);
      this.walkFrame = (this.walkFrame + rate * dt) % this.walk.frames.length;
      this.applyFrame(this.walk.frames[Math.floor(this.walkFrame)]);
    } else {
      this.idleFrame = (this.idleFrame + (this.idle.fps ?? 5) * dt) % this.idle.frames.length;
      this.applyFrame(this.idle.frames[Math.floor(this.idleFrame)]);
    }
  }

  /** Применяет кадр: каждая часть сдвигается от позы из рисунка на целое число пикселей. */
  private applyFrame(frame: Record<string, [number, number]>): void {
    for (const [key, part] of this.parts) {
      const off = frame[key];
      part.sprite.position.set(part.base.x + (off ? off[0] : 0), part.base.y + (off ? off[1] : 0));
    }
  }
}
