import "./styles.css";
import catalogJson from "./data/catalog.json";
import { nextStationIndex, type LineLayout } from "./domain/layout.ts";
import { layoutNetwork, nearestGroup, type NetworkLayout } from "./domain/network.ts";
import { RideSession, type OperationConfig, type RideEvent } from "./domain/ride.ts";
import type { Catalog, Direction, LineDef, Point } from "./domain/types.ts";
import { newlyUnlocked } from "./domain/unlock.ts";
import * as native from "./native.ts";
import { Announcer, stationAnnouncementKey, stationAnnouncementText } from "./ui/announcer.ts";
import { celebrate, closeCelebration } from "./ui/celebration.ts";
import { MapView, type BoardArrow } from "./ui/map.ts";
import { findFreeRect, type Obstacle } from "./ui/placement.ts";
import { buildStationSign } from "./ui/sign.ts";
import { sfx } from "./ui/sfx.ts";

const catalog = catalogJson as Catalog;
const lineFiles = import.meta.glob("./data/lines/*.json", { eager: true, import: "default" }) as Record<string, LineDef>;
const lines = new Map(Object.values(lineFiles).map((l) => [l.id, l]));
/** 路線データのある路線（カタログ順。後の路線は前の路線の駅を基準に配置する） */
const networkLines = catalog.lines.flatMap((l) => (l.available && lines.has(l.id) ? [lines.get(l.id)!] : []));

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
/** HUD の幅の候補。路線図と重ならない最大の幅を使う */
const HUD_WIDTHS = [640, 560, 480, 400, 340, 290];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const map = new MapView(document.getElementById("map") as unknown as SVGSVGElement);
const hud = {
  root: $("hud"),
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
let network: NetworkLayout;
let mode: Mode = "idle";
let session: RideSession | null = null;
let cursor: Point = { x: -1000, y: -1000 };
let ignoring: boolean | null = null;
/** 乗車方向の矢印を出している駅（StationGroup の ID） */
let arrowsStation: string | null = null;
let arrowsCloseTimer: number | undefined;
let lastBlockedWarning = 0;
let leaveTimer: number | undefined;
/** 緊急停車の確認中に列車を止めた時刻 [s] */
let pausedAt: number | null = null;
let alarmTimer: number | undefined;
/** 乗車前の HUD に駅名標を出す駅（カーソルに最も近い駅） */
let idleStation = { line: 0, station: 0 };
let dangerTimer: number | undefined;

function operationConfig(): OperationConfig {
  const { boardingSec, dwellSec, delayProbability, delayMinSec, delayMaxSec, speedPxPerSec, minSegmentSec, maxSegmentSec } = settings;
  return { boardingSec, dwellSec, delayProbability, delayMinSec, delayMaxSec, speedPxPerSec, minSegmentSec, maxSegmentSec };
}

// ---------- 描画 ----------

function relayout() {
  const visible = playableLines().map((l) => l.id);
  network = layoutNetwork(networkLines, visible, window.innerWidth, window.innerHeight);
  map.render(network, window.innerWidth, window.innerHeight);
  idleStation = network.groups[0].members[0];
  closeArrows();
  updateHud();
  placeHud();
}

/** HUD を路線図と重ならない場所に置く */
function placeHud() {
  const obstacles: Obstacle[] = [];
  for (const { path } of network.lines) {
    for (let s = 0; s <= path.length; s += 10) obstacles.push({ ...path.pointAt(s), r: 16 });
  }
  for (const g of network.groups) {
    const p = network.lines[g.members[0].line].stations[g.members[0].station].point;
    // 駅名の分も避ける
    obstacles.push({ x: p.x + g.labelDir.x * 36, y: p.y + g.labelDir.y * 26, r: 40 });
  }
  const { frame } = network;
  const center = { x: (frame.x0 + frame.x1) / 2, y: (frame.y0 + frame.y1) / 2 };
  const { innerWidth: w, innerHeight: h } = window;
  const el = hud.root;
  let fallback: { at: Point; hits: number; width: number } | null = null;
  for (const width of HUD_WIDTHS) {
    el.style.width = `${Math.min(width, w * 0.5)}px`;
    // 乗車中は表示が 1 行増えるので余裕を持たせる
    const found = findFreeRect(obstacles, el.offsetWidth, el.offsetHeight + 16, w, h, center);
    if (found && found.hits === 0) {
      el.style.left = `${found.at.x}px`;
      el.style.top = `${found.at.y + 8}px`;
      return;
    }
    if (found && (!fallback || found.hits < fallback.hits)) fallback = { ...found, width };
  }
  // どこに置いても重なるなら、重なりが最も少ない場所に置く
  if (fallback) {
    el.style.width = `${Math.min(fallback.width, w * 0.5)}px`;
    el.style.left = `${fallback.at.x}px`;
    el.style.top = `${fallback.at.y + 8}px`;
  }
}

function stationName(layout: LineLayout, index: number | null): string {
  return index === null ? "—" : layout.stations[index].def.name;
}

function directionDef(line: LineDef, dir: Direction) {
  return dir === 1 ? line.directions.forward : line.directions.backward;
}

/** HUD の駅名標。同じ内容なら作り直さない */
let signKey = "";

function renderSign(layout: LineLayout, index: number, travel: Direction | null) {
  const currentLine = layout.line;
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
  const line = session ? session.layout.line : network.lines[idleStation.line].line;
  hud.line.textContent = line.name;
  hud.line.style.setProperty("--line-color", line.color);

  if (session) {
    const dir = directionDef(line, session.direction);
    hud.line.textContent = `${line.name} ${dir.name}`;
    if (session.phase === "running") {
      renderSign(session.layout, session.nextStation!, session.direction);
    } else {
      renderSign(session.layout, session.stationIndex, session.direction);
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
    renderSign(network.lines[idleStation.line], idleStation.station, null);
    hud.caption.textContent = "";
    hud.sub.textContent = "駅にカーソルを合わせ、線路沿いの矢印で乗車";
  }

  hud.hint.textContent = session ? "🚨 緊急停車: Esc キー" : `${settings.hotkey} / Esc で閉じる`;
  hud.hint.classList.toggle("emergency", session !== null);
}

// ---------- 路線の開業 ----------

/** 乗車できる路線（解放済みかつ路線データあり） */
function playableLines(): LineDef[] {
  // 開業を知らせて記録した路線だけを出す（乗車回数が足りていても、知らせるまでは出さない）
  return networkLines.filter((l) => progress.unlockedLines.includes(l.id));
}

/**
 * 乗車回数で開業条件を満たした路線を、路線図を開いたときに派手に知らせる。
 * 知らせてから記録するので、知らせる前にアプリを終了しても次の起動時に知らせる
 */
async function announceUnlocks() {
  const fresh = newlyUnlocked(catalog, progress.totalRides, progress.unlockedLines);
  if (fresh.length === 0) return;
  progress = await native.unlockLines(fresh.map((l) => l.id));
  const opened = fresh.flatMap((l) => (l.available && lines.has(l.id) ? [lines.get(l.id)!] : []));
  if (opened.length === 0) return;
  relayout();
  map.highlightLines(opened.map((l) => l.id));
  setIgnore(false);
  sfx.fanfare();
  window.setTimeout(() => announcer.playLine("unlock"), 1600);
  celebrate(opened, () => {
    map.highlightLines([]);
    ignoring = null;
    if (mode === "idle") onCursor(cursor);
  });
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

function openArrows(id: string) {
  window.clearTimeout(arrowsCloseTimer);
  if (arrowsStation === id) return;
  arrowsStation = id;
  map.setHover(id);
  const group = network.groups.find((g) => g.id === id)!;
  const arrows: BoardArrow[] = [];
  // 乗換駅では、乗り入れる全路線の両方向に矢印を出す
  for (const m of group.members) {
    const layout = network.lines[m.line];
    const st = layout.stations[m.station];
    for (const dir of [1, -1] as Direction[]) {
      const next = nextStationIndex(layout, m.station, dir);
      if (next === null) continue;
      // 駅から進行方向へ線路に沿って少し進んだ位置に、進行方向を向いた矢印を置く
      const s = st.s + dir * ARROW_OFFSET;
      const tan = layout.path.tangentAt(s);
      const inward = { x: -tan.y, y: tan.x };
      const def = directionDef(layout.line, dir);
      arrows.push({
        line: m.line,
        color: layout.line.color,
        direction: dir,
        // 駅名を両側に置く路線では、矢印のラベルを駅名より外に出す
        labelGap: layout.line.labelSide === "alternate" ? 50 : 30,
        point: layout.path.pointAt(s),
        angle: Math.atan2(tan.y * dir, tan.x * dir),
        outward: { x: -inward.x, y: -inward.y },
        title: group.members.length > 1 ? `${layout.line.name} ${def.name}` : `${def.name}（${def.label}）`,
        subtitle: `${stationName(layout, next)} 方面`,
      });
    }
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
  if (mode !== "idle" || !network) {
    setIgnore(true);
    return;
  }
  const target = document.elementFromPoint(p.x, p.y);
  // 駅と矢印の上だけクリックを受け付け、それ以外は背後のアプリへ透過させる
  setIgnore(!target?.closest("[data-interactive]"));

  const near = nearestGroup(network, p);
  map.setNear(near.distance <= NEAR_RADIUS ? near.group.id : null);
  if (near.member.line !== idleStation.line || near.member.station !== idleStation.station) {
    idleStation = near.member;
    updateHud();
  }

  const stationEl = target?.closest<SVGElement>("[data-station]");
  if (stationEl) {
    openArrows(stationEl.dataset.station!);
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

async function board(lineIndex: number, index: number, dir: Direction) {
  if (mode !== "idle") return;
  const layout = network.lines[lineIndex];
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

  // 新しい路線の開業は、乗車中には知らせず次に路線図を開いたときに知らせる（announceUnlocks）
  progress = await native.recordRide();
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
    map.showTrain(s.layout.line.vehicle, pose.point, pose.angle, "delayed");
    requestAnimationFrame(tick);
    return;
  }

  for (const ev of s.update(now)) handle(ev, s);
  if (session !== s) return;

  const pose = s.trainPose(now);
  map.showTrain(s.layout.line.vehicle, pose.point, pose.angle, s.phase === "running" ? "running" : s.phase === "delayed" ? "delayed" : "stopped");

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
  hud.sub.textContent = `${stationName(s.layout, s.stationIndex)} で下車しました`;
  announcer.playLine("thanks");
  leaveTimer = window.setTimeout(() => void native.hideOverlay(), 900);
}

function reset() {
  window.clearTimeout(leaveTimer);
  closeEmergency();
  hideDanger();
  closeCelebration();
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
  emergency.message.textContent = `${session.layout.line.name}を止める覚悟はありますか？`;
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
    if (!arrow || arrowsStation === null) return;
    const lineIndex = Number(arrow.dataset.boardLine);
    const member = network.groups.find((g) => g.id === arrowsStation)?.members.find((m) => m.line === lineIndex);
    if (member) void board(lineIndex, member.station, Number(arrow.dataset.boardDir) as Direction);
  });
  emergency.stop.addEventListener("click", confirmEmergency);
  emergency.cancel.addEventListener("click", cancelEmergency);

  native.events.onShown(() => {
    reset();
    relayout();
    void announceUnlocks();
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
