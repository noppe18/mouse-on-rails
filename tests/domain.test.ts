import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { layoutLine, segmentDistance, nextStationIndex } from "../src/domain/layout.ts";
import { layoutNetwork, roundCorners } from "../src/domain/network.ts";
import { RideSession, type OperationConfig } from "../src/domain/ride.ts";
import { newlyUnlocked, ridesUntilNextUnlock, unlockedCount } from "../src/domain/unlock.ts";
import type { Catalog, LineDef } from "../src/domain/types.ts";

const loadLine = (id: string): LineDef => JSON.parse(readFileSync(new URL(`../src/data/lines/${id}.json`, import.meta.url), "utf8"));
const yamanote = loadLine("yamanote");
const catalog: Catalog = JSON.parse(readFileSync(new URL("../src/data/catalog.json", import.meta.url), "utf8"));
const networkLines = catalog.lines.filter((l) => l.available).map((l) => loadLine(l.id));
const allIds = networkLines.map((l) => l.id);
const SCREENS = [
  [1366, 768],
  [1920, 1080],
  [2560, 1440],
  [3440, 1440],
];

const config: OperationConfig = {
  boardingSec: 1,
  dwellSec: 2,
  delayProbability: 0,
  delayMinSec: 3,
  delayMaxSec: 5,
  speedPxPerSec: 500,
  minSegmentSec: 1,
  maxSegmentSec: 4,
};

test("山手線は30駅", () => {
  assert.equal(yamanote.stations.length, 30);
  assert.equal(new Set(yamanote.stations.map((s) => s.id)).size, 30);
});

test("駅は路線上を時計回りに単調増加で並ぶ", () => {
  const layout = layoutLine(yamanote, 3440, 1440);
  for (let i = 1; i < layout.stations.length; i++) {
    assert.ok(layout.stations[i].s > layout.stations[i - 1].s);
  }
  // 池袋は上辺、品川は下辺、東京は右側、新宿は左側
  const byId = (id: string) => layout.stations.find((s) => s.def.id === id)!.point;
  assert.ok(byId("ikebukuro").y < 720);
  assert.ok(byId("shinagawa").y > 720);
  assert.ok(byId("tokyo").x > 1720);
  assert.ok(byId("shinjuku").x < 1720);
});

test("環状線は両方向に一周できる", () => {
  const layout = layoutLine(yamanote, 1920, 1080);
  assert.equal(nextStationIndex(layout, 29, 1), 0);
  assert.equal(nextStationIndex(layout, 0, -1), 29);
  const fwd = segmentDistance(layout, 29, 0, 1);
  const back = segmentDistance(layout, 0, 29, -1);
  assert.ok(Math.abs(fwd - back) < 1e-6 && fwd > 0 && fwd < layout.path.length / 10);
});

test("乗車→発車→到着→停車の状態遷移", () => {
  const layout = layoutLine(yamanote, 1920, 1080);
  const ride = new RideSession(layout, 0, 1, config, 0);
  assert.equal(ride.phase, "dwelling");
  assert.deepEqual(ride.update(0.5), []);
  const dep = ride.update(1);
  assert.deepEqual(dep, [{ type: "depart", from: 0, to: 1 }]);
  assert.equal(ride.atStation, false);
  const arr = ride.update(ride.phaseEnd);
  assert.deepEqual(arr, [{ type: "arrive", station: 1 }]);
  assert.equal(ride.atStation, true);
  // 停車中の車両は駅の位置にいる
  const pose = ride.trainPose(ride.phaseEnd - 0.1);
  assert.ok(Math.hypot(pose.point.x - layout.stations[1].point.x, pose.point.y - layout.stations[1].point.y) < 1e-6);
});

test("反時計回りは逆順に進む", () => {
  const layout = layoutLine(yamanote, 1920, 1080);
  const ride = new RideSession(layout, 0, -1, config, 0);
  assert.deepEqual(ride.update(1), [{ type: "depart", from: 0, to: 29 }]);
});

test("遅延は発車前に発生し、上限時間内に終わる", () => {
  const layout = layoutLine(yamanote, 1920, 1080);
  const ride = new RideSession(layout, 3, 1, { ...config, delayProbability: 1, delayMinSec: 999, delayMaxSec: 9999 }, 0, () => 0.99);
  const ev = ride.update(1);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, "delay");
  assert.equal(ride.phase, "delayed");
  assert.ok(ride.atStation);
  const ev2 = ride.update(1 + 61);
  assert.equal(ev2[0].type, "depart");
});

test("3回乗車ごとに路線が解放される", () => {
  assert.equal(unlockedCount(catalog, 0), 1);
  assert.equal(unlockedCount(catalog, 2), 1);
  assert.equal(unlockedCount(catalog, 3), 2);
  assert.equal(unlockedCount(catalog, 7), 3);
  assert.equal(unlockedCount(catalog, 10_000), catalog.lines.length);
  assert.equal(ridesUntilNextUnlock(catalog, 1), 2);
  assert.equal(ridesUntilNextUnlock(catalog, 10_000), null);
  assert.deepEqual(newlyUnlocked(catalog, 3, ["yamanote"]).map((l) => l.id), ["namboku"]);
  assert.deepEqual(newlyUnlocked(catalog, 3, ["yamanote", "namboku"]), []);
  assert.deepEqual(newlyUnlocked(catalog, 6, ["yamanote", "namboku"]).map((l) => l.id), ["marunouchi"]);
  // 起動していない間に 2 路線ぶん乗っていれば、まとめて開業する
  assert.deepEqual(newlyUnlocked(catalog, 7, ["yamanote"]).map((l) => l.id), ["namboku", "marunouchi"]);
  assert.deepEqual(newlyUnlocked(catalog, 9, ["yamanote", "namboku", "marunouchi"]).map((l) => l.id), ["ginza"]);
  // 全路線が開業したら、それ以上は何も開業しない
  assert.equal(ridesUntilNextUnlock(catalog, 9), null);
  assert.deepEqual(newlyUnlocked(catalog, 100, ["yamanote", "namboku", "marunouchi", "ginza"]), []);
});

test("実装済みの路線はすべて路線データがあり、駅番号と読みがそろっている", () => {
  for (const entry of catalog.lines.filter((l) => l.available)) {
    const line = loadLine(entry.id);
    assert.equal(line.id, entry.id);
    assert.equal(line.color, entry.color);
    assert.equal(new Set(line.stations.map((s) => s.id)).size, line.stations.length);
    assert.equal(new Set(line.stations.map((s) => s.number)).size, line.stations.length);
    assert.ok(line.sign?.code && line.vehicle, line.id);
    for (const st of line.stations) assert.ok(st.kana && st.romaji && Number.isInteger(st.number), `${line.id}/${st.id}`);
  }
});

test("路線網: どの画面サイズでも全路線が画面に収まり、駅は路線の始点から順に並ぶ", () => {
  for (const [w, h] of SCREENS) {
    for (let n = 1; n <= allIds.length; n++) {
      const net = layoutNetwork(networkLines, allIds.slice(0, n), w, h);
      assert.equal(net.lines.length, n);
      for (const layout of net.lines) {
        for (const p of layout.path.points) assert.ok(p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h, `${layout.line.id} ${w}x${h}`);
        for (let i = 1; i < layout.stations.length; i++) assert.ok(layout.stations[i].s > layout.stations[i - 1].s, `${layout.line.id} ${i}`);
      }
    }
  }
});

test("路線網: 他の路線は山手線の環の中に収まり、山手線の配置は変わらない", () => {
  for (const [w, h] of SCREENS) {
    const alone = layoutLine(networkLines[0], w, h);
    const net = layoutNetwork(networkLines, allIds, w, h);
    assert.deepEqual(net.lines[0].stations.map((s) => s.point), alone.stations.map((s) => s.point));
    for (const layout of net.lines) {
      for (const p of layout.path.points) {
        assert.ok(p.x >= net.frame.x0 - 0.5 && p.x <= net.frame.x1 + 0.5 && p.y >= net.frame.y0 - 0.5 && p.y <= net.frame.y1 + 0.5, layout.line.id);
      }
    }
  }
});

test("路線網: 南北線・丸ノ内線は縦横と 45° の直線で描き、乗換駅は同じ位置か連絡線でつながる", () => {
  for (const [w, h] of SCREENS) {
    const net = layoutNetwork(networkLines, allIds, w, h);
    for (const layout of net.lines.filter((l) => l.line.shape.type === "route")) {
      const pts = layout.path.points;
      for (let i = 1; i < pts.length; i++) {
        const dx = Math.abs(pts[i].x - pts[i - 1].x);
        const dy = Math.abs(pts[i].y - pts[i - 1].y);
        // 角を丸めた円弧の細かい区間は除き、直線の区間だけ確かめる
        if (Math.hypot(dx, dy) < 30) continue;
        assert.ok(dx < 0.01 || dy < 0.01 || Math.abs(dx - dy) < 0.01, `${layout.line.id} ${w}x${h} 区間 ${i}`);
      }
    }
    const point = (line: string, station: string) => {
      const l = net.lines.find((x) => x.line.id === line)!;
      return l.stations.find((s) => s.def.id === station)!.point;
    };
    const same = (a: { x: number; y: number }, b: { x: number; y: number }) => assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 1e-6);
    same(point("namboku", "meguro"), point("yamanote", "meguro"));
    same(point("namboku", "komagome"), point("yamanote", "komagome"));
    same(point("marunouchi", "ikebukuro"), point("yamanote", "ikebukuro"));
    same(point("marunouchi", "shinjuku"), point("yamanote", "shinjuku"));
    same(point("marunouchi", "korakuen"), point("namboku", "korakuen"));
    same(point("marunouchi", "yotsuya"), point("namboku", "yotsuya"));
    same(point("ginza", "shibuya"), point("yamanote", "shibuya"));
    same(point("ginza", "ueno"), point("yamanote", "ueno"));
    same(point("ginza", "ginza"), point("marunouchi", "ginza"));
    // 東京は山手線の線路と重ならないよう、少し内側に置いて連絡線でつなぐ
    const d = Math.hypot(point("marunouchi", "tokyo").x - point("yamanote", "tokyo").x, point("marunouchi", "tokyo").y - point("yamanote", "tokyo").y);
    assert.ok(d > 10 && d < 40);
    const tokyo = net.groups.find((g) => g.id === "tokyo")!;
    assert.equal(tokyo.members.length, 2);
  }
});

test("南北線は目黒から駒込、丸ノ内線は池袋から新宿、銀座線は渋谷から上野", () => {
  const namboku = loadLine("namboku");
  assert.equal(namboku.stations.length, 14);
  assert.deepEqual([namboku.sign?.code, namboku.stations[0].name, namboku.stations[13].name], ["N", "目黒", "駒込"]);
  const marunouchi = loadLine("marunouchi");
  assert.equal(marunouchi.stations.length, 18);
  assert.deepEqual([marunouchi.sign?.code, marunouchi.stations[0].number, marunouchi.stations[17].name], ["M", 25, "新宿"]);
  const ginza = loadLine("ginza");
  assert.equal(ginza.stations.length, 16);
  assert.deepEqual([ginza.sign?.code, ginza.stations[0].name, ginza.stations[15].number], ["G", "渋谷", 16]);
});

test("角を円弧で丸める。駅を置いた角はそのまま", () => {
  const { points, map } = roundCorners([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], 30);
  assert.deepEqual(points[0], { x: 0, y: 0 });
  assert.deepEqual(points[points.length - 1], { x: 100, y: 100 });
  // 90° の角は半径 30 の円弧になり、中点は角から r(√2 - 1) だけ内側
  const mid = points[map[1]];
  assert.ok(Math.abs(Math.hypot(100 - mid.x, mid.y) - 30 * (Math.SQRT2 - 1)) < 0.5);
  // 直線の頂点（曲がらない）はそのまま
  const straight = roundCorners([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }], 30);
  assert.deepEqual(straight.points, [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }]);
  // 駅を置いた角は丸めない
  const kept = roundCorners([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], 30, new Set([1]));
  assert.deepEqual(kept.points[kept.map[1]], { x: 100, y: 0 });
});

test("開路線は終点で折り返す", () => {
  const layout = layoutNetwork(networkLines, allIds, 1920, 1080).lines[1];
  const ride = new RideSession(layout, 12, 1, config, 0);
  ride.update(1); // 本駒込を発車
  ride.update(ride.phaseEnd); // 駒込に到着
  assert.equal(ride.stationIndex, 13);
  assert.equal(ride.nextStation, null);
  assert.deepEqual(ride.update(ride.phaseEnd), [{ type: "depart", from: 13, to: 12 }]);
  assert.equal(ride.direction, -1);
});

test("乗車駅では下車できず、次の駅からは下車できる", () => {
  const layout = layoutLine(yamanote, 1920, 1080);
  const ride = new RideSession(layout, 5, 1, { ...config, delayProbability: 1 }, 0, () => 0);
  assert.equal(ride.canAlight, false);
  ride.update(1); // 乗車駅で遅延
  assert.equal(ride.phase, "delayed");
  assert.equal(ride.canAlight, false);
  ride.update(ride.phaseEnd); // 発車
  assert.equal(ride.canAlight, false);
  ride.update(ride.phaseEnd); // 到着
  assert.equal(ride.stationIndex, 6);
  assert.equal(ride.canAlight, true);
});

test("一時停止した分だけ発車が遅れる", () => {
  const layout = layoutLine(yamanote, 1920, 1080);
  const ride = new RideSession(layout, 0, 1, config, 0);
  ride.shift(10);
  assert.deepEqual(ride.update(1), []);
  assert.equal(ride.update(11)[0].type, "depart");
});
