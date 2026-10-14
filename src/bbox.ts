/** 经纬度包围盒工具 + 内置省 / 地级 bbox 表查找。 */
import { BBOX } from "./data/bbox.js";
import type { Unit } from "./geometry.js";

/** 经纬度包围盒。 */
export interface BBox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

/** 一组区块的经纬度包围盒（视图的近似），无点返回 null。 */
export const bboxOf = (units: Unit[]): BBox | null => {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const u of units)
    for (const ring of u.rings)
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
  return Number.isFinite(minLon) ? { minLon, minLat, maxLon, maxLat } : null;
};

/** 两个包围盒是否相交（含相切）。 */
export const bboxHit = (a: BBox, b: BBox): boolean =>
  a.minLon <= b.maxLon && a.maxLon >= b.minLon && a.minLat <= b.maxLat && a.maxLat >= b.minLat;

/** 查内置 bbox：表里没有（县级节点、新设行政区）返回 null —— 调用方退化为不预筛，保守。 */
export const builtinBBox = (adcode: string): BBox | null => {
  if (!Object.hasOwn(BBOX, adcode)) return null;
  const [minLon, minLat, maxLon, maxLat] = BBOX[adcode]!;
  return { minLon, minLat, maxLon, maxLat };
};
