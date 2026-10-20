// SVG による路線図・車両の描画
import type { LineLayout } from "../domain/layout.ts";
import type { Direction, Point } from "../domain/types.ts";

/** 駅の前後に表示する、乗車方向を選ぶ矢印 */
export interface BoardArrow {
  direction: Direction;
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
  private stationNodes: SVGGElement[] = [];
  private train: SVGGElement | null = null;
  private arrows: SVGGElement | null = null;
  private near: number | null = null;
  private hover: number | null = null;

  constructor(svg: SVGSVGElement) {
    this.svg = svg;
  }

  render(layout: LineLayout, width: number, height: number): void {
    const { svg } = this;
    svg.replaceChildren();
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.style.setProperty("--line-color", layout.line.color);

    const d = layout.path.toSvgPath();
    el("path", { d, class: "rail-shadow" }, svg);
    el("path", { d, class: "rail" }, svg);
    el("path", { d, class: "rail-ties" }, svg);

    const stations = el("g", { class: "stations" }, svg);
    this.stationNodes = layout.stations.map((st) => {
      const g = el(
        "g",
        { class: "station", transform: `translate(${st.point.x},${st.point.y})`, "data-interactive": "", "data-station": st.index },
        stations,
      );
      el("circle", { r: 24, class: "station-hit" }, g);
      el("circle", { r: 8, class: "station-dot" }, g);
      const { x: nx, y: ny } = st.inward;
      const label = el("text", { class: "station-label", x: nx * 18, y: ny * 18 }, g);
      label.setAttribute("text-anchor", nx > 0.6 ? "start" : nx < -0.6 ? "end" : "middle");
      label.setAttribute("dominant-baseline", ny > 0.6 ? "hanging" : ny < -0.6 ? "auto" : "central");
      label.textContent = st.def.name;
      return g;
    });

    this.arrows = el("g", { class: "board-arrows" }, svg);

    this.train = this.buildTrain();
    this.train.style.display = "none";
    svg.appendChild(this.train);
    this.near = this.hover = null;
  }

  private buildTrain(): SVGGElement {
    const g = el("g", { class: "train" });
    const body = el("g", { class: "train-body" }, g);
    el("rect", { x: -32, y: -12, width: 64, height: 24, rx: 7, class: "car" }, body);
    el("rect", { x: -32, y: 4, width: 64, height: 4, class: "car-stripe" }, body);
    for (let i = 0; i < 5; i++) el("rect", { x: -26 + i * 10, y: -8, width: 7, height: 8, rx: 1.5, class: "car-window" }, body);
    el("rect", { x: 22, y: -10, width: 9, height: 20, rx: 4, class: "car-front" }, body);
    return g;
  }

  showBoardArrows(arrows: BoardArrow[]): void {
    if (!this.arrows) return;
    this.arrows.replaceChildren();
    for (const a of arrows) {
      const g = el(
        "g",
        { class: "board-arrow", "data-interactive": "", "data-board-dir": a.direction, transform: `translate(${a.point.x},${a.point.y})` },
        this.arrows,
      );
      el("circle", { r: 19, class: "board-arrow-bg" }, g);
      el("path", { d: "M-6,-9 L6,0 L-6,9", class: "board-arrow-chevron", transform: `rotate(${(a.angle * 180) / Math.PI})` }, g);
      const { x: ox, y: oy } = a.outward;
      let lx = ox * 30;
      let anchor = ox > 0.6 ? "start" : ox < -0.6 ? "end" : "middle";
      if (anchor === "middle") {
        // 上下の辺では、ラベルを進行方向側へ伸ばして左右の矢印のラベルが重ならないようにする
        const forward = Math.cos(a.angle) >= 0;
        anchor = forward ? "start" : "end";
        lx += forward ? -16 : 16;
      }
      const label = el("text", { class: "board-arrow-label", x: lx, y: oy * 30 }, g);
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

  setNear(index: number | null): void {
    if (index === this.near) return;
    if (this.near !== null) this.stationNodes[this.near]?.classList.remove("near");
    if (index !== null) this.stationNodes[index]?.classList.add("near");
    this.near = index;
  }

  setHover(index: number | null): void {
    if (index === this.hover) return;
    if (this.hover !== null) this.stationNodes[this.hover]?.classList.remove("hover");
    if (index !== null) this.stationNodes[index]?.classList.add("hover");
    this.hover = index;
  }

  showTrain(point: Point, angle: number, state: "stopped" | "running" | "delayed"): void {
    if (!this.train) return;
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
