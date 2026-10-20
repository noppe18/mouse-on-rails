import type { Catalog, CatalogEntry } from "./types.ts";

/** 累計乗車回数から解放済みの路線数を求める（山手線は最初から解放） */
export function unlockedCount(catalog: Catalog, totalRides: number): number {
  return Math.min(catalog.lines.length, 1 + Math.floor(Math.max(totalRides, 0) / catalog.ridesPerUnlock));
}

export function unlockedLines(catalog: Catalog, totalRides: number): CatalogEntry[] {
  return catalog.lines.slice(0, unlockedCount(catalog, totalRides));
}

/** 既に記録済みの解放状態と比較し、新たに解放された路線を返す */
export function newlyUnlocked(catalog: Catalog, totalRides: number, recorded: readonly string[]): CatalogEntry[] {
  return unlockedLines(catalog, totalRides).filter((l) => !recorded.includes(l.id));
}

/** 次の路線解放までの残り乗車回数。全路線解放済みなら null */
export function ridesUntilNextUnlock(catalog: Catalog, totalRides: number): number | null {
  if (unlockedCount(catalog, totalRides) >= catalog.lines.length) return null;
  return catalog.ridesPerUnlock - (Math.max(totalRides, 0) % catalog.ridesPerUnlock);
}
