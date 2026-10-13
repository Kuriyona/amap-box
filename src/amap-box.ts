/**
 * `AmapBox` —— 高德行政区划 → SVG 的核心 API。
 *
 * 构造：`new AmapBox({ Key, fetch, cache })`。取数与缓存都由调用方注入，
 * 因此在 Node / Bun / 浏览器 / 测试里都能用同一份逻辑。
 */
import type { AmapDistrict, AmapBoxOptions, GenerateResult, ResolveResult, SpanOptions } from "./types.js";
import { toUnit, type Unit } from "./geometry.js";
import { renderMap, wrapSvg, type RenderUnit } from "./render.js";

const API = "https://restapi.amap.com/v3/config/district";
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

  #byAdcode = new Map<string, AmapDistrict>();
  #allNodes: AmapDistrict[] = [];
  #indexLoaded = false;

  constructor(options: AmapBoxOptions) {
    if (!options || typeof options !== "object") throw new TypeError("AmapBox 需要 { Key, fetch, cache } 参数");
    if (!options.Key) throw new TypeError("AmapBox: 缺少 Key");
    if (typeof options.fetch !== "function") throw new TypeError("AmapBox: fetch 必须是函数");
    if (typeof options.cache?.read !== "function" || typeof options.cache?.write !== "function")
      throw new TypeError("AmapBox: cache 需要 { read, write }");
    this.#key = options.Key;
    this.#fetch = options.fetch;
    this.#cache = options.cache;
  }

  // ------------------------------------------------------------- API layer
  async #apiQuery(
    params: Record<string, string>,
    notes: string[],
    tries = 6,
  ): Promise<ApiResponse> {
    const url = `${API}?${new URLSearchParams({ key: this.#key, showbiz: "false", extensions: "all", ...params })}`;
    let info = "unknown";
    for (let t = 0; t < tries; t++) {
      let d: ApiResponse;
      try {
        d = ((await this.#fetch(url)) ?? {}) as ApiResponse;
      } catch (e) {
        d = { status: "0", info: String(e) };
      }
      if (d.status === "1") return d;
      info = d.info ?? "unknown";
      if (!RETRYABLE.test(info)) return d; // 真错误（如 key 无效）不再空转
      if (t < tries - 1) {
        notes.push(`限流重试 ${t + 1}/${tries - 1}: ${info}`);
        await sleep(700 + 500 * t);
      }
    }
    return { status: "0", info };
  }

  async #readCache(key: string, refresh: boolean): Promise<ApiResponse | null> {
    if (refresh) return null;
    let raw: string | null | undefined;
    try {
      raw = await this.#cache.read(key);
    } catch {
      return null;
    }
    if (!raw) return null;
    try {
      const d = JSON.parse(raw) as ApiResponse;
      return d?.districts?.length ? d : null;
    } catch {
      return null;
    }
  }

  async #writeCache(key: string, d: ApiResponse): Promise<void> {
    await this.#cache.write(key, JSON.stringify(d));
  }

  /** 单个行政区（仅自身，含边界）。 */
  async #fetchRegion(adcode: string, refresh: boolean, notes: string[]): Promise<AmapDistrict | null> {
    const hit = await this.#readCache(adcode, refresh);
    if (hit) return hit.districts![0];
    const d = await this.#apiQuery({ keywords: adcode, subdistrict: "0" }, notes);
    if (d.status !== "1" || !d.districts?.length) return null;
    await this.#writeCache(adcode, d);
    await sleep(350);
    return d.districts[0];
  }

  // ------------------------------------------------------------- index
  // 全国行政区划索引：一次请求拿到 国家->省->地->县 整棵树（extensions=base，不含边界）。
  // 之后所有名称/adcode 查找与层级链都只认它；只有索引缺失或 refresh 才重建。
  async #loadIndex(refresh: boolean, notes: string[]): Promise<AmapDistrict | null> {
    const hit = await this.#readCache("index", refresh);
    if (hit) return hit.districts![0];
    notes.push("首次运行：拉取全国行政区划索引（一次请求，不含边界）");
    const d = await this.#apiQuery({ keywords: COUNTRY, subdistrict: "3", extensions: "base" }, notes);
    if (d.status !== "1" || !d.districts?.length) return null;
    await this.#writeCache("index", d);
    notes.push("索引已缓存");
    return d.districts[0];
  }

  /** 载入并扁平化索引。成功返回 true。 */
  async #ensureIndex(refresh: boolean, notes: string[]): Promise<boolean> {
    if (this.#indexLoaded && !refresh) return true;
    const root = await this.#loadIndex(refresh, notes);
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
  #searchIndex(kw: string, notes: string[]): AmapDistrict[] {
    if (/^\d+$/.test(kw)) {
      const hit = this.#byAdcode.get(kw);
      return hit ? [hit] : [];
    }
    const exact = this.#allNodes.filter((d) => d.name === kw);
    const hits = exact.length ? exact : this.#allNodes.filter((d) => d.name.includes(kw));
    if (hits.length > MATCH_LIMIT) {
      notes.push(`「${kw}」在索引里匹配 ${hits.length} 个行政区，只取前 ${MATCH_LIMIT} 个`);
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
    const notes: string[] = [];
    if (!(await this.#ensureIndex(refresh, notes))) throw new Error("无法获取全国行政区划索引");
  }

  /**
   * 名称/adcode -> 命中的行政区列表。
   * 索引（国家->省->地->县）里查不到的名字（多为乡镇/街道级）才回落在线查询。
   */
  async resolve(keyword: string, refresh = false): Promise<ResolveResult> {
    const notes: string[] = [];
    if (!(await this.#ensureIndex(refresh, notes))) throw new Error("无法获取全国行政区划索引");
    let regions = this.#searchIndex(keyword, notes);
    if (!regions.length) {
      const found = await this.#apiQuery({ keywords: keyword, subdistrict: "1" }, notes);
      if (found.status !== "1") throw new Error(`查询失败: ${found.info}`);
      regions = found.districts ?? [];
    }
    return { regions, notes };
  }

  async #renderOne(
    root: AmapDistrict,
    upReq: number | "max",
    down: 0 | 1,
    refresh: boolean,
    shared: string[],
    outside: boolean,
  ): Promise<GenerateResult> {
    const query = { name: root.name, adcode: root.adcode, level: root.level ?? "" };
    const local: string[] = [];
    const finish = (extra: Partial<GenerateResult> & { up: number; file: string }) =>
      ({ query, landed: query, down, svg: null, blocks: 0, outline: false, neighbors: 0, ...extra, notes: [...shared, ...local] }) as GenerateResult;

    // 顺 AMap 的树把目标链拉出来：chain[0] = 国家级 … chain[d] = 目标本身
    const chain = this.#buildChain(root.adcode);
    const d = chain.length - 1;
    const landed = chain.at(-1)!.region;
    const landedInfo = { name: landed.name, adcode: landed.adcode, level: landed.level ?? "" };
    if (landed.adcode !== root.adcode) {
      local.push(`目标在 AMap 的层级树里对不上自身节点（乡镇/街道级常见），按 ${landed.name} 处理`);
    }

    let up = upReq === "max" ? d : upReq;
    if (up > d) {
      local.push(`往上级数 ${up} 超出范围（${landed.name} 只有 ${d} 级祖先），已按 ${d} 处理`);
      up = d;
    }
    const start = d - up + 1; // 这张图画的第一级
    const end = d + down; // 最后一级
    const file = svgFileName(landed, up, down);

    // 每级取「上一级节点的全部下级」；depth 用本图内的相对层级（最上层 = 0）
    const units: RenderUnit[] = [];
    for (let lvl = start; lvl <= end; lvl++) {
      const parent = chain[lvl - 1];
      let added = 0;
      for (const c of (parent.children ?? []).filter((x) => x.level && DRAWABLE[x.level])) {
        const full = await this.#fetchRegion(c.adcode, refresh, local);
        if (full?.polyline) {
          units.push({ ...toUnit(full), depth: lvl - start });
          added++;
        } else {
          local.push(`跳过无边界数据的下级: ${c.name} (${c.adcode})`);
        }
      }
      if (!added && lvl === d + 1) {
        // 索引只到县级：县级节点的下级（乡镇/街道）根本不在索引里，children 为空
        const county = parent.region.level === "district";
        local.push(
          (parent.children ?? []).length || county
            ? `${parent.region.name} 的下级是乡镇/街道级，接口不返回边界，这一层不画`
            : `${parent.region.name} 没有下级，这一层不画`,
        );
      }
    }

    let outline: Unit | null = null;
    if (units.length) {
      // 本图最上层 = R(d-up)；索引不带边界，单独取自身的 polyline
      const self = await this.#fetchRegion(chain[start - 1].region.adcode, refresh, local);
      if (self?.polyline) outline = toUnit(self);
    } else {
      // 没有任何下级可画（down 0，或目标是叶子）-> 退化为只画自身轮廓
      // 街道/乡镇级自身没有边界，退到它实际落到的那个行政区
      const self = await this.#fetchRegion(landed.adcode, refresh, local);
      if (!self?.polyline) {
        local.push(`${landed.name} 没有边界数据，无法出图`);
        return finish({ up, file, landed: landedInfo });
      }
      units.push({ ...toUnit(self), depth: 0 });
    }

    // 拓展外部轮廓：与「最外层级」R(d-up) 同级的其他行政区（不往下细分），
    // 边界取回来交给 renderMap，由它只画落在当前视图内的那些。
    const outsideCandidates: AmapDistrict[] = [];
    if (outside && d - up >= 1) {
      const top = chain[d - up].region;
      for (const c of chain[d - up - 1].children ?? []) {
        if (c.adcode === top.adcode || !c.level || !DRAWABLE[c.level]) continue;
        outsideCandidates.push(c);
      }
    }
    const neighbors: RenderUnit[] = [];
    for (const c of outsideCandidates) {
      const full = await this.#fetchRegion(c.adcode, refresh, local);
      if (full?.polyline) neighbors.push({ ...toUnit(full), depth: 0 });
    }

    const map = renderMap({
      units,
      outline,
      outside: neighbors,
      chain: chain.map((n) => n.region.adcode),
      target: landed.adcode,
      caption: landed.name,
      captionSub:
        up > 0
          ? chain.slice(d - up).map((n) => n.region.name).join(" › ")
          : landed.adcode,
    });
    if (!map) {
      local.push("没有可绘制的图层");
      return finish({ up, file, landed: landedInfo });
    }
    if (outside) {
      local.push(
        d - up < 1
          ? "拓展外部轮廓：最外层级已是国家级，没有同级相邻区域"
          : `拓展外部轮廓：同级候选 ${outsideCandidates.length} 个，视图内绘出 ${map.outside} 个`,
      );
    }
    return {
      query,
      landed: landedInfo,
      up,
      down,
      file,
      svg: wrapSvg(map),
      blocks: units.length,
      outline: !!outline,
      neighbors: map.outside,
      notes: [...shared, ...local],
    };
  }

  /**
   * 出图：关键字 -> 每命中一个行政区一张 SVG。
   * `up` 超过目标深度会被夹到深度（记在 `notes`）；`down` 只允许 `0 | 1`。
   */
  async generate(keyword: string, span: SpanOptions = {}): Promise<GenerateResult[]> {
    const upReq = span.up ?? 0;
    const downReq = span.down ?? 1;
    if (upReq !== "max" && (!Number.isInteger(upReq) || (upReq as number) < 0))
      throw new Error("up 只接受非负整数或 max");
    if (downReq !== 0 && downReq !== 1) throw new Error("down 只接受 0 或 1（最多往下 1 级）");

    const { regions, notes } = await this.resolve(keyword, !!span.refresh);
    if (!regions.length) throw new Error(`没有匹配「${keyword}」的行政区`);
    const out: GenerateResult[] = [];
    for (let i = 0; i < regions.length; i++) {
      // 解析层的提示（索引构建/匹配上限/限流）只挂在第一个结果上，避免多命中时重复
      out.push(await this.#renderOne(regions[i], upReq, downReq, !!span.refresh, i === 0 ? notes : [], !!span.outside));
    }
    return out;
  }
}
