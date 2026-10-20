import { nextStationIndex, segmentDistance, type LineLayout } from "./layout.ts";
import type { Direction, Point } from "./types.ts";

export interface OperationConfig {
  /** 乗車直後、発車までの時間 [s] */
  boardingSec: number;
  /** 各駅の停車時間 [s] */
  dwellSec: number;
  /** 発車前に遅延が発生する確率 (0..1) */
  delayProbability: number;
  delayMinSec: number;
  delayMaxSec: number;
  /** 走行速度 [CSS px/s] */
  speedPxPerSec: number;
  minSegmentSec: number;
  maxSegmentSec: number;
}

/** 遅延時間の上限。設定値に関わらず、これ以上は待たせない */
export const MAX_DELAY_SEC = 60;

export type RidePhase = "dwelling" | "delayed" | "running";

export type RideEvent =
  | { type: "depart"; from: number; to: number }
  | { type: "arrive"; station: number }
  | { type: "delay"; seconds: number; reason: DelayReason };

export type DelayReason = "safety" | "late";

const easeInOut = (k: number) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);

/**
 * 1回の乗車（乗車〜下車）を表す状態機械。
 * 時刻は秒単位で外から与え、副作用（カーソル操作・音声）は持たない。
 */
export class RideSession {
  phase: RidePhase = "dwelling";
  /** 停車中の駅、または走行中の出発駅 */
  stationIndex: number;
  /** 走行中の到着駅 */
  targetIndex: number | null = null;
  direction: Direction;
  phaseStart: number;
  phaseEnd: number;
  delayReason: DelayReason | null = null;
  readonly layout: LineLayout;
  readonly config: OperationConfig;
  private readonly random: () => number;
  private segmentLength = 0;

  constructor(
    layout: LineLayout,
    stationIndex: number,
    direction: Direction,
    config: OperationConfig,
    now: number,
    random: () => number = Math.random,
  ) {
    this.layout = layout;
    this.config = config;
    this.random = random;
    this.stationIndex = stationIndex;
    this.direction = direction;
    this.phaseStart = now;
    this.phaseEnd = now + config.boardingSec;
  }

  /** 時刻を進め、発生したイベントを返す */
  update(now: number): RideEvent[] {
    const events: RideEvent[] = [];
    // フレーム落ちしても状態遷移を取りこぼさない（上限付き）
    for (let guard = 0; guard < 8 && now >= this.phaseEnd; guard++) {
      const t = this.phaseEnd;
      if (this.phase === "dwelling") {
        if (this.random() < this.config.delayProbability) {
          const seconds = this.delayDuration();
          this.delayReason = this.random() < 0.5 ? "safety" : "late";
          this.enter("delayed", t, seconds);
          events.push({ type: "delay", seconds, reason: this.delayReason });
        } else {
          events.push(...this.depart(t));
        }
      } else if (this.phase === "delayed") {
        this.delayReason = null;
        events.push(...this.depart(t));
      } else {
        this.stationIndex = this.targetIndex!;
        this.targetIndex = null;
        this.enter("dwelling", t, this.config.dwellSec);
        events.push({ type: "arrive", station: this.stationIndex });
      }
    }
    return events;
  }

  /** 停車中（＝下車可能）か */
  get atStation(): boolean {
    return this.phase !== "running";
  }

  /** 次に停車する駅 */
  get nextStation(): number | null {
    if (this.phase === "running") return this.targetIndex;
    return nextStationIndex(this.layout, this.stationIndex, this.direction);
  }

  remaining(now: number): number {
    return Math.max(0, this.phaseEnd - now);
  }

  /** 車両の位置と向き（ラジアン） */
  trainPose(now: number): { point: Point; angle: number } {
    const { path, stations } = this.layout;
    let s = stations[this.stationIndex].s;
    if (this.phase === "running") {
      const k = Math.min(1, Math.max(0, (now - this.phaseStart) / (this.phaseEnd - this.phaseStart)));
      s = path.closed
        ? s + this.direction * this.segmentLength * easeInOut(k)
        : s + Math.sign(stations[this.targetIndex!].s - s) * this.segmentLength * easeInOut(k);
    }
    const tan = path.tangentAt(s);
    const forward = this.travelSign();
    return { point: path.pointAt(s), angle: Math.atan2(tan.y * forward, tan.x * forward) };
  }

  private travelSign(): number {
    if (this.layout.path.closed) return this.direction;
    const next = this.nextStation;
    if (next === null) return this.direction;
    return Math.sign(this.layout.stations[next].s - this.layout.stations[this.stationIndex].s) || 1;
  }

  private depart(t: number): RideEvent[] {
    let next = nextStationIndex(this.layout, this.stationIndex, this.direction);
    if (next === null) {
      // 開路線の終端では折り返す
      this.direction = (-this.direction) as Direction;
      next = nextStationIndex(this.layout, this.stationIndex, this.direction);
      if (next === null) return [];
    }
    this.segmentLength = segmentDistance(this.layout, this.stationIndex, next, this.direction);
    const { speedPxPerSec, minSegmentSec, maxSegmentSec } = this.config;
    const duration = Math.min(maxSegmentSec, Math.max(minSegmentSec, this.segmentLength / speedPxPerSec));
    this.targetIndex = next;
    this.enter("running", t, duration);
    return [{ type: "depart", from: this.stationIndex, to: next }];
  }

  private delayDuration(): number {
    const lo = Math.max(0, Math.min(this.config.delayMinSec, MAX_DELAY_SEC));
    const hi = Math.max(lo, Math.min(this.config.delayMaxSec, MAX_DELAY_SEC));
    return lo + (hi - lo) * this.random();
  }

  private enter(phase: RidePhase, start: number, duration: number) {
    this.phase = phase;
    this.phaseStart = start;
    this.phaseEnd = start + Math.max(0.05, duration);
  }
}
