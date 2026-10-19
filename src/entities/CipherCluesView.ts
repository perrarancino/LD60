import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import { pal } from '../core/Palette.ts';
import type { CipherClue, CipherTerminalPuzzle } from '../systems/CipherTerminalPuzzle.ts';

const FONT_FAMILY = 'uvKits';

interface ClueNode {
  clue: CipherClue;
  node: Container;
  plate: Graphics;
  digitText: Text;
  romanText: Text;
  led: Graphics;
  scaleSpring: number;
  time: number;
}

/**
 * Визуальный компонент настенных цифр шифра в комнатах 1-й локации.
 *
 * Отображает:
 * 1. Цифру от 0 до 9 (шрифт uvKits.ttf) — верхняя часть.
 * 2. Римскую цифру I, II, III, IV... под ней (шрифт uvKits.ttf) — порядковый номер в шифре.
 * 3. Ретро-плату/табличку в стилистике PCB и микросхем с индикаторным светодиодом.
 * 4. Анимацию мерцания и эффект при обнаружении роботом.
 */
export class CipherCluesView {
  public readonly container = new Container();
  private readonly nodes: Map<string, ClueNode> = new Map();

  private readonly digitStyle = new TextStyle({
    fontFamily: FONT_FAMILY,
    fontSize: 18,
    fill: 0x5bf5a3, // неоновый фосфорно-зеленый (pcb / oldtech)
    stroke: { color: 0x050c0e, width: 3, join: 'miter' },
    dropShadow: { color: 0x03080a, alpha: 0.9, angle: Math.PI / 2, distance: 2, blur: 0 },
    padding: 4
  });

  private readonly romanStyle = new TextStyle({
    fontFamily: FONT_FAMILY,
    fontSize: 12,
    fill: 0xfbc53d, // теплое золото / янтарь
    stroke: { color: 0x050c0e, width: 2, join: 'miter' },
    dropShadow: { color: 0x03080a, alpha: 0.9, angle: Math.PI / 2, distance: 1, blur: 0 },
    padding: 2
  });

  constructor(private readonly puzzle: CipherTerminalPuzzle) {
    this.rebuild();
  }

  /**
   * Перестроить визуальные объекты подсказок по текущему состоянию головоломки
   */
  public rebuild(): void {
    this.container.removeChildren();
    this.nodes.clear();

    const clues = this.puzzle.getClues();

    for (const clue of clues) {
      const node = new Container();
      node.position.set(clue.x, clue.y);

      // 1. Плата/табличка на стене
      const plate = new Graphics();
      this.drawPlate(plate, clue.isDiscovered);
      node.addChild(plate);

      // 2. Индикаторный светодиод вверху плашки
      const led = new Graphics();
      this.drawLed(led, clue.isDiscovered);
      node.addChild(led);

      // 3. Верхняя цифра (0..9)
      const digitText = new Text({
        text: String(clue.digit),
        style: this.digitStyle,
        resolution: 1,
        textureStyle: { scaleMode: 'nearest' }
      });
      digitText.anchor.set(0.5, 0.5);
      digitText.position.set(0, -7);
      node.addChild(digitText);

      // 4. Нижняя римская цифра (I, II, III, IV...)
      const romanText = new Text({
        text: clue.roman,
        style: this.romanStyle,
        resolution: 1,
        textureStyle: { scaleMode: 'nearest' }
      });
      romanText.anchor.set(0.5, 0.5);
      romanText.position.set(0, 10);
      node.addChild(romanText);

      this.container.addChild(node);

      this.nodes.set(clue.id, {
        clue,
        node,
        plate,
        digitText,
        romanText,
        led,
        scaleSpring: 1.0,
        time: Math.random() * 10
      });
    }
  }

  /**
   * Отрисовка подложки-платы под цифры
   */
  private drawPlate(g: Graphics, discovered: boolean): void {
    g.clear();
    // Фон платы (темный PCB текстолит)
    g.rect(-13, -20, 26, 40).fill({
      color: pal('pcb', 0),
      alpha: discovered ? 0.88 : 0.72
    });

    // Контурная рамка с фаской
    g.rect(-13, -20, 26, 40).stroke({
      width: 1,
      color: discovered ? pal('pcb', 6) : pal('pcb', 3),
      alpha: discovered ? 0.9 : 0.5
    });

    // Заклёпки по углам
    const rivetColor = pal('steel', 4);
    g.rect(-12, -19, 2, 2).fill(rivetColor);
    g.rect(10, -19, 2, 2).fill(rivetColor);
    g.rect(-12, 17, 2, 2).fill(rivetColor);
    g.rect(10, 17, 2, 2).fill(rivetColor);

    // Разделительная черта между арабской и римской цифрами
    g.rect(-8, 2, 16, 1).fill({
      color: discovered ? pal('pcb', 5) : pal('pcb', 2),
      alpha: 0.75
    });
  }

  /**
   * Отрисовка светодиода статуса вверху
   */
  private drawLed(g: Graphics, discovered: boolean): void {
    g.clear();
    const color = discovered ? 0x4ade80 : 0x615433; // зеленый при открытии / тускло-янтарный в покое
    g.rect(-2, -16, 4, 2).fill(color);
  }

  /**
   * Реакция на открытие цифры героем
   */
  public onClueDiscovered(clue: CipherClue): void {
    const entry = this.nodes.get(clue.id);
    if (!entry) return;

    entry.scaleSpring = 1.45; // импульс увеличения
    this.drawPlate(entry.plate, true);
    this.drawLed(entry.led, true);
    entry.digitText.style.fill = 0xffffff; // вспышка белым при обнаружении
  }

  /**
   * Обновление покадровой анимации (пульсация, затухание импульса)
   */
  public update(dt: number): void {
    for (const entry of this.nodes.values()) {
      entry.time += dt;

      // Пружинящее возвращение масштаба к 1
      if (entry.scaleSpring > 1.001) {
        entry.scaleSpring += (1.0 - entry.scaleSpring) * Math.min(1, dt * 10);
        entry.node.scale.set(entry.scaleSpring);
        if (entry.scaleSpring <= 1.05 && entry.clue.isDiscovered) {
          entry.digitText.style.fill = 0x8efee0; // постоянный цвет найденной цифры
        }
      } else {
        entry.node.scale.set(1.0);
      }

      // Легкое мерцание неонового свечения (фосфорный дисплей)
      const shimmer = 0.94 + 0.06 * Math.sin(entry.time * 3.5);
      entry.digitText.alpha = shimmer;
      entry.romanText.alpha = 0.9 + 0.1 * Math.sin(entry.time * 2.8 + 1.2);
    }
  }
}
