import { Container, Sprite } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { EnemyDef, EnemySpawnDef, RigDef } from '../data/types.ts';
import type { Level } from '../world/Level.ts';
import { RopeLimb } from './RopeLimb.ts';

// ---- Ползание по поверхностям
const BODY_FRONT = 9; // px: на таком расстоянии впереди центра проверяем стену (внутренний угол)
const WALL_PROBE_HEIGHT = 4; // px над поверхностью, на которой проверяем стену впереди
const EDGE_PROBE = 1.5; // px под поверхностью — проверка опоры под телом (внешний угол)
const EDGE_WRAP_DEPTH = 3; // px: на сколько паук «сползает» по грани за край
const FOLLOW_POS = 32; // 1/с: сглаживание видимой позиции (скругляет резкие переходы на углах)
const FOLLOW_ANGLE = 16; // 1/с: сглаживание поворота тела

// ---- Походка
const STEP_TRIGGER = 5; // px: нога отстала от нейтрального положения на столько — делаем шаг
const STEP_LEAD = 3; // px: стопа ставится чуть впереди нейтрального положения
const STEP_DURATION = 0.13; // с
const STEP_ARC = 3.2; // px: высота подъёма стопы в махе
const MAX_SWINGING = 4; // одновременно в воздухе не больше стольких ног (тетраподная походка)

interface Vec {
  x: number;
  y: number;
}

interface Foot {
  limb: RopeLimb;
  hip: Vec; // бедро в системе тела (начало — точка контакта, +x по рисунку), уже с учётом body_lower
  rest: Vec; // нейтральная стопа в системе тела (на поверхности, y = 0)
  group: number;
  bend: 1 | -1;
  world: Vec; // положение стопы в мире
  swing: boolean;
  from: Vec;
  t: number;
}

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Паук-ползун. Тело ползёт по любой поверхности тайлов — полу, стенам, потолку, огибая внутренние и внешние углы
 * (ориентация тела — одна из четырёх: нормаль n смотрит от поверхности). Восемь ног по два звена: стопы «приклеены» к
 * поверхности и делают шаги тетраподной походкой (две группы по 4 ноги), колени гнутся (двухзвенная дуга).
 * Всё процедурно — анимации не рисуются.
 */
export class Spider {
  public readonly container = new Container();

  private readonly bodyContainer = new Container();
  private feet: Foot[] = [];

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
  private urgent = 0; // время, пока ноги шагают «аврально» (сразу после поворота на углу)

  constructor(
    def: EnemyDef, spawn: EnemySpawnDef, private readonly level: Level, rig: RigDef, sprites: SpriteLibrary
  ) {
    const lower = rig.crawler?.body_lower ?? 0;
    const spread = rig.crawler?.leg_spread ?? 1; // множитель собственного наклона ноги из рисунка
    const splay = rig.crawler?.leg_splay ?? 0; // дополнительный разброс стоп наружу от центра тела, px
    const centreX = rig.crawler?.body_centre_x ?? rig.anchor.x; // центр тела по X на холсте
    this.speed = def.stats.movement_speed;
    this.turnTimer = 3 + Math.random() * 5;

    this.container.addChild(this.bodyContainer);

    // Части тела: торс и голова — обычные спрайты (опущены к поверхности на lower), ноги — двухзвенные конечности
    for (const p of rig.parts) {
      if (p.role === 'leg') {
        const limb = new RopeLimb(sprites.imageData(p.sprite_id), p.pivot, p.rope?.segments ?? 2);
        const hip = { x: p.pivot.x - rig.anchor.x, y: p.pivot.y - rig.anchor.y + lower };
        // Нейтральная стопа: наклон ноги из рисунка (×spread) + разброс наружу от центра тела; стопа стоит на поверхности (y = 0)
        const artDx = Math.cos(limb.drawnAngle) * limb.length;
        const outward = p.pivot.x < centreX ? -1 : 1;
        const footRest = { x: hip.x + artDx * spread + outward * splay, y: 0 };
        this.feet.push({
          limb, hip, rest: footRest, group: p.gait_group ?? 0, bend: p.bend ?? 1,
          world: { x: 0, y: 0 }, swing: false, from: { x: 0, y: 0 }, t: 0
        });
        this.bodyContainer.addChild(limb.container);
      } else {
        const sprite: Sprite = sprites.createSprite(p.sprite_id);
        sprite.position.set(-rig.anchor.x, -rig.anchor.y + lower);
        this.bodyContainer.addChild(sprite);
      }
    }

    this.placeOnSurface(spawn, level.tileSize);
    this.visPos = { ...this.s };
    this.visAngle = this.targetAngle();
    this.mirror = this.targetMirror();
    this.applyTransform();
    // Стопы сразу встают на нейтральные места (сначала делаем два прохода, чтобы кинематика ног «разогрелась»)
    for (const f of this.feet) f.world = this.neutral(f, 0);
    for (let i = 0; i < 8; i++) this.updateLegs(0.02); // ноги «разогреваются» до полной длины
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

  // ---------- Преобразования тело <-> мир (по видимому состоянию) ----------

  private toWorld(lx: number, ly: number): Vec {
    const c = Math.cos(this.visAngle);
    const s = Math.sin(this.visAngle);
    const x = lx * this.mirror;
    return { x: this.visPos.x + x * c - ly * s, y: this.visPos.y + x * s + ly * c };
  }

  private toLocal(wx: number, wy: number): Vec {
    const c = Math.cos(this.visAngle);
    const s = Math.sin(this.visAngle);
    const dx = wx - this.visPos.x;
    const dy = wy - this.visPos.y;
    return { x: (dx * c + dy * s) * this.mirror, y: -dx * s + dy * c };
  }

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
    this.urgent -= dt;

    this.crawl(dt);

    // Видимое состояние догоняет истинное: переходы на углах получаются скруглёнными
    const kp = 1 - Math.exp(-FOLLOW_POS * dt);
    this.visPos.x += (this.s.x - this.visPos.x) * kp;
    this.visPos.y += (this.s.y - this.visPos.y) * kp;
    this.visAngle += wrapAngle(this.targetAngle() - this.visAngle) * (1 - Math.exp(-FOLLOW_ANGLE * dt));
    const mirror = this.targetMirror();
    if (mirror !== this.mirror) {
      // Разворот: тело отражается, ноги переопределяются — стопы остаются на месте в мире
      this.mirror = mirror;
    }
    this.applyTransform();

    this.updateLegs(dt);
  }

  /** Движение тела вдоль поверхности, огибание внутренних и внешних углов. */
  private crawl(dt: number): void {
    // Случайные развороты
    this.turnTimer -= dt;
    if (this.turnTimer <= 0) {
      this.t = { x: -this.t.x, y: -this.t.y };
      this.turnTimer = 4 + Math.random() * 6;
    }

    const step = this.speed * dt;
    this.s = { x: this.s.x + this.t.x * step, y: this.s.y + this.t.y * step };

    if (this.cornerCooldown > 0) {
      this.snapToSurface();
      return;
    }

    // Внутренний угол: впереди стена — поворачиваем «на стену»
    const front = {
      x: this.s.x + this.t.x * BODY_FRONT + this.n.x * WALL_PROBE_HEIGHT,
      y: this.s.y + this.t.y * BODY_FRONT + this.n.y * WALL_PROBE_HEIGHT
    };
    if (this.solid(front.x, front.y)) {
      const wall = this.cast(
        { x: this.s.x + this.n.x * WALL_PROBE_HEIGHT, y: this.s.y + this.n.y * WALL_PROBE_HEIGHT }, this.t, BODY_FRONT + 2
      );
      const d = wall ? Math.hypot(wall.x - (this.s.x + this.n.x * WALL_PROBE_HEIGHT), wall.y - (this.s.y + this.n.y * WALL_PROBE_HEIGHT)) : BODY_FRONT;
      // новая точка контакта — в углу, где поверхность упирается в стену
      this.s = { x: this.s.x + this.t.x * d, y: this.s.y + this.t.y * d };
      const oldN = this.n;
      this.n = { x: -this.t.x, y: -this.t.y };
      this.t = { x: oldN.x, y: oldN.y };
      this.cornerCooldown = 0.12;
      this.urgent = 0.2;
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
      this.urgent = 0.2;
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

  // ---------- Ноги ----------

  /** Нейтральное положение стопы на поверхности (с опережением по ходу движения). */
  private neutral(foot: Foot, lead: number): Vec {
    const base = this.toWorld(foot.rest.x, 0);
    const n = { x: this.visNormal().x, y: this.visNormal().y };
    // проекция на поверхность: луч вниз от точки над ней
    const hit = this.cast({ x: base.x + n.x * 5, y: base.y + n.y * 5 }, { x: -n.x, y: -n.y }, 12) ?? base;
    return { x: hit.x + this.t.x * lead, y: hit.y + this.t.y * lead };
  }

  private visNormal(): Vec {
    // нормаль по видимому углу (локальный «вверх» в мире)
    return { x: Math.sin(this.visAngle), y: -Math.cos(this.visAngle) };
  }

  private onSurface(p: Vec): boolean {
    const n = this.visNormal();
    return !this.solid(p.x + n.x * 0.6, p.y + n.y * 0.6) && this.solid(p.x - n.x * 0.6, p.y - n.y * 0.6);
  }

  private updateLegs(dt: number): void {
    const n = this.visNormal();
    const swinging = this.feet.filter((f) => f.swing);
    const swingingGroups = new Set(swinging.map((f) => f.group));

    for (const foot of this.feet) {
      const neutralNoLead = this.neutral(foot, 0);
      if (foot.swing) {
        foot.t += dt / STEP_DURATION;
        const u = Math.min(1, foot.t);
        const target = this.neutral(foot, STEP_LEAD);
        const k = u * u * (3 - 2 * u);
        const arc = Math.sin(Math.PI * u) * STEP_ARC;
        foot.world = {
          x: foot.from.x + (target.x - foot.from.x) * k + n.x * arc,
          y: foot.from.y + (target.y - foot.from.y) * k + n.y * arc
        };
        if (u >= 1) {
          foot.swing = false;
          foot.world = target;
        }
      } else {
        const lag = Math.hypot(foot.world.x - neutralNoLead.x, foot.world.y - neutralNoLead.y);
        const lost = !this.onSurface(foot.world);
        const wantsStep = lag > STEP_TRIGGER || lost;
        const otherGroupBusy = [...swingingGroups].some((g) => g !== foot.group);
        const tooMany = swinging.length >= MAX_SWINGING;
        const allowed = this.urgent > 0 || lost || (!otherGroupBusy && !tooMany);
        if (wantsStep && allowed) {
          foot.swing = true;
          foot.t = 0;
          foot.from = { ...foot.world };
          swinging.push(foot);
          swingingGroups.add(foot.group);
        }
      }

      // Двухзвенная нога: бедро -> стопа (в системе тела), колено — дуга с выгибом вперёд/назад
      const footLocal = this.toLocal(foot.world.x, foot.world.y);
      foot.limb.setKinematic(dt, foot.hip.x, foot.hip.y, footLocal.x, footLocal.y, foot.bend, { bodyX: 0, bodyY: 0, facing: 1 });
    }
  }
}
