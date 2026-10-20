// SVG による路線図・車両の描画
import { LABEL_OFFSET, type NetworkLayout } from "../domain/network.ts";
import type { Direction, Point, VehicleDef } from "../domain/types.ts";

/** 駅の前後に表示する、乗車方向を選ぶ矢印 */
export interface BoardArrow {
  /** NetworkLayout.lines の添字 */
  line: number;
  color: string;
  direction: Direction;
  /** 矢印からラベルまでの距離 */
  labelGap: number;
  point: Point;
  /** 進行方向（ラジアン） */
  angle: number;
  /** ラベルを置く向き（路線の外側） */
  outward: Point;
  title: string;
  subtitle: string;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, parent?: Element) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.appendChild(node);
  return node;
}

export class MapView {
  private readonly svg: SVGSVGElement;
  private stationNodes = new Map<string, SVGGElement>();
  private train: SVGGElement | null = null;
  private trainVehicle: VehicleDef | null = null;
  private arrows: SVGGElement | null = null;
  private near: string | null = null;
  private hover: string | null = null;

  constructor(svg: SVGSVGElement) {
    this.svg = svg;
  }

  render(network: NetworkLayout, width: number, height: number): void {
    const { svg } = this;
    svg.replaceChildren();
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

    // 線路は全路線の影を先に描き、交差部でも線路が途切れて見えないようにする
    const paths = network.lines.map((l) => ({ d: l.path.toSvgPath(), color: l.line.color, id: l.line.id }));
    // pathLength=1 にして、開業演出で線路を端から描けるようにする
    for (const { d, id } of paths) el("path", { d, class: "rail-shadow", "data-line": id, pathLength: 1 }, svg);
    for (const { d, color, id } of paths) {
      el("path", { d, class: "rail", style: `--line-color:${color}`, "data-line": id, pathLength: 1 }, svg);
      el("path", { d, class: "rail-ties", "data-line": id }, svg);
    }

    const stations = el("g", { class: "stations" }, svg);
    this.stationNodes.clear();
    for (const group of network.groups) {
      const points = group.members.map((m) => network.lines[m.line].stations[m.station].point);
      const primary = network.lines[group.members[0].line];
      const g = el(
        "g",
        { class: "station", "data-interactive": "", "data-station": group.id, style: `--line-color:${primary.line.color}` },
        stations,
      );
      if (group.members.length > 1) g.classList.add("transfer");
      // 乗換駅で路線ごとの駅が離れていれば連絡線でつなぐ
      const distinct = points.filter((p, i) => points.findIndex((q) => Math.hypot(p.x - q.x, p.y - q.y) < 1) === i);
      if (distinct.length > 1) {
        const d = distinct.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
        el("path", { d, class: "transfer-link-outline" }, g);
        el("path", { d, class: "transfer-link" }, g);
      }
      for (const p of distinct) {
        el("circle", { cx: p.x, cy: p.y, r: 24, class: "station-hit" }, g);
        el("circle", { cx: p.x, cy: p.y, r: group.members.length > 1 ? 9 : 8, class: "station-dot" }, g);
      }
      const at = points[0];
      const { x: nx, y: ny } = group.labelDir;
      const label = el("text", { class: "station-label", x: at.x + nx * LABEL_OFFSET, y: at.y + ny * LABEL_OFFSET }, g);
      label.setAttribute("text-anchor", nx > 0.3 ? "start" : nx < -0.3 ? "end" : "middle");
      label.setAttribute("dominant-baseline", ny > 0.3 ? "hanging" : ny < -0.3 ? "auto" : "central");
      label.textContent = primary.stations[group.members[0].station].def.name;
      this.stationNodes.set(group.id, g);
    }

    this.arrows = el("g", { class: "board-arrows" }, svg);
    this.train = null;
    this.trainVehicle = null;
    this.near = this.hover = null;
  }

  /** 進行方向 = +x の車両（1 両）。塗装は路線データに従う */
  private buildTrain(v: VehicleDef): SVGGElement {
    const g = el("g", { class: "train" });
    const body = el("g", { class: "train-body" }, g);
    el("rect", { x: -32, y: -12, width: 64, height: 24, rx: 7, class: "car", fill: v.body }, body);
    if (v.doorBands) {
      // ドア部分の帯（E235 系風）
      for (const x of [-21, -11, -1, 9]) el("rect", { x, y: -11, width: 4, height: 22, fill: v.band }, body);
    }
    if (v.topBand) el("rect", { x: -31, y: -10, width: 56, height: 2.5, fill: v.topBand }, body);
    el("rect", { x: -32, y: 3, width: 57, height: 4, fill: v.band }, body);
    if (v.subBand) el("rect", { x: -32, y: 7, width: 57, height: 1.8, fill: v.subBand }, body);
    for (let i = 0; i < 5; i++) el("rect", { x: -27 + i * 10, y: -7, width: 6, height: 8, rx: 1.5, class: "car-window" }, body);
    // 前面：顔の色、運転台の窓、アクセント
    el("path", { d: "M24,-12 H25 Q32,-12 32,-5 V5 Q32,12 25,12 H24 Z", fill: v.face, class: "car-face" }, body);
    el("rect", { x: 24.5, y: -9, width: 4.5, height: 18, rx: 2, class: "car-front-window" }, body);
    el("rect", { x: 29.6, y: -8, width: 1.6, height: 16, rx: 0.8, fill: v.faceAccent }, body);
    el("circle", { cx: 30.5, cy: -10, r: 1.3, class: "car-light" }, body);
    el("circle", { cx: 30.5, cy: 10, r: 1.3, class: "car-light" }, body);
    return g;
  }

  /** 開業した路線を強調する（線路を端から描き、光らせる）。空配列で解除 */
  highlightLines(ids: readonly string[]): void {
    for (const path of this.svg.querySelectorAll<SVGPathElement>("path[data-line]")) {
      path.classList.toggle("opening", ids.includes(path.dataset.line!));
    }
  }

  showBoardArrows(arrows: BoardArrow[]): void {
    if (!this.arrows) return;
    this.arrows.replaceChildren();
    for (const a of arrows) {
      const g = el(
        "g",
        {
          class: "board-arrow",
          "data-interactive": "",
          "data-board-line": a.line,
          "data-board-dir": a.direction,
          transform: `translate(${a.point.x},${a.point.y})`,
          style: `--line-color:${a.color}`,
        },
        this.arrows,
      );
      el("circle", { r: 19, class: "board-arrow-bg" }, g);
      el("path", { d: "M-6,-9 L6,0 L-6,9", class: "board-arrow-chevron", transform: `rotate(${(a.angle * 180) / Math.PI})` }, g);
      const { x: ox, y: oy } = a.outward;
      const gap = a.labelGap;
      let lx = ox * gap;
      let anchor = ox > 0.6 ? "start" : ox < -0.6 ? "end" : "middle";
      if (anchor === "middle") {
        // 上下の辺では、ラベルを進行方向側へ伸ばして左右の矢印のラベルが重ならないようにする
        const forward = Math.cos(a.angle) >= 0;
        anchor = forward ? "start" : "end";
        lx += forward ? -16 : 16;
      }
      const label = el("text", { class: "board-arrow-label", x: lx, y: oy * gap }, g);
      label.setAttribute("text-anchor", anchor);
      // 上側に出すラベルは2行目が下にはみ出さないよう持ち上げる
      const firstDy = oy < -0.6 ? "-1.1em" : oy > 0.6 ? "0.9em" : "-0.2em";
      const t1 = el("tspan", { x: lx, dy: firstDy, class: "board-arrow-title" }, label);
      t1.textContent = a.title;
      const t2 = el("tspan", { x: lx, dy: "1.25em" }, label);
      t2.textContent = a.subtitle;
    }
  }

  hideBoardArrows(): void {
    this.arrows?.replaceChildren();
  }

  setNear(index: string | null): void {
    if (index === this.near) return;
    if (this.near !== null) this.stationNodes.get(this.near)?.classList.remove("near");
    if (index !== null) this.stationNodes.get(index)?.classList.add("near");
    this.near = index;
  }

  setHover(index: string | null): void {
    if (index === this.hover) return;
    if (this.hover !== null) this.stationNodes.get(this.hover)?.classList.remove("hover");
    if (index !== null) this.stationNodes.get(index)?.classList.add("hover");
    this.hover = index;
  }

  showTrain(vehicle: VehicleDef, point: Point, angle: number, state: "stopped" | "running" | "delayed"): void {
    if (!this.train || this.trainVehicle !== vehicle) {
      this.train?.remove();
      this.train = this.buildTrain(vehicle);
      this.trainVehicle = vehicle;
      this.svg.appendChild(this.train);
    }
    this.train.style.display = "";
    this.train.setAttribute("transform", `translate(${point.x},${point.y}) rotate(${(angle * 180) / Math.PI})`);
    this.train.dataset.state = state;
  }

  hideTrain(): void {
    if (this.train) this.train.style.display = "none";
  }

  shakeTrain(): void {
    const body = this.train?.querySelector(".train-body");
    if (!body) return;
    body.classList.remove("shake");
    void (body as SVGGElement).getBBox();
    body.classList.add("shake");
  }
}
