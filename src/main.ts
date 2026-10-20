import "./styles.css";
import catalogJson from "./data/catalog.json";
import { layoutLine, nearestStation, nextStationIndex, type LineLayout } from "./domain/layout.ts";
import { RideSession, type OperationConfig, type RideEvent } from "./domain/ride.ts";
import type { Catalog, Direction, LineDef, Point } from "./domain/types.ts";
import { newlyUnlocked } from "./domain/unlock.ts";
import * as native from "./native.ts";
import { Announcer, stationAnnouncementKey, stationAnnouncementText } from "./ui/announcer.ts";
import { MapView, type BoardArrow } from "./ui/map.ts";
import { sfx } from "./ui/sfx.ts";

const catalog = catalogJson as Catalog;
const lineFiles = import.meta.glob("./data/lines/*.json", { eager: true, import: "default" }) as Record<string, LineDef>;
const lines = new Map(Object.values(lineFiles).map((l) => [l.id, l]));

/** 停車中、列車からこの距離以上カーソルを離すと下車 [CSS px] */
const ALIGHT_RADIUS = 44;
/** 停車直後は下車判定しない [s]（カーソル移動前の古い座標イベントで誤判定しないため） */
const ALIGHT_GRACE_SEC = 0.3;
/** この距離以内の駅を「近くの駅」として強調 [CSS px] */
const NEAR_RADIUS = 280;
/** 乗車方向の矢印を置く、駅から線路に沿った距離 [CSS px] */
const ARROW_OFFSET = 42;
const ARROWS_CLOSE_DELAY_MS = 350;
const BLOCKED_WARNING_COOLDOWN_MS = 5000;
const ALARM_INTERVAL_MS = 700;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const map = new MapView(document.getElementById("map") as unknown as SVGSVGElement);
const hud = {
  line: $("hud-line"),
  status: $("hud-status"),
  sub: $("hud-sub"),
  hint: $("hud-hint"),
};
const emergency = {
  root: $("emergency"),
  message: $("emergency-message"),
  stop: $<HTMLButtonElement>("emergency-stop"),
  cancel: $<HTMLButtonElement>("emergency-cancel"),
};
const announcer = new Announcer();

type Mode = "idle" | "riding" | "leaving";

let settings: native.Settings;
let progress: native.Progress;
let currentLine: LineDef = lines.get("yamanote")!;
let layout: LineLayout;
let mode: Mode = "idle";
let session: RideSession | null = null;
let cursor: Point = { x: -1000, y: -1000 };
let ignoring: boolean | null = null;
let arrowsStation: number | null = null;
let arrowsCloseTimer: number | undefined;
let lastBlockedWarning = 0;
let leaveTimer: number | undefined;
/** 緊急停車の確認中に列車を止めた時刻 [s] */
let pausedAt: number | null = null;
let alarmTimer: number | undefined;

function operationConfig(): OperationConfig {
  const { boardingSec, dwellSec, delayProbability, delayMinSec, delayMaxSec, speedPxPerSec, minSegmentSec, maxSegmentSec } = settings;
  return { boardingSec, dwellSec, delayProbability, delayMinSec, delayMaxSec, speedPxPerSec, minSegmentSec, maxSegmentSec };
}

// ---------- 描画 ----------

function relayout() {
  layout = layoutLine(currentLine, window.innerWidth, window.innerHeight);
  map.render(layout, window.innerWidth, window.innerHeight);
  closeArrows();
  updateHud();
}

function stationName(index: number | null): string {
  return index === null ? "—" : layout.stations[index].def.name;
}

function directionDef(dir: Direction) {
  return dir === 1 ? currentLine.directions.forward : currentLine.directions.backward;
}

function updateHud(now = performance.now() / 1000) {
  hud.line.textContent = currentLine.name;
  hud.line.style.setProperty("--line-color", currentLine.color);

  if (session) {
    const dir = directionDef(session.direction);
    hud.line.textContent = `${currentLine.name} ${dir.name}`;
    const remain = Math.ceil(session.remaining(now));
    if (pausedAt !== null) {
      hud.status.textContent = "⚠ 緊急停車の確認中";
      hud.sub.textContent = "";
    } else if (session.phase === "running") {
      hud.status.textContent = `次は ${stationName(session.nextStation)}`;
      hud.sub.textContent = "走行中は下車できません";
    } else if (!session.departed) {
      hud.status.textContent = `${stationName(session.stationIndex)} から乗車`;
      hud.sub.textContent =
        session.phase === "delayed"
          ? `⚠ 発車見合わせ中 ・ 運転再開まで 約 ${remain} 秒`
          : `発車まで ${remain} 秒 ・ 乗車駅では下車できません`;
    } else if (session.phase === "dwelling") {
      hud.status.textContent = `${stationName(session.stationIndex)} に停車中`;
      hud.sub.textContent = `発車まで ${remain} 秒 ・ カーソルを列車から離すと下車`;
    } else {
      hud.status.textContent = `⚠ 発車見合わせ中（${stationName(session.stationIndex)}）`;
      hud.sub.textContent = `運転再開まで 約 ${remain} 秒 ・ この駅で下車できます`;
    }
  } else if (mode === "idle") {
    hud.status.textContent = "近くの駅にカーソルを合わせてください";
    hud.sub.textContent = "線路沿いの矢印をクリックすると、その方向の列車に乗車します";
  }

  hud.hint.textContent = session ? "🚨 緊急停車: Esc キー" : `${settings.hotkey} / Esc で閉じる`;
  hud.hint.classList.toggle("emergency", session !== null);
}

function toast(message: string) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = message;
  $("toasts").appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

// ---------- 乗車方向の矢印 ----------

function openArrows(index: number) {
  window.clearTimeout(arrowsCloseTimer);
  if (arrowsStation === index) return;
  arrowsStation = index;
  map.setHover(index);
  const st = layout.stations[index];
  const arrows: BoardArrow[] = [];
  for (const dir of [1, -1] as Direction[]) {
    const next = nextStationIndex(layout, index, dir);
    if (next === null) continue;
    // 駅から進行方向へ線路に沿って少し進んだ位置に、進行方向を向いた矢印を置く
    const s = st.s + dir * ARROW_OFFSET;
    const tan = layout.path.tangentAt(s);
    const inward = { x: -tan.y, y: tan.x };
    const def = directionDef(dir);
    arrows.push({
      direction: dir,
      point: layout.path.pointAt(s),
      angle: Math.atan2(tan.y * dir, tan.x * dir),
      outward: { x: -inward.x, y: -inward.y },
      title: `${def.name}（${def.label}）`,
      subtitle: `${stationName(next)} 方面`,
    });
  }
  map.showBoardArrows(arrows);
}

function closeArrows() {
  window.clearTimeout(arrowsCloseTimer);
  arrowsStation = null;
  map.hideBoardArrows();
  map.setHover(null);
}

// ---------- カーソル・クリック透過 ----------

function setIgnore(ignore: boolean) {
  if (ignoring === ignore) return;
  ignoring = ignore;
  void native.setIgnoreCursor(ignore);
}

function onCursor(p: Point) {
  cursor = p;
  if (pausedAt !== null) {
    // 緊急停車の確認中は画面全体でクリックを受け付ける
    setIgnore(false);
    return;
  }
  if (mode !== "idle" || !layout) {
    setIgnore(true);
    return;
  }
  const target = document.elementFromPoint(p.x, p.y);
  // 駅と矢印の上だけクリックを受け付け、それ以外は背後のアプリへ透過させる
  setIgnore(!target?.closest("[data-interactive]"));

  const near = nearestStation(layout, p);
  map.setNear(near.distance <= NEAR_RADIUS ? near.station.index : null);

  const stationEl = target?.closest<SVGElement>("[data-station]");
  if (stationEl) {
    openArrows(Number(stationEl.dataset.station));
  } else if (target?.closest("[data-board-dir]")) {
    window.clearTimeout(arrowsCloseTimer);
  } else if (arrowsStation !== null) {
    window.clearTimeout(arrowsCloseTimer);
    arrowsCloseTimer = window.setTimeout(closeArrows, ARROWS_CLOSE_DELAY_MS);
  }
}

function moveCursor(p: Point) {
  cursor = p;
  void native.setCursor(p);
}

// ---------- 乗車・走行・下車 ----------

async function board(index: number, dir: Direction) {
  if (mode !== "idle") return;
  mode = "riding";
  closeArrows();
  setIgnore(true);
  map.setNear(null);

  const now = performance.now() / 1000;
  session = new RideSession(layout, index, dir, operationConfig(), now);
  void native.setRiding(true);
  // 乗車駅では下車できないので、発車前から拘束する
  void native.lockCursor(true);
  moveCursor(layout.stations[index].point);
  sfx.door();
  announcer.playLine("door_closing");
  requestAnimationFrame(tick);

  // 路線の解放は隠し要素。記録だけして画面には出さない
  progress = await native.recordRide();
  const fresh = newlyUnlocked(catalog, progress.totalRides, progress.unlockedLines);
  if (fresh.length > 0) progress = await native.unlockLines(fresh.map((l) => l.id));
}

function handle(ev: RideEvent, s: RideSession) {
  switch (ev.type) {
    case "depart":
      void native.lockCursor(true);
      sfx.depart();
      break;
    case "arrive": {
      void native.lockCursor(false);
      sfx.door();
      const st = s.layout.stations[ev.station].def;
      announcer.play(stationAnnouncementKey(s.layout.line.id, st.id), stationAnnouncementText(st.name));
      break;
    }
    case "delay":
      announcer.playLine(ev.reason === "safety" ? "delay_safety" : "delay_late");
      break;
  }
}

function tick(ts: number) {
  const s = session;
  if (!s) return;
  const now = ts / 1000;

  if (pausedAt !== null) {
    // 緊急停車の確認中は列車を止めておく
    const pose = s.trainPose(pausedAt);
    map.showTrain(pose.point, pose.angle, "delayed");
    requestAnimationFrame(tick);
    return;
  }

  for (const ev of s.update(now)) handle(ev, s);
  if (session !== s) return;

  const pose = s.trainPose(now);
  map.showTrain(pose.point, pose.angle, s.phase === "running" ? "running" : s.phase === "delayed" ? "delayed" : "stopped");

  if (!s.canAlight) {
    // 実際の OS カーソルを車両に追従させる（Rust 側へのハートビートも兼ねる）
    moveCursor(pose.point);
  } else if (
    now - s.phaseStart > ALIGHT_GRACE_SEC &&
    Math.hypot(cursor.x - pose.point.x, cursor.y - pose.point.y) > ALIGHT_RADIUS
  ) {
    alight();
    return;
  }
  updateHud(now);
  requestAnimationFrame(tick);
}

function alight() {
  const s = session;
  if (!s) return;
  session = null;
  mode = "leaving";
  void native.lockCursor(false);
  void native.setRiding(false);
  map.hideTrain();
  hud.status.textContent = `${stationName(s.stationIndex)} で下車しました`;
  hud.sub.textContent = "ご乗車ありがとうございました";
  updateHud();
  announcer.playLine("thanks");
  leaveTimer = window.setTimeout(() => void native.hideOverlay(), 900);
}

function reset() {
  window.clearTimeout(leaveTimer);
  closeEmergency();
  if (session) void native.setRiding(false);
  session = null;
  mode = "idle";
  map.hideTrain();
  closeArrows();
  ignoring = null;
  updateHud();
}

// ---------- 緊急停車 ----------

function openEmergency() {
  // 応答したことを先に伝える（伝えないと Rust 側が確認なしで停車する）
  void native.ackEmergency();
  if (!session) {
    void native.hideOverlay();
    return;
  }
  if (pausedAt !== null) {
    // 確認中にもう一度 Esc が押されたら、ダイアログを閉じて運転を続ける
    cancelEmergency();
    return;
  }
  pausedAt = performance.now() / 1000;
  announcer.playLine("emergency");
  emergency.message.textContent = `${currentLine.name}を止める覚悟はありますか？`;
  emergency.root.hidden = false;
  setIgnore(false);
  emergency.stop.focus();
  sfx.buzzer();
  alarmTimer = window.setInterval(() => sfx.buzzer(), ALARM_INTERVAL_MS);
  updateHud();
}

function closeEmergency() {
  window.clearInterval(alarmTimer);
  emergency.root.hidden = true;
  pausedAt = null;
}

function confirmEmergency() {
  closeEmergency();
  announcer.stop();
  void native.hideOverlay();
}

function cancelEmergency() {
  const s = session;
  if (!s || pausedAt === null) return;
  s.shift(performance.now() / 1000 - pausedAt);
  closeEmergency();
  announcer.stop();
  setIgnore(true);
  if (!s.canAlight) {
    moveCursor(s.trainPose(performance.now() / 1000).point);
    void native.lockCursor(true);
  }
  updateHud();
}

// ---------- 起動 ----------

async function main() {
  ({ settings, progress } = await native.bootstrap());
  announcer.volume = sfx.volume = settings.volume;
  announcer.speechFallback = settings.speechFallback;
  if (!progress.unlockedLines.includes("yamanote")) progress = await native.unlockLines(["yamanote"]);
  relayout();

  window.addEventListener("resize", () => {
    if (!session) relayout();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    // 乗車中の Esc は Rust 側のキーボードフックが拾う（ブラウザ単体での確認用にここでも処理する）
    if (session && !native.isTauri) openEmergency();
    else if (!session) void native.hideOverlay();
  });
  document.getElementById("map")!.addEventListener("click", (e) => {
    const arrow = (e.target as Element).closest<SVGElement>("[data-board-dir]");
    if (arrow && arrowsStation !== null) void board(arrowsStation, Number(arrow.dataset.boardDir) as Direction);
  });
  emergency.stop.addEventListener("click", confirmEmergency);
  emergency.cancel.addEventListener("click", cancelEmergency);

  native.events.onShown(() => {
    reset();
    relayout();
  });
  native.events.onHidden(() => {
    if (session) toast("緊急停車しました");
    reset();
  });
  native.events.onCursor(onCursor);
  native.events.onEmergencyRequest(openEmergency);
  native.events.onMouseBlocked(() => {
    if (!session || session.canAlight || pausedAt !== null) return;
    map.shakeTrain();
    const now = performance.now();
    if (now - lastBlockedWarning > BLOCKED_WARNING_COOLDOWN_MS) {
      lastBlockedWarning = now;
      sfx.buzzer();
      if (session.atStation) {
        announcer.playLine("no_alighting_origin");
        toast("ご乗車になった駅ではお降りになれません");
      } else {
        announcer.playLine("no_alighting");
        toast("危ないので駅以外では下車しないでください！");
      }
    }
  });
  native.events.onLockReleased(() => {
    if (!session) return;
    toast("安全のためカーソルの拘束を解除しました");
    void native.hideOverlay();
    reset();
  });
}

void main();
