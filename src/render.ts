/**
 * 渲染：把行政区环投影成 SVG 线稿。纯函数，无 IO。
 */
import { centroid, pointInRing, signedArea, simplify, type Point, type Unit } from "./geometry.js";
import type { ColorOptions, MapRatio } from "./types.js";

export const BG = "#0d1117";
export const LINE = "#ffffff";
export const MIN_STROKE = 0.8; // 区块线宽下限（单层按面积 / 多层最深一级）
export const MAX_STROKE = 2.2; // 区块线宽上限（保证整体轮廓 OUTLINE_STROKE 始终更粗）
export const OUTLINE_STROKE = 2.8; // 整体轮廓（与区块同图）：始终高于任何区块线宽
export const OUTLINE_STROKE_SOLO = 3.6; // 整体轮廓单独成图（没有区块，`up=0` 等）：只当边框
export const OUTSIDE_STROKE = 1; // 拓展外部轮廓：视图内的同级相邻区域（不参与缩放、不加标签）
export const OUTSIDE_OPACITY = 0.3;
export const CONTEXT_OPACITY = 0.45; // 分层上下文（非目标节点）基础不透明度
export const CONTEXT_DEPTH_OPACITY = 0.1; // 分层上下文每浅一级增加的亮度
export const CONTEXT_OPACITY_MAX = 0.75; // 分层上下文不透明度上限（整体轮廓，仍低于目标）
export const CTX_BAND_STEP = 0.2; // 每浅一级的线宽基准增量（层级关系的主要来源）
export const CTX_AREA_BAND = 0.75; // 多层级时：同级内面积微调占一个层距的比例（< 1 才不破坏层级）
export const TARGET_FILL = "#1f6feb"; // 目标节点所在区域的背景高亮色
export const TARGET_FILL_OPACITY = 0.22; // 背景高亮不透明度
export const HOT_TARGET = 3.6; // 查询目标自身（区块形态时）
export const HOT_ANCESTOR = 2.4; // 图上画到的链路祖先
export const DEPTH_BASE = 0.55; // 多层出图：所有线条的基准粗细
export const DEPTH_STEP = 0.35; // 每深一级加粗多少
export const PAD = 24;
export const CAPTION_H = 46;
export const MAP_LONG = 1000; // 图形长边 -> 1000px
export const TOL = 0.75; // 抽稀容差(px)
export const MIN_RING_AREA = 2; // 小于此面积的环（小岛）直接丢弃
/** 「目标居中」占比模式的默认比例（`center: "target"`）：目标包围盒长边 / 画幅长边。 */
export const DEFAULT_CENTER_RATIO = 0.5;

/** 归一化画幅比例：`"auto"` | 正数 | `"W:H"` -> `"auto"` 或数字；无法解析返回 `null`。 */
export function parseRatio(v: MapRatio): number | "auto" | null {
  if (v === "auto") return "auto";
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(v);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? w / h : null;
}

/** 「目标居中」归一化结果。 */
export type CenterMode = false | "outline" | number;

/**
 * 归一化 `center` 选项：`false`（不居中，默认）/ `"outline"`（方案一）/ 数字占比（方案二）。
 * `true` 等价于 `"outline"`，`"target"` 等价于 `DEFAULT_CENTER_RATIO`。
 */
export function parseCenter(
  v: boolean | "outline" | "target" | number | undefined,
): CenterMode {
  if (v === undefined || v === false) return false;
  if (v === true || v === "outline") return "outline";
  if (v === "target") return DEFAULT_CENTER_RATIO;
  return v;
}

/** 占比取景的缩放与画幅：目标世界长边 `tLong` -> 像素长边 `ratioValue * MAP_LONG`。 */
function ratioFrame(tLong: number, ratioValue: number, r: number | "auto") {
  const scale = (ratioValue * MAP_LONG) / Math.max(tLong, 1e-9);
  const a = r === "auto" ? 1 : r; // 未给画幅比例时默认方形
  const drawW = a >= 1 ? MAP_LONG : MAP_LONG * a;
  const drawH = a >= 1 ? MAP_LONG / a : MAP_LONG;
  return { scale, drawW, drawH };
}

/**
 * 占比取景（`center` 为数字）下画布覆盖的经纬度范围。
 * 供出图时按视图预筛候选（成本优化）；与 `renderMap` 共用同一套缩放/画幅推导。
 */
export function centerRatioViewBox(
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
  ratioValue: number,
  mapRatio: MapRatio = "auto",
): { minLon: number; minLat: number; maxLon: number; maxLat: number } {
  const lat0 = (minLat + maxLat) / 2;
  const cos0 = Math.cos((lat0 * Math.PI) / 180);
  const tLong = Math.max((maxLon - minLon) * cos0, maxLat - minLat, 1e-9);
  const { scale, drawW, drawH } = ratioFrame(tLong, ratioValue, parseRatio(mapRatio) ?? "auto");
  const cx = (minLon + maxLon) / 2;
  const cy = (minLat + maxLat) / 2;
  const halfLon = drawW / 2 / scale / cos0;
  const halfLat = drawH / 2 / scale;
  return { minLon: cx - halfLon, maxLon: cx + halfLon, minLat: cy - halfLat, maxLat: cy + halfLat };
}

/** 待绘制单元，带图内相对层级。 */
export interface RenderUnit extends Unit {
  depth?: number;
}

export interface RenderInput {
  /** 配色覆盖：背景 / 线条与文字 / 目标高亮，未给的用默认常量。 */
  colors?: ColorOptions;
  units: RenderUnit[];
  outline: Unit | null;
  caption: string;
  captionSub?: string;
  /** 查询链上的 adcode（用于高亮）。 */
  chain?: string[];
  /** 查询目标 adcode。 */
  target?: string | null;
  /**
   * 外部轮廓候选：与「最外层级」同级、落在当前视图内的会以更细更淡的线条画出（不参与缩放，也不加标签）。
   */
  outside?: RenderUnit[];
  /** 与「目标层级」同级的外部轮廓候选，样式同 `outside`。 */
  outsideTarget?: RenderUnit[];
  /** 画幅宽高比，默认 `"auto"`（按内容）。 */
  ratio?: MapRatio;
  /** 内容四周留白（px），默认 `PAD`。 */
  padding?: number;
  /** 是否绘制标题（含副标题），默认 `true`。 */
  title?: boolean;
  /** 非目标节点（上下文）的文字标签是否绘制。默认 `true`。 */
  contextLabels?: boolean;
  /** 目标节点自身的文字标签是否绘制。默认 `true`。 */
  targetLabels?: boolean;
  /** 是否给目标节点所在区域填充半透明高亮背景。默认 `true`。 */
  targetBackground?: boolean;
  /**
   * 是否让目标（而非内容包围盒）居中，默认 `false`。
   * - `true` / `"outline"`：目标质心居中，并保证最外层轮廓完整可见（多余空间补成留白）。
   * - `"target"`：目标质心居中，目标长边占画幅长边的 `DEFAULT_CENTER_RATIO`。
   * - 数字（`0 < N <= 1`）：目标质心居中，目标长边占画幅长边 `N`；上下文超出即裁掉。
   */
  center?: boolean | "outline" | "target" | number;
}

export interface RenderOutput {
  markup: string;
  W: number;
  H: number;
  /** 画布背景色。 */
  bg: string;
  /** 实际画出的外部轮廓区块总数（最外层同级 + 目标同级）。 */
  outside: number;
  /** 其中「与目标同级」的外部轮廓区块数。 */
  outsideTarget: number;
}

/**
 * 把 units（各下级，可带 depth）与 outline（整体轮廓）画成一张图。
 * 目标以外的节点按**图内相对层级**分层：越浅的层级越粗、越亮，整体轮廓最粗最亮；
 * 查询链（target + chain 上的祖先，且确实画成了区块）单独高亮：最粗、不透明度拉满。
 * 目标节点所在区域可选（`targetBackground`，默认开）填充半透明背景高亮。
 * 标签字号同级统一，由该级中「水平/垂直距离最短的一对」决定。
 * 没有任何可绘制内容时返回 null。
 */
export function renderMap({
  colors,
  units,
  outline,
  caption,
  captionSub,
  chain = [],
  target = null,
  outside = [],
  outsideTarget = [],
  ratio = "auto",
  padding = PAD,
  title = true,
  contextLabels = true,
  targetLabels = true,
  targetBackground = true,
  center = false,
}: RenderInput): RenderOutput | null {
  const bg = colors?.background ?? BG;
  const line = colors?.line ?? LINE;
  const targetFill = colors?.targetFill ?? TARGET_FILL;
  const sample = units.flatMap((u) => u.rings).flat();
  if (!sample.length) return null;
  const lat0 = sample.reduce((s, p) => s + p[1], 0) / sample.length;
  const cos0 = Math.cos((lat0 * Math.PI) / 180);
  const lon2x = (lon: number) => lon * cos0;

  const worldBBox = (us: Unit[]) => {
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const u of us)
      for (const ring of u.rings)
        for (const [lon, lat] of ring) {
          const x = lon2x(lon);
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (lat < y0) y0 = lat;
          if (lat > y1) y1 = lat;
        }
    return { x0, x1, y0, y1 };
  };

  const pad = Math.max(0, padding);
  const band = title ? CAPTION_H : 0; // 顶部标题带
  const r = parseRatio(ratio) ?? "auto";
  const mode = parseCenter(center); // false | "outline" | 占比
  // 目标单元：优先整体轮廓，其次区块
  const tgt =
    mode === false
      ? undefined
      : outline && outline.adcode === target
        ? outline
        : units.find((u) => u.adcode === target);

  let scale: number;
  let W: number;
  let H: number;
  let originX: number;
  let originY: number;
  let offY = 0;
  if (typeof mode === "number" && tgt) {
    // 方案二：目标居中，目标包围盒长边占画幅长边 mode。画幅固定，上下文超出即裁掉。
    const tb = worldBBox([tgt]);
    const tLong = Math.max(tb.x1 - tb.x0, tb.y1 - tb.y0, 1e-9);
    const fr = ratioFrame(tLong, mode, r);
    scale = fr.scale;
    W = fr.drawW + 2 * pad;
    H = fr.drawH + band + 2 * pad;
    originX = pad + fr.drawW / 2 - ((tb.x0 + tb.x1) / 2) * scale;
    originY = band + pad + fr.drawH / 2 + ((tb.y0 + tb.y1) / 2) * scale;
  } else {
    // 方案一 / 默认：内容盒居中。方案一取「以目标中心为中心、含最外层轮廓」的对称盒，
    // 保证轮廓完整可见（代价是目标偏居一角时留白较多）。
    let vx0: number;
    let vy1: number;
    let dx: number;
    let dy: number;
    if (mode === "outline" && tgt) {
      const frame = worldBBox(outline ? [...units, outline] : units);
      const tb = worldBBox([tgt]);
      const tcx = (tb.x0 + tb.x1) / 2;
      const tcy = (tb.y0 + tb.y1) / 2;
      const halfW = Math.max(tcx - frame.x0, frame.x1 - tcx);
      const halfH = Math.max(tcy - frame.y0, frame.y1 - tcy);
      vx0 = tcx - halfW;
      vy1 = tcy + halfH;
      dx = 2 * halfW;
      dy = 2 * halfH;
    } else {
      const cb = worldBBox(units);
      vx0 = cb.x0;
      vy1 = cb.y1;
      dx = cb.x1 - cb.x0;
      dy = cb.y1 - cb.y0;
    }
    scale = MAP_LONG / Math.max(dx, dy); // 长边 -> 1000px
    const boxW = dx * scale + 2 * pad; // 内容盒（含留白与标题带）
    const boxH = dy * scale + band + 2 * pad;
    // 画幅比例：auto 直接用内容盒；给定比例时内容缩放不变，居中后把多余空间作为留白补到画布
    W = boxW;
    H = boxH;
    let offX = 0;
    if (r !== "auto") {
      if (boxW / boxH > r) {
        W = boxW;
        H = boxW / r;
      } else {
        W = boxH * r;
        H = boxH;
      }
      offX = (W - boxW) / 2;
      offY = (H - boxH) / 2;
    }
    originX = offX + pad - vx0 * scale;
    originY = offY + band + pad + vy1 * scale;
  }
  // 北向上
  const toPx = ([lon, lat]: [number, number]): Point => [
    originX + lon2x(lon) * scale,
    originY - lat * scale,
  ];

  const project = (units0: Unit) => {
    const out: Point[][] = [];
    for (const r of units0.rings) {
      const px = r.map(toPx);
      if (Math.abs(signedArea(px)) < MIN_RING_AREA) continue;
      out.push(simplify(px, TOL));
    }
    if (!out.length) return null;
    const big = out.reduce((b, r) =>
      Math.abs(signedArea(r)) > Math.abs(signedArea(b)) ? r : b,
    );
    let c = centroid(big);
    if (!pointInRing(c, big)) c = toPx([units0.center[0], units0.center[1]]);
    return { rings: out, area: Math.abs(signedArea(big)), cx: c[0], cy: c[1] };
  };

  const chainSet = new Set(chain);
  const hotOf = (adcode: string) => (adcode === target ? 1 : chainSet.has(adcode) ? 2 : 0);

  const geo = units
    .map((u) => {
      const p = project(u);
      return p
        ? { ...p, name: u.name, depth: u.depth ?? 0, hot: hotOf(u.adcode), isTarget: u.adcode === target }
        : null;
    })
    .filter((g): g is NonNullable<typeof g> => g !== null);
  if (!geo.length) return null;
  const outlineIsTarget = outline != null && outline.adcode === target;
  // 每个区块在当前图内的相对层级（0 = 最上层）
  const depthOf = (g: (typeof geo)[number]) => g.depth - Math.min(...geo.map((x) => x.depth));
  const maxDepth = Math.max(...geo.map((g) => g.depth));

  // 目标以外的节点按图内相对层级分层：整体轮廓最粗最亮，越浅的层级越粗越亮；目标（与链路祖先）单独高亮。
  // 单层级按面积铺满 MIN~MAX；多层叠图按相对层级分档，同级内只用占一个层距以内的面积微调。
  const maxArea = Math.max(...geo.map((g) => g.area));
  const rel = (area: number) => Math.sqrt(area / maxArea);
  const step = maxDepth > 0 ? Math.min(CTX_BAND_STEP, (MAX_STROKE - MIN_STROKE) / maxDepth) : 0;
  const ctxWidth = (g: (typeof geo)[number]) =>
    maxDepth > 0
      ? MAX_STROKE - step * depthOf(g) + step * CTX_AREA_BAND * rel(g.area)
      : MIN_STROKE + (MAX_STROKE - MIN_STROKE) * rel(g.area);
  const ctxOpacity = (g: (typeof geo)[number]) =>
    Math.min(CONTEXT_OPACITY_MAX, CONTEXT_OPACITY + CONTEXT_DEPTH_OPACITY * (maxDepth - depthOf(g)));
  const strokeOf = (g: (typeof geo)[number]) =>
    g.hot === 1 ? HOT_TARGET : g.hot === 2 ? HOT_ANCESTOR : ctxWidth(g);
  const opacityOf = (g: (typeof geo)[number]) => (g.hot ? 1 : ctxOpacity(g));

  // 同级统一字号：由该级中「水平/垂直距离最短的那一对」决定 —— 超过它这一对就撞上。
  // 每级取所有两两组合允许字号的**最小值**。
  const byDepth = new Map<number, typeof geo>();
  for (const g of geo) {
    if (!byDepth.has(g.depth)) byDepth.set(g.depth, []);
    byDepth.get(g.depth)!.push(g);
  }
  const FLOOR = Math.max(7, W * 0.0075); // 可读下限
  const CEIL = Math.max(13, W * 0.021);
  const LINE_H = 1.25; // 一行字高 ≈ 1.25 * fontSize
  const clen = (g: (typeof geo)[number]) => [...g.name].length;
  // 一对同级区域允许的字号：水平错开 或 垂直错开，满足其一即可
  const allowPair = (a: (typeof geo)[number], b: (typeof geo)[number]) =>
    Math.max(
      (2 * Math.abs(a.cx - b.cx)) / (clen(a) + clen(b)),
      Math.abs(a.cy - b.cy) / LINE_H,
    );
  const fontByDepth = new Map<number, number>(); // 每级统一的字号
  const ownRoom = new Map<(typeof geo)[number], number>(); // 每个区域自己周边的空间
  for (const [depth, peers] of byDepth) {
    let tightest = Infinity;
    for (let i = 0; i < peers.length; i++) {
      for (let j = i + 1; j < peers.length; j++) {
        const v = allowPair(peers[i], peers[j]);
        if (v < tightest) tightest = v;
      }
    }
    fontByDepth.set(depth, Math.max(FLOOR, Math.min(CEIL, tightest * 0.9)));
    for (const g of peers) {
      let own = Infinity;
      for (const v of peers) if (v !== g) own = Math.min(own, allowPair(g, v));
      ownRoom.set(g, own);
    }
  }

  const dOf = (rings: Point[][]) =>
    rings
      .map((r) => "M " + r.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" L ") + " Z")
      .join(" ");

  // 拓展外部轮廓：与最外层/目标层级同级、投影后与画布（即当前视图）相交的相邻区域，只描边、不参与缩放/标签。
  // 相邻区域与本图最外层级共享边界，其投影包围盒必然探进画布，故「有交叠」即「在视图内」。
  const outsideLayer: string[] = [];
  const drawOutside = (list: RenderUnit[]) => {
    let drawn = 0;
    for (const u of list) {
      const p = project(u);
      if (!p) continue;
      let minx = Infinity;
      let miny = Infinity;
      let maxx = -Infinity;
      let maxy = -Infinity;
      for (const r of p.rings) {
        for (const [x, y] of r) {
          if (x < minx) minx = x;
          if (x > maxx) maxx = x;
          if (y < miny) miny = y;
          if (y > maxy) maxy = y;
        }
      }
      if (!(maxx > 0 && minx < W && maxy > 0 && miny < H)) continue; // 完全落在视图外
      outsideLayer.push(
        `<path d="${dOf(p.rings)}" fill="none" stroke="${line}" ` +
          `stroke-width="${OUTSIDE_STROKE.toFixed(2)}" stroke-opacity="${OUTSIDE_OPACITY.toFixed(2)}" ` +
          `stroke-linejoin="round"/>`,
      );
      drawn++;
    }
    return drawn;
  };
  const outsideBase = drawOutside(outside);
  const outsideTargetDrawn = drawOutside(outsideTarget);
  const outsideTotal = outsideBase + outsideTargetDrawn;

  const out: string[] = [...outsideLayer];
  for (const g of geo) {
    const fill =
      targetBackground && g.isTarget
        ? ` fill="${targetFill}" fill-opacity="${TARGET_FILL_OPACITY.toFixed(2)}"`
        : ` fill="none"`;
    out.push(
      `<path d="${dOf(g.rings)}"${fill} stroke="${line}" ` +
        `stroke-width="${strokeOf(g).toFixed(2)}" stroke-opacity="${opacityOf(g).toFixed(2)}" ` +
        `stroke-linejoin="round" stroke-linecap="round"/>`,
    );
  }
  if (outline) {
    const p = project(outline);
    if (p) {
      // 轮廓是最外层的框：始终高于任何区块；目标落到轮廓上时按边框线宽并全亮。
      const width = outlineIsTarget ? OUTLINE_STROKE_SOLO : OUTLINE_STROKE;
      const opacity = outlineIsTarget ? 1 : CONTEXT_OPACITY_MAX;
      const fill =
        targetBackground && outlineIsTarget
          ? ` fill="${targetFill}" fill-opacity="${TARGET_FILL_OPACITY.toFixed(2)}"`
          : ` fill="none"`;
      out.push(
        `<path d="${dOf(p.rings)}"${fill} stroke="${line}" ` +
          `stroke-width="${width.toFixed(2)}" stroke-opacity="${opacity.toFixed(2)}" stroke-linejoin="round"/>`,
      );
    }
  }

  // 标签落质心；同级同字号。自身周边连最小字号都塞不下的（很挤的那几个）就不标
  for (const g of geo) {
    if (ownRoom.get(g)! * 0.9 < FLOOR) continue;
    if (g.isTarget ? !targetLabels : !contextLabels) continue;
    const font = fontByDepth.get(g.depth)!;
    out.push(
      `<text x="${g.cx.toFixed(1)}" y="${g.cy.toFixed(1)}" font-size="${font.toFixed(1)}" ` +
        `text-anchor="middle" dominant-baseline="central" fill="${line}" fill-opacity="0.9" ` +
        `letter-spacing="1">${g.name}</text>`,
    );
  }

  if (!title) return { markup: out.join("\n"), W, H, bg, outside: outsideTotal, outsideTarget: outsideTargetDrawn };

  const tFont = Math.max(13, Math.min(30, W * 0.017));
  const sFont = tFont * 0.5;
  const tracking = caption.length > 3 ? 3 : 1;
  // CJK 约 1em，拉丁/空格约 0.55em
  const textW = (str: string, size: number) =>
    [...str].reduce(
      (s, ch) => s + (/[\u2e80-\u9fff\uff00-\uffef\u3000-\u303f]/.test(ch) ? 1 : 0.55),
      0,
    ) * size;
  const capW = textW(caption, tFont) + (caption.length - 1) * tracking;
  const subW = captionSub ? textW(captionSub, sFont) : 0;
  const GAP = 18;
  const tx = Math.max(pad, (W - (capW + (captionSub ? GAP + subW : 0))) / 2);
  out.push(
    `<text x="${tx.toFixed(1)}" y="${(offY + CAPTION_H - 12).toFixed(1)}" font-size="${tFont.toFixed(1)}" ` +
      `font-weight="600" fill="${line}" fill-opacity="0.92" letter-spacing="${tracking}">${caption}</text>`,
  );
  if (captionSub) {
    out.push(
      `<text x="${(tx + capW + GAP).toFixed(1)}" y="${(offY + CAPTION_H - 14).toFixed(1)}" ` +
        `font-size="${sFont.toFixed(1)}" fill="${line}" fill-opacity="0.42">${captionSub}</text>`,
    );
  }

  return { markup: out.join("\n"), W, H, bg, outside: outsideTotal, outsideTarget: outsideTargetDrawn };
}

/** 转义 XML 文本内容里必须转义的字符（`metadata` 内嵌的 JSON 用）。 */
const escapeXml = (s: string) =>
  s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

/**
 * 给渲染结果套上 `<svg>` 外壳。给了 `meta`（任意可 JSON 序列化的对象）时，
 * 在开头内嵌一个 `<metadata>` 元素，内容为其 JSON 文本 —— 让 SVG 文件自带出处与画的是什么。
 */
export function wrapSvg({ markup, W, H, bg = BG }: RenderOutput, meta?: unknown): string {
  const metaTag = meta === undefined ? "" : `<metadata>${escapeXml(JSON.stringify(meta))}</metadata>\n`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W.toFixed(1)} ${H.toFixed(1)}" ` +
    `width="${W.toFixed(0)}" height="${H.toFixed(0)}" font-family="Noto Sans CJK SC, ` +
    `Microsoft YaHei, PingFang SC, sans-serif">\n` +
    metaTag +
    `<rect x="0" y="0" width="${W.toFixed(1)}" height="${H.toFixed(1)}" fill="${bg}"/>\n` +
    `${markup}\n</svg>`
  );
}
