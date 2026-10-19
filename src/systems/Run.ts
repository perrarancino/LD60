import runData from '../../data/roguelike/run.json';

/** Узел забега: одна комната боевого уровня или арена босса — конкретный уровень из data/levels. */
export interface RunNode {
  index: number; // сквозной номер узла (0..)
  stage: number; // номер уровня забега (0..5)
  room: number; // номер комнаты внутри уровня (у босса — 0)
  kind: 'room' | 'boss';
  levelId: string; // id уровня из data/levels
}

const KEY = 'ld60.run';

/**
 * Забег рогалика: 6 уровней = трижды «3 комнаты -> босс». Уровни идут строго по порядку из data/roguelike/run.json (без случайности) и правятся
 * в редакторе уровней. Номер узла хранится в localStorage: каждая комната — отдельная загрузка страницы. Умер или победил — restart() начинает сначала.
 */
export class Run {
  private static instance: Run;
  public static get(): Run {
    if (!Run.instance) Run.instance = new Run();
    return Run.instance;
  }

  public readonly nodes: RunNode[] = [];
  public node = 0;
  /** Забег только что создан (сохранения не было): хранилище брони начинается с нуля. */
  public fresh = false;

  private constructor() {
    for (const [stage, st] of runData.stages.entries()) {
      for (const [room, levelId] of st.levels.entries()) {
        this.nodes.push({ index: this.nodes.length, stage, room, kind: st.kind === 'boss' ? 'boss' : 'room', levelId });
      }
    }
    try {
      const d = JSON.parse(localStorage.getItem(KEY) ?? 'null');
      if (d && Number.isFinite(d.node)) {
        this.node = Math.max(0, Math.min(this.nodes.length - 1, d.node));
        return;
      }
    } catch { /* нет сохранения — новый забег */ }
    this.restart();
    this.fresh = true;
  }

  private save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify({ node: this.node }));
    } catch { /* без сохранения */ }
  }

  public get current(): RunNode {
    return this.nodes[this.node];
  }

  /** Следующий узел; null — текущий последний (финальный босс). */
  public get next(): RunNode | null {
    return this.nodes[this.node + 1] ?? null;
  }

  /** Перейти к следующему узлу; false — забег пройден. */
  public advance(): boolean {
    if (this.node + 1 >= this.nodes.length) return false;
    this.node++;
    this.save();
    return true;
  }

  /** Новый забег с первой комнаты. */
  public restart(): void {
    this.node = 0;
    this.save();
  }

  /** Отладка: перейти к узлу n. */
  public jump(n: number): void {
    this.node = Math.max(0, Math.min(this.nodes.length - 1, n));
    this.save();
  }
}
