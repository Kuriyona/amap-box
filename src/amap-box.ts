/**
 * `AmapBox` —— 高德行政区划 → SVG 的核心 API。
 *
 * 构造：`new AmapBox({ Key, fetch, cache })`。取数与缓存都由调用方注入，
 * 因此在 Node / Bun / 浏览器 / 测试里都能用同一份逻辑。
 */
import type {
  AmapDistrict,
  AmapBoxOptions,
  GenerateResult,
  MapMeta,
  PerfStats,
  ResolveResult,
  Note,
  SpanOptions,
} from "./types.js";
import { toUnit, type Unit } from "./geometry.js";
import { bboxHit, bboxOf, builtinBBox } from "./bbox.js";
import { canvasViewBox, mapFrame, PAD, parseCenter, parseRatio, renderMap, wrapSvg, type RenderUnit } from "./render.js";
import pkg from "../package.json";

const API = "https://restapi.amap.com/v3/config/district";
const GENERATOR = `${pkg.name}@${pkg.version}`;
const ATTRIBUTION = "© 高德地图（AMap）行政区划数据";
const COUNTRY = "100000";
/** 只有这三级有边界数据；street（街道/乡镇）接口不返回 polyline，且 adcode 与其上级相同。 */
const DRAWABLE: Record<string, true> = { province: true, city: true, district: true };

const RETRYABLE = /CUQPS_HAS_EXCEEDED_THE_LIMIT|SERVICE_NOT_AVAILABLE|TIMEOUT|UNKNOWN_ERROR/i;
/** 与 AMap 的关键字搜索一样最多取 20 个，避免一次出几十上百张图。 */
const MATCH_LIMIT = 20;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** adcode 去掉末尾 0 后作为前缀，判断 child 是否在 target 的路径上。 */
const onPath = (childAdcode: string, targetAdcode: string) => {
  const p = childAdcode.replace(/0+$/, "");
  return p.length >= 2 && targetAdcode.startsWith(p);
};

interface ApiResponse {
  status?: string;
  info?: string;
  districts?: AmapDistrict[];
}

interface ChainNode {
  region: AmapDistrict;
  children: AmapDistrict[];
}

/** 出图过程的缓存统计收集器（键去重、按首次访问顺序）。 */
const newPerf = (): PerfStats => ({ cacheHits: [], cacheMisses: [] });
const record = (list: string[], key: string) => {
  if (!list.includes(key)) list.push(key);
};

/** 一次调用共享的取消与取数预算状态。 */
interface Gate {
  signal?: AbortSignal;
  /** 还允许新增几条取数；`Infinity` = 不限。 */
  fetchesLeft: number;
  /** 上限值，只用于提示文案。 */
  maxFetches: number;
  /** 已经因为预算拒绝过一次取数（= 本轮没跑完）。 */
  exhausted: boolean;
}

/** 一层（图 / 解析层）的提示与缓存统计，加上共享的 gate。 */
interface Run {
  notes: Note[];
  perf: PerfStats;
  gate: Gate;
}

const EXHAUSTED = "BUDGET_EXHAUSTED";

/** 建一份取数预算/取消状态；`maxFetches` 为 `Infinity` 时不限。 */
const newGate = (signal: AbortSignal | undefined, maxFetches: number): Gate => ({
  signal,
  fetchesLeft: maxFetches,
  maxFetches,
  exhausted: false,
});

/** 文本的 sha256（小写十六进制）。用平台自带 WebCrypto，保持零依赖。 */
const sha256Hex = async (text: string): Promise<string> => {
  const buf = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
};

/** 建议的出图文件名 `[名称]-[adcode]-u<K>d<M>.svg`（非法字符替换为 `_`）。 */
export function svgFileName(
  region: { name: string; adcode: string },
  up: number,
  down: number,
): string {
  return `${region.name.replace(/[\\/:*?"<>|\s]/g, "_")}-${region.adcode}-u${up}d${down}.svg`;
}

export class AmapBox {
  readonly #key: string;
  readonly #fetch: AmapBoxOptions["fetch"];
  readonly #cache: AmapBoxOptions["cache"];
  readonly #signal?: AbortSignal;

  #byAdcode = new Map<string, AmapDistrict>();
  #allNodes: AmapDistrict[] = [];
  #indexLoaded = false;

  constructor(options: AmapBoxOptions) {
    if (!options || typeof options !== "object") throw new TypeError("AmapBox 需要 { Key, fetch, cache } 参数");
    if (!options.Key) throw new TypeError("AmapBox: 缺少 Key");
    if (typeof options.fetch !== "function") throw new TypeError("AmapBox: fetch 必须是函数");
    if (typeof options.cache?.read !== "function" || typeof options.cache?.write !== "function")
      throw new TypeError("AmapBox: cache 需要 { read, write }");
    if (options.signal !== undefined && typeof options.signal.aborted !== "boolean")
      throw new TypeError("AmapBox: signal 必须是 AbortSignal");
    this.#key = options.Key;
    this.#fetch = options.fetch;
    this.#cache = options.cache;
    this.#signal = options.signal;
  }

  // ------------------------------------------------------------- API layer
  async #apiQuery(
    params: Record<string, string>,
    run: Run,
    tries = 6,
  ): Promise<ApiResponse> {
    const { gate } = run;
    gate.signal?.throwIfAborted();
    if (gate.fetchesLeft <= 0) {
      gate.exhausted = true;
      return { status: "0", info: EXHAUSTED };
    }
    gate.fetchesLeft--; // 一次逻辑取数记 1，限流重试不额外记
    const url = `${API}?${new URLSearchParams({ key: this.#key, showbiz: "false", extensions: "all", ...params })}`;
    let info = "unknown";
    for (let t = 0; t < tries; t++) {
      let d: ApiResponse;
      try {
        gate.signal?.throwIfAborted();
        d = ((await this.#fetch(url, gate.signal)) ?? {}) as ApiResponse;
      } catch (e) {
        gate.signal?.throwIfAborted(); // 中止要原样抛出，别被当成普通错误吞掉
        d = { status: "0", info: String(e) };
      }
      if (d.status === "1") return d;
      info = d.info ?? "unknown";
      if (!RETRYABLE.test(info)) return d; // 真错误（如 key 无效）不再空转
      if (t < tries - 1) {
        run.notes.push({ level: "warn", text: `限流重试 ${t + 1}/${tries - 1}: ${info}` });
        await sleep(700 + 500 * t);
      }
    }
    return { status: "0", info };
  }

  async #readCache(key: string, refresh: boolean, perf?: PerfStats): Promise<ApiResponse | null> {
    const miss = () => {
      if (perf) record(perf.cacheMisses, key);
      return null;
    };
    if (refresh) return miss();
    let raw: string | null | undefined;
    try {
      raw = await this.#cache.read(key);
    } catch {
      return miss();
    }
    if (!raw) return miss();
    try {
      const d = JSON.parse(raw) as ApiResponse;
      if (d?.districts?.length) {
        if (perf) record(perf.cacheHits, key);
        return d;
      }
    } catch {
      /* 缓存内容坏了，当未命中重新拉 */
    }
    return miss();
  }

  async #writeCache(key: string, d: ApiResponse): Promise<void> {
    await this.#cache.write(key, JSON.stringify(d));
  }

  /** 单个行政区（仅自身，含边界）。 */
  async #fetchRegion(
    adcode: string,
    refresh: boolean,
    run: Run,
  ): Promise<AmapDistrict | null> {
    const hit = await this.#readCache(adcode, refresh, run.perf);
    if (hit) return hit.districts![0];
    if (run.gate.exhausted) return null; // 预算已用尽，不再尝试
    const d = await this.#apiQuery({ keywords: adcode, subdistrict: "0" }, run);
    if (d.status !== "1" || !d.districts?.length) return null;
    await this.#writeCache(adcode, d);
    await sleep(350);
    return d.districts[0];
  }

  // ------------------------------------------------------------- index
  // 全国行政区划索引：一次请求拿到 国家->省->地->县 整棵树（extensions=base，不含边界）。
  // 之后所有名称/adcode 查找与层级链都只认它；只有索引缺失或 refresh 才重建。
  async #loadIndex(refresh: boolean, run: Run): Promise<AmapDistrict | null> {
    const hit = await this.#readCache("index", refresh, run.perf);
    if (hit) return hit.districts![0];
    run.notes.push({ level: "info", text: "首次运行：拉取全国行政区划索引（一次请求，不含边界）" });
    const d = await this.#apiQuery({ keywords: COUNTRY, subdistrict: "3", extensions: "base" }, run);
    if (d.status !== "1" || !d.districts?.length) return null;
    await this.#writeCache("index", d);
    run.notes.push({ level: "info", text: "索引已缓存" });
    return d.districts[0];
  }

  /** 载入并扁平化索引。成功返回 true。 */
  async #ensureIndex(refresh: boolean, run: Run): Promise<boolean> {
    if (this.#indexLoaded && !refresh) return true;
    const root = await this.#loadIndex(refresh, run);
    if (!root) return false;
    const byAdcode = new Map<string, AmapDistrict>(); // 省直辖/兵团下级与上级同 adcode，保留上层那个
    const allNodes: AmapDistrict[] = []; // 平铺的全部节点，供按名查找（含同 adcode 的街镇）
    const walk = (n: AmapDistrict) => {
      allNodes.push(n);
      if (!byAdcode.has(n.adcode)) byAdcode.set(n.adcode, n);
      for (const c of n.districts ?? []) walk(c);
    };
    walk(root);
    this.#byAdcode = byAdcode;
    this.#allNodes = allNodes;
    this.#indexLoaded = true;
    return true;
  }

  // 索引查找：纯数字按 adcode，否则先精确同名、再子串匹配（「中国」->「中华人民共和国」）
  #searchIndex(kw: string, run: Run): AmapDistrict[] {
    if (/^\d+$/.test(kw)) {
      const hit = this.#byAdcode.get(kw);
      return hit ? [hit] : [];
    }
    const exact = this.#allNodes.filter((d) => d.name === kw);
    const hits = exact.length ? exact : this.#allNodes.filter((d) => d.name.includes(kw));
    if (hits.length > MATCH_LIMIT) {
      run.notes.push({ level: "warn", text: `「${kw}」在索引里匹配 ${hits.length} 个行政区，只取前 ${MATCH_LIMIT} 个` });
      return hits.slice(0, MATCH_LIMIT);
    }
    return hits;
  }

  /** 单个行政区的层级链数据（自身 + 下一级名单）—— 全部来自索引。 */
  #fetchTree(adcode: string): ChainNode | null {
    const region = this.#byAdcode.get(adcode);
    if (!region) return null;
    return { region, children: region.districts ?? [] };
  }

  /** 顺索引树从 `100000` 逐级下降定位目标，返回 `[国家级 … 目标]`。 */
  #buildChain(targetAdcode: string): ChainNode[] {
    const top = this.#fetchTree(COUNTRY);
    if (!top) throw new Error("无法获取国家级数据");
    const chain: ChainNode[] = [top];
    if (top.region.adcode === targetAdcode) return chain;
    let kids = top.children;
    for (let depth = 0; depth < 5; depth++) {
      const next = kids.find(
        (c) => c.adcode !== chain.at(-1)!.region.adcode && onPath(c.adcode, targetAdcode),
      );
      if (!next) break;
      const full = this.#fetchTree(next.adcode);
      if (!full) break;
      chain.push(full);
      if (next.adcode === targetAdcode) break;
      kids = full.children;
    }
    return chain;
  }

  // ------------------------------------------------------------- public
  /** 确保全国索引就绪（惰性加载）。 */
  async ready(refresh = false): Promise<void> {
    const run: Run = { notes: [], perf: newPerf(), gate: newGate(this.#signal, Infinity) };
    if (!(await this.#ensureIndex(refresh, run))) throw this.#indexError(run);
  }

  /**
   * 名称/adcode -> 命中的行政区列表。
   * 索引（国家->省->地->县）里查不到的名字（多为乡镇/街道级）才回落在线查询。
   */
  async resolve(keyword: string, refresh = false): Promise<ResolveResult> {
    return this.#resolve(keyword, refresh, { notes: [], perf: newPerf(), gate: newGate(this.#signal, Infinity) });
  }

  /** 索引取不到时的错误：按是否用尽预算给不同文案。 */
  #indexError(run: Run): Error {
    return new Error(
      run.gate.exhausted
        ? `本轮取数预算用尽（maxFetches=${run.gate.maxFetches}）：全国行政区划索引还没建立`
        : "无法获取全国行政区划索引",
    );
  }

  /** `resolve` 的内部版：提示与缓存统计写进调用方给的容器（`generate` 用以把索引那一次算进第一张图）。 */
  async #resolve(keyword: string, refresh: boolean, run: Run): Promise<ResolveResult> {
    if (!(await this.#ensureIndex(refresh, run))) throw this.#indexError(run);
    let regions = this.#searchIndex(keyword, run);
    if (!regions.length) {
      if (run.gate.exhausted)
        throw new Error(`「${keyword}」不在全国索引里，且本轮取数预算已用尽（maxFetches=${run.gate.maxFetches}）`);
      const found = await this.#apiQuery({ keywords: keyword, subdistrict: "1" }, run);
      if (found.status !== "1") throw new Error(`查询失败: ${found.info}`);
      regions = found.districts ?? [];
    }
    return { regions, notes: run.notes };
  }

  async #renderOne(
    root: AmapDistrict,
    upReq: number | "max",
    down: 0 | 1,
    shared: Note[],
    span: SpanOptions,
    run: Run,
  ): Promise<GenerateResult> {
    const perf = run.perf;
    const refresh = !!span.refresh;
    const centerMode = parseCenter(span.center);
    const ratioMode = typeof centerMode === "number"; // 方案二：目标占画幅比例
    const outsideSameLevelReq = span.outsideSameLevel;
    const outside = !!span.outside || !!outsideSameLevelReq || ratioMode; // 目标同级隐含外部轮廓；占比模式默认带同级
    const layout = span;
    const query = { name: root.name, adcode: root.adcode, level: root.level ?? "" };
    const local: Note[] = run.notes;

    // 顺 AMap 的树把目标链拉出来：chain[0] = 国家级 … chain[d] = 目标本身
    const chain = this.#buildChain(root.adcode);
    const d = chain.length - 1;
    const landed = chain.at(-1)!.region;
    const landedInfo = { name: landed.name, adcode: landed.adcode, level: landed.level ?? "" };
    if (landed.adcode !== root.adcode) {
      local.push({ level: "warn", text: `目标在 AMap 的层级树里对不上自身节点（乡镇/街道级常见），按 ${landed.name} 处理` });
    }

    let up = upReq === "max" ? d : upReq;
    if (up > d) {
      local.push({ level: "warn", text: `往上级数 ${up} 超出范围（${landed.name} 只有 ${d} 级祖先），已按 ${d} 处理` });
      up = d;
    }
    const outsideSameLevel = outsideSameLevelReq ?? (ratioMode && (up <= 1 || d <= 1));
    if (outsideSameLevel && !(up <= 1 || d <= 1)) {
      throw new Error(
        `outsideSameLevel 仅在 up <= 1 或目标为省级以上时可用：${landed.name} 处于第 ${d} 级（${landed.level}）、up=${up}`,
      );
    }
    const start = d - up + 1; // 这张图画的第一级
    const end = d + down; // 最后一级
    const file = svgFileName(landed, up, down);
    // 元数据：同一参数下必须逐字节一致（review 页按 SVG 哈希找等价组合），所以不放时间戳
    const meta: MapMeta = {
      generator: GENERATOR,
      source: API,
      attribution: ATTRIBUTION,
      query,
      landed: landedInfo,
      chain: chain.map((n) => ({
        name: n.region.name,
        adcode: n.region.adcode,
        level: n.region.level ?? "",
      })),
      span: {
        up,
        down,
        outside,
        outsideSameLevel,
        ratio: span.ratio ?? "auto",
        padding: span.padding ?? PAD,
        title: span.title ?? true,
        contextLabels: span.contextLabels ?? true,
        targetLabels: span.targetLabels ?? true,
        targetBackground: span.targetBackground ?? true,
        center: span.center ?? false,
        ...(span.colors ? { colors: span.colors } : {}),
      },
    };
    const finish = (extra: Partial<GenerateResult> & { up: number; file: string }) =>
      ({
        query,
        landed: landedInfo,
        down,
        meta,
        perf,
        svg: null,
        hash: null,
        blocks: 0,
        outline: false,
        neighbors: 0,
        ...extra,
        notes: [...shared, ...local],
      }) as GenerateResult;
    /** 预算用尽：这张图没跑完，绝不能画成一张缺内容的 SVG。 */
    const bail = () => {
      local.push({
        level: "warn",
        text: `本轮取数预算用尽（maxFetches=${run.gate.maxFetches}）：这张图没跑完，已拉取的边界留在缓存里，重跑会接着来`,
      });
      return finish({ up, file, landed: landedInfo });
    };
    if (run.gate.exhausted) return bail();

    // 每级取「上一级节点的全部下级」；depth 用本图内的相对层级（最上层 = 0）
    const units: RenderUnit[] = [];
    for (let lvl = start; lvl <= end; lvl++) {
      const parent = chain[lvl - 1];
      let added = 0;
      for (const c of (parent.children ?? []).filter((x) => x.level && DRAWABLE[x.level])) {
        const full = await this.#fetchRegion(c.adcode, refresh, run);
        if (run.gate.exhausted) break; // 别把「预算用尽」误报成「跳过无边界数据的下级」
        if (full?.polyline) {
          units.push({ ...toUnit(full), depth: lvl - start });
          added++;
        } else {
          local.push({ level: "warn", text: `跳过无边界数据的下级: ${c.name} (${c.adcode})` });
        }
      }
      if (!added && lvl === d + 1) {
        // 索引只到县级：县级节点的下级（乡镇/街道）根本不在索引里，children 为空
        const county = parent.region.level === "district";
        local.push({
          level: "warn",
          text:
            (parent.children ?? []).length || county
              ? `${parent.region.name} 的下级是乡镇/街道级，接口不返回边界，这一层不画`
              : `${parent.region.name} 没有下级，这一层不画`,
        });
      }
    }

    let outline: Unit | null = null;
    if (units.length) {
      // 本图最上层 = R(d-up)；索引不带边界，单独取自身的 polyline
      const self = await this.#fetchRegion(chain[start - 1].region.adcode, refresh, run);
      if (self?.polyline) outline = toUnit(self);
    } else {
      // 没有任何下级可画（down 0，或目标是叶子）-> 退化为只画自身轮廓
      // 街道/乡镇级自身没有边界，退到它实际落到的那个行政区
      const self = await this.#fetchRegion(landed.adcode, refresh, run);
      if (!self?.polyline) {
        if (run.gate.exhausted) return bail();
        local.push({ level: "warn", text: `${landed.name} 没有边界数据，无法出图` });
        return finish({ up, file, landed: landedInfo });
      }
      units.push({ ...toUnit(self), depth: 0 });
    }

    // 画框：与渲染共用同一套推导。外部轮廓不参与缩放，所以视图在拉候选之前就定了
    const frame = mapFrame({ units, outline, target: landed.adcode, ratio: layout.ratio, padding: layout.padding, title: layout.title, center: layout.center });
    const view = frame ? canvasViewBox(frame) : null;
    // 外部轮廓候选：统一去重，排除目标自身与已绘制的区块（避免与区块路径重复）。
    const drawn = new Set(units.map((u) => u.adcode));
    if (outline) drawn.add(outline.adcode);
    const added = new Set<string>();
    const outsideCands = { cands: [] as AmapDistrict[], pruned: 0 };
    const targetCands = { cands: [] as AmapDistrict[], pruned: 0 };
    /** 候选是否可能落在视图内：先查内置 bbox（省 / 地级；查不到就不预筛，保守）。 */
    const inView = (c: AmapDistrict) => {
      if (!view) return true;
      const b = builtinBBox(c.adcode);
      return !b || bboxHit(b, view);
    };
    const addCandidate = (into: { cands: AmapDistrict[]; pruned: number }, c: AmapDistrict) => {
      if (!c.level || !DRAWABLE[c.level]) return;
      if (c.adcode === landed.adcode || drawn.has(c.adcode) || added.has(c.adcode)) return;
      added.add(c.adcode);
      if (!inView(c)) {
        into.pruned++;
        return;
      }
      into.cands.push(c);
    };
    // 最外层同级：R(d-up) 的同级其他行政区（不往下细分）
    if (outside && d - up >= 1) {
      const top = chain[d - up].region;
      for (const c of chain[d - up - 1].children ?? []) {
        if (c.adcode !== top.adcode) addCandidate(outsideCands, c);
      }
    }
    const fetchUnits = async (cands: AmapDistrict[]) => {
      const out: RenderUnit[] = [];
      for (const c of cands) {
        const full = await this.#fetchRegion(c.adcode, refresh, run);
        if (run.gate.exhausted) break;
        if (full?.polyline) out.push({ ...toUnit(full), depth: 0 });
      }
      return out;
    };
    const outsideUnits = await fetchUnits(outsideCands.cands);
    // 目标同级：先定位「上一层」元素，再取其下级中落在视图内的那些。
    // 可用条件保证视图不超过最外层级：up=0 时最外层同级已覆盖目标同级（去重后为空）；
    // up=1 时「上一层」元素 = 已取回的「最外层同级」候选（同为第 d-1 级）。
    // 视图已由 mapFrame 定好（含占比模式），这里不再各推一套。
    if (outsideSameLevel && up === 1 && view) {
      for (const u of outsideUnits) {
        const b = bboxOf([u]);
        if (!b || !bboxHit(b, view)) continue; // 祖先不在视图内 -> 下级更不可能
        for (const c of this.#fetchTree(u.adcode)?.children ?? []) addCandidate(targetCands, c);
      }
    }
    const targetUnits = await fetchUnits(targetCands.cands);
    if (run.gate.exhausted) return bail(); // 预算用尽不渲染：绝不能画出缺内容的 SVG

    const map = renderMap({
      units,
      outline,
      colors: layout.colors,
      outside: outsideUnits,
      outsideTarget: targetUnits,
      ratio: layout.ratio,
      padding: layout.padding,
      title: layout.title,
      contextLabels: layout.contextLabels,
      targetLabels: layout.targetLabels,
      targetBackground: layout.targetBackground,
      center: layout.center,
      chain: chain.map((n) => n.region.adcode),
      target: landed.adcode,
      caption: landed.name,
      captionSub:
        up > 0
          ? chain.slice(d - up).map((n) => n.region.name).join(" › ")
          : landed.adcode,
    });
    if (!map) {
      local.push({ level: "warn", text: "没有可绘制的图层" });
      return finish({ up, file, landed: landedInfo });
    }
    if (outside) {
      local.push({
        level: "info",
        text:
          d - up < 1
            ? "拓展外部轮廓：最外层级即目标自身，没有更上层的同级相邻区域"
            : `拓展外部轮廓：同级候选 ${outsideCands.cands.length} 个（按内置 bbox 预筛掉 ${outsideCands.pruned} 个），视图内绘出 ${map.outside - map.outsideTarget} 个`,
      });
    }
    if (outsideSameLevel) {
      local.push({
        level: "info",
        text: `目标同级外部轮廓：候选 ${targetCands.cands.length} 个（按内置 bbox 预筛掉 ${targetCands.pruned} 个），视图内绘出 ${map.outsideTarget} 个`,
      });
    }
    const svgText = wrapSvg(map, meta);
    return {
      query,
      landed: landedInfo,
      up,
      down,
      file,
      svg: svgText,
      hash: await sha256Hex(svgText),
      meta,
      perf,
      blocks: units.length,
      outline: !!outline,
      neighbors: map.outside,
      notes: [...shared, ...local],
    };
  }

  /**
   * 出图：关键字 -> 每命中一个行政区一张 SVG。
   * `up` 超过目标深度会被夹到深度（记在 `notes`）；`down` 只允许 `0 | 1`（默认 `0`）。
   */
  async generate(keyword: string, span: SpanOptions = {}): Promise<GenerateResult[]> {
    const upReq = span.up ?? 0;
    const downReq = span.down ?? 0;
    if (upReq !== "max" && (!Number.isInteger(upReq) || (upReq as number) < 0))
      throw new Error("up 只接受非负整数或 max");
    if (downReq !== 0 && downReq !== 1) throw new Error("down 只接受 0 或 1（最多往下 1 级）");
    if (span.ratio !== undefined && parseRatio(span.ratio) === null)
      throw new Error('ratio 只接受 "auto"、正数或 "W:H"');
    if (span.padding !== undefined && (!Number.isFinite(span.padding) || span.padding < 0))
      throw new Error("padding 只接受非负数字");
    if (span.title !== undefined && typeof span.title !== "boolean")
      throw new Error("title 只接受布尔值");
    if (span.colors !== undefined) {
      const c = span.colors;
      if (typeof c !== "object" || c === null)
        throw new Error("colors 只接受 { background?, line?, targetFill? } 对象");
      for (const k of ["background", "line", "targetFill"] as const) {
        const v = c[k];
        if (v !== undefined && (typeof v !== "string" || !v.trim()))
          throw new Error(`colors.${k} 只接受非空字符串`);
      }
    }
    if (span.center !== undefined) {
      const c = span.center;
      const ok =
        typeof c === "boolean" ||
        c === "outline" ||
        c === "target" ||
        (typeof c === "number" && Number.isFinite(c) && c > 0 && c <= 1);
      if (!ok) throw new Error('center 只接受布尔值、"outline"、"target" 或 (0,1] 的数字');
    }
    if (span.maxFetches !== undefined && (!Number.isInteger(span.maxFetches) || span.maxFetches < 0))
      throw new Error("maxFetches 只接受非负整数");
    if (span.signal !== undefined && typeof span.signal.aborted !== "boolean")
      throw new Error("signal 只接受 AbortSignal");

    const gate = newGate(span.signal ?? this.#signal, span.maxFetches ?? Infinity);
    // 解析层（索引等）只做一次，其缓存统计并进第一张图 —— 与 notes 的处理一致
    const resRun: Run = { notes: [], perf: newPerf(), gate };
    const { regions, notes } = await this.#resolve(keyword, !!span.refresh, resRun);
    if (!regions.length) throw new Error(`没有匹配「${keyword}」的行政区`);
    const out: GenerateResult[] = [];
    for (let i = 0; i < regions.length; i++) {
      gate.signal?.throwIfAborted(); // 每张图之前再查一次
      // 解析层的提示（索引构建/匹配上限/限流）只挂在第一个结果上，避免多命中时重复
      const run: Run = { notes: [], perf: i === 0 ? resRun.perf : newPerf(), gate };
      out.push(await this.#renderOne(regions[i], upReq, downReq, i === 0 ? notes : [], span, run));
    }
    return out;
  }
}
