import "./styles.css";
import catalogJson from "./data/catalog.json";
import { layoutLine, nearestStation, nextStationIndex, type LineLayout } from "./domain/layout.ts";
import { RideSession, type OperationConfig, type RideEvent } from "./domain/ride.ts";
import type { Catalog, Direction, LineDef, Point } from "./domain/types.ts";
import { newlyUnlocked, ridesUntilNextUnlock, unlockedLines } from "./domain/unlock.ts";
import * as native from "./native.ts";
import { Announcer, stationAnnouncementKey, stationAnnouncementText } from "./ui/announcer.ts";
import { MapView } from "./ui/map.ts";
import { sfx } from "./ui/sfx.ts";

const catalog = catalogJson as Catalog;
const lineFiles = import.meta.glob("./data/lines/*.json", { eager: true, import: "default" }) as Record<string, LineDef>;
const lines = new Map(Object.values(lineFiles).map((l) => [l.id, l]));

/** 停車中、列車からこの距離以上カーソルを離すと下車 [CSS px] */
const ALIGHT_RADIUS = 44;
/** この距離以内の駅を「近くの駅」として強調 [CSS px] */
const NEAR_RADIUS = 280;
/** 停車直後は下車判定しない [s]（カーソル移動前の古い座標イベントで誤判定しないため） */
const ALIGHT_GRACE_SEC = 0.3;
const POPUP_CLOSE_DELAY_MS = 350;
const BLOCKED_WARNING_COOLDOWN_MS = 5000;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const map = new MapView(document.getElementById("map") as unknown as SVGSVGElement);
const popup = $("popup");
const hud = {
  line: $("hud-line"),
  status: $("hud-status"),
  sub: $("hud-sub"),
  progress: $("hud-progress"),
  lines: $("hud-lines"),
  hint: $("hud-hint"),
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
let popupStation: number | null = null;
let popupCloseTimer: number | undefined;
let lastBlockedWarning = 0;
let leaveTimer: number | undefined;

function operationConfig(): OperationConfig {
  const { boardingSec, dwellSec, delayProbability, delayMinSec, delayMaxSec, speedPxPerSec, minSegmentSec, maxSegmentSec } = settings;
  return { boardingSec, dwellSec, delayProbability, delayMinSec, delayMaxSec, speedPxPerSec, minSegmentSec, maxSegmentSec };
}

// ---------- 描画 ----------

function relayout() {
  layout = layoutLine(currentLine, window.innerWidth, window.innerHeight);
  map.render(layout, window.innerWidth, window.innerHeight);
  closePopup();
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
    switch (session.phase) {
      case "running":
        hud.status.textContent = `次は ${stationName(session.nextStation)}`;
        hud.sub.textContent = "走行中は下車できません";
        break;
      case "dwelling":
        hud.status.textContent = `${stationName(session.stationIndex)} に停車中`;
        hud.sub.textContent = `発車まで ${remain} 秒 ・ カーソルを列車から離すと下車`;
        break;
      case "delayed":
        hud.status.textContent = `⚠ 発車見合わせ中（${stationName(session.stationIndex)}）`;
        hud.sub.textContent = `運転再開まで 約 ${remain} 秒 ・ この駅で下車できます`;
        break;
    }
  } else if (mode === "idle") {
    hud.status.textContent = "近くの駅にカーソルを合わせてください";
    hud.sub.textContent = "乗車する方向を選ぶと、カーソルが列車で運ばれます";
  }

  const until = ridesUntilNextUnlock(catalog, progress.totalRides);
  hud.progress.textContent =
    `累計乗車 ${progress.totalRides} 回` + (until === null ? " ・ 全路線開業済み" : ` ・ 次の路線開業まで あと ${until} 回`);

  const unlocked = new Set(unlockedLines(catalog, progress.totalRides).map((l) => l.id));
  hud.lines.replaceChildren(
    ...catalog.lines.map((l) => {
      const chip = document.createElement("span");
      chip.className = "line-chip";
      chip.style.setProperty("--line-color", l.color);
      if (!unlocked.has(l.id)) {
        chip.classList.add("locked");
        chip.textContent = "🔒 ？？？";
      } else {
        chip.textContent = l.available ? l.name : `${l.name}（準備中）`;
        if (l.id === currentLine.id) chip.classList.add("current");
      }
      return chip;
    }),
  );
  hud.hint.textContent = session
    ? "🚨 緊急脱出: Esc キー（いつでも降りられます）"
    : `${settings.hotkey} / Esc で閉じる`;
  hud.hint.classList.toggle("emergency", session !== null);
}

function toast(message: string) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = message;
  $("toasts").appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

// ---------- 乗車方向ポップアップ ----------

function openPopup(index: number) {
  window.clearTimeout(popupCloseTimer);
  if (popupStation === index) return;
  popupStation = index;
  map.setHover(index);
  const st = layout.stations[index];
  const make = (dir: Direction) => {
    const def = directionDef(dir);
    const next = nextStationIndex(layout, index, dir);
    const b = document.createElement("button");
    b.className = "dir-button";
    b.disabled = next === null;
    b.innerHTML = `<span class="dir-icon">${dir === 1 ? "↻" : "↺"}</span><span><b></b><small></small></span>`;
    b.querySelector("b")!.textContent = `${def.label}（${def.name}）`;
    b.querySelector("small")!.textContent = next === null ? "この方向へは行けません" : `${stationName(next)} 方面`;
    b.addEventListener("click", () => void board(index, dir));
    return b;
  };
  const title = document.createElement("div");
  title.className = "popup-title";
  title.textContent = `${st.def.name} 駅`;
  popup.replaceChildren(title, make(1), make(-1));
  popup.hidden = false;

  // 駅から路線の内側方向にずらして配置
  const offset = 30;
  const px = st.point.x + st.inward.x * offset;
  const py = st.point.y + st.inward.y * offset;
  const tx = st.inward.x > 0.6 ? "0%" : st.inward.x < -0.6 ? "-100%" : "-50%";
  const ty = st.inward.y > 0.6 ? "0%" : st.inward.y < -0.6 ? "-100%" : "-50%";
  popup.style.left = `${px}px`;
  popup.style.top = `${py}px`;
  popup.style.transform = `translate(${tx}, ${ty})`;
}

function closePopup() {
  window.clearTimeout(popupCloseTimer);
  popupStation = null;
  popup.hidden = true;
  map?.setHover(null);
}

// ---------- カーソル・クリック透過 ----------

function setIgnore(ignore: boolean) {
  if (ignoring === ignore) return;
  ignoring = ignore;
  void native.setIgnoreCursor(ignore);
}

function onCursor(p: Point) {
  cursor = p;
  if (mode !== "idle" || !layout) {
    setIgnore(true);
    return;
  }
  const target = document.elementFromPoint(p.x, p.y);
  // 駅とポップアップの上だけクリックを受け付け、それ以外は背後のアプリへ透過させる
  setIgnore(!target?.closest("[data-interactive]"));

  const near = nearestStation(layout, p);
  map.setNear(near.distance <= NEAR_RADIUS ? near.station.index : null);

  const stationEl = target?.closest<SVGElement>("[data-station]");
  if (stationEl) {
    openPopup(Number(stationEl.dataset.station));
  } else if (target?.closest("#popup")) {
    window.clearTimeout(popupCloseTimer);
  } else if (popupStation !== null) {
    window.clearTimeout(popupCloseTimer);
    popupCloseTimer = window.setTimeout(closePopup, POPUP_CLOSE_DELAY_MS);
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
  closePopup();
  setIgnore(true);
  map.setNear(null);

  const now = performance.now() / 1000;
  session = new RideSession(layout, index, dir, operationConfig(), now);
  void native.setRiding(true);
  moveCursor(layout.stations[index].point);
  sfx.door();
  announcer.playLine("door_closing");
  requestAnimationFrame(tick);

  progress = await native.recordRide();
  const fresh = newlyUnlocked(catalog, progress.totalRides, progress.unlockedLines);
  if (fresh.length > 0) {
    progress = await native.unlockLines(fresh.map((l) => l.id));
    for (const l of fresh) toast(`🎉 ${l.name} が開業しました！`);
    sfx.fanfare();
  }
  updateHud();
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
  for (const ev of s.update(now)) handle(ev, s);
  if (session !== s) return;

  const pose = s.trainPose(now);
  map.showTrain(pose.point, pose.angle, s.phase === "running" ? "running" : s.phase === "delayed" ? "delayed" : "stopped");

  if (s.phase === "running") {
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
  announcer.playLine("thanks");
  leaveTimer = window.setTimeout(() => void native.hideOverlay(), 900);
}

function reset() {
  window.clearTimeout(leaveTimer);
  if (session) void native.setRiding(false);
  session = null;
  mode = "idle";
  map.hideTrain();
  closePopup();
  ignoring = null;
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
    if (e.key === "Escape") void native.hideOverlay();
  });

  native.events.onShown(() => {
    reset();
    relayout();
  });
  native.events.onHidden(() => {
    // Esc・ホットキー等で閉じられた場合、走行中なら緊急停止（拘束は Rust 側で解除済み）
    if (session) toast("緊急停止しました");
    reset();
  });
  native.events.onCursor(onCursor);
  native.events.onMouseBlocked(() => {
    if (!session || session.atStation) return;
    map.shakeTrain();
    const now = performance.now();
    if (now - lastBlockedWarning > BLOCKED_WARNING_COOLDOWN_MS) {
      lastBlockedWarning = now;
      sfx.buzzer();
      announcer.playLine("no_alighting");
      toast("危ないので駅以外では下車しないでください！");
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
