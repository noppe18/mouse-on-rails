// SVG による路線図・車両の描画
import type { LineLayout } from "../domain/layout.ts";
import type { Point } from "../domain/types.ts";

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
