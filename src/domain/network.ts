// 複数の路線をまとめて配置する。山手線の環を基準に、他の路線はその駅を起点に
// 縦横と 45° の直線でデフォルメした経路で描く。
import { Path, roundedRectFrame } from "./geometry.ts";
import { layoutLine, stationAt, type LineLayout, type Rect } from "./layout.ts";
import type { LineDef, Point, RouteNode, RouteShape } from "./types.ts";

/** 複数の路線に属する駅（乗換駅）をまとめたもの */
export interface StationGroup {
  /** 駅 ID（路線をまたいで同じ駅は同じ ID） */
  id: string;
  /** 所属する路線と駅。先頭が駅名を出す路線 */
  members: { line: number; station: number }[];
  /** 駅名を置く向き（単位ベクトル） */
  labelDir: Point;
}

export interface NetworkLayout {
  /** 表示する路線（引数の順） */
  lines: LineLayout[];
  groups: StationGroup[];
  /** 山手線の環を描く範囲 */
  frame: Rect;
  /** route の路線の駅間隔 [CSS px] */
  spacing: number;
}

const DIRECTIONS_8 = Array.from({ length: 8 }, (_, i) => ({ x: Math.cos((i * Math.PI) / 4), y: Math.sin((i * Math.PI) / 4) }));
/** 駅の点から駅名までの距離 [CSS px]（ui/map.ts と合わせる） */
export const LABEL_OFFSET = 18;
/** 駅名の 1 文字の幅と高さの目安 [CSS px] */
const LABEL_CHAR = 14;
const LABEL_HEIGHT = 16;

const angleBetween = (a: Point, b: Point) => Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y)));

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 駅名の文字列が占める範囲（ui/map.ts の text-anchor / dominant-baseline の決め方と合わせる） */
export function labelBox(at: Point, dir: Point, name: string): Box {
  const w = name.length * LABEL_CHAR + 4;
  const h = LABEL_HEIGHT;
  const x = at.x + dir.x * LABEL_OFFSET;
  const y = at.y + dir.y * LABEL_OFFSET;
  const x0 = dir.x > 0.3 ? x : dir.x < -0.3 ? x - w : x - w / 2;
  const y0 = dir.y > 0.3 ? y : dir.y < -0.3 ? y - h : y - h / 2;
  return { x0, y0, x1: x0 + w, y1: y0 + h };
}

const overlapArea = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
const inside = (p: Point, b: Box, pad: number) => p.x > b.x0 - pad && p.x < b.x1 + pad && p.y > b.y0 - pad && p.y < b.y1 + pad;

/** 前後の頂点を縦横の直線と 45° の斜線でつなぐ曲がり角 */
export function diagonalBend(p: Point, q: Point, via: "diag-first" | "diag-last"): Point {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const d = Math.abs(dy);
    return via === "diag-last" ? { x: q.x - Math.sign(dx) * d, y: p.y } : { x: p.x + Math.sign(dx) * d, y: q.y };
  }
  const d = Math.abs(dx);
  return via === "diag-last" ? { x: p.x, y: q.y - Math.sign(dy) * d } : { x: q.x, y: p.y + Math.sign(dy) * d };
}

/** 円弧を近似する点の数（90° あたり） */
const ARC_STEPS_PER_RIGHT_ANGLE = 12;

/**
 * 折れ線の角を円弧で丸める（山手線の角丸と見た目をそろえる）。
 * 隣の角の円弧と重ならないよう、各辺の 45% までに収める。
 * keep に含めた頂点（駅を置く角。駅の点が角を隠す）は丸めず、位置をそのまま残す。
 * 戻り値の map[i] は元の頂点 i に対応する新しい点の添字
 */
export function roundCorners(points: readonly Point[], radius: number, keep: ReadonlySet<number> = new Set()): { points: Point[]; map: number[] } {
  const out: Point[] = [points[0]];
  const map = [0];
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1], p = points[i], b = points[i + 1];
    const l1 = Math.hypot(p.x - a.x, p.y - a.y), l2 = Math.hypot(b.x - p.x, b.y - p.y);
    const u1 = { x: (p.x - a.x) / l1, y: (p.y - a.y) / l1 };
    const u2 = { x: (b.x - p.x) / l2, y: (b.y - p.y) / l2 };
    const turn = Math.acos(Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y)));
    if (keep.has(i) || !(l1 > 0 && l2 > 0) || turn < 1e-3) {
      map.push(out.length);
      out.push(p);
      continue;
    }
    // 角から円弧の端までの距離
    const t = Math.min(radius * Math.tan(turn / 2), l1 * 0.45, l2 * 0.45);
    const r = t / Math.tan(turn / 2);
    const t1 = { x: p.x - u1.x * t, y: p.y - u1.y * t };
    // 曲がる側への法線
    const side = u1.x * u2.y - u1.y * u2.x > 0 ? 1 : -1;
    const c = { x: t1.x - u1.y * r * side, y: t1.y + u1.x * r * side };
    const a1 = Math.atan2(t1.y - c.y, t1.x - c.x);
    const steps = Math.max(2, Math.ceil((turn / (Math.PI / 2)) * ARC_STEPS_PER_RIGHT_ANGLE / 2) * 2);
    for (let k = 0; k <= steps; k++) {
      if (k === steps / 2) map.push(out.length);
      const ang = a1 + side * turn * (k / steps);
      out.push({ x: c.x + r * Math.cos(ang), y: c.y + r * Math.sin(ang) });
    }
  }
  map.push(out.length);
  out.push(points[points.length - 1]);
  return { points: out, map };
}

function layoutRoute(line: LineDef, shape: RouteShape, frame: Rect, spacing: number, radius: number, placed: Map<string, Point>): LineLayout {
  const local = new Map<string, Point>();
  const ref = (key: string): Point => {
    const p = key.includes(":") ? placed.get(key) : local.get(key);
    if (!p) throw new Error(`${line.id}: ${key} はまだ配置されていません`);
    return p;
  };
  const coord = (v: number | string | undefined, axis: "x" | "y"): number => {
    if (v === undefined) throw new Error(`${line.id}: 座標 ${axis} がありません`);
    if (typeof v === "string") return ref(v)[axis];
    return axis === "x" ? frame.x0 + v * (frame.x1 - frame.x0) : frame.y0 + v * (frame.y1 - frame.y0);
  };
  const place = (node: RouteNode): Point => {
    const base = node.at ? ref(`${node.at}:${node.station}`) : { x: coord(node.x, "x"), y: coord(node.y, "y") };
    return { x: base.x + (node.dx ?? 0) * spacing, y: base.y + (node.dy ?? 0) * spacing };
  };

  const points: (Point | null)[] = shape.nodes.map(() => null);
  shape.nodes.forEach((node, i) => {
    if (node.via) return;
    points[i] = place(node);
    if (node.station) local.set(node.station, points[i]!);
  });
  shape.nodes.forEach((node, i) => {
    if (!node.via) return;
    const p = points[i - 1];
    const q = points[i + 1];
    if (!p || !q) throw new Error(`${line.id}: 曲がり角の前後には座標のある頂点が必要です`);
    points[i] = diagonalBend(p, q, node.via);
  });
  // 駅を置いた角は丸めない（乗換駅の位置を他の路線とそろえたままにする）
  const stationVertices = new Set(shape.nodes.flatMap((node, i) => (node.station ? [i] : [])));
  const rounded = roundCorners(points as Point[], radius, stationVertices);
  const path = new Path(rounded.points, false);

  // 経路に書いた駅は頂点に、書いていない駅は前後の駅の間に等間隔で置く
  const anchors = new Map<number, number>();
  shape.nodes.forEach((node, i) => {
    if (!node.station) return;
    const index = line.stations.findIndex((s) => s.id === node.station);
    if (index < 0) throw new Error(`${line.id}: 駅 ${node.station} がありません`);
    anchors.set(index, path.cumulative[rounded.map[i]]);
  });
  const n = line.stations.length;
  if (!anchors.has(0) || !anchors.has(n - 1)) throw new Error(`${line.id}: 始点と終点の駅は経路に書いてください`);
  const stations = line.stations.map((def, index) => {
    let s = anchors.get(index);
    if (s === undefined) {
      let a = index - 1;
      while (!anchors.has(a)) a--;
      let b = index + 1;
      while (!anchors.has(b)) b++;
      s = anchors.get(a)! + ((index - a) / (b - a)) * (anchors.get(b)! - anchors.get(a)!);
    }
    return stationAt(def, index, path, s);
  });
  return { line, path, stations };
}

/** 枠 frame で全路線を配置する（route は前に配置した路線の駅を参照できる） */
function layoutAll(lines: readonly LineDef[], width: number, height: number, frame: Rect, spacing: number): Map<string, LineLayout> {
  const placed = new Map<string, Point>();
  // 角の丸めは山手線の角丸と同じ半径にする
  const ring = lines.find((l) => l.shape.type === "roundedRect");
  const radius = ring?.shape.type === "roundedRect" ? Math.min(width, height) * ring.shape.cornerRadius : spacing;
  const result = new Map<string, LineLayout>();
  for (const line of lines) {
    const layout =
      line.shape.type === "route" ? layoutRoute(line, line.shape, frame, spacing, radius, placed) : layoutLine(line, width, height, frame);
    for (const st of layout.stations) placed.set(`${line.id}:${st.def.id}`, st.point);
    result.set(line.id, layout);
  }
  return result;
}

/**
 * 駅をまとめ、駅名の向きを決める。
 * 駅名は路線の内側（両側に交互に置く路線では奇数番目を外側）を基本に、線路・駅・他の駅名・画面の端と
 * 重なる場合は重ならない向きに出す。乗換駅から順に決める
 */
function buildGroups(layouts: LineLayout[], width: number, height: number): StationGroup[] {
  const byId = new Map<string, StationGroup["members"]>();
  layouts.forEach((layout, line) =>
    layout.stations.forEach((st, station) => {
      const key = st.def.group ?? st.def.id;
      const members = byId.get(key) ?? [];
      members.push({ line, station });
      byId.set(key, members);
    }),
  );
  const groups = [...byId].map(([id, members]) => ({ id, members, labelDir: { x: 0, y: 0 } }));

  const track: Point[] = [];
  for (const { path } of layouts) for (let s = 0; s <= path.length; s += 6) track.push(path.pointAt(s));
  const dots = layouts.flatMap((l) => l.stations.map((st) => st.point));
  const placed: Box[] = [];
  const order = [...groups].sort((a, b) => b.members.length - a.members.length);
  for (const group of order) {
    const primary = layouts[group.members[0].line];
    const st = primary.stations[group.members[0].station];
    const flip = primary.line.labelSide === "alternate" && st.index % 2 === 1 ? -1 : 1;
    const preferred = { x: st.inward.x * flip, y: st.inward.y * flip };
    const cost = (dir: Point) => {
      const box = labelBox(st.point, dir, st.def.name);
      let c = 0;
      for (const p of placed) c += overlapArea(box, p) / 20;
      for (const p of track) if (inside(p, box, 4)) c += 3;
      for (const p of dots) if (inside(p, box, 7)) c += 20;
      if (box.x0 < 0 || box.y0 < 0 || box.x1 > width || box.y1 > height) c += 1000;
      // 迷ったら基本の向きに近いほうを選ぶ
      return c + angleBetween(dir, preferred);
    };
    group.labelDir = [preferred, ...DIRECTIONS_8].reduce((best, dir) => (cost(dir) < cost(best) ? dir : best));
    placed.push(labelBox(st.point, group.labelDir, st.def.name));
  }
  return groups;
}

/**
 * 路線網を画面に配置する。
 * @param lines 全路線（参照順。最初の角丸長方形の路線が基準の環）
 * @param visible 表示する路線 ID。表示する路線が画面に収まるよう、環を縮める
 */
export function layoutNetwork(lines: readonly LineDef[], visible: readonly string[], width: number, height: number): NetworkLayout {
  const ring = lines.find((l) => l.shape.type === "roundedRect");
  if (!ring || ring.shape.type !== "roundedRect") throw new Error("基準となる環状線がありません");
  const base = Math.min(width, height);
  const spacing = Math.min(60, Math.max(36, base * 0.042));
  const frame = roundedRectFrame(ring.shape, width, height);
  // 環の外に出る路線は、画面の端からこの余白をとる
  const pad = Math.max(40, (frame.x0 * 2) / 3);

  let layouts = layoutAll(lines, width, height, frame, spacing);
  for (let i = 0; i < 4; i++) {
    const shown = visible.flatMap((id) => layouts.get(id)?.path.points ?? []);
    const xs = shown.map((p) => p.x);
    const ys = shown.map((p) => p.y);
    const over = {
      left: pad - Math.min(...xs),
      right: Math.max(...xs) - (width - pad),
      top: pad - Math.min(...ys),
      bottom: Math.max(...ys) - (height - pad),
    };
    if (Math.max(over.left, over.right, over.top, over.bottom) < 0.5) break;
    frame.x0 += Math.max(0, over.left);
    frame.x1 -= Math.max(0, over.right);
    frame.y0 += Math.max(0, over.top);
    frame.y1 -= Math.max(0, over.bottom);
    layouts = layoutAll(lines, width, height, frame, spacing);
  }

  const shown = visible.flatMap((id) => layouts.get(id) ?? []);
  return { lines: shown, groups: buildGroups(shown, width, height), frame, spacing };
}

/** 位置 p に最も近い駅（乗換駅では最も近い路線の駅） */
export function nearestGroup(
  network: NetworkLayout,
  p: Point,
): { group: StationGroup; member: StationGroup["members"][number]; distance: number } {
  let best = { group: network.groups[0], member: network.groups[0].members[0], distance: Infinity };
  for (const group of network.groups) {
    for (const member of group.members) {
      const q = network.lines[member.line].stations[member.station].point;
      const distance = Math.hypot(q.x - p.x, q.y - p.y);
      if (distance < best.distance) best = { group, member, distance };
    }
  }
  return best;
}
