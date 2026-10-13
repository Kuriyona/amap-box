import { describe, expect, it } from "vitest";
import { renderMap, wrapSvg, type RenderUnit } from "../src/render.js";

const square = (x: number, s: number) => [
  [120 + x, 30],
  [120 + x + s, 30],
  [120 + x + s, 30 + s],
  [120 + x, 30 + s],
] as Array<[number, number]>;

const unit = (name: string, adcode: string, x: number, depth = 0): RenderUnit => ({
  name,
  adcode,
  center: [120 + x + 0.5, 30.5],
  rings: [square(x, 1)],
  depth,
});

const countPaths = (svg: string) => (svg.match(/<path /g) ?? []).length;
const countLabels = (svg: string) => (svg.match(/text-anchor="middle"/g) ?? []).length;

describe("renderMap", () => {
  it("无内容返回 null", () => {
    expect(renderMap({ units: [], outline: null, caption: "空" })).toBeNull();
  });

  it("单区块：一条 path + 一个标签 + 标题", () => {
    const map = renderMap({ units: [unit("杭州市", "330100", 0)], outline: null, caption: "杭州市" });
    expect(map).not.toBeNull();
    expect(countPaths(map!.markup)).toBe(1);
    expect(countLabels(map!.markup)).toBe(1);
    expect(map!.markup).toContain(">杭州市</text>");
    expect(map!.W).toBeGreaterThan(0);
    expect(map!.H).toBeGreaterThan(0);
  });

  it("多层叠图：区块 path = units 数，整体轮廓另算一条", () => {
    const map = renderMap({
      units: [unit("浙江省", "330000", 0, 0), unit("杭州市", "330100", 0.2, 1)],
      outline: { name: "中国", adcode: "100000", center: [120.5, 30.5], rings: [square(-1, 4)] },
      caption: "杭州市",
    });
    expect(map).not.toBeNull();
    expect(countPaths(map!.markup)).toBe(3); // 2 个区块 + 1 条轮廓
  });

  it("captionSub 附加到标题行", () => {
    const map = renderMap({
      units: [unit("临安区", "330112", 0)],
      outline: null,
      caption: "临安区",
      captionSub: "浙江省 › 杭州市",
    });
    expect(map!.markup).toContain("浙江省 › 杭州市");
  });
});

describe("wrapSvg", () => {
  it("套上 <svg> 外壳并带 viewBox", () => {
    const map = renderMap({ units: [unit("A", "1", 0)], outline: null, caption: "A" })!;
    const svg = wrapSvg(map);
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain(`viewBox="0 0 ${map.W.toFixed(1)} ${map.H.toFixed(1)}"`);
  });
});
