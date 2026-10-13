/**
 * 纯几何工具：折线解析与投影前/后的多边形运算。无任何 IO，可直接单测。
 */
import type { AmapDistrict } from "./types.js";

export type LonLat = [number, number];
export type Point = [number, number];
/** 一个环：一串点。 */
export type Ring = LonLat[];
/** 一个行政区的一组环。 */
export type Rings = Ring[];

/** 一个待绘制的行政区（已解析出环）。 */
export interface Unit {
  name: string;
  adcode: string;
  center: number[];
  rings: Rings;
}

/** 高德 `polyline` 串（`lon,lat;lon,lat|...`）-> 环数组，丢弃点数 < 3 的环。 */
export function parsePolyline(str?: string): Rings {
  const rings: Rings = [];
  for (const part of (str || "").split("|")) {
    const pts: LonLat[] = [];
    for (const pair of part.split(";")) {
      if (!pair) continue;
      const [lon, lat] = pair.split(",");
      pts.push([parseFloat(lon), parseFloat(lat)]);
    }
    if (pts.length >= 3) rings.push(pts);
  }
  return rings;
}

/** 把一个行政区节点转成待绘制的 `Unit`。 */
export function toUnit(d: AmapDistrict): Unit {
  return {
    name: d.name,
    adcode: d.adcode,
    center: (d.center || "").split(",").map(Number),
    rings: parsePolyline(d.polyline),
  };
}

/** 有向面积（>0 为逆时针）。 */
export function signedArea(ring: Point[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/** 环的质心（面积加权；退化时取顶点平均）。 */
export function centroid(ring: Point[]): Point {
  const a = signedArea(ring);
  if (Math.abs(a) < 1e-12) {
    return [
      ring.reduce((s, p) => s + p[0], 0) / ring.length,
      ring.reduce((s, p) => s + p[1], 0) / ring.length,
    ];
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    const cr = x1 * y2 - x2 * y1;
    cx += (x1 + x2) * cr;
    cy += (y1 + y2) * cr;
  }
  return [cx / (6 * a), cy / (6 * a)];
}

/** 射线法判断点是否在多边形内。 */
export function pointInRing([x, y]: Point, ring: Point[]): boolean {
  let inside = false;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    if (y1 > y !== y2 > y) {
      const xin = ((x2 - x1) * (y - y1)) / (y2 - y1) + x1;
      if (x < xin) inside = !inside;
    }
  }
  return inside;
}

/**
 * 道格拉斯-普克抽稀。国/省级边界原始点数以十万计，必须抽稀。
 * 首尾点始终保留。
 */
export function simplify(pts: Point[], tol: number): Point[] {
  const n = pts.length;
  if (n < 4) return pts;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let d: number;
      if (len2 === 0) d = Math.hypot(px - ax, py - ay);
      else {
        let t = ((px - ax) * dx + (py - ay) * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      }
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tol && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out: Point[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
  return out;
}
