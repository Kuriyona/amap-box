import { describe, expect, it } from "vitest";
import { centroid, parsePolyline, pointInRing, signedArea, simplify } from "../src/geometry.js";

const square = (x: number, y: number, s: number) => [
  [x, y],
  [x + s, y],
  [x + s, y + s],
  [x, y + s],
] as Array<[number, number]>;

describe("parsePolyline", () => {
  it("按 | 分环、按 ; 分点、按 , 分经纬", () => {
    expect(parsePolyline("120,30;121,30;121,31")).toEqual([
      [
        [120, 30],
        [121, 30],
        [121, 31],
      ],
    ]);
  });

  it("多环用 | 分隔", () => {
    const rings = parsePolyline("1,1;2,2;3,3|4,4;5,5;6,6");
    expect(rings).toHaveLength(2);
    expect(rings[1][0]).toEqual([4, 4]);
  });

  it("点数不足 3 的环、空串直接丢弃", () => {
    expect(parsePolyline("1,1;2,2")).toEqual([]);
    expect(parsePolyline("")).toEqual([]);
    expect(parsePolyline(undefined)).toEqual([]);
  });
});

describe("signedArea / centroid", () => {
  it("逆时针为正、顺时针为负，面积等于边长平方", () => {
    const ccw = square(0, 0, 2);
    expect(signedArea(ccw)).toBe(4);
    expect(signedArea([...ccw].reverse())).toBe(-4);
  });

  it("质心落在正方形中心", () => {
    expect(centroid(square(10, 20, 4))).toEqual([12, 22]);
  });
});

describe("pointInRing", () => {
  const ring = square(0, 0, 10);
  it("判内外", () => {
    expect(pointInRing([5, 5], ring)).toBe(true);
    expect(pointInRing([15, 5], ring)).toBe(false);
    expect(pointInRing([5, -1], ring)).toBe(false);
  });
});

describe("simplify", () => {
  it("保留首尾，去掉共线中间点", () => {
    const line: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 0],
    ];
    expect(simplify(line, 0.5)).toEqual([
      [0, 0],
      [4, 0],
    ]);
  });

  it("超过容差的点被保留", () => {
    const pts: Array<[number, number]> = [
      [0, 0],
      [1, 5],
      [2, 0],
    ];
    const out = simplify(pts, 0.5);
    expect(out).toContainEqual([1, 5]);
    expect(out[0]).toEqual([0, 0]);
    expect(out.at(-1)).toEqual([2, 0]);
  });

  it("点数 < 4 原样返回", () => {
    const pts: Array<[number, number]> = [
      [0, 0],
      [1, 1],
    ];
    expect(simplify(pts, 0.5)).toBe(pts);
  });
});
