import { describe, expect, it } from "vitest";
import { bboxHit, bboxOf, builtinBBox } from "../src/bbox.js";
import { BBOX } from "../src/data/regions.js";
import type { Unit } from "../src/geometry.js";

const squareUnit = (lon: number, lat: number, s: number): Unit => ({
  name: "x",
  adcode: "x",
  center: [lon, lat],
  rings: [
    [
      [lon, lat],
      [lon + s, lat],
      [lon + s, lat + s],
      [lon, lat + s],
    ],
  ],
});

describe("内置 bbox 表", () => {
  const keys = Object.keys(BBOX);

  it("键是 6 位数字、升序，条目数达标", () => {
    expect(keys.length).toBeGreaterThanOrEqual(340);
    for (const k of keys) expect(k).toMatch(/^\d{6}$/);
    expect(keys).toEqual([...keys].sort());
    for (const k of ["110000", "330000", "330100", "440000"]) expect(BBOX).toHaveProperty(k);
  });

  it("每个框都在中国经纬度范围内且非退化", () => {
    for (const [minLon, minLat, maxLon, maxLat] of Object.values(BBOX)) {
      for (const v of [minLon, minLat, maxLon, maxLat]) expect(Number.isFinite(v)).toBe(true);
      expect(minLon).toBeLessThan(maxLon);
      expect(minLat).toBeLessThan(maxLat);
      expect(minLon).toBeGreaterThanOrEqual(73);
      expect(maxLon).toBeLessThanOrEqual(136);
      expect(minLat).toBeGreaterThanOrEqual(3);
      expect(maxLat).toBeLessThanOrEqual(54);
    }
  });

  it("builtinBBox：命中返回框，缺失 / 非自有键返回 null", () => {
    const zj = BBOX["330000"]!;
    expect(builtinBBox("330000")).toEqual({ minLon: zj[0], minLat: zj[1], maxLon: zj[2], maxLat: zj[3] });
    expect(builtinBBox("999999")).toBeNull();
    expect(builtinBBox("constructor")).toBeNull();
  });

  it("bboxOf / bboxHit", () => {
    expect(bboxOf([])).toBeNull();
    const u = squareUnit(120, 30, 1);
    expect(bboxOf([u])).toEqual({ minLon: 120, minLat: 30, maxLon: 121, maxLat: 31 });
    expect(bboxHit(bboxOf([u])!, { minLon: 120.5, minLat: 30.5, maxLon: 122, maxLat: 32 })).toBe(true);
    expect(bboxHit(bboxOf([u])!, { minLon: 130, minLat: 40, maxLon: 131, maxLat: 41 })).toBe(false);
  });
});
