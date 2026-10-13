/**
 * 渲染：把行政区环投影成 SVG 线稿。纯函数，无 IO。
 */
import { centroid, pointInRing, signedArea, simplify, type Point, type Unit } from "./geometry.js";
import type { MapRatio } from "./types.js";

export const BG = "#0d1117";
export const LINE = "#ffffff";
export const MIN_STROKE = 0.8; // 单层出图：最细/最粗线条
export const MAX_STROKE = 2.8; // 单层里最大的那个区块；要比 HOT_TARGET 低一档
export const OUTLINE_STROKE = 3.6; // 整体轮廓（与下级同图）
export const OUTSIDE_STROKE = 1; // 拓展外部轮廓：视图内的同级相邻区域（不参与缩放、不加标签）
export const OUTSIDE_OPACITY = 0.3;
export const DIM_STROKE = 1; // 未高亮的上下文（整体轮廓 + 目标以外的区块）线宽
export const DIM_OPACITY = 0.3; // 未高亮的上下文不透明度（在白底/深底上都呈细灰线）
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

/** 待绘制单元，带图内相对层级。 */
export interface RenderUnit extends Unit {
  depth?: number;
}

export interface RenderInput {
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
  /**
   * 是否高亮上级轮廓：整体轮廓 + 目标节点以外的全部区块线。
   * `false`（默认）时它们只画细灰线（`DIM_STROKE` / `DIM_OPACITY`），仅目标节点保持亮白。
   */
  highlightContext?: boolean;
  /** 是否给目标节点所在区域填充半透明高亮背景。默认 `true`。 */
  targetBackground?: boolean;
}

export interface RenderOutput {
  markup: string;
  W: number;
  H: number;
  /** 实际画出的外部轮廓区块总数（最外层同级 + 目标同级）。 */
  outside: number;
  /** 其中「与目标同级」的外部轮廓区块数。 */
  outsideTarget: number;
}

/**
 * 把 units（各下级，可带 depth）与 outline（整体轮廓）画成一张图。
 * depth 不唯一时按层级区分线条：越深越粗越亮。
 * 查询链（target + chain 上的祖先，且确实画成了区块）单独高亮：最粗、不透明度拉满。
 * 未高亮上下文时（`highlightContext: false`，默认）：整体轮廓与目标以外的区块只画细灰线，仅目标保持亮白。
 * 目标节点所在区域可选（`targetBackground`，默认开）填充半透明背景高亮。
 * 标签字号同级统一，由该级中「水平/垂直距离最短的一对」决定。
 * 没有任何可绘制内容时返回 null。
 */
export function renderMap({
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
  highlightContext = false,
  targetBackground = true,
}: RenderInput): RenderOutput | null {
  const sample = units.flatMap((u) => u.rings).flat();
  if (!sample.length) return null;
  const lat0 = sample.reduce((s, p) => s + p[1], 0) / sample.length;
  const cos0 = Math.cos((lat0 * Math.PI) / 180);
  const lon2x = (lon: number) => lon * cos0;

  let minx = Infinity;
  let maxx = -Infinity;
  let miny = Infinity;
  let maxy = -Infinity;
  for (const [lon, lat] of sample) {
    const x = lon2x(lon);
    if (x < minx) minx = x;
    if (x > maxx) maxx = x;
    if (lat < miny) miny = lat;
    if (lat > maxy) maxy = lat;
  }
  const dx = maxx - minx;
  const dy = maxy - miny;
  const scale = MAP_LONG / Math.max(dx, dy); // 长边 -> 1000px
  const pad = Math.max(0, padding);
  const band = title ? CAPTION_H : 0; // 顶部标题带
  const boxW = dx * scale + 2 * pad; // 内容盒（含留白与标题带）
  const boxH = dy * scale + band + 2 * pad;
  // 画幅比例：auto 直接用内容盒；给定比例时内容缩放不变，居中后把多余空间作为留白补到画布
  let W = boxW;
  let H = boxH;
  let offX = 0;
  let offY = 0;
  const r = parseRatio(ratio) ?? "auto";
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
  // 北向上
  const toPx = ([lon, lat]: [number, number]): Point => [
    offX + pad + (lon2x(lon) - minx) * scale,
    offY + band + pad + (maxy - lat) * scale,
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
  const hasTarget = geo.some((g) => g.isTarget) || outlineIsTarget;
  // 未高亮上下文时：整体轮廓 + 目标节点以外的区块都画成细灰线，仅目标保持亮白
  const dimContext = !highlightContext && hasTarget;
  const multi = geo.length > 1; // 只有一个区块时无所谓「突出」
  for (const g of geo) if (!multi) g.hot = 0;

  // 只有把多个层级叠在一张图上时才需要按层级区分
  const layered = new Set(geo.map((g) => g.depth)).size > 1;
  const maxArea = Math.max(...geo.map((g) => g.area));
  const rel = (area: number) => Math.sqrt(area / maxArea);
  const strokeOf = (g: (typeof geo)[number]) =>
    dimContext && !g.isTarget
      ? DIM_STROKE
      : g.hot === 1
        ? HOT_TARGET
        : g.hot === 2
          ? HOT_ANCESTOR
          : layered
            ? DEPTH_BASE + DEPTH_STEP * g.depth + 0.45 * rel(g.area)
            : MIN_STROKE + (MAX_STROKE - MIN_STROKE) * rel(g.area);
  const opacityOf = (g: (typeof geo)[number]) =>
    dimContext && !g.isTarget
      ? DIM_OPACITY
      : g.hot
        ? 1
        : layered
          ? Math.min(1, 0.45 + 0.18 * g.depth)
          : 0.88;

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
        `<path d="${dOf(p.rings)}" fill="none" stroke="${LINE}" ` +
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
        ? ` fill="${TARGET_FILL}" fill-opacity="${TARGET_FILL_OPACITY.toFixed(2)}"`
        : ` fill="none"`;
    out.push(
      `<path d="${dOf(g.rings)}"${fill} stroke="${LINE}" ` +
        `stroke-width="${strokeOf(g).toFixed(2)}" stroke-opacity="${opacityOf(g).toFixed(2)}" ` +
        `stroke-linejoin="round" stroke-linecap="round"/>`,
    );
  }
  if (outline) {
    const p = project(outline);
    if (p) {
      // up=0 时轮廓就是目标自身，但轮廓始终只当边框（多层级时更细）
      const dim = dimContext && !outlineIsTarget;
      const fill =
        targetBackground && outlineIsTarget
          ? ` fill="${TARGET_FILL}" fill-opacity="${TARGET_FILL_OPACITY.toFixed(2)}"`
          : ` fill="none"`;
      out.push(
        `<path d="${dOf(p.rings)}"${fill} stroke="${LINE}" ` +
          `stroke-width="${(dim ? DIM_STROKE : layered ? 2.6 : OUTLINE_STROKE).toFixed(2)}" ` +
          `stroke-opacity="${(dim ? DIM_OPACITY : 1).toFixed(2)}" stroke-linejoin="round"/>`,
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
        `text-anchor="middle" dominant-baseline="central" fill="${LINE}" fill-opacity="0.9" ` +
        `letter-spacing="1">${g.name}</text>`,
    );
  }

  if (!title) return { markup: out.join("\n"), W, H, outside: outsideTotal, outsideTarget: outsideTargetDrawn };

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
      `font-weight="600" fill="${LINE}" fill-opacity="0.92" letter-spacing="${tracking}">${caption}</text>`,
  );
  if (captionSub) {
    out.push(
      `<text x="${(tx + capW + GAP).toFixed(1)}" y="${(offY + CAPTION_H - 14).toFixed(1)}" ` +
        `font-size="${sFont.toFixed(1)}" fill="${LINE}" fill-opacity="0.42">${captionSub}</text>`,
    );
  }

  return { markup: out.join("\n"), W, H, outside: outsideTotal, outsideTarget: outsideTargetDrawn };
}

/** 给渲染结果套上 `<svg>` 外壳。 */
export function wrapSvg({ markup, W, H }: RenderOutput): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W.toFixed(1)} ${H.toFixed(1)}" ` +
    `width="${W.toFixed(0)}" height="${H.toFixed(0)}" font-family="Noto Sans CJK SC, ` +
    `Microsoft YaHei, PingFang SC, sans-serif">\n` +
    `<rect x="0" y="0" width="${W.toFixed(1)}" height="${H.toFixed(1)}" fill="${BG}"/>\n` +
    `${markup}\n</svg>`
  );
}
