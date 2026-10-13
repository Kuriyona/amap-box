#!/usr/bin/env node
/**
 * CLI：审阅页生成器（正式流程的最后一步）。把目标地区的**全部跨度组合**出一遍，
 * 汇成一个可以在浏览器里逐张看、逐张写评语的页面。
 *
 *   amap-box-review [目标...] [--out <dir>] [--html <file>] [--cache <dir>] [--refresh]
 *
 * 默认目标 = 基准测试的四个层级：中国 / 浙江省 / 杭州市 / 临安区。
 * 每个目标先跑一次 up=max 探出它在层级树里的深度 d（文件名里带），
 * 再展开 up ∈ [0..d] × down ∈ {0,1}（4 个基准目标 = 2+4+6+8 = 20 张）。
 *
 * 出图全走 `AmapBox` 本身，所以缓存、索引、命名规则都跟正式出图完全一致。
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { AmapBox } from "../index.js";
import { diskCache, loadKey, nodeFetch } from "./common.js";
import { renderReviewPage, type PageGroup, type PageItem } from "./review-page.js";

const DEFAULTS = ["中国", "浙江省", "杭州市", "临安区"];
const USAGE = `用法: amap-box-review [目标...] [选项]
  --out <dir>    SVG 输出目录        (默认 review)
  --html <file>  审阅页              (默认 review.html；图片按 <out> 相对它定位)
  --cache <dir>  边界+索引缓存目录    (默认 districts)
  --refresh      忽略缓存重新出图
不带目标时用基准四个层级: ${DEFAULTS.join(" / ")}`;

async function main() {
  const flags = { out: "review", html: "review.html", cache: "districts", refresh: false };
  const targets: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") flags.out = argv[++i];
    else if (a === "--html") flags.html = argv[++i];
    else if (a === "--cache") flags.cache = argv[++i];
    else if (a === "--refresh") flags.refresh = true;
    else if (a === "-h" || a === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else if (a.startsWith("-")) {
      console.error(`未知选项: ${a}\n\n${USAGE}`);
      process.exit(2);
    } else targets.push(a);
  }
  if (!targets.length) targets.push(...DEFAULTS);

  const KEY = loadKey();
  if (!KEY) {
    console.error("缺少高德 key：设置环境变量 AMAP_KEY，或在 .env 写入 KEY=...");
    process.exit(2);
  }
  const box = new AmapBox({ Key: KEY, fetch: nodeFetch, cache: diskCache(flags.cache) });

  const parseName = (file: string) => {
    const m = file.match(/^(.*)-(\d+)-u(\d+)d(\d+)\.svg$/);
    if (!m) {
      console.error(`出不认识的文件名: ${file}`);
      process.exit(1);
    }
    return { name: m[1], adcode: m[2], up: +m[3], down: +m[4] };
  };

  mkdirSync(flags.out, { recursive: true });

  /** 出一次图，落盘并收集审阅项。 */
  async function gen(target: string, up: number | "max", down: 0 | 1): Promise<Array<PageItem & { hash: string }>> {
    const items: Array<PageItem & { hash: string }> = [];
    for (const r of await box.generate(target, { up, down, refresh: flags.refresh })) {
      if (!r.svg) continue;
      const info = parseName(r.file);
      writeFileSync(join(flags.out, r.file), r.svg);
      items.push({
        id: `${info.adcode}-u${up}d${down}`,
        k: `u${up}d${down}`,
        file: r.file,
        landed: info.name,
        paths: (r.svg.match(/<path /g) ?? []).length,
        labels: (r.svg.match(/text-anchor="middle"/g) ?? []).length,
        cmd: `amap-box ${target} --up ${up} --down ${down}`,
        warn: r.notes,
        hash: createHash("sha1").update(r.svg).digest("hex"),
      });
    }
    if (!items.length) {
      console.error(`没能出图: amap-box ${target} --up ${up} --down ${down}`);
      process.exit(1);
    }
    return items;
  }

  const groups: PageGroup[] = [];
  for (const target of targets) {
    // 探深度：up=max 会被夹到目标深度，文件名里的 u<K> 就是 d
    const d = Math.max(...(await gen(target, "max", 0)).map((p) => parseName(p.file).up));
    const items: Array<PageItem & { hash: string }> = [];
    for (let up = 0; up <= d; up++) {
      for (const down of [0, 1] as const) items.push(...(await gen(target, up, down)));
    }
    // 逐字节相同的组合（县级目标 down=1 退化为只画自身）
    const byHash = new Map<string, typeof items>();
    for (const it of items) {
      if (!byHash.has(it.hash)) byHash.set(it.hash, []);
      byHash.get(it.hash)!.push(it);
    }
    for (const same of byHash.values()) {
      if (same.length > 1) for (const it of same) it.same = same.filter((x) => x !== it).map((x) => x.k).join("、");
    }
    groups.push({ name: target, adcode: parseName(items[0].file).adcode, d, items });
    console.log(`${target}: d=${d} → ${items.length} 张 (${items.map((i) => i.k).join(" ")})`);
  }

  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const outDir = flags.out.split(sep).join("/").replace(/\/+$/, "");
  writeFileSync(flags.html, renderReviewPage({ total, outDir, groups }));
  console.log(`已写入 ${flags.html}（${total} 张，图片指向 ${outDir}/）`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
