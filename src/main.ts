import { Application, Container, Graphics } from 'pixi.js';
import { SpriteLibrary } from './assets/SpriteLibrary.ts';
import type { BackgroundDef, EnemyDef, LevelDef, RigDef, TileSetDef } from './data/types.ts';
import { Enemy } from './entities/Enemy.ts';
import { Spider } from './entities/Spider.ts';
import { SpiderMother } from './entities/SpiderMother.ts';
import { Particles } from './effects/Particles.ts';
import { ColorGrade } from './effects/ColorGrade.ts';
import { Lighting } from './effects/Lighting.ts';
import { PUNCH_FX, SMOKE_FX, SpriteEffects } from './effects/SpriteEffects.ts';
import type { Hittable } from './entities/Hittable.ts';
import { Worm } from './entities/Worm.ts';
import { Player } from './entities/Player.ts';
import type { Strike } from './entities/Player.ts';
import { Level } from './world/Level.ts';
import { ParallaxBackground } from './world/ParallaxBackground.ts';
import { GAME_CONFIG } from './core/Constants.ts';
import { InputManager } from './core/InputManager.ts';
import { AgingSystem } from './systems/AgingSystem.ts';
import { DamageNumbers, loadDamageFont } from './effects/DamageNumbers.ts';

// Загрузка начальных параметров игрока из конфигурационного JSON
import playerData from '../data/player/player_initial_state.json';
import enemiesData from '../data/enemies/enemies.json';
import tilesData from '../data/tiles/tiles.json';
import levelData from '../data/levels/test_level.json';

// Все риги из data/rigs (враги-«сборные», например паук, выбирают свой по rig_id)
const RIGS = Object.values(
  import.meta.glob('../data/rigs/*.json', { eager: true, import: 'default' }) as Record<string, RigDef>
);

// Все параллакс-фоны из data/backgrounds (уровень выбирает свой по background_id)
const BACKGROUNDS = Object.values(
  import.meta.glob('../data/backgrounds/*.json', { eager: true, import: 'default' }) as Record<string, BackgroundDef>
);

// Удар героя
const FIST_RADIUS = 6; // px: «толщина» кулака при проверке попаданий
const FORE_ARM_START = 0.4; // с какой доли длины руки от плеча считается ударной частью (плечо в теле не бьёт)
const PUNCH_SPARKS = [0xffffff, 0xdbe9f7, 0x9fb4c8]; // искры удара — цвета эффекта punch
const HIT_STOP = 0.045; // с: стоп-кадр при попадании (удар «вязнет» во враге)
const CRIT_HIT_STOP = 0.07;
const HIT_SHAKE = 1.5; // px арта: тряска камеры при попадании
const CRIT_SHAKE = 2.5;
const SHAKE_DECAY = 18; // 1/с: как быстро тряска затухает
const LAND_DUST = [0x9fb4c8, 0x6f8296, 0xdbe9f7]; // пыль при тяжёлом приземлении героя

/** Здоровье врага: сколько осталось, из скольких; view — что рисуется (убирается при смерти); remove — вычеркнуть из списков игры. */
interface Mob {
  hp: number;
  max: number;
  view: Container;
  remove: () => void;
}

// Вертикальная камера: плавно следует за героем (экспоненциальное сглаживание)
const CAMERA_REST_Y = 0.64; // доля высоты экрана, на которой камера старается держать ноги героя
const CAMERA_FOLLOW_GROUNDED = 5; // 1/с: скорость сближения, когда герой стоит на земле
const CAMERA_FOLLOW_AIR = 3; // 1/с: в воздухе камера следует чуть мягче
const CAMERA_AIR_MIN_SHARE = 0.3; // доля высоты полёта, за которой камера идёт в воздухе при малых прыжках (экран не дёргается от каждого прыжка)
const CAMERA_AIR_FULL_AT = 220; // px: при отрыве от земли на столько и больше (подъём по стене, длинное падение) камера следует за героем полностью
const CAMERA_TOP_MARGIN = 76; // px: ближе к верху ноги не подпускаем (иначе не влезет голова) — страховка
const CAMERA_BOTTOM_MARGIN = 24; // px от низа экрана — страховка

class GameApp {
  private app: Application;
  private input: InputManager;
  private aging: AgingSystem;

  private gameContainer: HTMLElement;
  private sprites = new SpriteLibrary();
  private worldLayer!: Container;
  private level!: Level;
  private player!: Player;
  private enemies: Enemy[] = [];
  private spiders: Spider[] = [];
  private worms: Worm[] = [];
  private mothers: SpiderMother[] = [];
  private fx = new Particles(); // частицы: брызги, пыль, след
  private sceneLayer!: Container; // фон, мир и свет — всё, что проходит цветокоррекцию (интерфейс — отдельно)
  private grade: ColorGrade | null = null; // цветокоррекция уровня
  private lighting: Lighting | null = null; // освещение: свечение фиолетовых деталей мобов и зелёный свет от фона
  private spriteFx!: SpriteEffects; // покадровые эффекты: удар по врагу, дым отскока от стены
  private punchHits = new Set<Hittable>(); // кого уже задел текущий удар (один удар — одно попадание)
  private punchHitId = 0;
  private readonly mobs = new Map<Hittable, Mob>(); // здоровье врагов
  private readonly numbers = new DamageNumbers(); // цифры урона (поверх цветокоррекции, под ним ничего нет)
  private hitStop = 0; // с: оставшийся стоп-кадр
  private shake = 0; // px арта: текущая сила тряски камеры
  private readonly combat = (playerData as unknown as { combat?: { punch_damage: [number, number]; crit_chance?: number; crit_multiplier?: number } }).combat
    ?? { punch_damage: [5, 8] as [number, number] };

  // Размер видимой области в «виртуальных» пикселях: растёт вместе с окном, пиксели не растягиваются
  private viewW: number = GAME_CONFIG.VIRTUAL_WIDTH;
  private viewH: number = GAME_CONFIG.VIRTUAL_HEIGHT;
  private grid = new Graphics();
  private background: ParallaxBackground | null = null;
  private scale = 1;
  private cameraY = 0;
  private groundRefY = 0; // высота ног при последнем касании земли
  private cameraReady = false;
  private pointer: { x: number; y: number } | null = null; // курсор в пикселях окна

  constructor() {
    this.app = new Application();
    this.input = InputManager.get();
    this.aging = new AgingSystem(
      playerData.aging_system.time_limit_seconds,
      playerData.aging_system.warning_threshold_seconds,
      playerData.aging_system.critical_threshold_seconds
    );
    this.gameContainer = document.getElementById('game-container')!;
  }

  public async start(): Promise<void> {
    // Асинхронная инициализация PixiJS v8 в режиме пиксель-арта
    await this.app.init({
      width: GAME_CONFIG.VIRTUAL_WIDTH,
      height: GAME_CONFIG.VIRTUAL_HEIGHT,
      backgroundColor: GAME_CONFIG.BACKGROUND_COLOR,
      roundPixels: true,
      antialias: false,
      resolution: 1
    });

    this.gameContainer.appendChild(this.app.canvas);
    this.handleResize();
    window.addEventListener('resize', () => this.handleResize());
    window.addEventListener('pointermove', (e) => (this.pointer = { x: e.clientX, y: e.clientY }));
    window.addEventListener('keydown', (e) => {
      if (e.key === 'F1') {
        e.preventDefault();
        window.location.href = './editor.html';
      }
    });

    await loadDamageFont();
    await this.setupScene();

    // Запуск основного игрового цикла (Pixi ticker)
    this.app.ticker.add((ticker) => {
      const dt = ticker.deltaTime / 60; // Перевод тиков в секунды
      this.update(dt);
    });
  }

  /**
   * Полноэкранный режим без растягивания и с рендером в родном разрешении экрана:
   * холст = физические пиксели окна, сцена масштабируется целым числом (по высоте окна к эталонной),
   * поэтому повёрнутые части тела и подпиксельные сдвиги рисуются без «дрожания» пикселей низкого разрешения,
   * а область обзора камеры растёт вместе с окном.
   */
  private handleResize(): void {
    const dpr = window.devicePixelRatio || 1;
    const physW = Math.round(window.innerWidth * dpr);
    const physH = Math.round(window.innerHeight * dpr);

    this.scale = Math.max(1, Math.round(physH / GAME_CONFIG.VIRTUAL_HEIGHT)); // целых физ. пикселей на 1 пиксель арта
    this.viewW = physW / this.scale;
    this.viewH = physH / this.scale;

    this.app.renderer.resize(physW, physH);
    this.app.stage.scale.set(this.scale);
    const canvas = this.app.canvas;
    canvas.style.width = `${physW / dpr}px`;
    canvas.style.height = `${physH / dpr}px`;

    this.drawGrid();
    this.lighting?.resize(physW, physH, this.scale);
    this.background?.resize(this.viewW, this.viewH);
    if (this.level) this.updateCamera();
  }

  /** Фоновая сетка токоведущих дорожек материнской платы (неподвижная, на весь обзор). */
  private drawGrid(): void {
    const g = this.grid;
    g.clear();
    g.setStrokeStyle({ width: 1, color: 0x18202c, alpha: 0.6 });
    for (let x = 0; x < this.viewW; x += 16) g.moveTo(x, 0).lineTo(x, this.viewH);
    for (let y = 0; y < this.viewH; y += 16) g.moveTo(0, y).lineTo(this.viewW, y);
    g.stroke();
  }

  /** Курсор мыши в мировых координатах (null, пока мышь не двигали). */
  private aimInWorld(): { x: number; y: number } | null {
    if (!this.pointer) return null;
    const canvas = this.app.canvas;
    const rect = canvas.getBoundingClientRect();
    const toPhys = canvas.width / rect.width; // CSS px -> физические px
    return {
      x: ((this.pointer.x - rect.left) * toPhys) / this.scale - this.worldLayer.x,
      y: ((this.pointer.y - rect.top) * toPhys) / this.scale - this.worldLayer.y
    };
  }

  /**
   * Камера. По X следует за героем (если уровень уже обзора — центрируется). По Y — плавное следование: камера
   * экспоненциально подтягивается к высоте героя (на земле быстрее, в воздухе мягче); страховочные поля не дают герою
   * выйти из кадра при быстром падении.
   */
  private updateCamera(dt = 0): void {
    const body = this.player.body;
    const lw = this.level.pixelWidth;
    const lh = this.level.pixelHeight;

    const camX = lw <= this.viewW
      ? -(this.viewW - lw) / 2
      : Math.max(0, Math.min(lw - this.viewW, body.x - this.viewW / 2));

    let camY: number;
    if (lh <= this.viewH) {
      camY = lh - this.viewH;
    } else {
      const maxY = lh - this.viewH;
      const feet = body.y;
      if (!this.cameraReady || body.grounded) this.groundRefY = feet;
      // В воздухе камера следует за высотой героя не полностью: при малых прыжках — лишь частично (плавно растёт доля до полной
      // при большом отрыве от земли), так нет резких скачков экрана
      const dy = feet - this.groundRefY;
      const t = Math.max(0, Math.min(1, (Math.abs(dy) - 80) / (CAMERA_AIR_FULL_AT - 80)));
      const share = body.grounded ? 1 : CAMERA_AIR_MIN_SHARE + (1 - CAMERA_AIR_MIN_SHARE) * t * t * (3 - 2 * t);
      const followFeet = this.groundRefY + dy * share;
      const target = Math.max(0, Math.min(maxY, followFeet - this.viewH * CAMERA_REST_Y));
      if (!this.cameraReady) {
        this.cameraY = target;
        this.cameraReady = true;
      } else {
        const rate = body.grounded ? CAMERA_FOLLOW_GROUNDED : CAMERA_FOLLOW_AIR;
        this.cameraY += (target - this.cameraY) * (1 - Math.exp(-rate * dt));
      }
      // Страховка: герой не должен выходить за поля кадра
      this.cameraY = Math.min(this.cameraY, feet - CAMERA_TOP_MARGIN);
      this.cameraY = Math.max(this.cameraY, feet - (this.viewH - CAMERA_BOTTOM_MARGIN));
      this.cameraY = Math.max(0, Math.min(maxY, this.cameraY));
      camY = this.cameraY;
    }

    // Камера выровнена по физическим пикселям: тайлы остаются чёткими, герой и камера не дрожат друг относительно друга
    const snap = (v: number) => Math.round(v * this.scale) / this.scale;
    // тряска: случайный сдвиг на целые пиксели арта, затухает
    this.shake *= Math.exp(-SHAKE_DECAY * dt);
    if (this.shake < 0.3) this.shake = 0;
    const sx = this.shake ? Math.round((Math.random() * 2 - 1) * this.shake) : 0;
    const sy = this.shake ? Math.round((Math.random() * 2 - 1) * this.shake) : 0;
    this.worldLayer.position.set(-snap(camX) + sx, -snap(camY) + sy);
    this.numbers.container.position.copyFrom(this.worldLayer.position);
    this.background?.update(snap(camX), snap(camY), lh, this.scale);
  }

  /**
   * Сцена: фоновая сетка, тестовый уровень из data/levels, герой и враги
   */
  private async setupScene(): Promise<void> {
    this.sceneLayer = new Container();
    this.app.stage.addChild(this.sceneLayer);
    this.sceneLayer.addChild(this.grid);
    this.drawGrid();

    const tileset = tilesData as TileSetDef;
    const levelDef = levelData as unknown as LevelDef;
    const enemyDefs = new Map((enemiesData as unknown as EnemyDef[]).map((e) => [e.id, e]));

    // Параллакс-фон уровня (если задан)
    const bgDef = levelDef.background_id ? BACKGROUNDS.find((b) => b.id === levelDef.background_id) : undefined;
    if (levelDef.background_id && !bgDef) throw new Error(`Уровень ссылается на неизвестный фон "${levelDef.background_id}"`);

    // Загружаем только те спрайты, которые реально нужны уровню
    const rigDef = RIGS.find((r) => r.id === playerData.rig_id);
    if (!rigDef) throw new Error(`Герой ссылается на неизвестный риг "${playerData.rig_id}"`);
    await this.sprites.load([
      PUNCH_FX.sprite,
      SMOKE_FX.sprite,
      ...(bgDef ? ParallaxBackground.spriteIds(bgDef) : []),
      playerData.sprite_id,
      ...rigDef.parts.flatMap((p) => [p.sprite_id, ...(p.face?.sprite_id ? [p.face.sprite_id] : [])]),
      ...Level.spriteIds(levelDef, tileset),
      ...levelDef.enemies.map((e) => e.sprite_id),
      // части тела врагов, собранных из слоёв (паук, червь, паучиха), и тех, кого они порождают
      ...levelDef.enemies.flatMap((e) => this.enemySpriteIds(enemyDefs, e.enemy_id, e.sprite_id))
    ]);

    if (bgDef) {
      this.background = new ParallaxBackground(bgDef, this.sprites);
      this.grid.visible = false; // вместо технической сетки — фон
      this.sceneLayer.addChildAt(this.background.container, 0);
      this.background.resize(this.viewW, this.viewH);
    }

    this.worldLayer = new Container();
    this.sceneLayer.addChild(this.worldLayer);

    this.level = new Level(levelDef, tileset, this.sprites);
    this.worldLayer.addChild(this.level.backLayer); // декор за тайлами (куллер) и отростки паутины
    this.worldLayer.addChild(this.level.container);
    this.worldLayer.addChild(this.level.frontLayer); // декор поверх тайлов (транзисторы)

    for (const spawn of levelDef.enemies) {
      const def = enemyDefs.get(spawn.enemy_id);
      if (!def) throw new Error(`Уровень ссылается на неизвестного врага "${spawn.enemy_id}"`);
      if (def.behavior_type === 'crawler') {
        // Ползающий враг (паук): процедурное тело по поверхностям тайлов
        const rig = RIGS.find((r) => r.id === def.rig_id);
        if (!rig) throw new Error(`Враг "${def.id}" ссылается на неизвестный риг "${def.rig_id}"`);
        const spider = new Spider(def, spawn, this.level, rig, this.sprites);
        this.spiders.push(spider);
        this.worldLayer.addChild(spider.container);
        this.trackSpider(spider, def.stats.max_health);
        continue;
      }
      if (def.behavior_type === 'spawner') {
        // Паучиха-матка: сидит на фоне (под тайлами), шатает лапками и выплёвывает паучков
        const rig = RIGS.find((r) => r.id === def.rig_id);
        if (!rig) throw new Error(`Враг "${def.id}" ссылается на неизвестный риг "${def.rig_id}"`);
        const mother = new SpiderMother(def, spawn, this.level.tileSize, rig, this.sprites, this.fx,
          (x, y, vx, vy) => this.spawnBaby(enemyDefs, def, x, y, vx, vy), (baby) => this.worldLayer.addChildAt(baby.container, this.worldLayer.getChildIndex(this.fx.container)));
        this.mothers.push(mother);
        this.worldLayer.addChildAt(mother.container, this.worldLayer.getChildIndex(this.level.container));
        this.track(mother, def.stats.max_health, mother.container, () => this.mothers.splice(this.mothers.indexOf(mother), 1));
        continue;
      }
      if (def.behavior_type === 'burrower') {
        // Червь-землерой: рисуется под тайлами, чтобы часть тела внутри блоков была скрыта
        const rig = RIGS.find((r) => r.id === def.rig_id);
        if (!rig) throw new Error(`Враг "${def.id}" ссылается на неизвестный риг "${def.rig_id}"`);
        const worm = new Worm(def, spawn, this.level, rig, this.sprites, this.worms);
        this.worms.push(worm);
        this.worldLayer.addChildAt(worm.container, this.worldLayer.getChildIndex(this.level.container));
        this.track(worm, def.stats.max_health, worm.container, () => this.worms.splice(this.worms.indexOf(worm), 1));
        continue;
      }
      const enemy = new Enemy(def, spawn, this.level.tileSize, this.sprites);
      this.enemies.push(enemy);
      this.worldLayer.addChild(enemy.sprite);
      this.track(enemy, def.stats.max_health, enemy.sprite, () => this.enemies.splice(this.enemies.indexOf(enemy), 1));
    }

    this.player = new Player(playerData.sprite_id, rigDef, this.sprites);
    this.player.spawnAt(levelDef.player_spawn.x, levelDef.player_spawn.y, this.level.tileSize);
    this.worldLayer.addChild(this.player.sprite);
    this.worldLayer.addChild(this.fx.container); // частицы поверх всего
    this.spriteFx = new SpriteEffects(this.sprites);
    this.worldLayer.addChild(this.spriteFx.container);
    // Отскок от стены: клуб дыма у стены на уровне корпуса
    this.player.onWallKick = (x, y, wallDir, along) => this.wallKickSmoke(x, y, wallDir, along);
    // Тяжёлое приземление (герой теряет равновесие): пыль в обе стороны и тряска
    this.player.onHardLanding = (x, y, power) => this.hardLanding(x, y, power);
    // Освещение поверх мира, под интерфейсом (интерфейс добавится в сцену позже)
    // тени отбрасывают существа и транзисторы (слой декора поверх тайлов); тайлы, декор за тайлами и эффекты — нет
    this.lighting = new Lighting(this.app.renderer, this.worldLayer, [
      this.level.backLayer, this.level.container, this.fx.container, this.spriteFx.container
    ], this.level.container, [this.level.frontLayer], () => this.spiders.map((s) => s.container),
    () => [...this.spiders, ...this.worms, ...this.mothers].map((e) => e.container)); // мобы со светящимися пикселями сами светят
    this.sceneLayer.addChildAt(this.lighting.backContainer, this.sceneLayer.getChildIndex(this.worldLayer)); // туман — за миром
    this.sceneLayer.addChild(this.lighting.container);
    this.app.stage.addChild(this.lighting.overlay); // свет жуков и неон — поверх цветокоррекции, под интерфейсом
    this.app.stage.addChild(this.numbers.container); // цифры урона — поверх всего, их не трогают ни свет, ни цветокоррекция
    if (levelDef.grade) {
      this.grade = new ColorGrade(levelDef.grade);
      this.grade.apply(this.sceneLayer);
    }
    this.lighting.resize(this.app.renderer.width, this.app.renderer.height, this.scale);
    this.updateCamera();
  }

  /** Всё, по чему можно ударить. */
  private *hittables(): Iterable<Hittable> {
    yield* this.enemies;
    yield* this.spiders;
    yield* this.worms;
    yield* this.mothers;
  }

  /**
   * Попадания кулака героя: пока кулак выброшен, проверяется отрезок «предплечье — кулак» с толщиной FIST_RADIUS против кругов
   * попадания врагов. Каждый удар задевает каждого врага один раз: вспышка, отдача, эффект punch по направлению удара и искры.
   */
  private resolveStrike(): void {
    const strike = this.player.strike;
    if (!strike) return;
    if (strike.id !== this.punchHitId) {
      this.punchHitId = strike.id;
      this.punchHits.clear();
    }
    const ax = strike.x1 + (strike.x2 - strike.x1) * FORE_ARM_START;
    const ay = strike.y1 + (strike.y2 - strike.y1) * FORE_ARM_START;
    for (const target of this.hittables()) {
      if (this.punchHits.has(target)) continue;
      const contact = this.strikeContact(strike, ax, ay, target);
      if (!contact) continue;
      this.punchHits.add(target);
      target.onHit(strike.dirX, strike.dirY);
      this.landPunch(contact.x, contact.y, strike);
      this.damage(target, contact.x, contact.y, strike.dirX);
    }
  }

  /** Регистрирует врага: здоровье, что рисуется и как вычеркнуть его из списков игры. */
  private track(target: Hittable, maxHp: number, view: Container, remove: () => void): void {
    this.mobs.set(target, { hp: maxHp, max: maxHp, view, remove });
  }

  private trackSpider(spider: Spider, maxHp: number): void {
    this.track(spider, maxHp, spider.container, () => {
      this.spiders.splice(this.spiders.indexOf(spider), 1);
      spider.expired = true; // матка считает живых паучков по этому флагу
    });
  }

  /** Урон от удара: случайный в диапазоне, иногда критический; цифра урона, стоп-кадр и тряска; при нуле — смерть. */
  private damage(target: Hittable, x: number, y: number, dirX: number): void {
    const mob = this.mobs.get(target);
    if (!mob) return;
    const [lo, hi] = this.combat.punch_damage;
    const crit = Math.random() < (this.combat.crit_chance ?? 0);
    let dmg = lo + Math.floor(Math.random() * (hi - lo + 1));
    if (crit) dmg = Math.round(dmg * (this.combat.crit_multiplier ?? 2));
    mob.hp -= dmg;
    this.numbers.spawn(x, y - 6, dmg, crit, dirX);
    this.hitStop = Math.max(this.hitStop, crit ? CRIT_HIT_STOP : HIT_STOP);
    this.shake = Math.max(this.shake, crit ? CRIT_SHAKE : HIT_SHAKE);
    if (mob.hp <= 0) this.kill(target, mob);
  }

  /** Смерть врага: он выходит из игры и исчезает (эффекты смерти — позже). */
  private kill(target: Hittable, mob: Mob): void {
    this.mobs.delete(target);
    mob.remove();
    mob.view.destroy({ children: true });
  }

  /** Тяжёлое приземление героя: пыль разлетается по земле в обе стороны, камеру трясёт по силе удара. */
  private hardLanding(x: number, y: number, power: number): void {
    for (const side of [-1, 1]) {
      this.fx.burst(x + side * 4, y - 1, {
        count: 8 + Math.round(6 * power), colors: LAND_DUST, speed: [40, 130], angle: side > 0 ? -0.25 : Math.PI + 0.25, spread: 0.35,
        life: [0.25, 0.55], size: [1, 2], gravity: 120, drag: 3
      });
      this.spriteFx.spawn(SMOKE_FX, x + side * 8, y - 4, {
        angle: Math.random() * Math.PI * 2, scale: 0.5 + 0.3 * power, vx: side * (50 + 30 * power), vy: -12, speed: 1
      });
    }
    this.shake = Math.max(this.shake, 1.5 + 2.5 * power);
  }

  /** Точка касания кулака с ближайшим кругом цели (null — не достал). */
  private strikeContact(strike: Strike, ax: number, ay: number, target: Hittable): { x: number; y: number } | null {
    const bx = strike.x2;
    const by = strike.y2;
    const abx = bx - ax;
    const aby = by - ay;
    const len2 = abx * abx + aby * aby || 1;
    let best: { x: number; y: number } | null = null;
    let bestGap = 0;
    for (const c of target.hitCircles()) {
      const t = Math.max(0, Math.min(1, ((c.x - ax) * abx + (c.y - ay) * aby) / len2));
      const px = ax + abx * t;
      const py = ay + aby * t;
      const gap = Math.hypot(c.x - px, c.y - py) - c.r - FIST_RADIUS;
      if (gap > 0 || (best && gap >= bestGap)) continue;
      best = { x: px, y: py };
      bestGap = gap;
    }
    return best;
  }

  /**
   * Отскок от стены: 3–4 клуба дыма разного размера веером разлетаются от стены в разные стороны. Крупный — по центру веера и медленный,
   * мелкие улетают дальше и быстрее по краям.
   */
  private wallKickSmoke(x: number, y: number, wallDir: -1 | 1, along = false): void {
    const count = 3 + Math.floor(Math.random() * 2);
    const away = wallDir > 0 ? Math.PI : 0; // направление от стены
    // вдоль стены (герой лезет вверх по ней) — дым уходит вниз и чуть от стены; от стены — веером от неё
    const base = along ? Math.PI / 2 + (wallDir > 0 ? 0.35 : -0.35) : away;
    const fan = along ? 1.4 : 2.3; // рад: ширина веера
    const middle = Math.floor((count - 1) / 2);
    for (let i = 0; i < count; i++) {
      const big = i === middle;
      const a = base + fan * (i / (count - 1) - 0.5) + (Math.random() - 0.5) * 0.3;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      const speed = big ? 55 + Math.random() * 20 : 140 + Math.random() * 70;
      const scale = big ? 0.9 + Math.random() * 0.25 : 0.35 + Math.random() * 0.4;
      this.spriteFx.spawn(SMOKE_FX, x + dx * 3, y + dy * 3, {
        angle: Math.random() * Math.PI * 2,
        scale,
        vx: dx * speed,
        vy: dy * speed - 10, // дым чуть поднимается
        speed: 0.85 + Math.random() * 0.4
      });
    }
  }

  /** Эффект удара в точке попадания: картинка punch повёрнута по направлению удара + искры. */
  private landPunch(x: number, y: number, strike: Strike): void {
    const angle = Math.atan2(strike.dirY, strike.dirX);
    const hx = x + strike.dirX * FIST_RADIUS;
    const hy = y + strike.dirY * FIST_RADIUS;
    this.spriteFx.spawn(PUNCH_FX, hx, hy, { angle });
    this.fx.burst(hx, hy, {
      count: 8, colors: PUNCH_SPARKS, speed: [60, 150], angle, spread: 0.8, life: [0.12, 0.3], size: [1, 2], drag: 5, grow: 0.4
    });
  }

  /** Паучок, выплюнутый маткой: летит из точки (x, y), садится на поверхность и дальше ползает как обычный паук. */
  private spawnBaby(defs: Map<string, EnemyDef>, mother: EnemyDef, x: number, y: number, vx: number, vy: number): Spider | null {
    const cfg = mother.spawns;
    const babyDef = cfg && defs.get(cfg.enemy_id);
    const rig = babyDef?.rig_id ? RIGS.find((r) => r.id === babyDef.rig_id) : undefined;
    if (!cfg || !babyDef || !rig) return null;
    const spawn = { enemy_id: babyDef.id, sprite_id: cfg.sprite_id ?? babyDef.sprite_variants[0], x: 0, y: 0 };
    const baby = new Spider(babyDef, spawn, this.level, rig, this.sprites, { scale: cfg.scale, lifetime: cfg.lifetime_seconds, fx: this.fx });
    baby.launch(x, y, vx, vy);
    this.spiders.push(baby); // слой выбирает матка: сначала ниже себя, потом передний
    this.trackSpider(baby, Math.max(1, Math.round(babyDef.stats.max_health * (cfg.scale ?? 1))));
    return baby;
  }

  /** Id всех спрайтов врага: вариант внешности, части рига (слои, ноги, сегменты, лапки) и спрайты порождаемых им врагов. */
  private enemySpriteIds(defs: Map<string, EnemyDef>, enemyId: string, spriteId?: string, depth = 0): string[] {
    const def = defs.get(enemyId);
    if (!def || depth > 3) return [];
    const rig = def.rig_id ? RIGS.find((r) => r.id === def.rig_id) : undefined;
    const ids: string[] = [...(spriteId ? [spriteId] : []), ...def.sprite_variants];
    if (rig) {
      ids.push(
        ...rig.parts.map((p) => p.sprite_id),
        ...(rig.crawler?.legs.flatMap((l) => [l.upper_sprite_id, l.lower_sprite_id]) ?? []),
        ...(rig.segmented ? [rig.segmented.head.sprite_id, rig.segmented.body.sprite_id, rig.segmented.tail.sprite_id] : []),
        ...(rig.wobbler ? [rig.wobbler.sprite_id, ...(rig.wobbler.thread ? [rig.wobbler.thread.sprite_id] : []), ...rig.wobbler.limbs.map((l) => l.sprite_id)] : [])
      );
    }
    if (def.spawns) ids.push(...this.enemySpriteIds(defs, def.spawns.enemy_id, def.spawns.sprite_id, depth + 1));
    return ids;
  }

  /**
   * Главный цикл обновления физики и логики
   */
  private update(dt: number): void {
    dt = Math.min(dt, 1 / 30); // защита от «туннелирования» после лагов/вкладки в фоне

    // Стоп-кадр при попадании: мир замирает на мгновение, камера трясётся, цифры живут
    if (this.hitStop > 0) {
      this.hitStop -= dt;
      this.numbers.update(dt);
      this.updateCamera(dt);
      this.lighting?.update();
      return;
    }

    // 1. Обновление таймера старения
    this.aging.update(dt);

    // 2. Игрок: ввод + физика на тайлах
    this.player.update(dt, this.input.poll(), this.level, this.aimInWorld());

    // 3. Враги
    for (const enemy of this.enemies) enemy.update(dt);
    for (const spider of this.spiders) spider.update(dt);
    for (const worm of this.worms) worm.update(dt);
    for (const mother of this.mothers) mother.update(dt);
    this.resolveStrike();
    this.fx.update(dt);
    this.spriteFx.update(dt);
    this.numbers.update(dt);
    // Выплюнутые паучки живут ограниченное время
    for (let i = this.spiders.length - 1; i >= 0; i--) {
      if (!this.spiders[i].expired) continue;
      this.spiders[i].container.destroy({ children: true });
      this.spiders.splice(i, 1);
    }

    // 4. Камера и анимация декора (отростки качаются только в обзоре)
    this.updateCamera(dt);
    const camLeft = -this.worldLayer.x;
    const b = this.player.body;
    this.level.update(dt, camLeft, camLeft + this.viewW, [{ left: b.left, right: b.right, top: b.top, bottom: b.bottom, vx: b.vx, vy: b.vy }]);
    this.lighting?.update();
    if (this.grade) {
      const span = Math.max(1, this.level.pixelWidth - this.viewW);
      this.grade.update(dt, Math.max(0, Math.min(1, camLeft / span)));
    }
  }
}

// Запуск приложения при готовности DOM
window.addEventListener('DOMContentLoaded', () => {
  const game = new GameApp();
  game.start().catch(console.error);
  if (import.meta.env.DEV) (window as unknown as { __game: GameApp }).__game = game; // отладка из консоли браузера
});
