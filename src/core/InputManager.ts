export interface InputState {
  horizontal: number; // Горизонтальная ось: -1 (влево), 0 (покой), 1 (вправо)
  vertical: number;   // Вертикальная ось: -1 (вверх), 0 (покой), 1 (вниз)
  jumpPressed: boolean;
  jumpHeld: boolean;
  attackPressed: boolean;
  attackHeld: boolean;
  interactPressed: boolean;
}

/**
 * Менеджер ввода: объединяет опрос клавиатуры (WASD, Стрелки, Пробел) и геймпадов
 */
export class InputManager {
  private static instance: InputManager;
  private keysDown: Set<string> = new Set();
  private keysJustPressed: Set<string> = new Set();

  private constructor() {
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));
  }

  public static get(): InputManager {
    if (!InputManager.instance) {
      InputManager.instance = new InputManager();
    }
    return InputManager.instance;
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (!this.keysDown.has(e.code)) {
      this.keysJustPressed.add(e.code);
    }
    this.keysDown.add(e.code);

    // Блокируем стандартную прокрутку страницы стрелками и пробелом в браузере
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
      e.preventDefault();
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    this.keysDown.delete(e.code);
  }

  public poll(): InputState {
    let horizontal = 0;
    if (this.keysDown.has('KeyA') || this.keysDown.has('ArrowLeft')) horizontal -= 1;
    if (this.keysDown.has('KeyD') || this.keysDown.has('ArrowRight')) horizontal += 1;

    let vertical = 0;
    if (this.keysDown.has('KeyW') || this.keysDown.has('ArrowUp')) vertical -= 1;
    if (this.keysDown.has('KeyS') || this.keysDown.has('ArrowDown')) vertical += 1;

    const jumpPressed = this.keysJustPressed.has('Space') || this.keysJustPressed.has('KeyW') || this.keysJustPressed.has('ArrowUp');
    const jumpHeld = this.keysDown.has('Space') || this.keysDown.has('KeyW') || this.keysDown.has('ArrowUp');

    const attackPressed = this.keysJustPressed.has('KeyJ') || this.keysJustPressed.has('KeyZ') || this.keysJustPressed.has('KeyX');
    const attackHeld = this.keysDown.has('KeyJ') || this.keysDown.has('KeyZ') || this.keysDown.has('KeyX');

    const interactPressed = this.keysJustPressed.has('KeyE') || this.keysJustPressed.has('KeyF') || this.keysJustPressed.has('Enter');

    // Опрос геймпада при наличии активного подключения
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = gamepads[0];
    if (pad) {
      const axisX = pad.axes[0] ?? 0;
      if (Math.abs(axisX) > 0.25) horizontal = axisX > 0 ? 1 : -1;
    }

    // Сброс буфера разовых нажатий текущего кадра
    this.keysJustPressed.clear();

    return {
      horizontal,
      vertical,
      jumpPressed,
      jumpHeld,
      attackPressed,
      attackHeld,
      interactPressed
    };
  }
}
