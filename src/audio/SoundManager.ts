import personDamageUrl from '../../assets/audio/sfx/person_damage.mp3';
import loseUrl from '../../assets/audio/sfx/lose.mp3';
import crabAttackUrl from '../../assets/audio/sfx/crab_attack.mp3';
import otherBossesAttackUrl from '../../assets/audio/sfx/other_bosses_attack.mp3';
import chirpUrl from '../../assets/audio/sfx/chirp.mp3';
import ratUrl from '../../assets/audio/sfx/rat.mp3';
import wardUrl from '../../assets/audio/sfx/ward_tesla.mp3';
import wormUrl from '../../assets/audio/sfx/worm.mp3';
import motherSpiderUrl from '../../assets/audio/sfx/mother_spider.mp3';
import miniSpiderUrl from '../../assets/audio/sfx/mini_spider.mp3';
import gearThrowUrl from '../../assets/audio/sfx/gear_throw.mp3';
import winUrl from '../../assets/audio/sfx/win.mp3';
import zapHandUrl from '../../assets/audio/sfx/zap_hand_attack.mp3';
import upgradeUrl from '../../assets/audio/sfx/upgrade.mp3';
import idleMusicUrl from '../../assets/audio/music/idle.mp3';
import bossMusicUrl from '../../assets/audio/music/boss.mp3';

export type SoundId =
  | 'person_damage' | 'lose' | 'crab_attack' | 'other_bosses_attack' | 'chirp' | 'rat' | 'ward' | 'worm'
  | 'mother_spider' | 'mini_spider' | 'gear_throw' | 'win' | 'zap_hand_attack' | 'upgrade';

/** Громкость эффектов по умолчанию — 30% (как просили для стартового меню). */
export const DEFAULT_SFX_VOLUME = 0.3;
/** Музыка по умолчанию тише эффектов: она фоновая. */
export const DEFAULT_MUSIC_VOLUME = 0.35;

const SFX_VOLUME_KEY = 'ld60.audio.sfx';
const MUSIC_VOLUME_KEY = 'ld60.audio.music';

/** URL эффектов: используются и для загрузки в игре, и для прогрева кеша экраном загрузки. */
export const SFX_URLS: Record<SoundId, string> = {
  person_damage: personDamageUrl,
  lose: loseUrl,
  crab_attack: crabAttackUrl,
  other_bosses_attack: otherBossesAttackUrl,
  chirp: chirpUrl,
  rat: ratUrl,
  ward: wardUrl,
  worm: wormUrl,
  mother_spider: motherSpiderUrl,
  mini_spider: miniSpiderUrl,
  gear_throw: gearThrowUrl,
  win: winUrl,
  zap_hand_attack: zapHandUrl,
  upgrade: upgradeUrl
};

export type MusicId = 'idle' | 'boss';
const MUSIC_URLS: Record<MusicId, string> = { idle: idleMusicUrl, boss: bossMusicUrl };

// Музыка боссов: трек 3:18; бой крутится на отрезке 1:20 — 2:50, концовка играется, когда босс почти побеждён.
const BOSS_LOOP_START = 80; // с: куда прыгаем (1:20)
const BOSS_LOOP_END = 170; // с: где отрезок кончается (2:50)
const BOSS_LOW_HP = 0.4; // здоровья мало: на 2:50 не зацикливаем, доигрываем трек до конца
const BOSS_VERY_LOW_HP = 0.15; // совсем мало: не ждём 2:50, прыгаем туда на ближайшем такте (кратном 4 с)
const BEAT_GRID = 4; // с: сетка тактов трека
const MUSIC_KEY = 'ld60.music.resume';

interface SoundConfig {
  url: string;
  baseVolume: number;
  echoSend: number;
  reverbSend: number;
  pitchVariance?: number;
  minGap: number; // с: чаще этого один и тот же звук не запускается (троттлинг)
}

const cfg = (id: SoundId, baseVolume: number, minGap: number, pitchVariance = 0.05, echoSend = 0.18, reverbSend = 0.3): SoundConfig =>
  ({ url: SFX_URLS[id], baseVolume, minGap, pitchVariance, echoSend, reverbSend });

const SOUND_CONFIGS: Record<SoundId, SoundConfig> = {
  person_damage: cfg('person_damage', 0.9, 0.12, 0.04),
  lose: cfg('lose', 1.0, 1, 0, 0.3, 0.45),
  crab_attack: cfg('crab_attack', 1.0, 0.3, 0.04, 0.3, 0.45),
  other_bosses_attack: cfg('other_bosses_attack', 0.95, 0.3, 0.05, 0.25, 0.4),
  chirp: cfg('chirp', 0.8, 0.12, 0.1),
  rat: cfg('rat', 0.85, 0.15, 0.08),
  ward: cfg('ward', 0.8, 0.2, 0.05),
  worm: cfg('worm', 0.85, 0.2, 0.08),
  mother_spider: cfg('mother_spider', 0.9, 0.25, 0.05),
  mini_spider: cfg('mini_spider', 0.7, 0.07, 0.12),
  gear_throw: cfg('gear_throw', 0.8, 0.12, 0.05),
  win: cfg('win', 1.0, 1, 0, 0.3, 0.45),
  zap_hand_attack: cfg('zap_hand_attack', 0.8, 0.12, 0.06),
  upgrade: cfg('upgrade', 1.0, 0.3, 0, 0.3, 0.4)
};

/**
 * Аудиосистема игры: загрузка и воспроизведение звуковых эффектов через Web Audio API.
 * Включает пространственную обработку:
 * - Эхо (DelayNode с обратной связью и низкочастотным фильтром для тёплых отражений);
 * - Атмосферный реверб (ConvolverNode с процедурным импульсом промышленного зала/пещеры);
 * - Мастер-компрессор для предотвращения перегрузок при наложении звуков.
 */
export class SoundManager {
  private static instance: SoundManager;

  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private sfxGain: GainNode | null = null;
  private musicGain: GainNode | null = null;

  private sfxVolume = DEFAULT_SFX_VOLUME;
  private musicVolume = DEFAULT_MUSIC_VOLUME;
  private musicBuffers = new Map<MusicId, AudioBuffer>();
  private music: { id: MusicId; source: AudioBufferSourceNode; startCtx: number; startPos: number; buffer: AudioBuffer } | null = null;
  private musicToken = 0; // каждый новый запуск музыки отменяет незавершённую загрузку предыдущего
  private lastMusicSave = 0;

  // Шина эхо (Delay)
  public echoSendNode: GainNode | null = null;
  public delayNode: DelayNode | null = null;
  public echoFeedbackNode: GainNode | null = null;
  public echoFilterNode: BiquadFilterNode | null = null;
  public echoReturnNode: GainNode | null = null;

  // Шина реверберации (Reverb)
  public reverbSendNode: GainNode | null = null;
  public convolverNode: ConvolverNode | null = null;
  public reverbFilterNode: BiquadFilterNode | null = null;
  public reverbReturnNode: GainNode | null = null;

  private buffers: Map<SoundId, AudioBuffer> = new Map();
  private loadingPromises: Map<SoundId, Promise<AudioBuffer | null>> = new Map();
  private initialized = false;
  private enabled = true;

  // Троттлинг одинаковых звуков и положение героя (для громкости и панорамы звуков мобов)
  private readonly lastPlayed = new Map<SoundId, number>();
  private listenerX = 0;
  private listenerY = 0;

  private constructor() {
    this.loadVolumeSettings();
    this.setupAutoUnlock();
  }

  public static get(): SoundManager {
    if (!SoundManager.instance) {
      SoundManager.instance = new SoundManager();
    }
    return SoundManager.instance;
  }

  private loadVolumeSettings(): void {
    this.sfxVolume = this.readStoredVolume(SFX_VOLUME_KEY, DEFAULT_SFX_VOLUME);
    this.musicVolume = this.readStoredVolume(MUSIC_VOLUME_KEY, DEFAULT_MUSIC_VOLUME);
  }

  private readStoredVolume(key: string, fallback: number): number {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) {
        const value = Number(raw);
        if (Number.isFinite(value)) return Math.max(0, Math.min(1, value));
      }
    } catch { /* localStorage недоступен — остаётся значение по умолчанию */ }
    return fallback;
  }

  private saveVolume(key: string, value: number): void {
    try {
      localStorage.setItem(key, String(value));
    } catch { /* без сохранения */ }
  }

  /**
   * Разблокировка AudioContext по первому взаимодействию с документом
   */
  private setupAutoUnlock(): void {
    const unlock = () => {
      this.ensureContext();
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('touchstart', unlock);
    };

    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock, { passive: true });
    window.addEventListener('touchstart', unlock, { passive: true });
  }

  /**
   * Инициализация аудио-графа с цепочкой эхо и реверберации
   */
  public init(): void {
    if (this.initialized) return;
    this.ensureContext();
    void this.preloadAll();
    this.initialized = true;
  }

  private ensureContext(): AudioContext | null {
    if (!this.ctx) {
      const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) return null;

      const ctx = new AudioContextClass();
      this.ctx = ctx;

      // 1. Мастер-компрессор и мастер-громкость
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -12;
      compressor.knee.value = 8;
      compressor.ratio.value = 4;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.15;

      const masterGain = ctx.createGain();
      masterGain.gain.value = 1.0;

      // Раздельные шины: эффекты и музыка регулируются независимо
      const sfxGain = ctx.createGain();
      sfxGain.gain.value = this.sfxVolume;

      const musicGain = ctx.createGain();
      musicGain.gain.value = this.musicVolume;

      compressor.connect(sfxGain);
      sfxGain.connect(masterGain);
      musicGain.connect(masterGain);
      masterGain.connect(ctx.destination);

      this.compressor = compressor;
      this.masterGain = masterGain;
      this.sfxGain = sfxGain;
      this.musicGain = musicGain;

      // 2. Цепочка ЭХО (Delay)
      const echoSend = ctx.createGain();
      echoSend.gain.value = 1.0;

      const delay = ctx.createDelay(1.0);
      delay.delayTime.value = 0.21; // ~210 мс задержка

      const echoFeedback = ctx.createGain();
      echoFeedback.gain.value = 0.33; // 33% обратная связь для затухающих повторов

      const echoFilter = ctx.createBiquadFilter();
      echoFilter.type = 'lowpass';
      echoFilter.frequency.value = 2200; // Тёплый затухающий хвост эха

      const echoReturn = ctx.createGain();
      echoReturn.gain.value = 0.65;

      // echoSend -> delay -> echoFilter -> echoReturn -> compressor
      //                     |          ^
      //                     +-> feedback ->+
      echoSend.connect(delay);
      delay.connect(echoFilter);
      echoFilter.connect(echoFeedback);
      echoFeedback.connect(delay);

      echoFilter.connect(echoReturn);
      echoReturn.connect(compressor);

      this.echoSendNode = echoSend;
      this.delayNode = delay;
      this.echoFeedbackNode = echoFeedback;
      this.echoFilterNode = echoFilter;
      this.echoReturnNode = echoReturn;

      // 3. Цепочка РЕВЕРБЕРАЦИИ (Reverb)
      const reverbSend = ctx.createGain();
      reverbSend.gain.value = 1.0;

      const convolver = ctx.createConvolver();
      convolver.buffer = this.buildReverbImpulse(ctx, 1.9, 2.6);

      const reverbFilter = ctx.createBiquadFilter();
      reverbFilter.type = 'lowpass';
      reverbFilter.frequency.value = 4200;

      const reverbReturn = ctx.createGain();
      reverbReturn.gain.value = 0.75;

      reverbSend.connect(convolver);
      convolver.connect(reverbFilter);
      reverbFilter.connect(reverbReturn);
      reverbReturn.connect(compressor);

      this.reverbSendNode = reverbSend;
      this.convolverNode = convolver;
      this.reverbFilterNode = reverbFilter;
      this.reverbReturnNode = reverbReturn;
    }

    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }

    return this.ctx;
  }

  /**
   * Генерация процедурного стерео-импульса реверберации
   * Создаёт объёмное акустическое пространство полузаброшенной фабрики / подземелья
   */
  private buildReverbImpulse(ctx: AudioContext, duration: number, decay: number): AudioBuffer {
    const rate = ctx.sampleRate;
    const length = Math.floor(rate * duration);
    const buffer = ctx.createBuffer(2, length, rate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);

    let lastL = 0;
    let lastR = 0;

    for (let i = 0; i < length; i++) {
      const t = i / length;
      // Экспоненциальное затухание
      const envelope = Math.pow(1 - t, decay);

      // Лёгкое сглаживание шума для естественной диффузии отражений
      const rawL = (Math.random() * 2 - 1);
      const rawR = (Math.random() * 2 - 1);

      lastL = lastL * 0.25 + rawL * 0.75;
      lastR = lastR * 0.25 + rawR * 0.75;

      left[i] = lastL * envelope;
      right[i] = lastR * envelope;
    }

    return buffer;
  }

  /**
   * Предварительная загрузка всех звуковых файлов. onProgress — для полосы загрузки на входе.
   */
  public async preloadAll(onProgress?: (loaded: number, total: number) => void): Promise<void> {
    const ids = Object.keys(SOUND_CONFIGS) as SoundId[];
    let loaded = 0;
    await Promise.all(ids.map(async (id) => {
      await this.loadSound(id);
      loaded++;
      onProgress?.(loaded, ids.length);
    }));
  }

  private async loadSound(id: SoundId): Promise<AudioBuffer | null> {
    if (this.buffers.has(id)) {
      return this.buffers.get(id)!;
    }

    if (this.loadingPromises.has(id)) {
      return this.loadingPromises.get(id)!;
    }

    const config = SOUND_CONFIGS[id];
    const promise = (async () => {
      try {
        const ctx = this.ensureContext();
        if (!ctx) return null;

        const res = await fetch(config.url);
        if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${config.url}`);
        const arrayBuf = await res.arrayBuffer();
        const audioBuf = await ctx.decodeAudioData(arrayBuf);
        this.buffers.set(id, audioBuf);
        return audioBuf;
      } catch (err) {
        console.warn(`[SoundManager] Не удалось загрузить звук ${id}:`, err);
        return null;
      } finally {
        this.loadingPromises.delete(id);
      }
    })();

    this.loadingPromises.set(id, promise);
    return promise;
  }

  /**
   * Базовое воспроизведение звука с раздельной маршрутизацией:
   * Dry (прямой сигнал) + посыл на Echo + посыл на Reverb
   */
  public async play(id: SoundId, options?: { volume?: number; pitch?: number; echoSend?: number; reverbSend?: number; pan?: number }): Promise<void> {
    if (!this.enabled) return;
    const nowT = performance.now() / 1000;
    if (nowT - (this.lastPlayed.get(id) ?? -9) < SOUND_CONFIGS[id].minGap) return;
    this.lastPlayed.set(id, nowT);
    const ctx = this.ensureContext();
    if (!ctx) return;

    let buffer = this.buffers.get(id);
    if (!buffer) {
      buffer = (await this.loadSound(id)) ?? undefined;
      if (!buffer) return;
    }

    const cfg = SOUND_CONFIGS[id];
    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Питч и случайная вариация
    let pitch = options?.pitch ?? 1.0;
    if (cfg.pitchVariance) {
      pitch += (Math.random() * 2 - 1) * cfg.pitchVariance;
    }
    source.playbackRate.value = Math.max(0.1, pitch);

    // Локальный гейн звука
    const soundGain = ctx.createGain();
    const vol = (options?.volume ?? cfg.baseVolume);
    soundGain.gain.value = vol;

    source.connect(soundGain);

    // 1. Dry путь (с панорамой, если звук идёт из точки мира)
    if (this.compressor) {
      if (options?.pan !== undefined && ctx.createStereoPanner) {
        const panner = ctx.createStereoPanner();
        panner.pan.value = Math.max(-1, Math.min(1, options.pan));
        soundGain.connect(panner);
        panner.connect(this.compressor);
      } else {
        soundGain.connect(this.compressor);
      }
    }

    // 2. Echo посыл
    if (this.echoSendNode) {
      const echoSendGain = ctx.createGain();
      const sendVal = options?.echoSend !== undefined ? options.echoSend : cfg.echoSend;
      echoSendGain.gain.value = sendVal;
      soundGain.connect(echoSendGain);
      echoSendGain.connect(this.echoSendNode);
    }

    // 3. Reverb посыл
    if (this.reverbSendNode) {
      const reverbSendGain = ctx.createGain();
      const sendVal = options?.reverbSend !== undefined ? options.reverbSend : cfg.reverbSend;
      reverbSendGain.gain.value = sendVal;
      soundGain.connect(reverbSendGain);
      reverbSendGain.connect(this.reverbSendNode);
    }

    source.start(0);
  }

  /** Положение героя (мир, px): от него считаются громкость и панорама звуков мобов. */
  public setListener(x: number, y: number): void {
    this.listenerX = x;
    this.listenerY = y;
  }

  /**
   * Звук из точки мира: чем дальше от героя, тем тише (полная громкость ближе 120 px, тишина дальше 640 px), слева и справа — в своём ухе.
   */
  public playAt(id: SoundId, x: number, y: number, options?: { volume?: number; pitch?: number }): void {
    const dist = Math.hypot(x - this.listenerX, y - this.listenerY);
    const k = Math.max(0, Math.min(1, 1 - (dist - 120) / 520));
    if (k < 0.04) return;
    const vol = (options?.volume ?? SOUND_CONFIGS[id].baseVolume) * k * k;
    void this.play(id, { volume: vol, pitch: options?.pitch, pan: Math.max(-0.85, Math.min(0.85, (x - this.listenerX) / 420)) });
  }

  /** Громкость эффектов (0..1), по умолчанию 30%. Значение переживает перезагрузку страницы. */
  public setSfxVolume(value: number): void {
    this.sfxVolume = Math.max(0, Math.min(1, value));
    if (this.sfxGain) this.sfxGain.gain.value = this.sfxVolume;
    this.saveVolume(SFX_VOLUME_KEY, this.sfxVolume);
  }

  public getSfxVolume(): number {
    return this.sfxVolume;
  }

  /** Громкость музыки (0..1): плавно применяется и к файловому треку, и к процедурному эмбиенту. */
  public setMusicVolume(value: number): void {
    this.musicVolume = Math.max(0, Math.min(1, value));
    if (this.musicGain) this.musicGain.gain.value = this.musicVolume;
    this.saveVolume(MUSIC_VOLUME_KEY, this.musicVolume);
  }

  public getMusicVolume(): number {
    return this.musicVolume;
  }

  private async loadMusic(id: MusicId): Promise<AudioBuffer | null> {
    const cached = this.musicBuffers.get(id);
    if (cached) return cached;
    try {
      const ctx = this.ensureContext();
      if (!ctx) return null;
      const res = await fetch(MUSIC_URLS[id]);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = await ctx.decodeAudioData(await res.arrayBuffer());
      this.musicBuffers.set(id, buffer);
      return buffer;
    } catch (err) {
      console.warn(`[SoundManager] music ${id} failed to load:`, err);
      return null;
    }
  }

  /** Позиция играющего трека, с. */
  private musicPos(): number {
    const m = this.music;
    if (!m || !this.ctx) return 0;
    return m.startPos + (this.ctx.currentTime - m.startCtx);
  }

  /** Запускает источник трека: с позиции pos в момент when (контекстное время); возвращает запись о нём. */
  private startSource(id: MusicId, buffer: AudioBuffer, pos: number, when: number, loop: boolean): NonNullable<SoundManager['music']> {
    const ctx = this.ctx!;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;
    source.connect(this.musicGain!);
    source.start(when, Math.max(0, Math.min(buffer.duration - 0.01, pos)));
    const rec = { id, source, startCtx: when, startPos: pos, buffer };
    source.onended = () => {
      // трек доиграл до конца сам (не по нашей остановке): у босса — снова с начала петли, у остальных — сначала
      if (this.music !== rec || loop) return;
      this.music = null;
      if (id === 'boss') void this.playMusic('boss', { from: BOSS_LOOP_START });
    };
    return rec;
  }

  /**
   * Музыка: idle — на меню, в комнатах и на экранах между ними (зациклена; после перезагрузки комнаты продолжается с того же места),
   * boss — на боссах (петля и концовка по здоровью босса, см. updateBossMusic). Тот же трек уже играет — ничего не делаем.
   */
  public async playMusic(id: MusicId, options?: { from?: number }): Promise<void> {
    if (this.music?.id === id && options?.from === undefined) return;
    const token = ++this.musicToken;
    const ctx = this.ensureContext();
    if (!ctx || !this.musicGain) return;
    const buffer = await this.loadMusic(id);
    if (!buffer || token !== this.musicToken) return;
    this.stopMusic(true);

    let pos = options?.from ?? 0;
    if (id === 'idle' && options?.from === undefined) {
      // продолжаем с места, где музыка была до перезагрузки страницы
      try {
        const saved = JSON.parse(sessionStorage.getItem(MUSIC_KEY) ?? 'null') as { id: MusicId; pos: number; ts: number } | null;
        if (saved && saved.id === 'idle' && Date.now() - saved.ts < 20000) pos = (saved.pos + (Date.now() - saved.ts) / 1000) % buffer.duration;
      } catch { /* нет сохранения */ }
    }
    this.musicGain.gain.cancelScheduledValues(ctx.currentTime);
    this.musicGain.gain.value = this.musicVolume;
    this.music = this.startSource(id, buffer, pos, ctx.currentTime, id === 'idle');
  }

  /** Совместимость со старым кодом экрана загрузки: стартовая музыка — idle. */
  public startMusic(): void {
    void this.playMusic('idle');
  }

  /** Остановка музыки; fadeSec > 0 — плавно затихает. */
  public stopMusic(immediate = false, fadeSec = 1.2): void {
    const m = this.music;
    this.music = null;
    this.musicToken++;
    if (!m || !this.ctx) return;
    if (immediate || fadeSec <= 0 || !this.musicGain) {
      try { m.source.stop(); } catch { /* уже остановлен */ }
      return;
    }
    const g = this.musicGain.gain;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, t + fadeSec);
    try { m.source.stop(t + fadeSec + 0.05); } catch { /* уже остановлен */ }
  }

  /**
   * Правило петли музыки босса. hp — здоровье босса 0..1 (null — боя нет). Вызывается каждый кадр.
   *  1) здоровья ещё много: в 2:50 трек прыгает обратно на 1:20 (сэмпл-точно, источник встаёт ровно в момент конца отрезка);
   *  2) здоровья мало: на 2:50 не зацикливаем — доигрываем до конца (а дойдёт до конца и босс жив — снова с 1:20);
   *  3) здоровья совсем мало, а трек ещё не дошёл до 2:50: не ждём — на ближайшем такте, кратном 4 с, прыгаем сразу на 2:50 (концовка).
   * Сохраняет и позицию idle-музыки для продолжения после перезагрузки страницы.
   */
  public updateMusic(hp: number | null): void {
    const ctx = this.ctx;
    const m = this.music;
    if (!ctx || !m) return;
    const now = performance.now();
    if (m.id === 'idle' && now - this.lastMusicSave > 1500) {
      this.lastMusicSave = now;
      try {
        sessionStorage.setItem(MUSIC_KEY, JSON.stringify({ id: 'idle', pos: this.musicPos() % m.buffer.duration, ts: Date.now() }));
      } catch { /* без сохранения */ }
    }
    if (m.id !== 'boss' || hp === null) return;

    const pos = this.musicPos();
    const endPos = BOSS_LOOP_END;
    const timeToEnd = endPos - pos;
    if (hp > BOSS_LOW_HP) {
      // петля: за полсекунды до конца отрезка планируем переход
      if (pos >= BOSS_LOOP_START && timeToEnd > 0 && timeToEnd < 0.5) this.jumpMusic(m, ctx.currentTime + timeToEnd, BOSS_LOOP_START);
      else if (pos > endPos + 0.05) this.jumpMusic(m, ctx.currentTime + 0.02, BOSS_LOOP_START); // прозевали момент (вкладка спала)
    } else if (hp <= BOSS_VERY_LOW_HP && pos < endPos - BEAT_GRID) {
      // на ближайшем такте (кратном 4 с) — на концовку
      const next = Math.ceil(pos / BEAT_GRID) * BEAT_GRID;
      if (next < endPos && next - pos < 0.5) this.jumpMusic(m, ctx.currentTime + (next - pos), endPos);
    }
  }

  /** Сэмпл-точный переход: текущий источник замолкает в момент when, новый встаёт с позиции pos в тот же момент. */
  private jumpMusic(from: NonNullable<SoundManager['music']>, when: number, pos: number): void {
    if (this.music !== from || !this.ctx) return;
    try { from.source.stop(when); } catch { /* уже остановлен */ }
    this.music = this.startSource(from.id, from.buffer, pos, when, false);
  }

  public setMasterVolume(value: number): void {
    if (this.masterGain) {
      this.masterGain.gain.value = Math.max(0, Math.min(2, value));
    }
  }

  public setEnabled(val: boolean): void {
    this.enabled = val;
  }
}
