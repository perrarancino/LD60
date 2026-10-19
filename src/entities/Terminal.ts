import { AnimatedSprite, Container, Graphics } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { TerminalDef } from '../data/types.ts';
import { pal } from '../core/Palette.ts';

const REACH_X = 26; // px: на таком расстоянии по горизонтали герой «у терминала»
const REACH_Y = 40; // px: и по вертикали (от ног)

/** Буква E в клавише: пиксельный узор 3x5 (1 — закрашено). */
const KEY_E = ['111', '100', '111', '100', '111'];

/**
 * Терминал брони на уровне: анимированный киоск. Когда герой рядом — над ним качается подсказка-клавиша «E» (без текста — пиксельная иконка).
 */
export class Terminal {
  public readonly container = new Container();
  public readonly style: string; // loc1 / loc2 — по спрайту: цвета окна
  public readonly x: number; // центр по x и ноги (мир)
  public readonly y: number;
  private readonly prompt = new Graphics();
  private time = Math.random() * 5;

  constructor(def: TerminalDef, tileSize: number, sprites: SpriteLibrary) {
    this.style = def.sprite_id.replace('terminal_', '');
    this.x = (def.x + 0.5) * tileSize;
    this.y = (def.y + 1) * tileSize;
    const sprite: AnimatedSprite = sprites.createAnimated(def.sprite_id);
    this.container.addChild(sprite);
    this.container.position.set(this.x, this.y);
    this.drawPrompt();
    this.prompt.position.set(0, -66);
    this.prompt.visible = false;
    this.container.addChild(this.prompt);
  }

  /** Подсказка: клавиша с «E» на тёмной подложке с золотой кромкой и стрелкой вниз. */
  private drawPrompt(): void {
    const g = this.prompt;
    g.clear();
    g.rect(-6, -6, 12, 12).fill(pal('steel', 0));
    g.rect(-5, -5, 10, 10).fill(pal('gold', 5));
    g.rect(-4, -4, 8, 8).fill(pal('steel', 1));
    KEY_E.forEach((row, ry) => {
      for (let rx = 0; rx < 3; rx++) if (row[rx] === '1') g.rect(-3 + rx * 2, -5 + ry * 2 + 1, 2, 2).fill(pal('gold', 7));
    });
    g.rect(-2, 6, 4, 1).fill(pal('gold', 5));
    g.rect(-1, 7, 2, 1).fill(pal('gold', 5));
  }

  /** Герой достаёт до терминала. */
  public reaches(px: number, py: number): boolean {
    return Math.abs(px - this.x) <= REACH_X && py <= this.y + 6 && py >= this.y - REACH_Y;
  }

  public update(dt: number, near: boolean): void {
    this.time += dt;
    this.prompt.visible = near;
    if (near) this.prompt.y = -66 + Math.round(Math.sin(this.time * 4) * 1.5);
  }
}
