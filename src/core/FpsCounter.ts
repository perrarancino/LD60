import type { Ticker } from 'pixi.js';

const CAPS = [0, 60, 30]; // ограничение частоты кадров, F4: 0 — без ограничения (по частоте монитора)
const CAP_KEY = 'ld60.fpsCap';

/**
 * Счётчик FPS в углу экрана (обычный HTML-элемент поверх холста: не рисуется в игре и не стоит GPU).
 * Показывает среднюю частоту кадров и время кадра за последние полсекунды, а также худший кадр. F3 — показать/скрыть.
 * F4 — ограничение частоты кадров (без ограничения → 60 → 30; запоминается): на мониторах 120–240 Гц экономит видеокарту, когда запас не нужен.
 */
export class FpsCounter {
  private readonly el = document.createElement('div');
  private frames = 0;
  private acc = 0; // мс за окно
  private worst = 0; // мс худшего кадра в окне
  private visible = true;
  private cap = 0;

  constructor(private readonly ticker?: Ticker) {
    const s = this.el.style;
    s.position = 'fixed';
    s.left = '6px';
    s.top = '4px';
    s.zIndex = '1000';
    s.pointerEvents = 'none';
    s.font = '12px/1.2 "Courier New", monospace';
    s.color = '#7CFF8A';
    s.textShadow = '1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000';
    s.whiteSpace = 'pre';
    document.body.appendChild(this.el);
    try {
      const saved = Number(localStorage.getItem(CAP_KEY));
      if (CAPS.includes(saved)) this.cap = saved;
    } catch { /* хранилище недоступно — без ограничения */ }
    this.applyCap();
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F3') {
        e.preventDefault();
        this.visible = !this.visible;
        this.el.style.display = this.visible ? 'block' : 'none';
      } else if (e.code === 'F4') {
        e.preventDefault();
        this.cap = CAPS[(CAPS.indexOf(this.cap) + 1) % CAPS.length];
        try { localStorage.setItem(CAP_KEY, String(this.cap)); } catch { /* не сохранилось — не страшно */ }
        this.applyCap();
        this.frames = 0;
        this.acc = 0;
        this.worst = 0;
      }
    });
  }

  private applyCap(): void {
    if (this.ticker) this.ticker.maxFPS = this.cap;
  }

  /** Раз в кадр: frameMs — длительность последнего кадра, мс. */
  public tick(frameMs: number): void {
    this.frames++;
    this.acc += frameMs;
    this.worst = Math.max(this.worst, frameMs);
    if (this.acc < 500) return;
    const fps = (this.frames * 1000) / this.acc;
    const avg = this.acc / this.frames;
    this.el.textContent = `FPS ${fps.toFixed(0)}${this.cap ? ` (лимит ${this.cap})` : ''}\n${avg.toFixed(1)} мс (макс ${this.worst.toFixed(0)})`;
    this.frames = 0;
    this.acc = 0;
    this.worst = 0;
  }
}
