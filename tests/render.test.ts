import { describe, expect, it } from "vitest";
import { CAPTION_H, DIM_OPACITY, DIM_STROKE, HOT_TARGET, PAD, renderMap, TARGET_FILL, wrapSvg, type RenderUnit } from "../src/render.js";

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

  it("外部轮廓：只画落在视图内的同级相邻区域，且不加标签", () => {
    const map = renderMap({
      units: [unit("杭州市", "330100", 0)],
      outline: null,
      outside: [unit("邻区", "330200", 1), unit("远区", "330201", 50)],
      caption: "杭州市",
    })!;
    expect(map.outside).toBe(1); // 只有紧邻的那个在视图内
    expect(countPaths(map.markup)).toBe(2); // 主区块 + 1 条外部轮廓
    expect(countLabels(map.markup)).toBe(1); // 外部轮廓不加标签
    expect(map.markup).not.toContain(">邻区</text>");
    expect(map.markup).not.toContain(">远区</text>");
  });

  it("画幅比例：数字与 \"W:H\" 都归一化为宽高比，且不改变内容缩放", () => {
    const u = unit("杭州市", "330100", 0);
    const bbox = (markup: string) => {
      const d = markup.match(/<path d="([^"]+)"/)![1];
      const n = [...d.matchAll(/(-?\d+\.\d),(-?\d+\.\d)/g)].map((m) => [+m[1]!, +m[2]!]);
      const xs = n.map((p) => p[0]!);
      const ys = n.map((p) => p[1]!);
      return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    };
    const auto = renderMap({ units: [u], outline: null, caption: "杭州市" })!;
    const one = renderMap({ units: [u], outline: null, caption: "杭州市", ratio: 1 })!;
    const wide = renderMap({ units: [u], outline: null, caption: "杭州市", ratio: "16:9" })!;
    expect(one.W).toBeCloseTo(one.H, 6);
    expect(wide.W / wide.H).toBeCloseTo(16 / 9, 6);
    // 比例只改画布，内容长边仍是 1000px
    const a = bbox(auto.markup);
    const o = bbox(one.markup);
    expect(o.w).toBeCloseTo(a.w, 6);
    expect(o.h).toBeCloseTo(a.h, 6);
  });

  it("title:false 去掉标题与标题带", () => {
    const u = unit("A", "1", 0);
    const on = renderMap({ units: [u], outline: null, caption: "A", captionSub: "330100" })!;
    const off = renderMap({ units: [u], outline: null, caption: "A", captionSub: "330100", title: false })!;
    expect(on.markup).toContain(">330100</text>");
    expect(off.markup).not.toContain(">330100</text>");
    expect(off.markup).toContain(">A</text>"); // 区块标签仍在
    expect(on.H - off.H).toBeCloseTo(CAPTION_H, 6);
  });

  it("padding 可配置，默认 PAD", () => {
    const u = unit("A", "1", 0);
    const def = renderMap({ units: [u], outline: null, caption: "A" })!;
    const zero = renderMap({ units: [u], outline: null, caption: "A", padding: 0 })!;
    expect(def.W - zero.W).toBeCloseTo(2 * PAD, 6);
    expect(def.H - zero.H).toBeCloseTo(2 * PAD, 6);
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

  it("目标背景：默认给目标节点所在区域填充，可关闭，且不额外增加 path", () => {
    const on = renderMap({ units: [unit("杭州市", "330100", 0)], outline: null, caption: "T", target: "330100" })!;
    const off = renderMap({
      units: [unit("杭州市", "330100", 0)],
      outline: null,
      caption: "T",
      target: "330100",
      targetBackground: false,
    })!;
    expect(on.markup).toContain(`fill="${TARGET_FILL}"`);
    expect(off.markup).not.toContain(TARGET_FILL);
    expect(countPaths(on.markup)).toBe(countPaths(off.markup)); // 背景高亮是同一 path 的 fill 属性
  });

  it("目标背景：目标落到整体轮廓上时填充轮廓区域", () => {
    const map = renderMap({
      units: [unit("临安区", "330112", 0), unit("富阳区", "330111", 1)],
      outline: { name: "杭州市", adcode: "330100", center: [120.5, 30.5], rings: [square(-1, 4)] },
      caption: "T",
      target: "330100",
    })!;
    // 2 个区块 + 轮廓 = 3 条 path，填充挂在轮廓那条上
    expect(countPaths(map.markup)).toBe(3);
    expect((map.markup.match(new RegExp(TARGET_FILL, "g")) ?? []).length).toBe(1);
  });

  it("上级轮廓高亮：默认把整体轮廓与目标以外的区块压成细灰线，仅目标亮白", () => {
    const units = [unit("杭州市", "330100", 0), unit("宁波市", "330200", 1)];
    const outline = { name: "浙江省", adcode: "330000", center: [120.5, 30.5], rings: [square(-1, 4)] };
    const dim = renderMap({ units, outline, caption: "T", target: "330100", targetBackground: false })!;
    const hot = renderMap({ units, outline, caption: "T", target: "330100", targetBackground: false, highlightContext: true })!;
    const dimmed = (m: string) => (m.match(new RegExp(`stroke-opacity="${DIM_OPACITY.toFixed(2)}"`, "g")) ?? []).length;
    expect(dimmed(dim.markup)).toBe(2); // 宁波市 + 浙江省轮廓
    expect(dimmed(hot.markup)).toBe(0);
    expect(dim.markup).toContain(`stroke-width="${DIM_STROKE.toFixed(2)}"`); // 轮廓变细
    expect(dim.markup).toContain(`stroke-width="${HOT_TARGET.toFixed(2)}"`); // 目标仍亮白
  });

  it("标签开关：可分开关闭目标节点与上下文标签", () => {
    const units = [unit("甲市", "1", 0), unit("乙市", "2", 1)];
    const base = renderMap({ units, outline: null, caption: "T", target: "1" })!;
    expect(countLabels(base.markup)).toBe(2);
    const ctxOff = renderMap({ units, outline: null, caption: "T", target: "1", contextLabels: false })!;
    expect(ctxOff.markup).toContain(">甲市</text>");
    expect(ctxOff.markup).not.toContain(">乙市</text>");
    const tgtOff = renderMap({ units, outline: null, caption: "T", target: "1", targetLabels: false })!;
    expect(tgtOff.markup).not.toContain(">甲市</text>");
    expect(tgtOff.markup).toContain(">乙市</text>");
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
