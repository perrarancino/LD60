/**
 * Счётчик FPS в углу экрана (обычный HTML-элемент поверх холста: не рисуется в игре и не стоит GPU).
 * Показывает среднюю частоту кадров и время кадра за последние полсекунды, а также худший кадр. F3 — показать/скрыть.
 */
export class FpsCounter {
  private readonly el = document.createElement('div');
  private frames = 0;
  private acc = 0; // мс за окно
  private worst = 0; // мс худшего кадра в окне
  private visible = true;

  constructor() {
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
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F3') {
        e.preventDefault();
        this.visible = !this.visible;
        this.el.style.display = this.visible ? 'block' : 'none';
      }
    });
  }

  /** Раз в кадр: frameMs — длительность последнего кадра, мс. */
  public tick(frameMs: number): void {
    this.frames++;
    this.acc += frameMs;
    this.worst = Math.max(this.worst, frameMs);
    if (this.acc < 500) return;
    const fps = (this.frames * 1000) / this.acc;
    const avg = this.acc / this.frames;
    this.el.textContent = `FPS ${fps.toFixed(0)}\n${avg.toFixed(1)} мс (макс ${this.worst.toFixed(0)})`;
    this.frames = 0;
    this.acc = 0;
    this.worst = 0;
  }
}
