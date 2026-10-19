import { pal } from '../core/Palette.ts';

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');
const PIXEL = 4; // px экрана на один пиксель холста: крупные пиксели
const CELL = 7; // пикселей холста в клетке (≈ 28 px экрана)
const DURATION = 0.7; // с: волна доходит до самых дальних углов
const COVER = '#05070b';

/**
 * Быстрая «пиксельная волна» вместо плавного затемнения: из точки (герой) расходится кольцо — клетки вырастают из центра в квадраты, на фронте волны
 * они ярко светятся (золото -> бирюза), позади остаётся тёмный экран. Дальше поверх встаёт экран улучшения или кубики.
 */
export class ScreenWipe {
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private raf = 0;
  private t = 0;
  private last = 0;
  private fx = 0;
  private fy = 0;
  private done: (() => void) | null = null;

  constructor() {
    this.canvas.style.cssText = 'position: fixed; left: 0; top: 0; width: 100%; height: 100%; z-index: 2400; pointer-events: none; display: none; image-rendering: pixelated;';
    document.body.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
  }

  /** Запускает волну из точки экрана (fx, fy — CSS px); done вызывается, когда экран закрыт целиком. */
  public start(fx: number, fy: number, done: () => void): void {
    this.canvas.width = Math.ceil(window.innerWidth / PIXEL);
    this.canvas.height = Math.ceil(window.innerHeight / PIXEL);
    this.fx = fx / PIXEL;
    this.fy = fy / PIXEL;
    this.t = 0;
    this.done = done;
    this.canvas.style.display = 'block';
    this.last = performance.now();
    cancelAnimationFrame(this.raf);
    const frame = (now: number) => {
      this.t += Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.draw();
      if (this.t >= DURATION) {
        const cb = this.done;
        this.done = null;
        cb?.();
        return;
      }
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  private draw(): void {
    const c = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    c.clearRect(0, 0, W, H);
    const progress = Math.min(1, this.t / DURATION);
    const maxD = Math.max(Math.hypot(this.fx, this.fy), Math.hypot(W - this.fx, this.fy), Math.hypot(this.fx, H - this.fy), Math.hypot(W - this.fx, H - this.fy));
    const front = progress * 1.35; // фронт волны (в долях maxD), с запасом, чтобы дальние углы закрылись полностью
    for (let y = 0; y < H; y += CELL) {
      for (let x = 0; x < W; x += CELL) {
        const cx = x + CELL / 2;
        const cy = y + CELL / 2;
        const d = Math.hypot(cx - this.fx, cy - this.fy) / maxD;
        const local = Math.max(0, Math.min(1, (front - d) * 3.4)); // 0 — клетка ещё не тронута, 1 — закрыта
        if (local <= 0) continue;
        const e = local * local * (3 - 2 * local);
        const s = Math.ceil((CELL + 1) * e);
        if (local < 1) {
          // фронт волны светится: золотой у кромки, бирюзовый чуть позади; клетка слегка поворачивается кругом (мерцание)
          const glow = Math.sin(local * Math.PI);
          c.fillStyle = hex(local < 0.45 ? pal('gold', 6) : pal('electric', 6));
          c.globalAlpha = 0.35 + 0.65 * glow;
          const g = s + 2;
          c.fillRect(Math.round(cx - g / 2), Math.round(cy - g / 2), g, g);
          c.globalAlpha = 1;
        }
        c.fillStyle = COVER;
        c.fillRect(Math.round(cx - s / 2), Math.round(cy - s / 2), s, s);
      }
    }
  }
}
