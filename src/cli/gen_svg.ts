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
import type { MapRatio } from "../types.js";
import { diskCache, loadKey, nodeFetch, renderNameTemplate } from "./common.js";

const USAGE = `用法: amap-box <行政区名|adcode> [选项]
选项:
  --up <N|max>   往上包含几级祖先   (默认 0；max = 一直到国家级)
  --down <0|1>   往下细分几级       (默认 0；0 = 只画目标自身，1 = 再画一级下级)
  --chain        等价于 --up max
  --outside      拓展外部轮廓：把「最外层级」同级、落在视图内的相邻区域一并画出（不往下细分）
  --outside-same-level  同时把「与目标同层级」、落在视图内的区域也作为外部轮廓画出（隐含 --outside；
                        仅 up<=1 或目标为省级以上时可用，否则报错）
  --ratio <auto|W:H|N>  画幅宽高比   (默认 auto = 按内容；如 1、16:9)
  --padding <N>  内容四周留白(px)    (默认 24)
  --no-title     不画标题            (默认画)
  --no-context-labels  不画非目标节点（上下文）的标签  (默认画)
  --no-target-label    不画目标节点自身的标签          (默认画)
  --no-target-bg       不给目标节点所在区域填充背景高亮 (默认填)
  --center [outline|target|N]  让目标居中 (默认不居中，内容居中)：
                        outline = 目标居中且整体轮廓完整；target = 目标占画幅长边 0.5；
                        N(0<N<=1) = 目标占画幅长边比例（target/N 隐含目标同级外部轮廓）
  --out <dir>    输出目录            (默认 out；「-」= 写到 stdout，只允许单个命中)
  --cache <dir>  边界+索引缓存目录     (默认 districts)
  --max-fetches <N>  本轮最多新增几次取数（缓存未命中才计；跑满即停，未跑完的图不写）
  --key <KEY>    高德 key（优先于 AMAP_KEY 与 .env）
  --name <template>  文件名模板：{name} / {adcode} / {up} / {down}（未以 .svg 结尾自动补；多命中同名会互相覆盖）
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
    outsideSameLevel: boolean;
    noTitle: boolean;
    noContextLabels: boolean;
    noTargetLabel: boolean;
    noTargetBg: boolean;
    ratio?: string;
    padding?: string;
    center?: string;
    up?: string;
    down?: string;
    maxFetches?: string;
    key?: string;
    name?: string;
  } = {
    out: "out",
    cache: "districts",
    refresh: false,
    chain: false,
    outside: false,
    outsideSameLevel: false,
    noTitle: false,
    noContextLabels: false,
    noTargetLabel: false,
    noTargetBg: false,
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
    else if (a === "--outside-same-level") flags.outsideSameLevel = true;
    else if (a === "--no-title") flags.noTitle = true;
    else if (a === "--no-context-labels") flags.noContextLabels = true;
    else if (a === "--no-target-label") flags.noTargetLabel = true;
    else if (a === "--no-target-bg") flags.noTargetBg = true;
    else if (a === "--ratio") flags.ratio = argv[++i];
    else if (a === "--padding") flags.padding = argv[++i];
    else if (a === "--max-fetches") flags.maxFetches = argv[++i];
    else if (a === "--key") flags.key = argv[++i];
    else if (a === "--name") flags.name = argv[++i];
    else if (a === "--center") {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-") && /^(outline|target|\d+(?:\.\d+)?)$/i.test(next)) {
        flags.center = next;
        i++;
      } else flags.center = "outline"; // 裸 --center = 方案一
    }
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
  let downReq: 0 | 1 = 0;
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
  let ratio: MapRatio | undefined;
  if (flags.ratio !== undefined) {
    const v = String(flags.ratio).trim().toLowerCase();
    const wh = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(v);
    if (v === "auto") ratio = "auto";
    else if (wh && Number(wh[1]) > 0 && Number(wh[2]) > 0) ratio = v as MapRatio; // 原样写进 meta.span.ratio
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
  let maxFetches: number | undefined;
  if (flags.maxFetches !== undefined) {
    const v = String(flags.maxFetches).trim();
    if (/^\d+$/.test(v)) maxFetches = Number(v);
    else {
      console.error(`--max-fetches 只接受非负整数，收到: ${flags.maxFetches}\n\n${USAGE}`);
      process.exit(2);
    }
  }
  let center: boolean | "outline" | "target" | number | undefined;
  if (flags.center !== undefined) {
    const v = String(flags.center).trim().toLowerCase();
    if (v === "outline") center = "outline";
    else if (v === "target") center = "target";
    else if (/^\d+(?:\.\d+)?$/.test(v) && Number(v) > 0 && Number(v) <= 1) center = Number(v);
    else {
      console.error(`--center 只接受 outline、target 或 (0,1] 的数字，收到: ${flags.center}\n\n${USAGE}`);
      process.exit(2);
    }
  }

  const KEY = loadKey(flags.key);
  if (!KEY) {
    console.error("缺少高德 key：设置环境变量 AMAP_KEY，或在 .env 写入 KEY=...");
    process.exit(2);
  }

  const toStdout = flags.out === "-";
  const log = (s: string) => (toStdout ? console.error(s) : console.log(s));
  if (toStdout && flags.name !== undefined) console.error("! --out - 忽略 --name");

  const box = new AmapBox({ Key: KEY, fetch: nodeFetch, cache: diskCache(flags.cache) });

  let generated;
  try {
    generated = await box.generate(keyword, {
      up: upReq,
      down: downReq,
      outside: flags.outside || undefined,
      outsideSameLevel: flags.outsideSameLevel || undefined,
      ratio,
      padding,
      title: !flags.noTitle,
      contextLabels: !flags.noContextLabels,
      targetLabels: !flags.noTargetLabel,
      targetBackground: !flags.noTargetBg,
      center,
      maxFetches,
      refresh: flags.refresh,
    });
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  if (toStdout && generated.length > 1) {
    console.error(`--out - 只支持单个命中（本次 ${generated.length} 个），请改用 --out <dir>`);
    process.exit(2);
  }

  if (!toStdout) mkdirSync(flags.out, { recursive: true });
  let written = 0;
  const seen = new Set<string>();
  for (const r of generated) {
    log(`· ${r.query.name} (${r.query.level} ${r.query.adcode})`);
    for (const n of r.notes) console.error(n.level === "warn" ? `  ! ${n.text}` : `  ${n.text}`);
    if (!r.svg) {
      if (toStdout) {
        console.error(`${r.query.name} 没有出图`);
        process.exit(1);
      }
      continue;
    }
    if (toStdout) {
      process.stdout.write(r.svg);
      log(`  已输出到 stdout（${r.svg.length} 字节）`);
      written++;
      continue;
    }
    const bits = [
      `往上 ${r.up} 级 / 往下 ${r.down} 级`,
      `${r.blocks} 个区块${r.outline ? " + 整体轮廓" : ""}${r.neighbors ? ` + ${r.neighbors} 个外部轮廓` : ""}`,
      `新增取数 ${r.perf.cacheMisses.length}${r.perf.cacheHits.length ? `（缓存命中 ${r.perf.cacheHits.length}）` : ""}`,
    ];
    if (flags.ratio !== undefined) bits.push(`画幅 ${flags.ratio}`);
    if (flags.padding !== undefined) bits.push(`留白 ${flags.padding}px`);
    if (flags.noTitle) bits.push("无标题");
    if (flags.noContextLabels) bits.push("无上下文标签");
    if (flags.noTargetLabel) bits.push("无目标标签");
    if (flags.noTargetBg) bits.push("无目标背景");
    if (flags.center !== undefined) bits.push(`目标居中 ${flags.center}`);
    if (flags.outsideSameLevel) bits.push("含目标同级轮廓");
    const file =
      flags.name !== undefined
        ? renderNameTemplate(flags.name, { name: r.landed.name, adcode: r.landed.adcode, up: r.up, down: r.down })
        : r.file;
    if (seen.has(file)) console.error(`! --name 对多个命中产出同名文件 ${file}，后者覆盖前者`);
    seen.add(file);
    writeFileSync(join(flags.out, file), r.svg);
    log(`  已写入 ${file}  （${bits.join("；")}）`);
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
