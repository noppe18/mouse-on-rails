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
  /** 駅名標用のよみがな・ローマ字・駅ナンバー・スリーレターコード */
  kana?: string;
  romaji?: string;
  number?: number;
  code?: string;
  /** 路線上の位置 (0..1)。省略時は stationLayout に従って配置 */
  t?: number;
}

export interface DirectionDef {
  /** UI 表示用（例: 時計回り） */
  label: string;
  /** 鉄道としての呼び名（例: 外回り） */
  name: string;
}

/**
 * 駅の配置方法。
 * even: 路線上に等間隔（startT から）
 * vertices: polyline の各頂点に 1 駅ずつ（頂点数 = 駅数）
 */
export type StationLayoutDef = { mode: "even"; startT?: number } | { mode: "vertices" };

/** 駅名標の表示設定 */
export interface SignDef {
  /** デザイン。省略時は JR 東日本風 */
  style?: "jr-east" | "tokyo-metro";
  /** 路線記号（例: JY, N） */
  code: string;
  /** 帯の色 */
  barColor: string;
  /** 特定都区市内の表示（例: 山） */
  areaMark?: string;
}

/** 車両の塗装 */
export interface VehicleDef {
  /** 形式名（表示用） */
  model: string;
  body: string;
  /** 窓下の帯 */
  band: string;
  /** 窓上の帯 */
  topBand?: string;
  /** 窓下の帯に添える細帯 */
  subBand?: string;
  /** ドア部分を帯色で塗る（E235 系風） */
  doorBands?: boolean;
  /** 前面の色 */
  face: string;
  faceAccent: string;
}

export interface LineDef {
  id: string;
  name: string;
  nameEn: string;
  color: string;
  sign?: SignDef;
  loop: boolean;
  shape: ShapeDef;
  stationLayout?: StationLayoutDef;
  /** 駅名ラベルの位置。alternate は路線の両側へ交互に置く（駅間の狭い横長の路線向け） */
  labelSide?: "inward" | "alternate";
  /** forward = stations 配列の順方向 */
  directions: { forward: DirectionDef; backward: DirectionDef };
  vehicle: VehicleDef;
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
