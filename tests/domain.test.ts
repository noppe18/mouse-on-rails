import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { layoutLine, segmentDistance, nextStationIndex } from "../src/domain/layout.ts";
import { RideSession, type OperationConfig } from "../src/domain/ride.ts";
import { newlyUnlocked, ridesUntilNextUnlock, unlockedCount } from "../src/domain/unlock.ts";
import type { Catalog, LineDef } from "../src/domain/types.ts";

const yamanote: LineDef = JSON.parse(readFileSync(new URL("../src/data/lines/yamanote.json", import.meta.url), "utf8"));
const catalog: Catalog = JSON.parse(readFileSync(new URL("../src/data/catalog.json", import.meta.url), "utf8"));

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
  assert.deepEqual(newlyUnlocked(catalog, 3, ["yamanote"]).map((l) => l.id), ["chuo"]);
  assert.deepEqual(newlyUnlocked(catalog, 3, ["yamanote", "chuo"]), []);
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
