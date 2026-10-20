import "./styles.css";
import catalogJson from "./data/catalog.json";
import { layoutLine, nearestStation, nextStationIndex, type LineLayout } from "./domain/layout.ts";
import { RideSession, type OperationConfig, type RideEvent } from "./domain/ride.ts";
import type { Catalog, CatalogEntry, Direction, LineDef, Point } from "./domain/types.ts";
import { newlyUnlocked, unlockedLines } from "./domain/unlock.ts";
import * as native from "./native.ts";
import { Announcer, stationAnnouncementKey, stationAnnouncementText } from "./ui/announcer.ts";
import { MapView, type BoardArrow } from "./ui/map.ts";
import { buildStationSign } from "./ui/sign.ts";
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
const DANGER_DURATION_MS = 2500;
const LINE_STORAGE_KEY = "mouse-on-rails.line";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const map = new MapView(document.getElementById("map") as unknown as SVGSVGElement);
const hud = {
  lines: $("hud-lines"),
  line: $("hud-line"),
  caption: $("hud-caption"),
  sign: $("hud-sign"),
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
/** 乗車前の HUD に駅名標を出す駅（カーソルに最も近い駅） */
let idleStation = 0;
let dangerTimer: number | undefined;
/** 開業したがまだ知らせていない路線 */
let pendingUnlocks: CatalogEntry[] = [];
/** 開業後まだ乗っていない路線（路線切替に NEW を付ける） */
const newLines = new Set<string>();
let renderedTabs = "";

function operationConfig(): OperationConfig {
  const { boardingSec, dwellSec, delayProbability, delayMinSec, delayMaxSec, speedPxPerSec, minSegmentSec, maxSegmentSec } = settings;
  return { boardingSec, dwellSec, delayProbability, delayMinSec, delayMaxSec, speedPxPerSec, minSegmentSec, maxSegmentSec };
}

// ---------- 描画 ----------

function relayout() {
  layout = layoutLine(currentLine, window.innerWidth, window.innerHeight);
  map.render(layout, window.innerWidth, window.innerHeight);
  // 路線を切り替えると駅数が変わる
  idleStation = Math.min(idleStation, layout.stations.length - 1);
  closeArrows();
  updateHud();
}

function stationName(index: number | null): string {
  return index === null ? "—" : layout.stations[index].def.name;
}

function directionDef(dir: Direction) {
  return dir === 1 ? currentLine.directions.forward : currentLine.directions.backward;
}

/** HUD の駅名標。同じ内容なら作り直さない */
let signKey = "";

function renderSign(index: number, travel: Direction | null) {
  const key = `${currentLine.id}:${index}:${travel}`;
  if (key === signKey) return;
  signKey = key;
  const st = layout.stations[index].def;
  // 進行方向が決まっていれば、次の駅を矢印側（右）に置く
  const toRight = nextStationIndex(layout, index, travel ?? 1);
  const toLeft = nextStationIndex(layout, index, travel === null ? -1 : (-travel as Direction));
  const neighbor = (i: number | null) => {
    if (i === null) return null;
    const { name, romaji, number } = layout.stations[i].def;
    return { name, romaji, number };
  };
  hud.sign.replaceChildren(
    buildStationSign({
      style: currentLine.sign?.style ?? "jr-east",
      lineName: currentLine.name,
      lineNameEn: currentLine.nameEn,
      lineCode: currentLine.sign?.code,
      lineColor: currentLine.color,
      barColor: currentLine.sign?.barColor ?? currentLine.color,
      areaMark: currentLine.sign?.areaMark,
      station: st,
      left: neighbor(toLeft),
      right: neighbor(toRight),
      arrow: travel === null ? "none" : "right",
    }),
  );
}

function updateHud() {
  hud.line.textContent = currentLine.name;
  hud.line.style.setProperty("--line-color", currentLine.color);
  updateLineTabs();

  if (session) {
    const dir = directionDef(session.direction);
    hud.line.textContent = `${currentLine.name} ${dir.name}`;
    if (session.phase === "running") {
      renderSign(session.nextStation!, session.direction);
    } else {
      renderSign(session.stationIndex, session.direction);
    }
    if (pausedAt !== null) {
      hud.caption.textContent = "⚠ 緊急停車の確認中";
      hud.sub.textContent = "";
    } else if (session.phase === "running") {
      hud.caption.textContent = "次は";
      hud.sub.textContent = "走行中は下車できません";
    } else if (session.phase === "delayed") {
      hud.caption.textContent = "⚠ 発車見合わせ中";
      hud.sub.textContent = session.departed ? "この駅で下車できます" : "乗車駅では下車できません";
    } else if (!session.departed) {
      hud.caption.textContent = "まもなく発車します";
      hud.sub.textContent = "乗車駅では下車できません";
    } else {
      hud.caption.textContent = "停車中";
      hud.sub.textContent = "カーソルを列車から離すと下車";
    }
  } else if (mode === "idle") {
    renderSign(idleStation, null);
    hud.caption.textContent = "";
    hud.sub.textContent = "駅にカーソルを合わせ、線路沿いの矢印で乗車";
  }

  hud.hint.textContent = session ? "🚨 緊急停車: Esc キー" : `${settings.hotkey} / Esc で閉じる`;
  hud.hint.classList.toggle("emergency", session !== null);
}

// ---------- 路線の切り替え ----------

/** 乗車できる路線（解放済みかつ路線データあり） */
function playableLines(): LineDef[] {
  return unlockedLines(catalog, progress.totalRides).flatMap((l) => (l.available && lines.has(l.id) ? [lines.get(l.id)!] : []));
}

function updateLineTabs() {
  const playable = playableLines();
  // 乗車中や路線が 1 つしか無いときは、切り替えを出さず路線名だけ表示する
  const show = mode === "idle" && playable.length > 1;
  const key = show ? `${playable.map((l) => l.id).join()}|${currentLine.id}|${[...newLines].join()}` : "";
  hud.line.hidden = show;
  hud.lines.hidden = !show;
  if (key === renderedTabs) return;
  renderedTabs = key;
  hud.lines.replaceChildren(
    ...(show ? playable : []).map((l) => {
      const b = document.createElement("button");
      b.className = "hud-line-tab";
      b.dataset.line = l.id;
      b.dataset.interactive = "";
      b.style.setProperty("--line-color", l.color);
      b.textContent = l.name;
      b.classList.toggle("current", l.id === currentLine.id);
      b.classList.toggle("is-new", newLines.has(l.id));
      b.setAttribute("aria-pressed", String(l.id === currentLine.id));
      return b;
    }),
  );
}

function switchLine(id: string) {
  const line = lines.get(id);
  if (!line || mode !== "idle" || !playableLines().includes(line)) return;
  newLines.delete(id);
  try {
    localStorage.setItem(LINE_STORAGE_KEY, id);
  } catch {
    // 保存できなくても切り替えはできる
  }
  if (line === currentLine) {
    updateHud();
    return;
  }
  currentLine = line;
  relayout();
}

function restoreLine() {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(LINE_STORAGE_KEY);
  } catch {
    // 既定の山手線を使う
  }
  const line = saved ? lines.get(saved) : undefined;
  if (line && playableLines().includes(line)) currentLine = line;
}

function announceUnlocks() {
  if (pendingUnlocks.length === 0) return;
  toast(`🎉 ${pendingUnlocks.map((l) => l.name).join("・")}が開業しました！`);
  announcer.playLine("unlock");
  pendingUnlocks = [];
}

function toast(message: string) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = message;
  $("toasts").appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

/** 走行中に降りようとしたときの警告。押し続けている間は表示を延長する */
function showDanger() {
  const el = $("danger");
  el.hidden = false;
  window.clearTimeout(dangerTimer);
  dangerTimer = window.setTimeout(hideDanger, DANGER_DURATION_MS);
}

function hideDanger() {
  window.clearTimeout(dangerTimer);
  $("danger").hidden = true;
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
  if (near.station.index !== idleStation) {
    idleStation = near.station.index;
    updateHud();
  }

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

  newLines.delete(currentLine.id);
  // 新しい路線の開業は、乗車中には知らせず次に路線図を開いたときに知らせる
  progress = await native.recordRide();
  const fresh = newlyUnlocked(catalog, progress.totalRides, progress.unlockedLines);
  if (fresh.length > 0) {
    progress = await native.unlockLines(fresh.map((l) => l.id));
    const playable = fresh.filter((l) => l.available && lines.has(l.id));
    pendingUnlocks.push(...playable);
    for (const l of playable) newLines.add(l.id);
  }
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
  updateHud();
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
  updateHud();
  hud.caption.textContent = "ご乗車ありがとうございました";
  hud.sub.textContent = `${stationName(s.stationIndex)} で下車しました`;
  announcer.playLine("thanks");
  leaveTimer = window.setTimeout(() => void native.hideOverlay(), 900);
}

function reset() {
  window.clearTimeout(leaveTimer);
  closeEmergency();
  hideDanger();
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
  hideDanger();
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
  restoreLine();
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
  hud.lines.addEventListener("click", (e) => {
    const tab = (e.target as Element).closest<HTMLElement>("[data-line]");
    if (tab) switchLine(tab.dataset.line!);
  });
  emergency.stop.addEventListener("click", confirmEmergency);
  emergency.cancel.addEventListener("click", cancelEmergency);

  native.events.onShown(() => {
    reset();
    relayout();
    announceUnlocks();
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
    // 乗車駅で発車を待っている間は、降りられないだけで警告はしない
    if (session.atStation) return;
    showDanger();
    const now = performance.now();
    if (now - lastBlockedWarning > BLOCKED_WARNING_COOLDOWN_MS) {
      lastBlockedWarning = now;
      sfx.buzzer();
      announcer.playLine("no_alighting");
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
