import { EventBus } from '../core/EventBus.ts';

export interface AgingState {
  timeRemaining: number;
  totalTime: number;
  isPaused: boolean;
  isWarning: boolean;
  isCritical: boolean;
  isExpired: boolean;
}

export class AgingSystem {
  private totalTime: number;
  private timeRemaining: number;
  private isPaused: boolean = false;
  private warningThreshold: number;
  private criticalThreshold: number;

  private warningTriggered = false;
  private criticalTriggered = false;
  private expiredTriggered = false;

  constructor(totalTimeSeconds = 300, warningThreshold = 60, criticalThreshold = 30) {
    this.totalTime = totalTimeSeconds;
    this.timeRemaining = totalTimeSeconds;
    this.warningThreshold = warningThreshold;
    this.criticalThreshold = criticalThreshold;
  }

  public update(deltaTimeSeconds: number): void {
    if (this.isPaused || this.expiredTriggered) return;

    this.timeRemaining = Math.max(0, this.timeRemaining - deltaTimeSeconds);

    if (this.timeRemaining <= this.warningThreshold && !this.warningTriggered) {
      this.warningTriggered = true;
      EventBus.get().emit('aging:warning', { timeRemaining: this.timeRemaining });
    }

    if (this.timeRemaining <= this.criticalThreshold && !this.criticalTriggered) {
      this.criticalTriggered = true;
      EventBus.get().emit('aging:critical', { timeRemaining: this.timeRemaining });
    }

    if (this.timeRemaining <= 0 && !this.expiredTriggered) {
      this.expiredTriggered = true;
      EventBus.get().emit('aging:expired');
    }

    EventBus.get().emit('aging:tick', this.getState());
  }

  public reset(newTotalTime?: number): void {
    if (newTotalTime) this.totalTime = newTotalTime;
    this.timeRemaining = this.totalTime;
    this.warningTriggered = false;
    this.criticalTriggered = false;
    this.expiredTriggered = false;
    EventBus.get().emit('aging:reset', this.getState());
  }

  public setPaused(paused: boolean): void {
    this.isPaused = paused;
  }

  public addTime(seconds: number): void {
    this.timeRemaining = Math.min(this.totalTime, this.timeRemaining + seconds);
  }

  public getState(): AgingState {
    return {
      timeRemaining: this.timeRemaining,
      totalTime: this.totalTime,
      isPaused: this.isPaused,
      isWarning: this.timeRemaining <= this.warningThreshold,
      isCritical: this.timeRemaining <= this.criticalThreshold,
      isExpired: this.timeRemaining <= 0
    };
  }
}
