import { EventBus } from '../core/EventBus.ts';
import { pal } from '../core/Palette.ts';
import type { CipherTerminalPuzzle, CipherSubmitResult } from '../systems/CipherTerminalPuzzle.ts';

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');

/**
 * Интерфейс терминала ввода настенного шифра (комната «Пароль» 1-й локации).
 *
 * Отображает:
 * 1. 4 слота с римскими номерами I, II, III, IV.
 * 2. Уже введенные цифры или прочерки.
 * 3. Подсказки по найденным в комнатах цифрам шифра.
 * 4. Экранную клавиатуру и поддержку ввода с физической клавиатуры (0-9, Backspace, Enter, Esc).
 */
export class CipherTerminalUI {
  private readonly root = document.createElement('div');
  private opened = false;
  private statusMsg = '';
  private isError = false;
  private isSuccess = false;

  constructor(private readonly puzzle: CipherTerminalPuzzle) {
    this.root.id = 'cipher-terminal-ui';
    this.root.style.cssText = `
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
      width: min(440px, 94vw); z-index: 1100; display: none;
      font: 14px/1.3 "Courier New", monospace; color: ${hex(pal('pcb', 7))};
      background: ${hex(pal('pcb', 0))}; border: 2px solid ${hex(pal('pcb', 5))};
      box-shadow: 0 0 24px rgba(0, 0, 0, 0.8), inset 0 0 16px rgba(34, 208, 76, 0.15);
      border-radius: 8px; padding: 18px 20px; user-select: none;
    `;

    document.body.appendChild(this.root);

    window.addEventListener('keydown', (e) => {
      if (!this.opened) return;
      if (e.code === 'Escape') {
        e.preventDefault();
        this.close();
      } else if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        this.handleDigit(e.key);
      } else if (e.code === 'Backspace') {
        e.preventDefault();
        this.handleBackspace();
      } else if (e.code === 'Enter') {
        e.preventDefault();
        this.handleSubmit();
      }
    });

    EventBus.get().on('puzzle:cipher:reset', () => { if (this.opened) this.render(); });
    EventBus.get().on('puzzle:cipher:clue_discovered', () => { if (this.opened) this.render(); });
  }

  public get isOpen(): boolean {
    return this.opened;
  }

  public open(): void {
    this.opened = true;
    this.statusMsg = this.puzzle.isSolved
      ? 'ДОСТУП УЖЕ РАЗРЕШЕН! ШЛЮЗ ОТКРЫТ.'
      : 'ВВЕДИТЕ 4 ЦИФРЫ ШИФРА ИЗ КОМНАТ 1-Й ЛОКАЦИИ';
    this.isError = false;
    this.isSuccess = this.puzzle.isSolved;
    this.root.style.display = 'block';
    this.render();
  }

  public close(): void {
    this.opened = false;
    this.root.style.display = 'none';
  }

  private handleDigit(digit: string): void {
    if (this.puzzle.isSolved) return;
    this.puzzle.inputDigit(digit);
    this.render();
  }

  private handleBackspace(): void {
    if (this.puzzle.isSolved) return;
    this.puzzle.backspace();
    this.statusMsg = 'ВВЕДИТЕ ЦИФРЫ ШИФРА';
    this.isError = false;
    this.render();
  }

  private handleClear(): void {
    if (this.puzzle.isSolved) return;
    this.puzzle.clearInput();
    this.statusMsg = 'ПОЛЕ ВВОДА ОЧИЩЕНО';
    this.isError = false;
    this.render();
  }

  private handleSubmit(): void {
    if (this.puzzle.isSolved) return;
    const res: CipherSubmitResult = this.puzzle.submit();
    this.statusMsg = res.message;
    this.isError = !res.isCorrect;
    this.isSuccess = res.isCorrect;
    this.render();
  }

  private render(): void {
    const code = this.puzzle.currentEnteredCode;
    const len = this.puzzle.length;
    const clues = this.puzzle.getClues();

    // Слоты шифра с римскими цифрами сверху
    let slotsHtml = '';
    for (let i = 0; i < len; i++) {
      const roman = clues[i]?.roman ?? ['I', 'II', 'III', 'IV', 'V'][i] ?? `${i + 1}`;
      const char = code[i] ?? '_';
      const isFilled = i < code.length;
      slotsHtml += `
        <div style="display:flex; flex-direction:column; align-items:center; gap:4px;">
          <span style="font-size:12px; color:${hex(pal('gold', 6))}; font-weight:bold;">${roman}</span>
          <div style="width:48px; height:54px; border:2px solid ${isFilled ? hex(pal('pcb', 6)) : hex(pal('steel', 3))};
                      background:${isFilled ? hex(pal('pcb', 1)) : hex(pal('steel', 0))};
                      display:flex; align-items:center; justify-content:center;
                      font-size:26px; font-weight:bold; color:${isFilled ? hex(pal('electric', 7)) : hex(pal('steel', 4))};
                      border-radius:4px; box-shadow:inset 0 0 8px rgba(0,0,0,0.5);">
            ${char}
          </div>
        </div>
      `;
    }

    // Подсказки по найденным комнатам
    let hintsHtml = '';
    for (let i = 0; i < clues.length; i++) {
      const c = clues[i];
      const found = c.isDiscovered;
      hintsHtml += `
        <div style="display:flex; align-items:center; gap:4px; padding:3px 6px;
                    border:1px solid ${found ? hex(pal('pcb', 4)) : hex(pal('steel', 2))};
                    background:${found ? 'rgba(34,208,76,0.1)' : 'rgba(0,0,0,0.3)'};
                    border-radius:4px; font-size:12px;">
          <span style="color:${hex(pal('gold', 5))};">[${c.roman}]</span>
          <span style="color:${found ? hex(pal('pcb', 6)) : hex(pal('steel', 4))}; font-weight:bold;">
            ${found ? c.digit : '?'}
          </span>
          <span style="color:${hex(pal('steel', 5))}; font-size:10px; margin-left:4px;">${c.roomName ?? ''}</span>
        </div>
      `;
    }

    // Экранные кнопки 0..9, Сброс, Ввод
    let buttonsHtml = '<div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:6px; margin-top:12px;">';
    for (const d of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      buttonsHtml += `
        <button class="cipher-num-btn" data-digit="${d}" style="
          padding:10px 0; font-size:18px; font-weight:bold; background:${hex(pal('pcb', 1))};
          color:${hex(pal('steel', 7))}; border:1px solid ${hex(pal('pcb', 4))};
          border-radius:4px; cursor:pointer;">${d}</button>
      `;
    }
    buttonsHtml += `
      <button id="cipher-clear-btn" style="
        padding:10px 0; font-size:13px; font-weight:bold; background:${hex(pal('ember', 2))};
        color:${hex(pal('ember', 6))}; border:1px solid ${hex(pal('ember', 4))};
        border-radius:4px; cursor:pointer;">СБРОС</button>
      <button class="cipher-num-btn" data-digit="0" style="
        padding:10px 0; font-size:18px; font-weight:bold; background:${hex(pal('pcb', 1))};
        color:${hex(pal('steel', 7))}; border:1px solid ${hex(pal('pcb', 4))};
        border-radius:4px; cursor:pointer;">0</button>
      <button id="cipher-enter-btn" style="
        padding:10px 0; font-size:13px; font-weight:bold; background:${hex(pal('gold', 3))};
        color:${hex(pal('gold', 7))}; border:1px solid ${hex(pal('gold', 5))};
        border-radius:4px; cursor:pointer;">ВВОД</button>
    </div>`;

    this.root.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid ${hex(pal('pcb', 4))}; padding-bottom:8px; margin-bottom:12px;">
        <span style="font-weight:bold; font-size:14px; color:${hex(pal('pcb', 6))};">ТЕРМИНАЛ ШИФРА [1-Я ЛОКАЦИЯ]</span>
        <button id="cipher-close-btn" style="background:none; border:none; color:${hex(pal('steel', 5))}; font-size:16px; cursor:pointer; font-weight:bold;">✕</button>
      </div>

      <div style="display:flex; justify-content:center; gap:14px; margin-bottom:14px;">
        ${slotsHtml}
      </div>

      <div style="text-align:center; min-height:22px; font-size:12px; font-weight:bold; margin-bottom:12px;
                  color:${this.isError ? hex(pal('ember', 5)) : (this.isSuccess ? hex(pal('pcb', 6)) : hex(pal('steel', 6)))};">
        ${this.statusMsg}
      </div>

      <div style="margin-bottom:10px; font-size:11px; color:${hex(pal('steel', 5))};">
        НАЙДЕННЫЕ ЦИФРЫ В КОМНАТАХ:
      </div>
      <div style="display:grid; grid-template-columns:repeat(2, 1fr); gap:6px; margin-bottom:12px;">
        ${hintsHtml}
      </div>

      ${buttonsHtml}
    `;

    // Слушатели кликов
    this.root.querySelector('#cipher-close-btn')?.addEventListener('click', () => this.close());
    this.root.querySelector('#cipher-clear-btn')?.addEventListener('click', () => this.handleClear());
    this.root.querySelector('#cipher-enter-btn')?.addEventListener('click', () => this.handleSubmit());
    this.root.querySelectorAll('.cipher-num-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const d = (e.currentTarget as HTMLElement).getAttribute('data-digit');
        if (d) this.handleDigit(d);
      });
    });
  }
}
