import { Armor, SLOTS, SLOT_NAMES } from '../systems/ArmorSystem.ts';
import type { Slot } from '../systems/ArmorSystem.ts';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { RigDef, RigPartDef } from '../data/types.ts';
import { pal } from '../core/Palette.ts';

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');
const ROLE_SLOT: Record<RigPartDef['role'], Slot> = { head: 'head', torso: 'torso', arm: 'arms', leg: 'legs' };
const FADE_IN = 0.5; // с: экран проявляется из темноты
const DONE_DELAY = 1.3; // с: после выбора — вспышка и пауза, потом дальше
const NAME = 'uvKits';

interface Layer {
  slot: Slot;
  canvases: HTMLCanvasElement[]; // по моделям героя (0 — медная, 1 — синяя): рисунок части и (у головы) глаз
  alphas: ImageData[][]; // то же в виде пикселей — для попадания курсором
  eyes: boolean[];
}

/**
 * Экран улучшения (перед боссом и после него): тёмный экран, сверху «Выбери часть, которую надо прокачать», в центре стоит герой крупно. Курсор наводится на часть
 * тела — она подсвечивается, под героем написано, что она делает и чем станет синей; клик — часть становится синей (вспышка), и забег идёт дальше.
 * Уже синие части не выбираются и не подсвечиваются. Герой собран из тех же слоёв, что и в игре: медная часть — модель 1, синяя — модель 2.
 */
export class UpgradeUI {
  private readonly root = document.createElement('div');
  private readonly canvas = document.createElement('canvas');
  private readonly title = document.createElement('div');
  private readonly info = document.createElement('div');
  private readonly ctx: CanvasRenderingContext2D;
  private opened = false;
  private onClose: (() => void) | null = null;
  private layers: Layer[] = [];
  private raf = 0;
  private t = 0;
  private last = 0;
  private hover: Slot | null = null;
  private picked: Slot | null = null;
  private pickT = 0;
  private scale = 6;
  private sparks: { x: number; y: number; vx: number; vy: number; life: number; c: number }[] = [];

  constructor() {
    this.root.id = 'upgrade-ui';
    this.root.style.cssText = `position: fixed; inset: 0; z-index: 2500; display: none; background: #05070b; opacity: 0; user-select: none;
      font-family: ${NAME}, "Courier New", monospace; color: ${hex(pal('steel', 7))};`;
    this.canvas.style.cssText = 'position: absolute; inset: 0; width: 100%; height: 100%; image-rendering: pixelated;';
    this.title.style.cssText = `position: absolute; left: 0; right: 0; top: 7%; text-align: center; font-size: 30px; letter-spacing: 1px; color: ${hex(pal('gold', 6))};
      text-shadow: 0 0 12px ${hex(pal('gold', 4))}aa;`;
    this.title.textContent = 'Выбери часть, которую надо прокачать';
    this.info.style.cssText = `position: absolute; left: 0; right: 0; bottom: 7%; text-align: center; font-size: 18px; line-height: 1.5; min-height: 80px; padding: 0 8%;`;
    this.root.append(this.canvas, this.title, this.info);
    document.body.appendChild(this.root);
    this.ctx = this.canvas.getContext('2d')!;
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerdown', (e) => this.onClick(e));
    window.addEventListener('resize', () => this.resize());
  }

  public get isOpen(): boolean {
    return this.opened;
  }

  /** Есть ли что улучшать (хоть одна часть ещё медная). */
  public static available(): boolean {
    return SLOTS.some((s) => Armor.get().canUpgrade(s));
  }

  /** Открывает экран: sprites и rigs — слои героя (rigs[0] — медная модель, rigs[1] — синяя). */
  public open(sprites: SpriteLibrary, rigs: RigDef[], onClose: () => void): void {
    this.opened = true;
    this.onClose = onClose;
    this.picked = null;
    this.hover = null;
    this.sparks = [];
    this.t = 0;
    this.buildLayers(sprites, rigs);
    this.root.style.display = 'block';
    this.root.style.transition = 'none';
    this.root.style.opacity = '0';
    void this.root.offsetWidth; // перезапуск CSS-перехода
    this.root.style.transition = `opacity ${FADE_IN}s ease-in-out`;
    this.root.style.opacity = '1';
    this.resize();
    this.updateInfo();
    cancelAnimationFrame(this.raf);
    this.last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.step(dt);
      this.draw();
      if (this.opened) this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  private buildLayers(sprites: SpriteLibrary, rigs: RigDef[]): void {
    this.layers = [];
    const base = rigs[0];
    base.parts.forEach((part, i) => {
      const canvases: HTMLCanvasElement[] = [];
      const alphas: ImageData[][] = [];
      const eyes: boolean[] = [];
      rigs.forEach((rig) => {
        const ids = [rig.parts[i].sprite_id];
        const face = rig.parts[i].face?.sprite_id;
        if (face) ids.push(face);
        const datas = ids.map((id) => sprites.imageData(id));
        const c = document.createElement('canvas');
        c.width = datas[0].width;
        c.height = datas[0].height;
        const cx = c.getContext('2d')!;
        for (const d of datas) {
          const tmp = document.createElement('canvas');
          tmp.width = d.width;
          tmp.height = d.height;
          tmp.getContext('2d')!.putImageData(d, 0, 0);
          cx.drawImage(tmp, 0, 0);
        }
        canvases.push(c);
        alphas.push(datas);
        eyes.push(!!face);
      });
      this.layers.push({ slot: ROLE_SLOT[part.role], canvases, alphas, eyes });
    });
  }

  private resize(): void {
    const h = window.innerHeight;
    this.scale = Math.max(3, Math.floor((h * 0.55) / 64));
    this.canvas.width = window.innerWidth;
    this.canvas.height = h;
  }

  private heroOrigin(): { x: number; y: number } {
    const s = this.scale;
    return { x: Math.round((this.canvas.width - 64 * s) / 2), y: Math.round(this.canvas.height * 0.5 - 34 * s) };
  }

  /** Часть тела под курсором (по непрозрачным пикселям слоёв, сверху вниз по порядку отрисовки). */
  private partAt(clientX: number, clientY: number): Slot | null {
    const rect = this.canvas.getBoundingClientRect();
    const o = this.heroOrigin();
    const ix = Math.floor(((clientX - rect.left) * (this.canvas.width / rect.width) - o.x) / this.scale);
    const iy = Math.floor(((clientY - rect.top) * (this.canvas.height / rect.height) - o.y) / this.scale);
    if (ix < 0 || iy < 0 || ix >= 64 || iy >= 64) return null;
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const l = this.layers[i];
      const tier = Math.min(Armor.get().equipped[l.slot], 2) - 1;
      for (const d of l.alphas[Math.max(0, tier)]) {
        if (d.data[(iy * d.width + ix) * 4 + 3] > 20) return l.slot;
      }
    }
    return null;
  }

  private onMove(e: PointerEvent): void {
    if (this.picked) return;
    const slot = this.partAt(e.clientX, e.clientY);
    const next = slot && Armor.get().canUpgrade(slot) ? slot : null;
    if (next !== this.hover) {
      this.hover = next;
      this.updateInfo();
    }
    this.canvas.style.cursor = next ? 'pointer' : 'default';
  }

  private onClick(e: PointerEvent): void {
    if (this.picked) return;
    const slot = this.partAt(e.clientX, e.clientY);
    if (!slot || !Armor.get().upgrade(slot)) return;
    this.picked = slot;
    this.pickT = 0;
    this.hover = null;
    this.canvas.style.cursor = 'default';
    this.updateInfo();
    // искры вокруг улучшенной части
    const o = this.heroOrigin();
    const s = this.scale;
    const c = { head: [32, 22], torso: [33, 38], arms: [33, 36], legs: [32, 54] }[slot];
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 80 + Math.random() * 220;
      this.sparks.push({ x: o.x + c[0] * s, y: o.y + c[1] * s, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 60, life: 0.6 + Math.random() * 0.7, c: [pal('cobalt', 5), pal('cobalt', 7), pal('steel', 7)][i % 3] });
    }
  }

  private updateInfo(): void {
    const a = Armor.get();
    if (this.picked) {
      this.info.innerHTML = `<span style="color:${hex(pal('cobalt', 6))}">${SLOT_NAMES[this.picked]} улучшены</span>`;
    } else if (this.hover) {
      this.info.innerHTML = `<span style="color:${hex(pal('gold', 6))}">${SLOT_NAMES[this.hover]}</span>: ${Armor.purpose(this.hover)}<br>`
        + `<span style="color:${hex(pal('cobalt', 6))}">Станет синей: ${a.describe(this.hover, 2)}</span>`;
    } else {
      this.info.innerHTML = `<span style="opacity:.6">Наведи на часть тела</span>`;
    }
  }

  private step(dt: number): void {
    this.t += dt;
    if (this.picked) {
      this.pickT += dt;
      if (this.pickT >= DONE_DELAY && this.opened) {
        this.opened = false;
        const cb = this.onClose;
        this.onClose = null;
        cb?.();
      }
    }
    for (const s of this.sparks) {
      s.life -= dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vy += 300 * dt;
    }
    this.sparks = this.sparks.filter((s) => s.life > 0);
  }

  private draw(): void {
    const c = this.ctx;
    c.imageSmoothingEnabled = false;
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const o = this.heroOrigin();
    const s = this.scale;
    // мягкое свечение под героем
    const g = c.createRadialGradient(o.x + 32 * s, o.y + 40 * s, 10, o.x + 32 * s, o.y + 40 * s, 36 * s);
    g.addColorStop(0, 'rgba(70,110,150,0.28)');
    g.addColorStop(1, 'rgba(70,110,150,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const armor = Armor.get();
    for (const l of this.layers) {
      const tier = Math.min(armor.equipped[l.slot], 2) - 1;
      const img = l.canvases[Math.max(0, tier)];
      const hovered = this.hover === l.slot;
      const flashing = this.picked === l.slot && this.pickT < 0.6;
      if (hovered) {
        const pulse = 0.5 + 0.5 * Math.sin(this.t * 7);
        c.filter = `brightness(${1.35 + 0.35 * pulse}) drop-shadow(0 0 ${6 + 4 * pulse}px #ffe5aa)`;
      } else if (flashing) {
        c.filter = `brightness(${1 + 3 * (1 - this.pickT / 0.6)})`;
      }
      c.drawImage(img, o.x, o.y, 64 * s, 64 * s);
      c.filter = 'none';
    }
    for (const sp of this.sparks) {
      c.fillStyle = hex(sp.c);
      const z = Math.max(2, Math.round(s * 0.6));
      c.fillRect(Math.round(sp.x), Math.round(sp.y), z, z);
    }
  }
}
