import { Container, Text, TextStyle } from 'pixi.js';
import type { CipherClue, CipherTerminalPuzzle } from '../systems/CipherTerminalPuzzle.ts';

const FONT_FAMILY = 'uvKits';

interface ClueNode {
  clue: CipherClue;
  node: Container;
  digitText: Text;
  time: number;
}

/**
 * Цифры шифра: четыре зелёных светящихся цифры подряд (слева направо — порядок кода) прямо поверх тайлов комнаты перед комнатой пароля.
 * Шрифт uvKits, неоновое свечение (тень без смещения с размытием), лёгкое мерцание. Код случайный при каждом запуске (CipherTerminalPuzzle).
 */
export class CipherCluesView {
  public readonly container = new Container();
  private readonly nodes: Map<string, ClueNode> = new Map();

  private readonly digitStyle = new TextStyle({
    fontFamily: FONT_FAMILY,
    fontSize: 30,
    fill: 0x7dffb8, // неоновый зелёный
    dropShadow: { color: 0x2cff8a, alpha: 0.95, angle: 0, distance: 0, blur: 8 },
    padding: 10
  });

  constructor(private readonly puzzle: CipherTerminalPuzzle) {
    this.rebuild();
  }

  /** Перестроить цифры по текущему состоянию головоломки. */
  public rebuild(): void {
    this.container.removeChildren();
    this.nodes.clear();
    for (const clue of this.puzzle.getClues()) {
      const node = new Container();
      node.position.set(clue.x, clue.y);
      const digitText = new Text({
        text: String(clue.digit),
        style: this.digitStyle,
        resolution: 1,
        textureStyle: { scaleMode: 'nearest' }
      });
      digitText.anchor.set(0.5, 0.5);
      node.addChild(digitText);
      this.container.addChild(node);
      this.nodes.set(clue.id, { clue, node, digitText, time: Math.random() * 10 });
    }
  }

  /** Цифру заметили: короткая вспышка (поведение осталось от прежней версии; цифры видны всегда). */
  public onClueDiscovered(clue: CipherClue): void {
    const entry = this.nodes.get(clue.id);
    if (entry) entry.time = 0;
  }

  /** Мерцание неонового свечения. */
  public update(dt: number): void {
    for (const entry of this.nodes.values()) {
      entry.time += dt;
      entry.digitText.alpha = 0.88 + 0.12 * Math.sin(entry.time * 3.2 + entry.clue.orderIndex);
    }
  }
}
