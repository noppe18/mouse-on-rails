import type { Point, RoundedRectShape, ShapeDef } from "./types.ts";

/** 弧長でパラメータ化された折れ線 */
export class Path {
  readonly points: Point[];
  readonly closed: boolean;
  readonly cumulative: number[];
  readonly length: number;

  constructor(points: Point[], closed: boolean) {
    if (points.length < 2) throw new Error("Path needs at least 2 points");
    this.points = closed ? [...points, points[0]] : points;
    this.closed = closed;
    this.cumulative = [0];
    for (let i = 1; i < this.points.length; i++) {
      const a = this.points[i - 1];
      const b = this.points[i];
      this.cumulative.push(this.cumulative[i - 1] + Math.hypot(b.x - a.x, b.y - a.y));
    }
    this.length = this.cumulative[this.cumulative.length - 1];
  }

  /** 範囲外の s を閉路なら折り返し、開路なら端に丸める */
  normalize(s: number): number {
    if (this.closed) return ((s % this.length) + this.length) % this.length;
    return Math.min(Math.max(s, 0), this.length);
  }

  private segmentAt(s: number): number {
    let lo = 0;
    let hi = this.cumulative.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cumulative[mid] <= s) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  pointAt(s: number): Point {
    const ns = this.normalize(s);
    const i = this.segmentAt(ns);
    const a = this.points[i];
    const b = this.points[i + 1];
    const segLen = this.cumulative[i + 1] - this.cumulative[i];
    const k = segLen === 0 ? 0 : (ns - this.cumulative[i]) / segLen;
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
  }

  /** 進行方向の単位ベクトル */
  tangentAt(s: number): Point {
    const ns = this.normalize(s);
    const i = this.segmentAt(ns);
    const a = this.points[i];
    const b = this.points[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
  }

  toSvgPath(): string {
    const [first, ...rest] = this.points;
    const d = `M${first.x.toFixed(1)},${first.y.toFixed(1)} ` + rest.map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    return this.closed ? d + " Z" : d;
  }
}

const ARC_STEPS = 24;

/** 画面上で時計回り（y 軸下向き）に一周する角丸長方形。始点は上辺の左端 */
export function roundedRectPoints(x0: number, y0: number, x1: number, y1: number, r: number): Point[] {
  const radius = Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2);
  const corners = [
    { cx: x1 - radius, cy: y0 + radius, start: -Math.PI / 2 }, // 右上
    { cx: x1 - radius, cy: y1 - radius, start: 0 }, // 右下
    { cx: x0 + radius, cy: y1 - radius, start: Math.PI / 2 }, // 左下
    { cx: x0 + radius, cy: y0 + radius, start: Math.PI }, // 左上
  ];
  const pts: Point[] = [];
  for (const c of corners) {
    for (let i = 0; i <= ARC_STEPS; i++) {
      const a = c.start + (Math.PI / 2) * (i / ARC_STEPS);
      pts.push({ x: c.cx + radius * Math.cos(a), y: c.cy + radius * Math.sin(a) });
    }
  }
  // 上辺の左端を始点にするため、左上の弧の終点を先頭へ回す
  const last = pts.pop()!;
  return [last, ...pts];
}

/** 角丸長方形の路線を描く範囲（画面の端から余白をとる） */
export function roundedRectFrame(shape: RoundedRectShape, width: number, height: number) {
  const margin = Math.max(Math.min(width, height) * shape.margin, shape.minMarginPx ?? 0);
  return { x0: margin, y0: margin, x1: width - margin, y1: height - margin };
}

export function buildPath(
  shape: Exclude<ShapeDef, { type: "route" }>,
  width: number,
  height: number,
  frame?: { x0: number; y0: number; x1: number; y1: number },
): Path {
  switch (shape.type) {
    case "roundedRect": {
      const f = frame ?? roundedRectFrame(shape, width, height);
      const r = Math.min(width, height) * shape.cornerRadius;
      return new Path(roundedRectPoints(f.x0, f.y0, f.x1, f.y1, r), true);
    }
    case "polyline":
      return new Path(
        shape.points.map(([x, y]) => ({ x: x * width, y: y * height })),
        shape.closed,
      );
  }
}
