import { SoundManager } from '../audio/SoundManager.ts';

const STYLE_ID = 'ld60-start-screen-style';
const FONT = "uvKits, 'Courier New', monospace";

/**
 * Стартовый экран, минимализм: чёрный фон и пиксельный шрифт. Сначала тонкая полоса загрузки, потом меню — название, два ползунка громкости
 * (SOUND по умолчанию 30%, MUSIC) и START. Без свечения, теней и подсказок. Сам ничего не грузит: переходами управляет BootFlow.
 */
export class StartScreen {
  private readonly root = document.createElement('div');
  private readonly barFill: HTMLElement;
  private readonly loadPct: HTMLElement;
  private readonly menu: HTMLElement;
  private readonly error: HTMLElement;
  private readonly startButton: HTMLButtonElement;

  private startHandler: (() => void) | null = null;
  private launching = false;

  constructor() {
    this.injectStyle();

    this.root.className = 'sb-start is-loading';
    this.root.innerHTML = `
      <div class="sb-loading">
        <div class="sb-title">TEXTOLITE</div>
        <div class="sb-bar"><div class="sb-bar-fill"></div></div>
        <div class="sb-pct">0%</div>
      </div>
      <div class="sb-menu" aria-hidden="true">
        <div class="sb-title">TEXTOLITE</div>
        <div class="sb-rows">
          <label class="sb-row" for="sb-sfx"><span>SOUND</span><output id="sb-sfx-val"></output></label>
          <input class="sb-slider" id="sb-sfx" type="range" min="0" max="100" step="1" aria-label="Sound volume">
          <label class="sb-row" for="sb-music"><span>MUSIC</span><output id="sb-music-val"></output></label>
          <input class="sb-slider" id="sb-music" type="range" min="0" max="100" step="1" aria-label="Music volume">
        </div>
        <button class="sb-go" type="button">START</button>
        <div class="sb-error" role="alert"></div>
      </div>
    `;
    document.body.appendChild(this.root);

    const query = <T extends HTMLElement>(selector: string): T => {
      const el = this.root.querySelector<T>(selector);
      if (!el) throw new Error(`[StartScreen] missing element ${selector}`);
      return el;
    };
    this.barFill = query('.sb-bar-fill');
    this.loadPct = query('.sb-pct');
    this.menu = query('.sb-menu');
    this.error = query('.sb-error');
    this.startButton = query<HTMLButtonElement>('.sb-go');

    // Ползунки показывают сохранённые значения (звуки по умолчанию — 30%)
    const audio = SoundManager.get();
    this.bindVolume(query<HTMLInputElement>('#sb-sfx'), query<HTMLOutputElement>('#sb-sfx-val'), (v) => audio.setSfxVolume(v), audio.getSfxVolume());
    this.bindVolume(query<HTMLInputElement>('#sb-music'), query<HTMLOutputElement>('#sb-music-val'), (v) => audio.setMusicVolume(v), audio.getMusicVolume());

    this.startButton.addEventListener('click', () => this.fireStart());
  }

  /** Полоса загрузки: value 0..1. label оставлен для совместимости с BootFlow (на экране только проценты). */
  public setProgress(value: number, _label?: string): void {
    const percent = Math.round(Math.max(0, Math.min(1, value)) * 100);
    this.barFill.style.width = `${percent}%`;
    this.loadPct.textContent = `${percent}%`;
  }

  /** Загрузка кончилась: показываем меню. */
  public showMenu(): void {
    this.root.classList.remove('is-loading');
    this.root.classList.add('is-menu');
    this.menu.setAttribute('aria-hidden', 'false');
    window.setTimeout(() => this.startButton.focus({ preventScroll: true }), 200);
  }

  public onStart(handler: () => void): void {
    this.startHandler = handler;
  }

  /** Гасим меню перед передачей управления игре. */
  public setLaunching(): void {
    this.launching = true;
    this.startButton.disabled = true;
    this.startButton.blur();
    this.root.classList.add('is-launching');
    this.menu.setAttribute('aria-hidden', 'true');
  }

  /** Экран убран, но остаётся в DOM до dispose — чтобы суметь показать ошибку. */
  public hide(): void {
    this.root.classList.add('is-hidden');
  }

  public dispose(): void {
    this.root.remove();
    document.getElementById(STYLE_ID)?.remove();
  }

  /** Ошибка запуска: возвращаем экран, пишем, что случилось, START превращается в RELOAD. */
  public showError(message: string): void {
    this.launching = false;
    this.startButton.disabled = false;
    this.startButton.textContent = 'RELOAD';
    this.startHandler = () => window.location.reload();
    this.root.classList.remove('is-launching', 'is-hidden', 'is-loading');
    this.root.classList.add('is-menu', 'is-error');
    this.menu.setAttribute('aria-hidden', 'false');
    this.error.textContent = message;
    this.startButton.focus({ preventScroll: true });
  }

  private fireStart(): void {
    if (this.launching) return;
    this.startHandler?.();
  }

  private bindVolume(slider: HTMLInputElement, output: HTMLOutputElement, apply: (value: number) => void, initial: number): void {
    const write = (raw: number) => {
      const percent = Math.max(0, Math.min(100, Math.round(raw)));
      slider.value = String(percent);
      slider.style.setProperty('--fill', `${percent}%`);
      output.textContent = `${percent}%`;
    };
    write(Math.round(initial * 100));
    slider.addEventListener('input', () => {
      const percent = Number(slider.value);
      write(percent);
      apply(percent / 100);
    });
  }

  private injectStyle(): void {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .sb-start { position: fixed; inset: 0; z-index: 5000; background: #05070b; color: #d5ebff; font-family: ${FONT};
        display: flex; align-items: center; justify-content: center; opacity: 1; transition: opacity 0.3s ease; -webkit-font-smoothing: none; }
      .sb-start.is-launching, .sb-start.is-hidden { opacity: 0; pointer-events: none; }
      .sb-loading, .sb-menu { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; transition: opacity 0.3s ease; }
      .sb-menu { opacity: 0; pointer-events: none; }
      .sb-start.is-menu .sb-menu { opacity: 1; pointer-events: auto; }
      .sb-start.is-menu .sb-loading, .sb-start.is-error .sb-loading { opacity: 0; }

      .sb-title { font-size: clamp(34px, 7vw, 64px); letter-spacing: 0.12em; text-indent: 0.12em; line-height: 1; }

      .sb-bar { margin-top: 40px; width: min(280px, 70vw); height: 6px; background: #12283b; }
      .sb-bar-fill { height: 100%; width: 0; background: #d5ebff; }
      .sb-pct { margin-top: 14px; font-size: 14px; letter-spacing: 0.1em; color: #738da3; }

      .sb-rows { margin-top: 44px; width: min(260px, 70vw); display: flex; flex-direction: column; gap: 6px; }
      .sb-row { display: flex; justify-content: space-between; font-size: 14px; letter-spacing: 0.1em; color: #738da3; }
      .sb-row output { color: #d5ebff; }

      .sb-slider { -webkit-appearance: none; appearance: none; width: 100%; height: 14px; margin: 0 0 10px; background: transparent; cursor: pointer; --fill: 30%; }
      .sb-slider:focus-visible { outline: 1px solid #d5ebff; outline-offset: 3px; }
      .sb-slider::-webkit-slider-runnable-track { height: 4px; background: linear-gradient(90deg, #d5ebff 0 var(--fill), #12283b var(--fill) 100%); }
      .sb-slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 8px; height: 12px; margin-top: -4px; background: #d5ebff; border: 0; border-radius: 0; }
      .sb-slider::-moz-range-track { height: 4px; background: #12283b; }
      .sb-slider::-moz-range-progress { height: 4px; background: #d5ebff; }
      .sb-slider::-moz-range-thumb { width: 8px; height: 12px; background: #d5ebff; border: 0; border-radius: 0; }

      .sb-go { margin-top: 30px; padding: 10px 28px; font-family: ${FONT}; font-size: 22px; letter-spacing: 0.2em; text-indent: 0.2em;
        color: #d5ebff; cursor: pointer; background: none; border: 0; border-radius: 0; }
      .sb-go::before { content: '> '; opacity: 0; }
      .sb-go:hover::before, .sb-go:focus-visible::before { opacity: 1; }
      .sb-go:focus { outline: none; }
      .sb-go:disabled { opacity: 0.4; cursor: default; }

      .sb-error { display: none; margin-top: 18px; max-width: 80vw; text-align: center; font-size: 14px; color: #fc896b; }
      .sb-start.is-error .sb-error { display: block; }
    `;
    document.head.appendChild(style);
  }
}
