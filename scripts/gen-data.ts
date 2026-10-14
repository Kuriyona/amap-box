#!/usr/bin/env bun
/**
 * 生成 `src/data/regions.ts`：内置的全国行政区划索引 + 省/地级经纬度包围盒。
 *
 *   bun scripts/gen-data.ts [--refresh] [--check] [--cache <dir>]
 *
 * 索引（`level` 全树，含 `center`、不含边界）来自缓存 `index.json`，缺失才请求一次；
 * 包围盒取 `level ∈ {province, city}` 的节点，逐个取自身边界（缓存 `<adcode>.json`，缺失才请求）
 * 求外接矩形并向外取整到 1e-3。两者出自同一次遍历，不会互相漂移。
 *
 * `--check` 用缓存里已有的数据重算并逐项比对现有文件（校验生成器自洽），不一致时退出码 1。
 *
 * 这是一次性 dev 工具，不随包发布。
 */
import { existsSync, writeFileSync } from "node:fs";
import { parsePolyline } from "../src/geometry.js";
import { diskCache, loadKey, nodeFetch } from "../src/cli/common.js";

const API = "https://restapi.amap.com/v3/config/district";
const RETRYABLE = /CUQPS_HAS_EXCEEDED_THE_LIMIT|SERVICE_NOT_AVAILABLE|TIMEOUT|UNKNOWN_ERROR/i;
const GAP = 350;
/** 索引里出现的级别（顺序即生成文件里的级别码）。 */
const LEVELS = ["country", "province", "city", "district", "street"] as const;
/** 收进包围盒表的级别。 */
const BBOX_LEVELS: Record<string, true> = { province: true, city: true };
const OUT = "src/data/regions.ts";
const COUNTRY = "100000";

interface AmapDistrict {
  name: string;
  adcode: string;
  level?: string;
  center?: string;
  polyline?: string;
  districts?: AmapDistrict[];
  [key: string]: unknown;
}
interface ApiResponse {
  status?: string;
  info?: string;
  districts?: AmapDistrict[];
}
/** 生成文件里的一行：`[adcode, 名称, 级别码, 中心经度, 中心纬度, 下级?]`。 */
type RegionRow = [number, string, number, number, number, RegionRow[]?];

const sleep = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/** 去掉浮点尾巴的十进制写法（`116.3683244` -> `116.368324`）。 */
const num = (v: number, digits: number): string => String(round(v, digits));

/** 四舍五入到 `digits` 位小数（生成物与比对都用它，保证字面量一致）。 */
const round = (v: number, digits: number): number => Math.round(v * 10 ** digits) / 10 ** digits;

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
      console.log("用法: bun scripts/gen-data.ts [--refresh] [--check] [--cache <dir>]");
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

  // 索引 -> 紧凑行（同一份遍历既出 REGIONS，又收集要算包围盒的节点）。
  const bboxNodes: AmapDistrict[] = [];
  const rowOf = (n: AmapDistrict): RegionRow => {
    const code = LEVELS.indexOf((n.level ?? "") as (typeof LEVELS)[number]);
    if (code < 0) throw new Error(`未知 level「${n.level}」（${n.adcode} ${n.name}）`);
    const [lon, lat] = (n.center ?? "").split(",").map(Number);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      console.error(`  警告 ${n.adcode} ${n.name} 无 center，中心按 0,0 写入`);
      return [Number(n.adcode), n.name, code, 0, 0];
    }
    return [Number(n.adcode), n.name, code, round(lon!, 6), round(lat!, 6)];
  };
  const walk = (n: AmapDistrict, isRoot = false): RegionRow => {
    if (!isRoot && n.level && BBOX_LEVELS[n.level]) bboxNodes.push(n);
    const row = rowOf(n);
    const kids = (n.districts ?? []).map((c) => walk(c));
    if (kids.length) row.push(kids);
    return row;
  };
  const regionsRoot = walk(root, true);

  // ------------------------------------------------------------------ 包围盒
  let fetched = 0;
  let cached = 0;
  const entries: Array<[string, [number, number, number, number]]> = [];
  const skipped: string[] = [];
  for (const n of bboxNodes) {
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

  const count = (lvl: string) => {
    let n = 0;
    const visit = (r: RegionRow) => {
      if (LEVELS[r[2]] === lvl) n++;
      for (const c of r[5] ?? []) visit(c);
    };
    visit(regionsRoot);
    return n;
  };
  const stats = LEVELS.map((l) => `${l} ${count(l)}`).join(" / ");

  if (check) {
    if (!existsSync(OUT)) {
      console.error(`--check 需要已存在的 ${OUT}`);
      process.exit(1);
    }
    const have = (await import(`../${OUT}`)) as { REGIONS: unknown; BBOX: Record<string, number[]> };
    const diffs: string[] = [];
    if (JSON.stringify(have.REGIONS) !== JSON.stringify([regionsRoot]))
      diffs.push("REGIONS 与缓存索引重建结果不一致");
    const haveKeys = Object.keys(have.BBOX);
    for (const [adcode, bbox] of entries) {
      const t = have.BBOX[adcode];
      if (!t) diffs.push(`BBOX 缺 ${adcode}`);
      else if (!(t.length === bbox.length && t.every((v, i) => v === bbox[i])))
        diffs.push(`BBOX ${adcode} 表值 ${t.join(", ")} vs 实算 ${bbox.join(", ")}`);
    }
    for (const k of haveKeys) if (!entries.some(([a]) => a === k)) diffs.push(`BBOX 多出 ${k}`);
    for (const d of diffs) console.error(`DIFF ${d}`);
    console.error(
      `已校验 REGIONS（${haveKeys.length} 条 bbox + 索引树），缓存缺失跳过 ${skipped.length} 项` +
        (diffs.length ? `，不一致 ${diffs.length} 项` : ""),
    );
    process.exit(diffs.length ? 1 : 0);
  }

  const body =
    "/**\n" +
    " * 内置全国行政区划索引 + 省 / 地级经纬度包围盒。\n" +
    " *\n" +
    ` * 由 \`bun scripts/gen-data.ts\` 生成（AMap 行政区划接口），请勿手改：${stats}。\n` +
    " * 索引不含边界；包围盒是原始边界的外接矩形，向外取整到 1e-3。\n" +
    " */\n" +
    "\n" +
    "/** 级别码 → 级别名。 */\n" +
    `export const LEVELS = [${LEVELS.map((l) => JSON.stringify(l)).join(", ")}] as const;\n` +
    "\n" +
    "/** 索引一行：`[adcode, 名称, 级别码（索引 LEVELS）, 中心经度, 中心纬度, 下级?]`。 */\n" +
    "export type RegionRow = readonly [\n" +
    "  adcode: number,\n" +
    "  name: string,\n" +
    "  level: number,\n" +
    "  lon: number,\n" +
    "  lat: number,\n" +
    "  children?: readonly RegionRow[],\n" +
    "];\n" +
    "\n" +
    "/** 全国行政区划索引（根节点 `100000`）。 */\n" +
    "export const REGIONS: readonly RegionRow[] = [\n" +
    emitRow(regionsRoot, 1) +
    "\n];\n" +
    "\n" +
    "/** 省 / 地级行政区的经纬度包围盒（`[西, 南, 东, 北]`）。 */\n" +
    "export const BBOX: Readonly<Record<string, readonly [number, number, number, number]>> = {\n" +
    entries.map(([a, b]) => `  "${a}": [${b.join(", ")}],`).join("\n") +
    "\n};\n";
  writeFileSync(OUT, body);
  console.error(`内置数据：${stats}`);
  console.error(`内置 bbox ${entries.length} 项（新拉 ${fetched}，缓存命中 ${cached}）`);
  if (skipped.length) for (const s of skipped) console.error(`  跳过 ${s}`);
  console.error(`已写入 ${OUT}`);
}

/** 把一行渲染成 TS 字面量（有下级时换行缩进，叶子行单行）。 */
function emitRow(row: RegionRow, depth: number): string {
  const pad = "  ".repeat(depth);
  const head =
    `[${row[0]}, ${JSON.stringify(row[1])}, ${row[2]}, ${num(row[3], 6)}, ${num(row[4], 6)}`;
  const kids = row[5];
  if (!kids?.length) return `${pad}${head}],`;
  return (
    `${pad}${head}, [\n` +
    kids.map((k) => emitRow(k, depth + 1)).join("\n") +
    `\n${pad}]],`
  );
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

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
