import { EventBus } from '../core/EventBus.ts';

import kill01Url from '../../assets/audio/sfx/kill_01.wav';
import kill02Url from '../../assets/audio/sfx/kill_02.wav';
import armorChangeUrl from '../../assets/audio/sfx/armor_change.wav';
import scrapPickupUrl from '../../assets/audio/sfx/scrap_pickup.wav';

export type SoundId = 'kill_01' | 'kill_02' | 'armor_change' | 'scrap_pickup';

interface SoundConfig {
  url: string;
  baseVolume: number;
  echoSend: number;
  reverbSend: number;
  pitchVariance?: number;
}

const SOUND_CONFIGS: Record<SoundId, SoundConfig> = {
  kill_01: {
    url: kill01Url,
    baseVolume: 0.75,
    echoSend: 0.40,
    reverbSend: 0.55,
    pitchVariance: 0.06
  },
  kill_02: {
    url: kill02Url,
    baseVolume: 0.48, // сбалансировано по RMS с kill_01
    echoSend: 0.40,
    reverbSend: 0.55,
    pitchVariance: 0.06
  },
  armor_change: {
    url: armorChangeUrl,
    baseVolume: 0.75,
    echoSend: 0.30,
    reverbSend: 0.45,
    pitchVariance: 0.03
  },
  scrap_pickup: {
    url: scrapPickupUrl,
    baseVolume: 0.85,
    echoSend: 0.28,
    reverbSend: 0.38,
    pitchVariance: 0.04
  }
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

  // Троттлинг и комбо подбора
  private lastScrapTime = 0;
  private scrapComboCount = 0;
  private lastArmorChangeTime = 0;

  private constructor() {
    this.setupAutoUnlock();
    this.setupEventListeners();
  }

  public static get(): SoundManager {
    if (!SoundManager.instance) {
      SoundManager.instance = new SoundManager();
    }
    return SoundManager.instance;
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

  private setupEventListeners(): void {
    const bus = EventBus.get();

    bus.on('armor:changed', () => {
      this.playArmorChange();
    });

    bus.on('enemy:killed', () => {
      this.playKill();
    });

    bus.on('loot:pickup', (data?: { type?: string }) => {
      if (!data || data.type === 'scrap') {
        this.playScrapPickup();
      }
    });
  }

  /**
   * Инициализация аудио-графа с цепочкой эхо и реверберации
   */
  public init(): void {
    if (this.initialized) return;
    this.ensureContext();
    this.preloadAll();
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
      masterGain.gain.value = 0.9;

      compressor.connect(masterGain);
      masterGain.connect(ctx.destination);

      this.compressor = compressor;
      this.masterGain = masterGain;

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
   * Предварительная загрузка всех звуковых файлов
   */
  public preloadAll(): void {
    const ids = Object.keys(SOUND_CONFIGS) as SoundId[];
    for (const id of ids) {
      this.loadSound(id).catch(() => {});
    }
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
  public async play(id: SoundId, options?: { volume?: number; pitch?: number; echoSend?: number; reverbSend?: number }): Promise<void> {
    if (!this.enabled) return;
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

    // 1. Dry путь
    if (this.compressor) {
      soundGain.connect(this.compressor);
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

  /**
   * Воспроизведение звука при убийстве:
   * Случайный выбор между эффектами kill_01 и kill_02
   */
  public playKill(): void {
    const choice: SoundId = Math.random() < 0.5 ? 'kill_01' : 'kill_02';
    this.play(choice);
  }

  /**
   * Воспроизведение звука при смене комплекта брони:
   * Защита от дребезга (debounce) при быстрых кликах в интерфейсе
   */
  public playArmorChange(): void {
    const now = performance.now();
    if (now - this.lastArmorChangeTime < 60) return;
    this.lastArmorChangeTime = now;
    this.play('armor_change');
  }

  /**
   * Воспроизведение звука при подборе материалов (мусора / scrap):
   * Динамическое повышение питча при цепочке сбора нескольких предметов подряд
   */
  public playScrapPickup(): void {
    const now = performance.now();
    // Минимальный интервал во избежание клиппинга при одновременном сборе
    if (now - this.lastScrapTime < 35) return;

    if (now - this.lastScrapTime < 450) {
      this.scrapComboCount = Math.min(8, this.scrapComboCount + 1);
    } else {
      this.scrapComboCount = 0;
    }
    this.lastScrapTime = now;

    // Питч плавно возрастает при серии подобранных предметов
    const comboPitch = 1.0 + this.scrapComboCount * 0.04;
    this.play('scrap_pickup', { pitch: comboPitch });
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
