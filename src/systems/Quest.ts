/**
 * Квестовое состояние героя: предметы (батарейка), флаги (подставка включена), что уже подобрано на уровнях.
 * Живёт только в одном «прохождении»: каждый запуск игры и перезагрузка страницы начинают с чистого листа (карта восстанавливается целиком —
 * батарейки лежат на местах, подставки пусты). Состояние переносится лишь через дверь на другой уровень (carryOver перед переходом):
 * страница перезагружается, и герой приносит с собой предметы и флаги.
 */
export class Quest {
  private static instance: Quest;
  public static get(): Quest {
    if (!Quest.instance) Quest.instance = new Quest();
    return Quest.instance;
  }

  private static readonly KEY = 'ld60.quest';
  private static readonly CARRY = 'ld60.quest.carry';

  private readonly items = new Map<string, number>();
  private readonly flags = new Set<string>();
  private readonly taken = new Set<string>();

  private constructor() {
    try {
      const carried = sessionStorage.getItem(Quest.CARRY) === '1';
      sessionStorage.removeItem(Quest.CARRY); // перенос действует на одну загрузку
      const saved = carried ? sessionStorage.getItem(Quest.KEY) : null;
      sessionStorage.removeItem(Quest.KEY); // не перенесли — забываем всё прежнее
      const d = JSON.parse(saved ?? 'null');
      if (!d) return;
      for (const [id, n] of Object.entries(d.items ?? {})) if (Number(n) > 0) this.items.set(id, Number(n));
      for (const f of d.flags ?? []) this.flags.add(String(f));
      for (const t of d.taken ?? []) this.taken.add(String(t));
    } catch { /* хранилище недоступно — чистый лист */ }
  }

  private save(): void {
    try {
      sessionStorage.setItem(Quest.KEY, JSON.stringify({ items: Object.fromEntries(this.items), flags: [...this.flags], taken: [...this.taken] }));
    } catch { /* без сохранения */ }
  }

  /** Вызывать перед уходом через дверь на другой уровень: следующая загрузка страницы продолжит с этим состоянием. */
  public carryOver(): void {
    this.save();
    try {
      sessionStorage.setItem(Quest.CARRY, '1');
    } catch { /* без переноса */ }
  }

  public count(item: string): number {
    return this.items.get(item) ?? 0;
  }

  public has(item: string): boolean {
    return this.count(item) > 0;
  }

  public add(item: string, n = 1): void {
    this.items.set(item, this.count(item) + n);
    this.save();
  }

  /** Забирает один предмет; false — предмета нет. */
  public take(item: string): boolean {
    const n = this.count(item);
    if (n <= 0) return false;
    if (n === 1) this.items.delete(item);
    else this.items.set(item, n - 1);
    this.save();
    return true;
  }

  public flag(name: string): boolean {
    return this.flags.has(name);
  }

  public setFlag(name: string): void {
    if (this.flags.has(name)) return;
    this.flags.add(name);
    this.save();
  }

  /** Объект уровня уже подобран (предмет не появляется снова). */
  public wasTaken(levelId: string, objectId: string): boolean {
    return this.taken.has(`${levelId}:${objectId}`);
  }

  public markTaken(levelId: string, objectId: string): void {
    this.taken.add(`${levelId}:${objectId}`);
    this.save();
  }

  /** Новая игра: всё забыть. */
  public reset(): void {
    this.items.clear();
    this.flags.clear();
    this.taken.clear();
    this.save();
  }

  /** Сводка для интерфейса: id предмета -> сколько. */
  public inventory(): [string, number][] {
    return [...this.items];
  }
}
