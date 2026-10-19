const FONT = "uvKits, 'Courier New', monospace";

const LINES: Array<[string, string]> = [
  ['GAME DESIGN', 'Intich'],
  ['ART', 'MakotoMacy, GodsGived'],
  ['MUSIC', 'VioFox'],
  ['PROGRAMMING', 'MakotoMacy']
];

/**
 * Титры после прохождения игры: чёрный экран, пиксельный шрифт, строки проявляются по очереди. Висят holdMs (по умолчанию 5 с) под музыку, потом
 * вызывается done (игра возвращается в меню).
 */
export class Credits {
  private readonly root = document.createElement('div');

  constructor() {
    this.root.style.cssText = `position: fixed; inset: 0; z-index: 4000; display: none; flex-direction: column; align-items: center; justify-content: center; gap: 22px;
      background: #05070b; color: #d5ebff; font-family: ${FONT}; text-align: center; opacity: 0; transition: opacity 0.6s ease; -webkit-font-smoothing: none;`;
    const title = document.createElement('div');
    title.textContent = 'TEXTOLITE';
    title.style.cssText = 'font-size: clamp(30px, 6vw, 54px); letter-spacing: 0.12em; text-indent: 0.12em; margin-bottom: 14px;';
    this.root.appendChild(title);
    for (const [role, names] of LINES) {
      const block = document.createElement('div');
      block.className = 'credit-line';
      block.style.cssText = 'opacity: 0; transition: opacity 0.5s ease;';
      block.innerHTML = `<div style="font-size: 16px; letter-spacing: 0.25em; text-indent: 0.25em; color: #97b2c9; margin-bottom: 6px;">${role}</div>
        <div style="font-size: clamp(18px, 3.2vw, 26px); letter-spacing: 0.06em;">${names}</div>`;
      this.root.appendChild(block);
    }
    document.body.appendChild(this.root);
  }

  public show(holdMs: number, done: () => void): void {
    this.root.style.display = 'flex';
    void this.root.offsetWidth;
    this.root.style.opacity = '1';
    const lines = [...this.root.querySelectorAll<HTMLElement>('.credit-line')];
    lines.forEach((el, i) => window.setTimeout(() => { el.style.opacity = '1'; }, 500 + i * 450));
    window.setTimeout(done, holdMs);
  }
}
