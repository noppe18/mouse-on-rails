// 駅名標を SVG で生成する
const SVG_NS = "http://www.w3.org/2000/svg";

const WIDTH = 640;
const HEIGHT = 200;
const NAME_SIZE = 50;

export interface SignNeighbor {
  name: string;
  romaji?: string;
  number?: number;
}

export interface StationSignData {
  /** デザイン（JR 東日本風 / 東京メトロ風） */
  style: "jr-east" | "tokyo-metro";
  lineName: string;
  lineNameEn: string;
  /** 路線記号（例: JY） */
  lineCode?: string;
  /** 駅ナンバリングの枠と帯中央の色 */
  lineColor: string;
  /** 帯の色 */
  barColor: string;
  /** 右上の特定都区市内の表示（例: 山） */
  areaMark?: string;
  station: {
    name: string;
    kana?: string;
    romaji?: string;
    number?: number;
    /** スリーレターコード（例: TYO） */
    code?: string;
  };
  left: SignNeighbor | null;
  right: SignNeighbor | null;
  /** 帯の矢印の向き（進行方向） */
  arrow: "left" | "right" | "none";
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent: Element, text?: string) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text !== undefined) node.textContent = text;
  parent.appendChild(node);
  return node;
}

/** 文字数に応じた駅名の字間（短い駅名ほど広げる） */
function letterSpacing(length: number): number {
  if (length <= 2) return 0.6;
  if (length === 3) return 0.2;
  return 0;
}

function numberBadge(svg: SVGSVGElement, data: StationSignData, x: number) {
  const { lineCode, lineColor, station } = data;
  if (station.number === undefined || !lineCode) return;
  const g = el("g", { class: "sign-badge", transform: `translate(${x},0)` }, svg);
  const innerY = station.code ? 34 : 24;
  if (station.code) {
    el("rect", { x: -26, y: 12, width: 52, height: 78, rx: 7, fill: "#222" }, g);
    el("text", { x: 0, y: 28, "text-anchor": "middle", fill: "#fff", "font-size": 11, "font-weight": 700 }, g, station.code);
  }
  el("rect", { x: -21, y: innerY, width: 42, height: 52, rx: 5, fill: "#fff", stroke: lineColor, "stroke-width": 5 }, g);
  el("text", { x: 0, y: innerY + 20, "text-anchor": "middle", fill: "#222", "font-size": 13, "font-weight": 700 }, g, lineCode);
  el(
    "text",
    { x: 0, y: innerY + 43, "text-anchor": "middle", fill: "#222", "font-size": 22, "font-weight": 900 },
    g,
    String(station.number).padStart(2, "0"),
  );
}

function areaMark(svg: SVGSVGElement, mark: string) {
  const g = el("g", { class: "sign-area" }, svg);
  [mark, "区"].forEach((ch, i) => {
    const x = WIDTH - 72 + i * 28;
    el("rect", { x, y: 16, width: 24, height: 24, fill: "#fff", stroke: "#222", "stroke-width": 2 }, g);
    el("text", { x: x + 12, y: 34, "text-anchor": "middle", fill: "#222", "font-size": 16, "font-weight": 900 }, g, ch);
  });
}

function bar(svg: SVGSVGElement, data: StationSignData) {
  const top = 122;
  const h = 30;
  const left = 24;
  const right = WIDTH - 24;
  const tip = 16;
  const mid = top + h / 2;
  // 進行方向の端だけ矢印の形にする
  const l = data.arrow === "left" ? [`${left - 4},${mid}`, `${left + tip},${top}`] : [`${left},${top}`];
  const r = data.arrow === "right" ? [`${right - tip},${top}`, `${right + 4},${mid}`, `${right - tip},${top + h}`] : [`${right},${top}`, `${right},${top + h}`];
  const lb = data.arrow === "left" ? [`${left + tip},${top + h}`] : [`${left},${top + h}`];
  el("polygon", { points: [...l, ...r, ...lb].join(" "), fill: data.barColor }, svg);
  el("rect", { x: WIDTH / 2 - 22, y: top, width: 44, height: h, fill: data.lineColor }, svg);

  const textY = top + 21;
  const attrs = { fill: "#fff", "font-size": 17, "font-weight": 700 };
  if (data.left) el("text", { ...attrs, x: left + (data.arrow === "left" ? 26 : 14), y: textY }, svg, data.left.name);
  if (data.right) {
    el("text", { ...attrs, x: right - (data.arrow === "right" ? 26 : 14), y: textY, "text-anchor": "end" }, svg, data.right.name);
  }
}

function signRoot(data: StationSignData): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${WIDTH} ${HEIGHT}`);
  svg.setAttribute("class", "station-sign");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${data.station.name}駅`);
  return svg;
}

/** 駅名を最大幅に収める属性 */
function fitName(attrs: Record<string, string | number>, length: number, size: number, maxWidth: number) {
  if (length * size > maxWidth) {
    attrs.textLength = maxWidth;
    attrs.lengthAdjust = "spacingAndGlyphs";
  }
  return attrs;
}

/** 東京メトロ風の丸い駅ナンバリング */
function metroBadge(parent: Element, code: string, number: number, cx: number, cy: number, r: number, color: string) {
  const g = el("g", { class: "sign-badge" }, parent);
  el("circle", { cx, cy, r, fill: "#fff", stroke: color, "stroke-width": r * 0.3 }, g);
  el("text", { x: cx, y: cy - r * 0.12, "text-anchor": "middle", fill: "#222", "font-size": r * 0.5, "font-weight": 700 }, g, code);
  el(
    "text",
    { x: cx, y: cy + r * 0.5, "text-anchor": "middle", fill: "#222", "font-size": r * 0.72, "font-weight": 900 },
    g,
    String(number).padStart(2, "0"),
  );
}

/** 東京メトロ風: 上部に路線名の帯、丸い駅ナンバリング、下部の灰色の帯に隣の駅 */
function buildMetroSign(data: StationSignData): SVGSVGElement {
  const svg = signRoot(data);
  const { station, lineColor, lineCode } = data;
  el("rect", { x: 3, y: 3, width: WIDTH - 6, height: HEIGHT - 6, rx: 8, fill: "#fff", stroke: "#3a3f44", "stroke-width": 4 }, svg);
  el("path", { d: `M3,36 V11 Q3,3 11,3 H${WIDTH - 11} Q${WIDTH - 3},3 ${WIDTH - 3},11 V36 Z`, fill: lineColor }, svg);
  el("text", { x: 22, y: 26, fill: "#fff", "font-size": 17, "font-weight": 900 }, svg, data.lineName);
  el("text", { x: 22 + data.lineName.length * 17 + 12, y: 26, fill: "#fff", "font-size": 13, "font-weight": 700 }, svg, data.lineNameEn);

  if (lineCode && station.number !== undefined) metroBadge(svg, lineCode, station.number, 78, 88, 32, lineColor);
  el("text", fitName({ x: WIDTH / 2 + 30, y: 98, "text-anchor": "middle", fill: "#111", "font-size": 46, "font-weight": 900 }, station.name.length, 46, 380), svg, station.name);
  if (station.kana) {
    el("text", { x: WIDTH / 2 + 30, y: 122, "text-anchor": "middle", fill: "#333", "font-size": 13, "font-weight": 700, "letter-spacing": "0.15em" }, svg, station.kana);
  }
  if (station.romaji) {
    el("text", { x: WIDTH / 2 + 30, y: 143, "text-anchor": "middle", fill: "#111", "font-size": 17, "font-weight": 700 }, svg, station.romaji);
  }

  // 隣の駅
  el("rect", { x: 5, y: 152, width: WIDTH - 10, height: 43, fill: "#eef1f3" }, svg);
  el("rect", { x: 5, y: 152, width: WIDTH - 10, height: 4, fill: lineColor }, svg);
  const side = (n: SignNeighbor | null, right: boolean) => {
    if (!n) return;
    const pointed = data.arrow === (right ? "right" : "left");
    const edge = right ? WIDTH - 22 : 22;
    const dir = right ? -1 : 1;
    if (pointed) el("text", { x: edge, y: 182, "text-anchor": right ? "end" : "start", fill: lineColor, "font-size": 18, "font-weight": 900 }, svg, right ? "▶" : "◀");
    const badgeX = edge + dir * (pointed ? 36 : 14);
    if (lineCode && n.number !== undefined) metroBadge(svg, lineCode, n.number, badgeX, 176, 13, lineColor);
    const textX = badgeX + dir * 20;
    const anchor = right ? "end" : "start";
    el("text", { x: textX, y: 175, "text-anchor": anchor, fill: "#111", "font-size": 16, "font-weight": 700 }, svg, n.name);
    if (n.romaji) el("text", { x: textX, y: 190, "text-anchor": anchor, fill: "#333", "font-size": 11 }, svg, n.romaji);
  };
  side(data.left, false);
  side(data.right, true);
  return svg;
}

/** 駅名標の SVG を生成する */
export function buildStationSign(data: StationSignData): SVGSVGElement {
  if (data.style === "tokyo-metro") return buildMetroSign(data);
  const svg = signRoot(data);

  el("rect", { x: 3, y: 3, width: WIDTH - 6, height: HEIGHT - 6, rx: 6, fill: "#fff", stroke: "#222", "stroke-width": 6 }, svg);

  // 駅名（長い駅名は幅に収める）
  const { name } = data.station;
  const spacing = letterSpacing(name.length);
  const nameWidth = name.length * NAME_SIZE * (1 + spacing);
  const maxNameWidth = 360;
  const nameAttrs: Record<string, string | number> = {
    x: WIDTH / 2 + (spacing * NAME_SIZE) / 2,
    y: 80,
    "text-anchor": "middle",
    fill: "#111",
    "font-size": NAME_SIZE,
    "font-weight": 900,
    "letter-spacing": `${spacing}em`,
  };
  if (nameWidth > maxNameWidth) {
    nameAttrs.x = WIDTH / 2;
    nameAttrs.textLength = maxNameWidth;
    nameAttrs.lengthAdjust = "spacingAndGlyphs";
  }
  el("text", nameAttrs, svg, name);
  if (data.station.kana) {
    el("text", { x: WIDTH / 2, y: 106, "text-anchor": "middle", fill: "#222", "font-size": 14, "font-weight": 700, "letter-spacing": "0.15em" }, svg, data.station.kana);
  }

  const shownWidth = Math.min(nameWidth, maxNameWidth);
  numberBadge(svg, data, Math.max(44, WIDTH / 2 - shownWidth / 2 - 44));
  if (data.areaMark) areaMark(svg, data.areaMark);
  bar(svg, data);

  // ローマ字
  const y = 182;
  if (data.left?.romaji) el("text", { x: 28, y, fill: "#222", "font-size": 12 }, svg, data.left.romaji);
  if (data.station.romaji) {
    el("text", { x: WIDTH / 2, y, "text-anchor": "middle", fill: "#111", "font-size": 18, "font-weight": 700 }, svg, data.station.romaji);
  }
  if (data.right?.romaji) el("text", { x: WIDTH - 28, y, "text-anchor": "end", fill: "#222", "font-size": 12 }, svg, data.right.romaji);
  return svg;
}
