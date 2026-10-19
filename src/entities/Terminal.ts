import { AnimatedSprite, Container } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { TerminalDef } from '../data/types.ts';
import { getSharedOutlineFilter } from '../effects/OutlineFilter.ts';

const REACH_X = 26; // px: на таком расстоянии по горизонтали герой «у терминала»
const REACH_Y = 40; // px: и по вертикали (от ног)

/**
 * Терминал брони на уровне: анимированный киоск.
 * Взаимодействие происходит кликом мыши при наведении курсора.
 */
export class Terminal {
  public readonly container = new Container();
  public readonly style: string; // loc1 / loc2 — по спрайту: цвета окна
  public readonly x: number; // центр по x и ноги (мир)
  public readonly y: number;
  private readonly sprite: AnimatedSprite;
  private time = Math.random() * 5;

  constructor(def: TerminalDef, tileSize: number, sprites: SpriteLibrary) {
    this.style = def.sprite_id.replace('terminal_', '');
    this.x = (def.x + 0.5) * tileSize;
    this.y = (def.y + 1) * tileSize;
    this.sprite = sprites.createAnimated(def.sprite_id);
    this.container.addChild(this.sprite);
    this.container.position.set(this.x, this.y);
  }

  /** Герой достаёт до терминала. */
  public reaches(px: number, py: number): boolean {
    return Math.abs(px - this.x) <= REACH_X && py <= this.y + 6 && py >= this.y - REACH_Y;
  }

  /** Проверка, наведён ли курсор мыши на терминал в мировых координатах */
  public containsPoint(wx: number, wy: number): boolean {
    return wx >= this.x - 24 && wx <= this.x + 24 && wy >= this.y - 62 && wy <= this.y + 4;
  }

  public update(dt: number, hovered = false): void {
    this.time += dt;
    this.sprite.filters = hovered ? [getSharedOutlineFilter().filter] : null;
  }
}
