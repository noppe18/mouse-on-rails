import { buildPath, Path } from "./geometry.ts";
import type { Direction, LineDef, Point, StationDef, StationLayoutDef } from "./types.ts";

export interface StationLayout {
  def: StationDef;
  index: number;
  /** 路線始点からの弧長 */
  s: number;
  point: Point;
  /** 路線の内側を向く法線 */
  inward: Point;
}

export interface LineLayout {
  line: LineDef;
  path: Path;
  stations: StationLayout[];
}

/** 路線データを画面サイズに合わせて配置する */
export function layoutLine(line: LineDef, width: number, height: number): LineLayout {
  const path = buildPath(line.shape, width, height);
  const n = line.stations.length;
  const mode: StationLayoutDef = line.stationLayout ?? { mode: "even" };
  if (mode.mode === "vertices" && path.cumulative.length - (path.closed ? 1 : 0) !== n) {
    throw new Error(`${line.id}: 頂点数と駅数が一致しません`);
  }
  const startT = mode.mode === "even" ? (mode.startT ?? 0) : 0;
  const stations = line.stations.map((def, index) => {
    let s: number;
    if (def.t !== undefined) {
      s = path.normalize(def.t * path.length);
    } else if (mode.mode === "vertices") {
      s = path.cumulative[index];
    } else {
      const t = line.loop ? startT + index / n : startT + (index / Math.max(n - 1, 1)) * (1 - startT);
      s = path.normalize(t * path.length);
    }
    const tan = path.tangentAt(s);
    // 時計回りの経路では (-ty, tx) が内側
    return { def, index, s, point: path.pointAt(s), inward: { x: -tan.y, y: tan.x } };
  });
  return { line, path, stations };
}

/** 隣の駅のインデックス。開路線の終端では null */
export function nextStationIndex(layout: LineLayout, index: number, direction: Direction): number | null {
  const n = layout.stations.length;
  const next = index + direction;
  if (layout.line.loop) return (next + n) % n;
  return next < 0 || next >= n ? null : next;
}

/** 駅間の走行距離（進行方向に沿った弧長） */
export function segmentDistance(layout: LineLayout, from: number, to: number, direction: Direction): number {
  const a = layout.stations[from].s;
  const b = layout.stations[to].s;
  if (!layout.path.closed) return Math.abs(b - a);
  const L = layout.path.length;
  return direction === 1 ? (((b - a) % L) + L) % L : (((a - b) % L) + L) % L;
}

export function nearestStation(layout: LineLayout, p: Point): { station: StationLayout; distance: number } {
  let best = layout.stations[0];
  let bestD = Infinity;
  for (const st of layout.stations) {
    const d = Math.hypot(st.point.x - p.x, st.point.y - p.y);
    if (d < bestD) {
      best = st;
      bestD = d;
    }
  }
  return { station: best, distance: bestD };
}
