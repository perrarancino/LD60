import runData from '../../data/roguelike/run.json';

/** Узел забега: комната боевого уровня или арена босса. */
export interface RunNode {
  index: number; // сквозной номер узла (0..)
  stage: number; // номер уровня забега (0..5)
  room: number; // номер комнаты внутри уровня (у босса — 0)
  kind: 'room' | 'boss';
  biome: string;
  bossLevel?: string; // id уровня-арены босса из data/levels
}

const KEY = 'ld60.run';

/**
 * Забег рогалика: 6 уровней = трижды «3 комнаты -> босс». Состояние (зерно и номер узла) хранится в localStorage: каждая комната — отдельная загрузка страницы,
 * и по зерну комната собирается одинаково. Умер или победил — restart() начинает новый забег с новым зерном.
 */
export class Run {
  private static instance: Run;
  public static get(): Run {
    if (!Run.instance) Run.instance = new Run();
    return Run.instance;
  }

  public readonly nodes: RunNode[] = [];
  public seed = 1;
  public node = 0;
  /** Забег только что создан (сохранения не было): хранилище брони начинается с нуля. */
  public fresh = false;

  private constructor() {
    for (const [stage, st] of runData.stages.entries()) {
      const count = st.kind === 'rooms' ? (st as { rooms?: number }).rooms ?? 3 : 1;
      for (let room = 0; room < count; room++) {
        this.nodes.push({ index: this.nodes.length, stage, room, kind: st.kind === 'boss' ? 'boss' : 'room', biome: st.biome, bossLevel: (st as { boss_level?: string }).boss_level });
      }
    }
    try {
      const d = JSON.parse(localStorage.getItem(KEY) ?? 'null');
      if (d && Number.isFinite(d.seed) && Number.isFinite(d.node)) {
        this.seed = d.seed;
        this.node = Math.max(0, Math.min(this.nodes.length - 1, d.node));
        return;
      }
    } catch { /* нет сохранения — новый забег */ }
    this.restart();
    this.fresh = true;
  }

  private save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify({ seed: this.seed, node: this.node }));
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

  /** Новый забег: новое зерно, с первой комнаты. */
  public restart(): void {
    this.seed = 1 + Math.floor(Math.random() * 1_000_000);
    this.node = 0;
    this.save();
  }

  /** Отладка: перейти к узлу n. */
  public jump(n: number): void {
    this.node = Math.max(0, Math.min(this.nodes.length - 1, n));
    this.save();
  }
}
