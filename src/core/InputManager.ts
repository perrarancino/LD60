const MOUSE_ATTACK = 'Mouse0';
const MOUSE_SPECIAL = 'Mouse2';

export interface InputState {
  horizontal: number; // Горизонтальная ось: -1 (влево), 0 (покой), 1 (вправо)
  vertical: number;   // Вертикальная ось: -1 (вверх), 0 (покой), 1 (вниз)
  jumpPressed: boolean;
  jumpHeld: boolean;
  attackPressed: boolean;
  attackHeld: boolean;
  specialAttackPressed: boolean;
  specialAttackHeld: boolean;
  hubMenuPressed: boolean;
  mouseLeftPressed: boolean;
  mouseRightPressed: boolean;
}

/**
 * Менеджер ввода: объединяет опрос клавиатуры (WASD, Стрелки, Пробел), левой/правой кнопок мыши и геймпадов
 */
export class InputManager {
  private static instance: InputManager;
  private keysDown: Set<string> = new Set();
  private keysJustPressed: Set<string> = new Set();

  private constructor() {
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));
    // Блокируем контекстное меню браузера на ПКМ
    window.addEventListener('contextmenu', (e) => e.preventDefault());

    // Левая и правая кнопки мыши
    window.addEventListener('mousedown', (e) => {
      const code = e.button === 0 ? MOUSE_ATTACK : e.button === 2 ? MOUSE_SPECIAL : null;
      if (!code) return;
      if (!this.keysDown.has(code)) this.keysJustPressed.add(code);
      this.keysDown.add(code);
    });
    window.addEventListener('mouseup', (e) => {
      const code = e.button === 0 ? MOUSE_ATTACK : e.button === 2 ? MOUSE_SPECIAL : null;
      if (code) this.keysDown.delete(code);
    });

    // Сброс зажатых клавиш при переключении вкладки, сворачивании или потере фокуса окна (исправление бага залипания)
    window.addEventListener('blur', () => this.reset());
    window.addEventListener('focus', () => this.reset());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.reset();
    });
  }

  /**
   * Сброс всех зажатых клавиш и кнопок мыши (при потере фокуса, смене вкладки или экрана)
   */
  public reset(): void {
    this.keysDown.clear();
    this.keysJustPressed.clear();
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

    const mouseLeftPressed = this.keysJustPressed.has(MOUSE_ATTACK);
    const mouseRightPressed = this.keysJustPressed.has(MOUSE_SPECIAL);

    const attackPressed = this.keysJustPressed.has('KeyJ') || this.keysJustPressed.has('KeyZ') || this.keysJustPressed.has('KeyX') ||
      mouseLeftPressed;
    const attackHeld = this.keysDown.has('KeyJ') || this.keysDown.has('KeyZ') || this.keysDown.has('KeyX') || this.keysDown.has(MOUSE_ATTACK);

    const specialAttackPressed = this.keysJustPressed.has('KeyK') || mouseRightPressed;
    const specialAttackHeld = this.keysDown.has('KeyK') || this.keysDown.has(MOUSE_SPECIAL);

    const hubMenuPressed = this.keysJustPressed.has('KeyC') || this.keysJustPressed.has('KeyH') || this.keysJustPressed.has('Tab');

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
      specialAttackPressed,
      specialAttackHeld,
      hubMenuPressed,
      mouseLeftPressed,
      mouseRightPressed
    };
  }
}
