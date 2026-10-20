// Rust 側（OS 依存処理）とのブリッジ。
// ブラウザ単体（vite dev）でもレイアウト確認ができるよう簡易的な代替実装を持つ。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Point } from "./domain/types.ts";

export interface Settings {
  hotkey: string;
  boardingSec: number;
  dwellSec: number;
  delayProbability: number;
  delayMinSec: number;
  delayMaxSec: number;
  speedPxPerSec: number;
  minSegmentSec: number;
  maxSegmentSec: number;
  volume: number;
  speechFallback: boolean;
}

export interface Progress {
  totalRides: number;
  unlockedLines: string[];
}

export const isTauri = "__TAURI_INTERNALS__" in window;

const browserProgress: Progress = { totalRides: 0, unlockedLines: ["yamanote"] };
const browserSettings: Settings = {
  hotkey: "Ctrl+Alt+M",
  boardingSec: 1.5,
  dwellSec: 1,
  delayProbability: 0.15,
  delayMinSec: 4,
  delayMaxSec: 10,
  speedPxPerSec: 100,
  minSegmentSec: 6,
  maxSegmentSec: 21,
  volume: 0.9,
  speechFallback: true,
};

export async function bootstrap(): Promise<{ settings: Settings; progress: Progress }> {
  if (!isTauri) return { settings: browserSettings, progress: browserProgress };
  return invoke("get_bootstrap");
}

export async function hideOverlay(): Promise<void> {
  if (isTauri) await invoke("hide_overlay");
}

export async function setIgnoreCursor(ignore: boolean): Promise<void> {
  if (isTauri) await invoke("set_ignore_cursor", { ignore });
}

/** 実際の OS カーソルを移動する（座標はウィンドウ内の CSS px）。走行中のハートビートも兼ねる */
export async function setCursor(p: Point): Promise<void> {
  if (isTauri) await invoke("set_cursor", { x: p.x, y: p.y });
}

/** 物理マウス入力によるカーソル移動を禁止／許可する */
export async function lockCursor(locked: boolean): Promise<void> {
  if (isTauri) await invoke("lock_cursor", { locked });
}

/** 乗車中かどうかを通知する。乗車中は Esc キーで緊急停車できる */
export async function setRiding(riding: boolean): Promise<void> {
  if (isTauri) await invoke("set_riding", { riding });
}

/** 緊急停車の確認ダイアログを表示したことを通知する（未通知のままだと Rust 側が確認なしで停車する） */
export async function ackEmergency(): Promise<void> {
  if (isTauri) await invoke("ack_emergency");
}

export async function recordRide(): Promise<Progress> {
  if (!isTauri) {
    browserProgress.totalRides++;
    return { ...browserProgress };
  }
  return invoke("record_ride");
}

export async function unlockLines(ids: string[]): Promise<Progress> {
  if (!isTauri) {
    browserProgress.unlockedLines = [...new Set([...browserProgress.unlockedLines, ...ids])];
    return { ...browserProgress };
  }
  return invoke("unlock_lines", { ids });
}

export interface NativeEvents {
  /** オーバーレイが表示された */
  onShown(cb: () => void): void;
  /** ホットキー・トレイ等でオーバーレイが閉じられた（走行中なら緊急停止） */
  onHidden(cb: () => void): void;
  /** カーソル位置（ウィンドウ内 CSS px） */
  onCursor(cb: (p: Point) => void): void;
  /** 走行中に物理マウス入力が抑止された */
  onMouseBlocked(cb: () => void): void;
  /** 乗車中に Esc が押された（マウスの拘束は解除済み） */
  onEmergencyRequest(cb: () => void): void;
  /** ハートビート途絶によりカーソル拘束が自動解除された */
  onLockReleased(cb: () => void): void;
}

export const events: NativeEvents = isTauri
  ? {
      onShown: (cb) => void listen("overlay-shown", () => cb()),
      onHidden: (cb) => void listen("overlay-hidden", () => cb()),
      onCursor: (cb) => void listen<Point>("cursor", (e) => cb(e.payload)),
      onMouseBlocked: (cb) => void listen("mouse-blocked", () => cb()),
      onEmergencyRequest: (cb) => void listen("emergency-request", () => cb()),
      onLockReleased: (cb) => void listen("lock-released", () => cb()),
    }
  : {
      onShown: (cb) => void queueMicrotask(cb),
      onHidden: () => {},
      onCursor: (cb) => window.addEventListener("mousemove", (e) => cb({ x: e.clientX, y: e.clientY })),
      onMouseBlocked: () => {},
      onEmergencyRequest: () => {},
      onLockReleased: () => {},
    };
