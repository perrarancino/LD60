import { preloadAssets } from '../boot/preloadAssets.ts';
import { SoundManager } from '../audio/SoundManager.ts';
import { StartScreen } from './StartScreen.ts';
import { loadDamageFont } from '../effects/DamageNumbers.ts';

export interface PlayableGame {
  start(): Promise<void>;
}

const SESSION_KEY = 'ld60.boot.started';
const MIN_LOADING_MS = 900; // экран загрузки не должен мелькать, даже когда всё в кеше

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** Игра уже запускалась в этой вкладке: значит, перезагрузка комнаты, а не первый вход — меню не показываем. */
export function wasLaunchedThisSession(): boolean {
  try {
    return sessionStorage.getItem(SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

function markLaunched(): void {
  try {
    sessionStorage.setItem(SESSION_KEY, '1');
  } catch { /* приватный режим без sessionStorage — меню просто появится снова */ }
}

/**
 * Порядок запуска игры:
 * 1. Экран загрузки прогревает спрайты, звуки и шрифт (нужно для itch: без этого первый кадр ждёт сеть).
 * 2. На первом входе показывается меню с громкостью и СТАРТ; при перезагрузке комнаты — сразу игра.
 * 3. Игра создаётся под уже закрытым экраном (переход кубиков), поэтому стыка с чёрным кадром нет.
 */
export class BootFlow {
  private screen: StartScreen | null = null;
  private starting = false;

  constructor(private readonly createGame: () => PlayableGame, private readonly skipMenu: boolean) {}

  public async run(): Promise<void> {
    // Перезагрузка комнаты рогалика: полный прогрев не нужен (файлы уже в кеше браузера), а переход кубиков
    // сам закрывает экран. Так между комнатами нет ни лишней паузы на 152 спрайта, ни мелькания меню.
    if (this.skipMenu) {
      await this.startDirect();
      return;
    }

    const startedAt = performance.now();
    await loadDamageFont(); // пиксельный шрифт нужен самому экрану
    const screen = new StartScreen();
    this.screen = screen;

    try {
      await preloadAssets((progress) => screen.setProgress(progress.value, progress.label));
    } catch (err) {
      // Недостающие ассеты не должны запирать игрока на экране загрузки: игру догрузит уже SpriteLibrary
      console.warn('[Boot] часть ассетов не прогрелась:', err);
    }

    const left = MIN_LOADING_MS - (performance.now() - startedAt);
    if (left > 0) await wait(left);
    screen.setProgress(1, 'READY');
    await wait(260);

    screen.showMenu();
    SoundManager.get().startMusic(); // заиграет после первого жеста: AudioContext разблокируется штатным обработчиком
    screen.onStart(() => { void this.launch(); });
  }

  /** Прямой запуск (перезагрузка комнаты, редактор, отладочный адрес): без прогрева и без меню. */
  private async startDirect(): Promise<void> {
    markLaunched();
    SoundManager.get().startMusic();

    let game: PlayableGame;
    try {
      game = this.createGame();
    } catch (err) {
      console.error('[Boot] не удалось создать игру:', err);
      return;
    }

    try {
      await game.start();
    } catch (err) {
      console.error('[Boot] не удалось запустить игру:', err);
    }
  }

  private async launch(): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    markLaunched();

    const screen = this.screen;

    // Клик по СТАРТ — жест пользователя: если музыка ещё не включилась, включаем её сейчас
    SoundManager.get().startMusic();

    screen?.setLaunching();
    await wait(380); // гасим меню, под ним уже встают кубики перехода

    let game: PlayableGame;
    try {
      game = this.createGame();
    } catch (err) {
      console.error('[Boot] не удалось создать игру:', err);
      screen?.showError('Could not start the game. Reload the page (F5).');
      this.starting = false;
      return;
    }

    screen?.hide();

    try {
      await game.start();
      screen?.dispose();
      this.screen = null;
    } catch (err) {
      console.error('[Boot] не удалось запустить игру:', err);
      screen?.showError('Level failed to load. Reload the page (F5).');
      this.starting = false;
    }
  }
}
