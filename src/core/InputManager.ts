export interface InputState {
  horizontal: number; // -1 (left), 0 (idle), 1 (right)
  vertical: number;   // -1 (up/climb), 0, 1 (down)
  jumpPressed: boolean;
  jumpHeld: boolean;
  attackPressed: boolean;
  attackHeld: boolean;
  interactPressed: boolean;
}

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

    // Prevent scrolling with arrows and space in browser
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

    // Poll Gamepad if connected
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = gamepads[0];
    if (pad) {
      const axisX = pad.axes[0] ?? 0;
      if (Math.abs(axisX) > 0.25) horizontal = axisX > 0 ? 1 : -1;

      if (pad.buttons[0]?.pressed) {
        // A / Cross button
        // Combine with keyboard
      }
    }

    // Clear just-pressed buffer after polling for this frame
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
