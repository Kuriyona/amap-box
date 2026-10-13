#!/usr/bin/env node
/**
 * CLI：高德行政区划 -> SVG（深色线稿），单张图。
 *
 *   amap-box <行政区名|adcode> [--up N|max] [--down 0|1] [--out <dir>] [--cache <dir>] [--refresh]
 *
 * 只是 `AmapBox` 的一层壳：key 从环境变量/`.env` 取，缓存落磁盘，`fetch` 用全局 fetch，
 * 然后把每张图写进 `--out`。出图逻辑全部在库内。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AmapBox } from "../index.js";
import { diskCache, loadKey, nodeFetch } from "./common.js";

const USAGE = `用法: amap-box <行政区名|adcode> [选项]
选项:
  --up <N|max>   往上包含几级祖先   (默认 0；max = 一直到国家级)
  --down <0|1>   往下细分几级       (默认 1；0 = 只画目标自身)
  --chain        等价于 --up max
  --outside      拓展外部轮廓：把「最外层级」同级、落在视图内的相邻区域一并画出（不往下细分）
  --ratio <auto|W:H|N>  画幅宽高比   (默认 auto = 按内容；如 1、16:9)
  --padding <N>  内容四周留白(px)    (默认 24)
  --no-title     不画标题            (默认画)
  --out <dir>    输出目录            (默认 out)
  --cache <dir>  边界+索引缓存目录     (默认 districts)
  --refresh      忽略缓存，重新拉取（含重建全国索引）
层级: 国家级(0) -> 省级(1) -> 地级(2) -> 县级(3)
索引: <cache>/index.json 首次运行一次请求生成，之后查找/层级只走它`;

async function main() {
  const flags: {
    out: string;
    cache: string;
    refresh: boolean;
    chain: boolean;
    outside: boolean;
    noTitle: boolean;
    ratio?: string;
    padding?: string;
    up?: string;
    down?: string;
  } = {
    out: "out",
    cache: "districts",
    refresh: false,
    chain: false,
    outside: false,
    noTitle: false,
  };
  let keyword: string | null = null;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") flags.out = argv[++i];
    else if (a === "--cache") flags.cache = argv[++i];
    else if (a === "--up") flags.up = argv[++i];
    else if (a === "--down") flags.down = argv[++i];
    else if (a === "--chain") flags.chain = true;
    else if (a === "--outside") flags.outside = true;
    else if (a === "--no-title") flags.noTitle = true;
    else if (a === "--ratio") flags.ratio = argv[++i];
    else if (a === "--padding") flags.padding = argv[++i];
    else if (a === "--refresh") flags.refresh = true;
    else if (a === "-h" || a === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else if (a.startsWith("-")) {
      console.error(`未知选项: ${a}\n\n${USAGE}`);
      process.exit(2);
    } else if (keyword === null) keyword = a;
    else {
      console.error(`只接受一个行政区名（多余: ${a}）\n\n${USAGE}`);
      process.exit(2);
    }
  }
  if (!keyword) {
    console.error(USAGE);
    process.exit(2);
  }

  // 跨度参数：up 可以超过目标深度（会 clamp 并警告），down 只有 0/1
  let upReq: number | "max" = flags.chain ? "max" : 0;
  if (flags.up !== undefined) {
    const v = String(flags.up).toLowerCase();
    if (v === "max") upReq = "max";
    else if (/^\d+$/.test(v)) upReq = Number(v);
    else {
      console.error(`--up 只接受非负整数或 max，收到: ${flags.up}\n\n${USAGE}`);
      process.exit(2);
    }
  }
  let downReq: 0 | 1 = 1;
  if (flags.down !== undefined) {
    const v = String(flags.down).toLowerCase();
    if (v === "0") downReq = 0;
    else if (v === "1" || v === "max") downReq = 1;
    else {
      console.error(`--down 只接受 0 或 1（最多 1 级），收到: ${flags.down}\n\n${USAGE}`);
      process.exit(2);
    }
  }

  // 版式：比例 / 留白 / 标题
  let ratio: number | "auto" | undefined;
  if (flags.ratio !== undefined) {
    const v = String(flags.ratio).trim().toLowerCase();
    const wh = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(v);
    if (v === "auto") ratio = "auto";
    else if (wh && Number(wh[1]) > 0 && Number(wh[2]) > 0) ratio = Number(wh[1]) / Number(wh[2]);
    else if (/^\d+(?:\.\d+)?$/.test(v) && Number(v) > 0) ratio = Number(v);
    else {
      console.error(`--ratio 只接受 auto、W:H 或正数，收到: ${flags.ratio}\n\n${USAGE}`);
      process.exit(2);
    }
  }
  let padding: number | undefined;
  if (flags.padding !== undefined) {
    const v = String(flags.padding).trim();
    if (/^\d+(?:\.\d+)?$/.test(v)) padding = Number(v);
    else {
      console.error(`--padding 只接受非负数字，收到: ${flags.padding}\n\n${USAGE}`);
      process.exit(2);
    }
  }

  const KEY = loadKey();
  if (!KEY) {
    console.error("缺少高德 key：设置环境变量 AMAP_KEY，或在 .env 写入 KEY=...");
    process.exit(2);
  }

  const box = new AmapBox({ Key: KEY, fetch: nodeFetch, cache: diskCache(flags.cache) });

  let generated;
  try {
    generated = await box.generate(keyword, {
      up: upReq,
      down: downReq,
      outside: flags.outside,
      ratio,
      padding,
      title: !flags.noTitle,
      refresh: flags.refresh,
    });
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  mkdirSync(flags.out, { recursive: true });
  let written = 0;
  for (const r of generated) {
    console.log(`· ${r.query.name} (${r.query.level} ${r.query.adcode})`);
    for (const n of r.notes) console.error(`  ${n}`);
    if (!r.svg) continue;
    const file = join(flags.out, r.file);
    writeFileSync(file, r.svg);
    const bits = [
      `往上 ${r.up} 级 / 往下 ${r.down} 级`,
      `${r.blocks} 个区块${r.outline ? " + 整体轮廓" : ""}${r.neighbors ? ` + ${r.neighbors} 个外部轮廓` : ""}`,
    ];
    if (flags.ratio !== undefined) bits.push(`画幅 ${flags.ratio}`);
    if (flags.padding !== undefined) bits.push(`留白 ${flags.padding}px`);
    if (flags.noTitle) bits.push("无标题");
    console.log(`  已写入 ${file}  （${bits.join("；")}）`);
    written++;
  }

  if (!written) {
    console.error("没有生成任何文件");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
