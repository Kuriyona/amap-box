import { describe, expect, it } from "vitest";
import { builtinBBox } from "../src/bbox.js";
import { LEVELS } from "../src/data/regions.js";
import { bundledIndexRoot } from "../src/regions.js";
import type { AmapDistrict } from "../src/types.js";

const nodes: AmapDistrict[] = [];
const walk = (n: AmapDistrict) => {
  nodes.push(n);
  for (const c of n.districts ?? []) walk(c);
};
walk(bundledIndexRoot());

const at = (adcode: string) => nodes.find((n) => n.adcode === adcode);

describe("内置索引（随包发布的生成物）", () => {
  it("结构完整：6 位 adcode、非空名称、合法层级与 center", () => {
    expect(nodes.length).toBeGreaterThan(4000); // 索引是整棵树，不是残片
    for (const n of nodes) {
      expect(n.adcode).toMatch(/^\d{6}$/);
      expect(n.name.length).toBeGreaterThan(0);
      expect(LEVELS).toContain(n.level);
      expect(n.center).toMatch(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/);
    }
  });

  it("关键节点在位（含直辖市多出的一级）", () => {
    expect(bundledIndexRoot()).toMatchObject({ adcode: "100000", level: "country" });
    expect(at("330000")).toMatchObject({ name: "浙江省", level: "province" });
    expect(at("330100")).toMatchObject({ name: "杭州市", level: "city" });
    expect(at("330112")).toMatchObject({ name: "临安区", level: "district" });
    expect(at("110100")).toMatchObject({ level: "city" }); // 北京市 -> 北京城区 -> 各区
    expect(at("110101")).toMatchObject({ name: "东城区", level: "district" });
  });

  it("省直辖县级市按地级保留（其街镇与它同 adcode）", () => {
    expect(at("429004")).toMatchObject({ name: "仙桃市", level: "city" });
    expect(at("419001")).toMatchObject({ name: "济源市", level: "city" });
    // 同 adcode 的街镇仍在树里（按名查找用），但 byAdcode 保留的是上层那个
    expect(at("429004")!.districts!.length).toBeGreaterThan(0);
  });

  it("bbox 表与索引同源：省 / 地级节点一个不缺，县级不预筛", () => {
    const want = nodes.filter((n) => n.level === "province" || n.level === "city");
    expect(want.length).toBeGreaterThan(400);
    for (const n of want) expect(builtinBBox(n.adcode), n.adcode).not.toBeNull();
    expect(builtinBBox("330112")).toBeNull(); // 县级：表里没有 -> 调用方退化不预筛
  });
});
