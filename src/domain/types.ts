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

/**
 * 経路の頂点。駅（station あり）か曲がり角（station なし）。
 * 座標は数値なら山手線の環（角丸長方形）に対する比率（0 = 左端/上端, 1 = 右端/下端）、
 * 文字列なら既に配置した駅の座標（"路線ID:駅ID"、同じ路線なら "駅ID"）。
 * dx / dy は駅間隔を単位にしたずれ。
 */
export interface RouteNode {
  station?: string;
  /** 指定した路線の同じ駅に置く（例: "yamanote"） */
  at?: string;
  x?: number | string;
  y?: number | string;
  dx?: number;
  dy?: number;
  /**
   * 前後の頂点を、縦横の直線と 45° の斜線でつなぐ曲がり角。
   * diag-first は斜線から、diag-last は直線から始める
   */
  via?: "diag-first" | "diag-last";
}

/**
 * 他の路線の駅を基準に、縦横と 45° の直線でデフォルメした経路。
 * 経路に書かない駅は、前後の駅の間に等間隔で置く
 */
export interface RouteShape {
  type: "route";
  nodes: RouteNode[];
}

export type ShapeDef = RoundedRectShape | PolylineShape | RouteShape;

export interface StationDef {
  id: string;
  name: string;
  /** 駅名標用のよみがな・ローマ字・駅ナンバー・スリーレターコード */
  kana?: string;
  romaji?: string;
  number?: number;
  code?: string;
  /**
   * 乗換駅としてまとめる ID（省略時は id）。路線図の都合で同じ駅を離して描くとき、
   * 別の値にすると連絡線でつながず別々の駅として描く
   */
  group?: string;
  /** 路線上の位置 (0..1)。省略時は stationLayout に従って配置 */
  t?: number;
}

export interface DirectionDef {
  /** UI 表示用（例: 時計回り） */
  label: string;
  /** 鉄道としての呼び名（例: 外回り） */
  name: string;
}

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
  stationLayout?: { mode: "even"; startT?: number };
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
