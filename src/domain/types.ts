// 路線データ（JSON）の型定義

export interface Point {
  x: number;
  y: number;
}

/** 角丸長方形。値は画面の短辺に対する比率 */
export interface RoundedRectShape {
  type: "roundedRect";
  margin: number;
  minMarginPx?: number;
  cornerRadius: number;
}

/** 正規化座標 (0..1) の折れ線。将来の路線追加用 */
export interface PolylineShape {
  type: "polyline";
  closed: boolean;
  points: [number, number][];
}

export type ShapeDef = RoundedRectShape | PolylineShape;

export interface StationDef {
  id: string;
  name: string;
  /** 路線上の位置 (0..1)。省略時は stationLayout に従って配置 */
  t?: number;
}

export interface DirectionDef {
  /** UI 表示用（例: 時計回り） */
  label: string;
  /** 鉄道としての呼び名（例: 外回り） */
  name: string;
}

export interface LineDef {
  id: string;
  name: string;
  color: string;
  loop: boolean;
  shape: ShapeDef;
  stationLayout?: { mode: "even"; startT?: number };
  /** forward = stations 配列の順方向 */
  directions: { forward: DirectionDef; backward: DirectionDef };
  stations: StationDef[];
}

export interface CatalogEntry {
  id: string;
  name: string;
  color: string;
  /** 路線データが実装済みか */
  available: boolean;
}

export interface Catalog {
  ridesPerUnlock: number;
  lines: CatalogEntry[];
}

/** 1 = forward（stations 配列の順）, -1 = backward */
export type Direction = 1 | -1;
