// 路線図の上に重ねる案内（HUD）の置き場所を探す
import type { Point } from "../domain/types.ts";

/** 避けたいもの（中心と半径） */
export interface Obstacle {
  x: number;
  y: number;
  r: number;
}

const STEP = 16;

function hits(o: Obstacle, x: number, y: number, w: number, h: number): boolean {
  const cx = Math.min(Math.max(o.x, x), x + w);
  const cy = Math.min(Math.max(o.y, y), y + h);
  return Math.hypot(o.x - cx, o.y - cy) < o.r;
}

/**
 * 幅 w・高さ h の長方形を、重なる障害物が最も少なく、同じなら prefer に最も近い位置に置く。
 * 戻り値は左上の座標と、重なった障害物の数（0 なら重なりなし）。置ける場所が無ければ null
 */
export function findFreeRect(
  obstacles: readonly Obstacle[],
  w: number,
  h: number,
  width: number,
  height: number,
  prefer: Point,
  margin = 12,
): { at: Point; hits: number } | null {
  const candidates: Point[] = [];
  for (let y = margin; y + h <= height - margin; y += STEP) {
    for (let x = margin; x + w <= width - margin; x += STEP) candidates.push({ x, y });
  }
  const dist = (c: Point) => Math.hypot(c.x + w / 2 - prefer.x, c.y + h / 2 - prefer.y);
  candidates.sort((a, b) => dist(a) - dist(b));
  let best: { at: Point; hits: number } | null = null;
  for (const at of candidates) {
    const n = obstacles.reduce((sum, o) => sum + (hits(o, at.x, at.y, w, h) ? 1 : 0), 0);
    if (n === 0) return { at, hits: 0 };
    if (!best || n < best.hits) best = { at, hits: n };
  }
  return best;
}
