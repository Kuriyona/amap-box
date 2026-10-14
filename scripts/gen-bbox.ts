#!/usr/bin/env bun
/**
 * 生成 `src/data/bbox.ts`：省 / 地级行政区的经纬度包围盒（内置预筛数据）。
 *
 *   bun scripts/gen-bbox.ts [--refresh] [--check] [--cache <dir>]
 *
 * 取全国索引（缓存 `index.json`）-> 递归收集 `level ∈ {province, city}` 的节点（跳过国家级）
 * -> 每个 adcode 取自身边界（缓存 `<adcode>.json`，缺失才请求）-> `parsePolyline` 求包围盒，
 * 向外取整到 1e-3 -> 按 adcode 升序写成 TS 常量表。
 *
 * `--check` 用缓存里已有的边界重算所有能校验的条目并逐项比对（校验生成器自洽）。
 *
 * 这是一次性 dev 工具，不随包发布。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parsePolyline } from "../src/geometry.js";
import { diskCache, loadKey, nodeFetch } from "../src/cli/common.js";

const API = "https://restapi.amap.com/v3/config/district";
const RETRYABLE = /CUQPS_HAS_EXCEEDED_THE_LIMIT|SERVICE_NOT_AVAILABLE|TIMEOUT|UNKNOWN_ERROR/i;
const GAP = 350;
const LEVELS: Record<string, true> = { province: true, city: true };
const OUT = "src/data/bbox.ts";
const COUNTRY = "100000";

interface AmapDistrict {
  name: string;
  adcode: string;
  level?: string;
  polyline?: string;
  districts?: AmapDistrict[];
  [key: string]: unknown;
}
interface ApiResponse {
  status?: string;
  info?: string;
  districts?: AmapDistrict[];
}

const sleep = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

async function main() {
  const argv = process.argv.slice(2);
  let refresh = false;
  let check = false;
  let cacheDir = "districts";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--refresh") refresh = true;
    else if (a === "--check") check = true;
    else if (a === "--cache") cacheDir = argv[++i];
    else if (a === "-h" || a === "--help") {
      console.log("用法: bun scripts/gen-bbox.ts [--refresh] [--check] [--cache <dir>]");
      process.exit(0);
    } else {
      console.error(`未知选项: ${a}`);
      process.exit(2);
    }
  }

  const KEY = loadKey();
  if (!KEY) {
    console.error("缺少高德 key：设置环境变量 AMAP_KEY，或在 .env 写入 KEY=...");
    process.exit(2);
  }
  const cache = diskCache(cacheDir);

  /** 单次请求 + 限流退避（同 AmapBox#apiQuery：非限流错误立即返回）。 */
  const apiQuery = async (params: Record<string, string>): Promise<ApiResponse> => {
    const url = `${API}?${new URLSearchParams({ key: KEY, showbiz: "false", extensions: "all", ...params })}`;
    let info = "unknown";
    for (let t = 0; t < 6; t++) {
      let d: ApiResponse;
      try {
        d = ((await nodeFetch(url)) ?? {}) as ApiResponse;
      } catch (e) {
        d = { status: "0", info: String(e) };
      }
      if (d.status === "1") return d;
      info = d.info ?? "unknown";
      if (!RETRYABLE.test(info)) return d;
      if (t < 5) {
        console.error(`  限流重试 ${t + 1}/5: ${info}`);
        await sleep(700 + 500 * t);
      }
    }
    return { status: "0", info };
  };

  const readCache = async (key: string): Promise<ApiResponse | null> => {
    if (refresh) return null;
    const raw = await cache.read(key);
    if (!raw) return null;
    try {
      const d = JSON.parse(raw) as ApiResponse;
      return d?.districts?.length ? d : null;
    } catch {
      return null;
    }
  };

  // ------------------------------------------------------------------ 索引
  let index = await readCache("index");
  if (!index) {
    console.error("拉取全国索引（一次请求，不含边界）…");
    const d = await apiQuery({ keywords: COUNTRY, subdistrict: "3", extensions: "base" });
    if (d.status !== "1" || !d.districts?.length) {
      console.error(`无法获取全国索引: ${d.info}`);
      process.exit(1);
    }
    await cache.write("index", JSON.stringify(d));
    index = d;
  }
  const root = index.districts![0]!;

  const nodes: AmapDistrict[] = [];
  const walk = (n: AmapDistrict, isRoot = false) => {
    if (!isRoot && n.level && LEVELS[n.level]) nodes.push(n);
    for (const c of n.districts ?? []) walk(c);
  };
  walk(root, true);

  // ------------------------------------------------------------------ 边界
  let fetched = 0;
  let cached = 0;
  const entries: Array<[string, [number, number, number, number]]> = [];
  const skipped: string[] = [];
  for (const n of nodes) {
    let d = await readCache(n.adcode);
    if (d) cached++;
    else {
      d = await apiQuery({ keywords: n.adcode, subdistrict: "0", extensions: "all" });
      if (d.status !== "1" || !d.districts?.length) {
        skipped.push(`${n.adcode} ${n.name}（${d.info}）`);
        continue;
      }
      await cache.write(n.adcode, JSON.stringify(d));
      fetched++;
      await sleep(GAP);
    }
    const bbox = bboxOf(parsePolyline(d.districts![0]!.polyline));
    if (!bbox) {
      skipped.push(`${n.adcode} ${n.name}（无 polyline）`);
      continue;
    }
    entries.push([n.adcode, bbox]);
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const prov = nodes.filter((n) => n.level === "province").length;
  const city = nodes.filter((n) => n.level === "city").length;

  if (check) {
    const have = existsSync(OUT) ? readJsonTable() : new Map<string, number[]>();
    let ok = 0;
    let miss = 0;
    let bad = 0;
    for (const [adcode, bbox] of entries) {
      const t = have.get(adcode);
      if (!t) {
        miss++;
        continue;
      }
      if (!(t.length === bbox.length && t.every((v, i) => v === bbox[i]))) {
        bad++;
        console.error(`DIFF ${adcode} 表值 ${t.join(", ")} vs 实算 ${bbox.join(", ")}`);
      } else ok++;
    }
    console.error(`已校验 ${ok} 项，缓存缺失跳过 ${miss} 项${bad ? `，不一致 ${bad} 项` : ""}`);
    process.exit(bad ? 1 : 0);
  }

  const body =
    "/** 省 / 地级行政区的经纬度包围盒（内置预筛数据）。\n" +
    " * 由 `bun scripts/gen-bbox.ts` 生成（AMap 行政区划接口，原始边界外接矩形，向外取整到 1e-3），请勿手改。 */\n" +
    "export const BBOX: Record<string, readonly [number, number, number, number]> = {\n" +
    entries.map(([a, b]) => `  "${a}": [${b.join(", ")}],`).join("\n") +
    "\n};\n";
  writeFileSync(OUT, body);
  console.error(`内置 bbox：省 ${prov} 个 / 地级 ${city} 个（新拉 ${fetched}，缓存命中 ${cached}）`);
  if (skipped.length) for (const s of skipped) console.error(`  跳过 ${s}`);
  console.error(`已写入 ${OUT}（${entries.length} 项）`);
}

/** 外接矩形，向外取整到 1e-3；无点返回 null。 */
function bboxOf(rings: Array<Array<[number, number]>>): [number, number, number, number] | null {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const ring of rings)
    for (const [lon, lat] of ring) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  if (!Number.isFinite(minLon)) return null;
  return [
    Math.floor(minLon * 1000) / 1000,
    Math.floor(minLat * 1000) / 1000,
    Math.ceil(maxLon * 1000) / 1000,
    Math.ceil(maxLat * 1000) / 1000,
  ];
}

/** 读取已生成的表（用于 `--check`）。 */
function readJsonTable(): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const src = readFileSync(OUT, "utf8");
  for (const m of src.matchAll(/"(\d+)":\s*\[([^\]]+)\]/g)) {
    out.set(m[1]!, m[2]!.split(",").map((s) => Number(s.trim())));
  }
  return out;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
