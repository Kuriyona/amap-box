import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AmapBox } from "../src/index.js";
import type { AmapCache, AmapDistrict, Note } from "../src/types.js";

// ---------------------------------------------------------------- fixture
const NAMES: Record<string, { name: string; level: string }> = {
  "100000": { name: "中华人民共和国", level: "country" },
  "330000": { name: "浙江省", level: "province" },
  "330100": { name: "杭州市", level: "city" },
  "330110": { name: "临安区", level: "district" },
  "329111": { name: "富阳区", level: "district" },
  "330200": { name: "宁波市", level: "city" },
  "330211": { name: "同名区", level: "district" },
  "329000": { name: "江苏省", level: "province" },
  "329100": { name: "南京市", level: "city" },
  "110000": { name: "北京市", level: "province" },
  "330900": { name: "虚构市", level: "city" },
};

const POLY: Record<string, string> = {
  "100000": "73,18;135,18;135,54;73,54",
  "330000": "119,29;122,29;122,32;119,32",
  "330100": "119.5,29.5;121.5,29.5;121.5,31.5;119.5,31.5",
  "330110": "119.6,29.6;120.4,29.6;120.4,30.4;119.6,30.4",
  "329111": "120.6,29.6;121.4,29.6;121.4,30.4;120.6,30.4",
  "330211": "120.6,29.6;121.4,29.6;121.4,30.4;120.6,30.4",
};

const node = (adcode: string, districts?: AmapDistrict[]): AmapDistrict => ({
  ...NAMES[adcode],
  adcode,
  center: "120.5,30.5",
  ...(districts ? { districts } : {}),
});

const INDEX_TREE = node("100000", [
  node("330000", [node("330100", [node("330110", []), node("329111", [])])]),
]);

function makeEnv(
  tree: AmapDistrict = INDEX_TREE,
  hooks: { onIndex?: () => unknown } = {},
  polys: Record<string, string> = POLY,
) {
  const store = new Map<string, string>();
  const calls: string[] = [];
  let indexHits = 0;
  const fetchImpl = (raw: string) => {
    calls.push(raw);
    const url = new URL(raw);
    const kw = url.searchParams.get("keywords")!;
    const sub = url.searchParams.get("subdistrict");
    if (sub === "3") {
      indexHits++;
      const forced = hooks.onIndex?.();
      if (forced) return forced;
      return { status: "1", districts: [tree] };
    }
    if (sub === "1") return { status: "1", districts: [] }; // 在线关键字搜索：查无此名
    const poly = polys[kw];
    return poly
      ? { status: "1", districts: [{ ...NAMES[kw], adcode: kw, center: "120.5,30.5", polyline: poly }] }
      : { status: "0", info: "NO_DATA" };
  };
  const cache: AmapCache = {
    read: (k) => store.get(k) ?? null,
    write: (k, v) => void store.set(k, v),
  };
  const box = new AmapBox({ Key: "TEST", fetch: fetchImpl, cache });
  return { box, store, calls, indexHits: () => indexHits };
}

const countPaths = (svg: string) => (svg.match(/<path /g) ?? []).length;
/** 提示文本拼一段，便于 `toContain` 断言（不关心 level）。 */
const nz = (notes: Note[]) => notes.map((n) => n.text).join("\n");

// ---------------------------------------------------------------- tests
describe("构造", () => {
  it("缺 Key / fetch / cache 时报错", () => {
    const cache: AmapCache = { read: () => null, write: () => {} };
    expect(() => new AmapBox(null as never)).toThrow(TypeError);
    expect(() => new AmapBox({ Key: "", fetch: () => ({}), cache })).toThrow(/Key/);
    expect(() => new AmapBox({ Key: "k", fetch: null as never, cache })).toThrow(/fetch/);
    expect(() => new AmapBox({ Key: "k", fetch: () => ({}), cache: {} as never })).toThrow(/cache/);
  });
});

describe("resolve", () => {
  it("精确同名 / 数字 adcode / 子串", async () => {
    const { box } = makeEnv();
    expect((await box.resolve("杭州市")).regions.map((r) => r.adcode)).toEqual(["330100"]);
    expect((await box.resolve("330100")).regions.map((r) => r.name)).toEqual(["杭州市"]);
    expect((await box.resolve("人民")).regions.map((r) => r.name)).toEqual(["中华人民共和国"]);
  });

  it("索引查不到时回落在线查询，仍无结果则返回空", async () => {
    const { box, calls } = makeEnv();
    expect((await box.resolve("查不到的地方")).regions).toEqual([]);
    expect(calls.some((u) => u.includes("keywords=%E6%9F%A5%E4%B8%8D%E5%88%B0"))).toBe(true);
  });

  it("匹配过多时只取前 20 并记提示", async () => {
    const many = node("100000", [
      ...Array.from({ length: 25 }, (_, i) => ({
        name: "测试镇",
        adcode: `9900${i}`,
        level: "city",
        center: "120.5,30.5",
      })),
    ]);
    const { box } = makeEnv(many);
    const { regions, notes } = await box.resolve("测试镇");
    expect(regions).toHaveLength(20);
    expect(nz(notes)).toContain("只取前 20 个");
  });
});

describe("generate", () => {
  it("默认 up0/down0：只画目标自身轮廓", async () => {
    const { box } = makeEnv();
    const [r] = await box.generate("杭州市");
    expect(r.file).toBe("杭州市-330100-u0d0.svg");
    expect(r.up).toBe(0);
    expect(r.down).toBe(0);
    expect(r.blocks).toBe(1);
    expect(r.outline).toBe(false);
    expect(countPaths(r.svg!)).toBe(1);
  });

  it("down1：只画目标的下级 + 目标轮廓", async () => {
    const { box } = makeEnv();
    const [r] = await box.generate("杭州市", { down: 1 });
    expect(r.file).toBe("杭州市-330100-u0d1.svg");
    expect(r.blocks).toBe(2); // 临安区 + 富阳区
    expect(r.outline).toBe(true); // 整体轮廓 = 杭州市自身
    expect(r.svg).toContain(">杭州市</text>");
    expect(countPaths(r.svg!)).toBe(3); // 2 区块 + 1 轮廓
  });

  it("up1：带出父级同级（浙江省）", async () => {
    const { box } = makeEnv();
    const [r] = await box.generate("杭州市", { up: 1, down: 1 });
    expect(r.file).toBe("杭州市-330100-u1d1.svg");
    expect(r.blocks).toBe(3); // 浙江省 + 临安区 + 富阳区
    expect(r.outline).toBe(true); // 轮廓 = 浙江省
  });

  it("up 超出深度时被夹到深度并记提示", async () => {
    const { box } = makeEnv();
    const [r] = await box.generate("330110", { up: 9, down: 0 });
    expect(r.up).toBe(3);
    expect(r.file).toBe("临安区-330110-u3d0.svg");
    expect(nz(r.notes)).toContain("超出范围");
  });

  it("县级目标 down1：下级是乡镇/街道，记提示并退化为只画自身", async () => {
    const { box } = makeEnv();
    const [r] = await box.generate("330110", { down: 1 });
    expect(nz(r.notes)).toContain("乡镇/街道级");
    expect(r.blocks).toBe(1); // 无下级可画 -> 只画自身
    expect(r.outline).toBe(false);
  });

  it("down0 退化为只画自身轮廓", async () => {
    const { box } = makeEnv();
    const [r] = await box.generate("330110", { up: 0, down: 0 });
    expect(r.file).toBe("临安区-330110-u0d0.svg");
    expect(r.blocks).toBe(1);
    expect(r.outline).toBe(false);
    expect(countPaths(r.svg!)).toBe(1);
  });

  it("没有匹配时报错", async () => {
    const { box } = makeEnv();
    await expect(box.generate("不存在的地方")).rejects.toThrow(/没有匹配/);
  });

  it("多命中：本地提示逐张保留，解析层提示只在第一张", async () => {
    const dup = (adcode: string): AmapDistrict => ({
      name: "同名区",
      adcode,
      level: "district",
      center: "120.5,30.5",
      districts: [],
    });
    const tree = node("100000", [
      node("330000", [node("330100", [dup("330110")]), node("330200", [dup("330211")])]),
    ]);
    const { box } = makeEnv(tree);
    const res = await box.generate("同名区", { down: 1 });
    expect(res).toHaveLength(2);
    for (const r of res) expect(nz(r.notes)).toContain("乡镇/街道级");
    expect(nz(res[0].notes)).toContain("首次运行");
    expect(nz(res[1].notes)).not.toContain("首次运行");
  });

  it("拓展外部轮廓：画视图内的同级相邻区域（不往下细分、不加标签）", async () => {
    const { box } = makeEnv(INDEX_TREE, {}, {
      ...POLY,
      // 富阳区与临安区在视图内有交叠
      "329111": "119.8,29.8;120.6,29.8;120.6,30.6;119.8,30.6",
    });
    const [r] = await box.generate("330110", { up: 0, down: 0, outside: true });
    expect(r.landed.adcode).toBe("330110");
    expect(r.blocks).toBe(1); // 只画自身
    expect(r.neighbors).toBe(1); // 富阳区
    expect(countPaths(r.svg!)).toBe(2); // 临安区 + 富阳区
    expect((r.svg!.match(/text-anchor="middle"/g) ?? []).length).toBe(1); // 外部轮廓不加标签
    expect(nz(r.notes)).toContain("同级候选 1 个（按内置 bbox 预筛掉 0 个），视图内绘出 1 个");
  });

  it("拓展外部轮廓：视图外的同级相邻区域不画", async () => {
    const { box } = makeEnv(); // 默认富阳区在临安区画布右侧之外
    const [off] = await box.generate("330110", { up: 0, down: 0, outside: false });
    expect(off.neighbors).toBe(0);
    const [on] = await box.generate("330110", { up: 0, down: 0, outside: true });
    expect(on.neighbors).toBe(0);
    expect(countPaths(on.svg!)).toBe(1);
    expect(nz(on.notes)).toContain("同级候选 1 个（按内置 bbox 预筛掉 0 个），视图内绘出 0 个");
  });

  it("拓展外部轮廓：最外层级即目标自身时无更上层同级", async () => {
    const { box } = makeEnv();
    const [r] = await box.generate("100000", { up: 0, down: 1, outside: true });
    expect(r.neighbors).toBe(0);
    expect(nz(r.notes)).toContain("没有更上层的同级相邻区域");
  });

  it("目标同级外部轮廓：up=1 时画出相邻「上一层」下、与目标同层级且落在视图内的区域", async () => {
    const tree = node("100000", [
      node("330000", [node("330100", [node("330110", []), node("329111", [])])]),
      node("329000", [node("329100", [])]),
    ]);
    const { box } = makeEnv(tree, {}, {
      ...POLY,
      "329000": "120.0,29.0;122.0,29.0;122.0,31.0;120.0,31.0", // 与视图（浙江省）有交叠
      "329100": "120.2,29.2;121.8,29.2;121.8,30.8;120.2,30.8",
    });
    // 仅给 outsideSameLevel（隐含 outside）：最外层同级 = 江苏省；目标同级 = 江苏省的下级 南京市
    const [r] = await box.generate("杭州市", { up: 1, down: 0, outsideSameLevel: true });
    expect(r.blocks).toBe(1); // 只画 浙江省的地级市（含杭州市）
    expect(r.neighbors).toBe(2); // 江苏省 + 南京市
    expect(nz(r.notes)).toContain("目标同级外部轮廓：候选 1 个（按内置 bbox 预筛掉 0 个），视图内绘出 1 个");
  });

  it("目标同级外部轮廓：视图外的「上一层」不下探", async () => {
    const tree = node("100000", [
      node("330000", [node("330100", [])]),
      node("329000", [node("329100", [])]),
    ]);
    const { box } = makeEnv(tree, {}, {
      ...POLY,
      "329000": "100.0,20.0;101.0,20.0;101.0,21.0;100.0,21.0", // 远在视图外
      "329100": "100.2,20.2;100.8,20.2;100.8,20.8;100.2,20.8",
    });
    const [r] = await box.generate("杭州市", { up: 1, down: 0, outsideSameLevel: true });
    expect(r.neighbors).toBe(0);
    expect(nz(r.notes)).toContain("目标同级外部轮廓：候选 0 个（按内置 bbox 预筛掉 0 个），视图内绘出 0 个");
  });

  it("目标同级外部轮廓：超出可用条件（up>=2 且目标为地级/县级）时报错", async () => {
    const { box } = makeEnv();
    await expect(box.generate("330110", { up: 2, down: 0, outsideSameLevel: true })).rejects.toThrow(/outsideSameLevel/);
  });

  it("版式：ratio / padding / title 生效，非法值报错", async () => {
    const { box } = makeEnv();
    const [on] = await box.generate("杭州市", { up: 0, down: 0 });
    expect(on.svg).toContain(">330100</text>"); // captionSub 在标题行
    const [off] = await box.generate("杭州市", { up: 0, down: 0, title: false, ratio: 1, padding: 0 });
    expect(off.svg).not.toContain(">330100</text>");
    const m = off.svg!.match(/width="(\d+)" height="(\d+)"/)!;
    expect(Math.abs(+m[1]! - +m[2]!)).toBeLessThanOrEqual(1); // 1:1
    await expect(box.generate("杭州市", { ratio: "1:0" })).rejects.toThrow(/ratio/);
    await expect(box.generate("杭州市", { padding: -1 })).rejects.toThrow(/padding/);
    await expect(box.generate("杭州市", { title: "yes" as never })).rejects.toThrow(/title/);
  });

  it("配色：colors 透传到 SVG，非法值报错", async () => {
    const { box } = makeEnv();
    const [r] = await box.generate("杭州市", {
      up: 0,
      down: 0,
      colors: { background: "#001122", line: "#abcdef", targetFill: "#ff0000" },
    });
    expect(r.svg).toContain('fill="#001122"');
    expect(r.svg).toContain('stroke="#abcdef"');
    expect(r.svg).toContain('fill="#ff0000"');
    await expect(box.generate("杭州市", { colors: { line: "" } })).rejects.toThrow(/colors\.line/);
    await expect(box.generate("杭州市", { colors: "dark" as never })).rejects.toThrow(/colors/);
  });

  it("meta/perf：SVG 内嵌元数据、结果带 meta 与缓存命中统计", async () => {
    const { box } = makeEnv();
    const [first] = await box.generate("杭州市");
    expect(first.meta.generator).toMatch(/^@kuriyona\/amap-box@\d/);
    expect(first.meta.source).toContain("restapi.amap.com/v3/config/district");
    expect(first.meta.query).toEqual({ name: "杭州市", adcode: "330100", level: "city" });
    expect(first.meta.landed).toEqual(first.meta.query);
    expect(first.meta.chain.map((c) => c.adcode)).toEqual(["100000", "330000", "330100"]);
    expect(first.meta.span).toEqual({
      up: 0,
      down: 0,
      outside: false,
      outsideSameLevel: false,
      ratio: "auto",
      padding: 24,
      title: true,
      contextLabels: true,
      targetLabels: true,
      targetBackground: true,
      center: false,
    });
    // 结果里的 meta 就是 SVG 里那份（JSON 序列化）
    const embedded = /<metadata>(.*)<\/metadata>/s.exec(first.svg!)![1]!;
    expect(JSON.parse(embedded)).toEqual(first.meta);
    // 首次：索引与目标边界都没缓存 -> 未命中
    expect(first.perf.cacheMisses).toEqual(["index", "330100"]);
    expect(first.perf.cacheHits).toEqual([]);
    // 二次：索引已在实例内存里（不再读缓存），只有边界走缓存命中
    const [second] = await box.generate("杭州市");
    expect(second.perf.cacheHits).toEqual(["330100"]);
    expect(second.perf.cacheMisses).toEqual([]);
  });

  it("meta 随参数变化（up/down/colors/center）", async () => {
    const { box } = makeEnv();
    const [r] = await box.generate("杭州市", { up: 1, down: 1, colors: { line: "#abcdef" }, center: "outline" });
    expect(r.meta.span).toMatchObject({ up: 1, down: 1, colors: { line: "#abcdef" }, center: "outline" });
    const [def] = await box.generate("杭州市");
    expect(def.meta.span).not.toHaveProperty("colors"); // 未给则不出现
  });

  it("非法跨度报错", async () => {
    const { box } = makeEnv();
    await expect(box.generate("杭州市", { down: 2 as never })).rejects.toThrow(/down/);
    await expect(box.generate("杭州市", { up: -1 })).rejects.toThrow(/up/);
    await expect(box.generate("杭州市", { up: 1.5 })).rejects.toThrow(/up/);
  });
});

describe("目标居中", () => {
  it("center:数字 -> 目标居中，且默认开启目标同级外部轮廓；文件名不含 center", async () => {
    const { box } = makeEnv();
    const [r] = await box.generate("杭州市", { up: 1, down: 0, center: 0.5 });
    expect(r.svg).toBeTruthy();
    expect(r.file).toBe("杭州市-330100-u1d0.svg");
    expect(nz(r.notes)).toContain("目标同级外部轮廓"); // 占比模式默认开启
  });

  it('center: "target" / "outline" / true / 数字 均可用', async () => {
    const { box } = makeEnv();
    for (const c of ["target", "outline", true, 0.8] as const) {
      const [r] = await box.generate("杭州市", { up: 1, down: 0, center: c });
      expect(r.svg, String(c)).toBeTruthy();
    }
  });

  it("非法 center 报错", async () => {
    const { box } = makeEnv();
    await expect(box.generate("杭州市", { center: 0 })).rejects.toThrow(/center/);
    await expect(box.generate("杭州市", { center: 1.5 })).rejects.toThrow(/center/);
    await expect(box.generate("杭州市", { center: "huge" as never })).rejects.toThrow(/center/);
  });

  it("center 数字 + up>=2（不满足同级条件）：不默认开启同级轮廓，也不报错", async () => {
    const { box } = makeEnv();
    const [r] = await box.generate("临安区", { up: 2, down: 0, center: 0.5 });
    expect(r.svg).toBeTruthy();
    expect(nz(r.notes)).not.toContain("目标同级外部轮廓");
  });
});

describe("缓存", () => {
  it("二次调用命中缓存，不再打接口", async () => {
    const { box, calls } = makeEnv();
    await box.generate("杭州市");
    const warm = calls.length;
    await box.generate("杭州市");
    expect(calls.length).toBe(warm);
  });

  it("refresh 绕开缓存重建索引", async () => {
    const { box, calls, indexHits } = makeEnv();
    await box.generate("杭州市");
    expect(indexHits()).toBe(1);
    const [r] = await box.generate("杭州市", { refresh: true });
    expect(indexHits()).toBe(2);
    expect(calls.length).toBeGreaterThan(1);
    expect(r.perf.cacheHits).toEqual([]); // 强制绕过缓存 -> 全部算未命中
    expect(r.perf.cacheMisses).toEqual(["index", "330100"]);
  });
});

describe("限流", () => {
  it("可重试错误会退避重试", async () => {
    let first = true;
    const { box } = makeEnv(INDEX_TREE, {
      onIndex: () => {
        if (!first) return null;
        first = false;
        return { status: "0", info: "CUQPS_HAS_EXCEEDED_THE_LIMIT" };
      },
    });
    const [r] = await box.generate("杭州市");
    expect(r.svg).toBeTruthy();
    expect(nz(r.notes)).toContain("限流重试");
  });

  it("不可重试错误立即返回，不空转", async () => {
    let n = 0;
    const { box } = makeEnv(INDEX_TREE, {
      onIndex: () => {
        n++;
        return { status: "0", info: "INVALID_USER_KEY" };
      },
    });
    await expect(box.ready()).rejects.toThrow(/索引/);
    expect(n).toBe(1);
  });
});

describe("notes 分级", () => {
  it("限流重试与 up 越界是 warn，索引构建与外部轮廓计数是 info", async () => {
    let first = true;
    const { box } = makeEnv(INDEX_TREE, {
      onIndex: () => {
        if (!first) return null;
        first = false;
        return { status: "0", info: "CUQPS_HAS_EXCEEDED_THE_LIMIT" };
      },
    });
    const [r] = await box.generate("杭州市", { up: 9, down: 0, outside: true });
    const level = (s: string) => r.notes.find((n) => n.text.includes(s))?.level;
    expect(level("限流重试")).toBe("warn");
    expect(level("超出范围")).toBe("warn");
    expect(level("首次运行")).toBe("info");
    expect(level("拓展外部轮廓")).toBe("info");
  });
});

describe("候选预筛", () => {
  it("表里有的同级候选按 bbox 预筛：视图外的省不取数", async () => {
    const tree = node("100000", [
      node("330000", [node("330100", [])]),
      node("110000", []), // 北京：真实 bbox 与浙江视图不相交
    ]);
    const { box, calls } = makeEnv(tree);
    const [r] = await box.generate("杭州市", { up: 1, down: 0, outside: true });
    expect(calls.some((u) => u.includes("keywords=110000"))).toBe(false);
    expect(nz(r.notes)).toContain("预筛掉 1 个");
  });

  it("表里没有的 adcode 保守取数（不预筛）", async () => {
    const tree = node("100000", [
      node("330000", [node("330100", [])]),
      node("329000", []), // 虚构省：表里没有
    ]);
    const { box, calls } = makeEnv(tree);
    await box.generate("杭州市", { up: 1, down: 0, outside: true });
    expect(calls.some((u) => u.includes("keywords=329000"))).toBe(true);
  });
});

describe("取数预算 maxFetches", () => {
  it("跑满即停：未跑完的图为 null + warn，边界请求数为 0；缓存即进度", async () => {
    const { box, calls } = makeEnv();
    const [r1] = await box.generate("杭州市", { down: 1, maxFetches: 1 });
    expect(r1.svg).toBeNull();
    expect(r1.hash).toBeNull();
    const warn = r1.notes.find((n) => n.text.includes("预算用尽"));
    expect(warn?.level).toBe("warn");
    expect(calls.filter((u) => u.includes("subdistrict=0")).length).toBe(0);

    const [r2] = await box.generate("杭州市", { down: 1, maxFetches: 3 });
    expect(r2.svg).toBeTruthy();
    expect(r2.perf.cacheMisses).toEqual(["330110", "329111", "330100"]);
  });

  it("maxFetches: 0（冷缓存）连索引都拿不到 -> 抛预算错误", async () => {
    const { box } = makeEnv();
    await expect(box.generate("杭州市", { maxFetches: 0 })).rejects.toThrow(/预算/);
    await expect(box.generate("杭州市", { maxFetches: -1 })).rejects.toThrow(/maxFetches/);
    await expect(box.generate("杭州市", { maxFetches: 1.5 })).rejects.toThrow(/maxFetches/);
  });
});

describe("signal", () => {
  it("已中止的信号：抛 AbortError 且一次请求都不发", async () => {
    const { box, calls } = makeEnv();
    const ac = new AbortController();
    ac.abort();
    await expect(box.generate("杭州市", { signal: ac.signal })).rejects.toThrow(/abort/i);
    expect(calls.length).toBe(0);
  });

  it("中途中止（索引返回后）：不再发边界请求", async () => {
    const ac = new AbortController();
    const { box, calls } = makeEnv(INDEX_TREE, {
      onIndex: () => {
        ac.abort();
        return null;
      },
    });
    await expect(box.generate("杭州市", { signal: ac.signal })).rejects.toThrow(/abort/i);
    expect(calls.filter((u) => u.includes("subdistrict=0")).length).toBe(0);
  });
});

describe("hash", () => {
  it("= svg 的 sha256；两次同参一致；svg 为 null 时为 null", async () => {
    const { box } = makeEnv();
    const [r] = await box.generate("杭州市");
    expect(r.hash).toBe(createHash("sha256").update(r.svg!).digest("hex"));
    const [r2] = await box.generate("杭州市");
    expect(r2.hash).toBe(r.hash);

    const tree = node("100000", [node("330000", [node("330900", [])])]);
    const { box: box2 } = makeEnv(tree);
    const [n] = await box2.generate("330900");
    expect(n.svg).toBeNull();
    expect(n.hash).toBeNull();
  });
});
