import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { LevelObjectDef } from '../data/types.ts';
import { Quest } from '../systems/Quest.ts';
import { CipherTerminalPuzzle } from '../systems/CipherTerminalPuzzle.ts';
import { EventBus } from '../core/EventBus.ts';

interface KeyDef {
  id: string;
  digit: string;
  x: number; // local center x
  y: number; // local center y
  w: number;
  h: number;
  label: string;
}

/**
 * Интерактивный терминал пароля, функционирующий прямо на спрайте `deco_password` (64×64 px).
 * Без модального Web UI:
 * - 10 кнопок (1-5 в верхнем ряду, 6-0 в нижнем) с нанесенными цифрами;
 * - Нижняя широкая клавиша ENTER;
 * - Экранчик с отображением введенного кода (_ _ _ _), статусов [ OK ] и [ERR];
 * - Подсветка и клики мыши прямо по кнопкам на спрайте;
 * - Поддержка клавиш клавиатуры (0-9, Backspace, Enter, Esc) при нахождении игрока рядом.
 */
export class PasswordTerminalEntity {
  public readonly container = new Container();
  public readonly def: LevelObjectDef;

  private screenBg: Graphics;
  private screenText: Text;
  private buttonHighlights: Graphics;
  private pressEffect: Graphics;

  private keys: KeyDef[] = [];
  private hoveredKey: KeyDef | null = null;
  private pressedKeyId: string | null = null;
  private pressTimer = 0;

  private errTimer = 0;
  private shakeOffset = { x: 0, y: 0 };

  private audioCtx: AudioContext | null = null;
  private isNearby = false;

  constructor(
    def: LevelObjectDef,
    sprites: SpriteLibrary,
    private readonly puzzle: CipherTerminalPuzzle,
    private readonly quest = Quest.get()
  ) {
    this.def = def;
    this.container.position.set(def.x, def.y);

    // 1. Базовый спрайт терминала
    const sprite = sprites.createSprite('deco_password');
    if (def.flip_x) sprite.scale.x = -1;
    this.container.addChild(sprite);

    // 2. Разметка экранчика (координаты внутри спрайта относительно anchor (0.5, 1.0))
    // Размеры экрана: 44×16 px, центр: (-0.5, -41.5)
    this.screenBg = new Graphics();
    this.container.addChild(this.screenBg);

    const textStyle = new TextStyle({
      fontFamily: 'uvKits, monospace, sans-serif',
      fontSize: 10,
      fill: '#00e5ff',
      fontWeight: 'bold',
      align: 'center',
      dropShadow: {
        alpha: 0.8,
        angle: Math.PI / 2,
        blur: 3,
        color: '#00e5ff',
        distance: 0
      }
    });

    this.screenText = new Text({ text: '_ _ _ _', style: textStyle });
    this.screenText.anchor.set(0.5, 0.5);
    this.screenText.position.set(-0.5, -41.5);
    this.container.addChild(this.screenText);

    // 3. Разметка кнопок (10 цифровых + ENTER)
    // Ряд 1: Y = -27.5, кнопки 1, 2, 3, 4, 5
    const row1X = [-18.5, -9.5, -0.5, 8.5, 17.5];
    const row1Digits = ['1', '2', '3', '4', '5'];
    for (let i = 0; i < 5; i++) {
      this.keys.push({
        id: `btn_${row1Digits[i]}`,
        digit: row1Digits[i],
        x: row1X[i],
        y: -27.5,
        w: 8,
        h: 8,
        label: row1Digits[i]
      });
    }

    // Ряд 2: Y = -17.5, кнопки 6, 7, 8, 9, 0
    const row2X = [-18.5, -9.5, -0.5, 8.5, 17.5];
    const row2Digits = ['6', '7', '8', '9', '0'];
    for (let i = 0; i < 5; i++) {
      this.keys.push({
        id: `btn_${row2Digits[i]}`,
        digit: row2Digits[i],
        x: row2X[i],
        y: -17.5,
        w: 8,
        h: 8,
        label: row2Digits[i]
      });
    }

    // Ряд 3: ENTER (широкая клавиша)
    this.keys.push({
      id: 'btn_enter',
      digit: 'enter',
      x: -0.5,
      y: -8.5,
      w: 36,
      h: 8,
      label: 'ENTER'
    });

    // 4. Отрисовка цифр и надписей на кнопках
    for (const k of this.keys) {
      const isEnter = k.digit === 'enter';
      const labelStyle = new TextStyle({
        fontFamily: 'uvKits, monospace, sans-serif',
        fontSize: isEnter ? 5.5 : 7,
        fill: isEnter ? '#ffd54f' : '#ffffff',
        fontWeight: 'bold',
        align: 'center'
      });
      const lbl = new Text({ text: k.label, style: labelStyle });
      lbl.anchor.set(0.5, 0.5);
      lbl.position.set(k.x, k.y);
      this.container.addChild(lbl);
    }

    // 5. Графика подсветки при наведении и нажатии
    this.buttonHighlights = new Graphics();
    this.pressEffect = new Graphics();
    this.container.addChild(this.buttonHighlights);
    this.container.addChild(this.pressEffect);

    // 6. Подписка на глобальные события шифра
    EventBus.get().on('puzzle:cipher:reset', () => this.refreshScreen());
    EventBus.get().on('puzzle:cipher:solved', () => this.onSolved());

    if (this.quest.flag('cipher_solved') || this.puzzle.isSolved) {
      this.screenText.text = '[ OK ]';
      this.screenText.style.fill = '#5bf5a3';
    } else {
      this.refreshScreen();
    }
  }

  private initAudio(): void {
    if (!this.audioCtx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) this.audioCtx = new AudioCtx();
    }
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }
  }

  private playTone(freq: number, type: OscillatorType, duration: number, delay = 0): void {
    try {
      this.initAudio();
      if (!this.audioCtx) return;
      const ctx = this.audioCtx;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, ctx.currentTime + delay);
      gain.gain.setValueAtTime(0.08, ctx.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + delay);
      osc.stop(ctx.currentTime + delay + duration);
    } catch (_) {
      // Audio autoplay restrictions
    }
  }

  private playClickSound(): void {
    this.playTone(650, 'sine', 0.04);
  }

  private playEnterSound(): void {
    this.playTone(850, 'sine', 0.05);
  }

  private playSuccessSound(): void {
    this.playTone(523.25, 'sine', 0.1, 0);
    this.playTone(659.25, 'sine', 0.1, 0.08);
    this.playTone(783.99, 'sine', 0.1, 0.16);
    this.playTone(1046.5, 'sine', 0.25, 0.24);
  }

  private playErrorSound(): void {
    this.playTone(160, 'sawtooth', 0.18);
  }

  /** Проверяет попадание точки мира (x, y) в кнопку терминала */
  public hitTest(worldX: number, worldY: number): KeyDef | null {
    const lx = worldX - this.def.x;
    const ly = worldY - this.def.y;
    for (const k of this.keys) {
      const halfW = k.w / 2;
      const halfH = k.h / 2;
      if (lx >= k.x - halfW && lx <= k.x + halfW && ly >= k.y - halfH && ly <= k.y + halfH) {
        return k;
      }
    }
    return null;
  }

  public isNearbyHero(hero: { x: number; y: number }): boolean {
    const distToHero = Math.hypot(hero.x - this.def.x, hero.y - (this.def.y - 32));
    return distToHero <= 80;
  }

  /** Обработка клика мыши */
  public onClick(worldX: number, worldY: number): boolean {
    if (!this.isNearby) return false;
    const key = this.hitTest(worldX, worldY);
    if (!key) return false;
    this.pressKey(key);
    return true;
  }

  /** Нажатие на кнопку */
  public pressKey(key: KeyDef): void {
    if (this.quest.flag('cipher_solved') || this.puzzle.isSolved) return;
    this.pressedKeyId = key.id;
    this.pressTimer = 0.1;

    if (key.digit === 'enter') {
      this.playEnterSound();
      this.submitCode();
    } else {
      this.playClickSound();
      this.puzzle.inputDigit(key.digit);
      this.refreshScreen();

      // Если введено нужное количество цифр — автопроверка
      if (this.puzzle.currentEnteredCode.length === this.puzzle.length) {
        this.submitCode();
      }
    }
  }

  /** Нажатие с клавиатуры */
  public handleKeyInput(e: KeyboardEvent): boolean {
    if (!this.isNearby || this.quest.flag('cipher_solved') || this.puzzle.isSolved) return false;
    if (e.key >= '0' && e.key <= '9') {
      const target = this.keys.find((k) => k.digit === e.key);
      if (target) {
        this.pressKey(target);
        return true;
      }
    } else if (e.key === 'Enter') {
      const enterKey = this.keys.find((k) => k.digit === 'enter');
      if (enterKey) {
        this.pressKey(enterKey);
        return true;
      }
    } else if (e.key === 'Backspace') {
      this.puzzle.backspace();
      this.playClickSound();
      this.refreshScreen();
      return true;
    } else if (e.key === 'Escape') {
      this.puzzle.clearInput();
      this.playClickSound();
      this.refreshScreen();
      return true;
    }
    return false;
  }

  private submitCode(): void {
    const res = this.puzzle.submit();
    if (res.isCorrect) {
      this.onSolved();
    } else {
      this.errTimer = 0.75;
      this.playErrorSound();
      this.screenText.text = '[ERR]';
      this.screenText.style.fill = '#ff0b08';
    }
  }

  private onSolved(): void {
    this.quest.setFlag('cipher_solved');
    this.playSuccessSound();
    this.screenText.text = '[ OK ]';
    this.screenText.style.fill = '#5bf5a3';
  }

  private refreshScreen(): void {
    if (this.errTimer > 0) return;
    if (this.quest.flag('cipher_solved') || this.puzzle.isSolved) {
      this.screenText.text = '[ OK ]';
      this.screenText.style.fill = '#5bf5a3';
      return;
    }
    const entered = this.puzzle.currentEnteredCode;
    const len = this.puzzle.length;
    const chars: string[] = [];
    for (let i = 0; i < len; i++) {
      chars.push(i < entered.length ? entered[i] : '_');
    }
    this.screenText.text = chars.join(' ');
    this.screenText.style.fill = '#00e5ff';
  }

  public update(dt: number, hero: { x: number; y: number }, aimWorld: { x: number; y: number } | null): void {
    // 1. Проверка дистанции героя до терминала
    const distToHero = Math.hypot(hero.x - this.def.x, hero.y - (this.def.y - 32));
    this.isNearby = distToHero <= 75;

    // 2. Обработка ошибки
    if (this.errTimer > 0) {
      this.errTimer -= dt;
      // Тряска экрана при ошибке
      const shakeAmt = (this.errTimer / 0.75) * 2;
      this.shakeOffset.x = (Math.random() - 0.5) * shakeAmt;
      this.shakeOffset.y = (Math.random() - 0.5) * shakeAmt;
      if (this.errTimer <= 0) {
        this.shakeOffset.x = 0;
        this.shakeOffset.y = 0;
        this.puzzle.clearInput();
        this.refreshScreen();
      }
    }

    // 3. Отрисовка экрана
    this.screenBg.clear();
    const sx = -22 + this.shakeOffset.x;
    const sy = -49 + this.shakeOffset.y;
    this.screenBg.roundRect(sx, sy, 44, 16, 2).fill({ color: 0x020c17 });
    if (this.quest.flag('cipher_solved') || this.puzzle.isSolved) {
      this.screenBg.roundRect(sx, sy, 44, 16, 2).stroke({ color: 0x5bf5a3, width: 1, alpha: 0.8 });
    } else if (this.errTimer > 0) {
      this.screenBg.roundRect(sx, sy, 44, 16, 2).stroke({ color: 0xff0b08, width: 1, alpha: 0.9 });
    } else {
      this.screenBg.roundRect(sx, sy, 44, 16, 2).stroke({ color: 0x12283b, width: 1 });
    }
    this.screenText.position.set(-0.5 + this.shakeOffset.x, -41.5 + this.shakeOffset.y);

    // 4. Наведение мыши на кнопки
    this.hoveredKey = (aimWorld && this.isNearby) ? this.hitTest(aimWorld.x, aimWorld.y) : null;
    this.buttonHighlights.clear();
    if (this.hoveredKey && !this.puzzle.isSolved && !this.quest.flag('cipher_solved')) {
      const hk = this.hoveredKey;
      this.buttonHighlights
        .roundRect(hk.x - hk.w / 2, hk.y - hk.h / 2, hk.w, hk.h, 1)
        .fill({ color: 0x00e5ff, alpha: 0.35 })
        .stroke({ color: 0x00e5ff, width: 1, alpha: 0.8 });
    }

    // 5. Визуальный эффект нажатия
    this.pressEffect.clear();
    if (this.pressTimer > 0) {
      this.pressTimer -= dt;
      const pk = this.keys.find((k) => k.id === this.pressedKeyId);
      if (pk) {
        this.pressEffect
          .roundRect(pk.x - pk.w / 2, pk.y - pk.h / 2, pk.w, pk.h, 1)
          .fill({ color: 0xffffff, alpha: 0.65 });
      }
      if (this.pressTimer <= 0) this.pressedKeyId = null;
    }
  }
}
