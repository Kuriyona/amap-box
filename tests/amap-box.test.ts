import { describe, expect, it } from "vitest";
import { AmapBox } from "../src/index.js";
import type { AmapCache, AmapDistrict } from "../src/types.js";

// ---------------------------------------------------------------- fixture
const NAMES: Record<string, { name: string; level: string }> = {
  "100000": { name: "中华人民共和国", level: "country" },
  "330000": { name: "浙江省", level: "province" },
  "330100": { name: "杭州市", level: "city" },
  "330110": { name: "临安区", level: "district" },
  "330111": { name: "富阳区", level: "district" },
  "330200": { name: "宁波市", level: "city" },
  "330211": { name: "同名区", level: "district" },
  "320000": { name: "江苏省", level: "province" },
  "320100": { name: "南京市", level: "city" },
};

const POLY: Record<string, string> = {
  "100000": "73,18;135,18;135,54;73,54",
  "330000": "119,29;122,29;122,32;119,32",
  "330100": "119.5,29.5;121.5,29.5;121.5,31.5;119.5,31.5",
  "330110": "119.6,29.6;120.4,29.6;120.4,30.4;119.6,30.4",
  "330111": "120.6,29.6;121.4,29.6;121.4,30.4;120.6,30.4",
  "330211": "120.6,29.6;121.4,29.6;121.4,30.4;120.6,30.4",
};

const node = (adcode: string, districts?: AmapDistrict[]): AmapDistrict => ({
  ...NAMES[adcode],
  adcode,
  center: "120.5,30.5",
  ...(districts ? { districts } : {}),
});

const INDEX_TREE = node("100000", [
  node("330000", [node("330100", [node("330110", []), node("330111", [])])]),
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
    expect(notes.join("\n")).toContain("只取前 20 个");
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
    expect(r.notes.join("\n")).toContain("超出范围");
  });

  it("县级目标 down1：下级是乡镇/街道，记提示并退化为只画自身", async () => {
    const { box } = makeEnv();
    const [r] = await box.generate("330110", { down: 1 });
    expect(r.notes.join("\n")).toContain("乡镇/街道级");
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
    for (const r of res) expect(r.notes.join("\n")).toContain("乡镇/街道级");
    expect(res[0].notes.join("\n")).toContain("首次运行");
    expect(res[1].notes.join("\n")).not.toContain("首次运行");
  });

  it("拓展外部轮廓：画视图内的同级相邻区域（不往下细分、不加标签）", async () => {
    const { box } = makeEnv(INDEX_TREE, {}, {
      ...POLY,
      // 富阳区与临安区在视图内有交叠
      "330111": "119.8,29.8;120.6,29.8;120.6,30.6;119.8,30.6",
    });
    const [r] = await box.generate("330110", { up: 0, down: 0, outside: true });
    expect(r.landed.adcode).toBe("330110");
    expect(r.blocks).toBe(1); // 只画自身
    expect(r.neighbors).toBe(1); // 富阳区
    expect(countPaths(r.svg!)).toBe(2); // 临安区 + 富阳区
    expect((r.svg!.match(/text-anchor="middle"/g) ?? []).length).toBe(1); // 外部轮廓不加标签
    expect(r.notes.join("\n")).toContain("同级候选 1 个，视图内绘出 1 个");
  });

  it("拓展外部轮廓：视图外的同级相邻区域不画", async () => {
    const { box } = makeEnv(); // 默认富阳区在临安区画布右侧之外
    const [off] = await box.generate("330110", { up: 0, down: 0, outside: false });
    expect(off.neighbors).toBe(0);
    const [on] = await box.generate("330110", { up: 0, down: 0, outside: true });
    expect(on.neighbors).toBe(0);
    expect(countPaths(on.svg!)).toBe(1);
    expect(on.notes.join("\n")).toContain("同级候选 1 个，视图内绘出 0 个");
  });

  it("拓展外部轮廓：最外层级即目标自身时无更上层同级", async () => {
    const { box } = makeEnv();
    const [r] = await box.generate("100000", { up: 0, down: 1, outside: true });
    expect(r.neighbors).toBe(0);
    expect(r.notes.join("\n")).toContain("没有更上层的同级相邻区域");
  });

  it("目标同级外部轮廓：up=1 时画出相邻「上一层」下、与目标同层级且落在视图内的区域", async () => {
    const tree = node("100000", [
      node("330000", [node("330100", [node("330110", []), node("330111", [])])]),
      node("320000", [node("320100", [])]),
    ]);
    const { box } = makeEnv(tree, {}, {
      ...POLY,
      "320000": "120.0,29.0;122.0,29.0;122.0,31.0;120.0,31.0", // 与视图（浙江省）有交叠
      "320100": "120.2,29.2;121.8,29.2;121.8,30.8;120.2,30.8",
    });
    // 仅给 outsideSameLevel（隐含 outside）：最外层同级 = 江苏省；目标同级 = 江苏省的下级 南京市
    const [r] = await box.generate("杭州市", { up: 1, down: 0, outsideSameLevel: true });
    expect(r.blocks).toBe(1); // 只画 浙江省的地级市（含杭州市）
    expect(r.neighbors).toBe(2); // 江苏省 + 南京市
    expect(r.notes.join("\n")).toContain("目标同级外部轮廓：候选 1 个，视图内绘出 1 个");
  });

  it("目标同级外部轮廓：视图外的「上一层」不下探", async () => {
    const tree = node("100000", [
      node("330000", [node("330100", [])]),
      node("320000", [node("320100", [])]),
    ]);
    const { box } = makeEnv(tree, {}, {
      ...POLY,
      "320000": "100.0,20.0;101.0,20.0;101.0,21.0;100.0,21.0", // 远在视图外
      "320100": "100.2,20.2;100.8,20.2;100.8,20.8;100.2,20.8",
    });
    const [r] = await box.generate("杭州市", { up: 1, down: 0, outsideSameLevel: true });
    expect(r.neighbors).toBe(0);
    expect(r.notes.join("\n")).toContain("目标同级外部轮廓：候选 0 个，视图内绘出 0 个");
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
    expect(r.notes.join("\n")).toContain("目标同级外部轮廓"); // 占比模式默认开启
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
    expect(r.notes.join("\n")).not.toContain("目标同级外部轮廓");
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
    await box.generate("杭州市", { refresh: true });
    expect(indexHits()).toBe(2);
    expect(calls.length).toBeGreaterThan(1);
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
    expect(r.notes.join("\n")).toContain("限流重试");
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
