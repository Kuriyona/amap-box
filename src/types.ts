/**
 * `@kuriyona/amap-box` 的公共类型。
 */

/** 高德 `district` 接口返回的单个行政区节点（只声明用得到的字段，其余原样保留）。 */
export interface AmapDistrict {
  name: string;
  adcode: string;
  level?: string;
  center?: string;
  polyline?: string;
  districts?: AmapDistrict[];
  [key: string]: unknown;
}

/**
 * 取数函数：给定完整 URL（已含 key），返回**已解析**的响应对象。
 * 直接透传平台的原生 `fetch` 时记得 `.json()`：
 * `(url) => fetch(url).then((r) => r.json())`。
 */
export type AmapFetch = (url: string) => unknown | Promise<unknown>;

/**
 * 键值缓存。值一律是字符串（本库内部用 JSON 序列化），
 * 键形如 `"index"`（全国索引）与 `<adcode>`（单个行政区边界）。
 */
export interface AmapCache {
  read(key: string): string | null | undefined | Promise<string | null | undefined>;
  write(key: string, value: string): void | Promise<void>;
}

/** 构造函数参数。 */
export interface AmapBoxOptions {
  /** 高德 Web 服务 key。 */
  Key: string;
  /** 取数函数。 */
  fetch: AmapFetch;
  /** 缓存实现。 */
  cache: AmapCache;
}

/** 画幅比例：`"auto"`（按内容）或正数宽高比 W/H；也接受 `"16:9"` 这样的字符串。 */
export type MapRatio = number | "auto" | `${number}:${number}`;

/** 配色：三项都可选，未给的用默认值。 */
export interface ColorOptions {
  /** 画布背景色。默认 `#0d1117`（`BG`）。 */
  background?: string;
  /** 线条与文字颜色。默认 `#ffffff`（`LINE`）。 */
  line?: string;
  /** 目标节点所在区域的背景高亮色。默认 `#1f6feb`（`TARGET_FILL`）。 */
  targetFill?: string;
}

/** 出图版式（画幅）。 */
export interface LayoutOptions {
  /** 配色覆盖（背景 / 线条与文字 / 目标高亮）。 */
  colors?: ColorOptions;
  /** 画幅宽高比。默认 `"auto"`：由内容包围盒 + 留白 + 标题带决定。 */
  ratio?: MapRatio;
  /** 内容四周留白（px）。默认 `24`。 */
  padding?: number;
  /** 是否绘制标题（含副标题）。默认 `true`。 */
  title?: boolean;
  /** 非目标节点（上下文）的文字标签是否绘制。默认 `true`。 */
  contextLabels?: boolean;
  /** 目标节点自身的文字标签是否绘制。默认 `true`。 */
  targetLabels?: boolean;
  /** 是否给目标节点所在区域填充半透明高亮背景。默认 `true`。 */
  targetBackground?: boolean;
  /**
   * 是否让**目标**（而非内容包围盒）居中，默认 `false`。
   * - `true` / `"outline"`（方案一）：目标质心居中，并保证最外层轮廓 `R(d-up)` 完整可见
   *   （多余空间补成留白）；目标偏居轮廓一角时会留下较多空白。`u0d0` 等目标即轮廓时与默认一致。
   * - `"target"`（方案二）：目标质心居中，目标包围盒长边占画幅长边的 `0.5`。
   * - 数字（`0 < N <= 1`）：同方案二，比例取 `N`。此时上下文（如上级轮廓）超出画幅即被裁掉，
   *   且 `outsideSameLevel` 默认开启（在条件允许时）。
   */
  center?: boolean | "outline" | "target" | number;
}

/** 出图跨度与版式。 */
export interface SpanOptions extends LayoutOptions {
  /** 往上包含几级祖先；`"max"` = 一直到国家级。默认 `0`。 */
  up?: number | "max";
  /** 往下细分几级，只允许 `0 | 1`。默认 `0`（只画目标自身）。 */
  down?: 0 | 1;
  /**
   * 是否拓展外部轮廓：把「最外层级」（`R(d-up)`，如 杭州 u1 / 浙江 u0 都是浙江省）同级的其他
   * 行政区中，落在当前视图内的那些轮廓也画出来（不往下细分），让图更完整。默认 `false`。
   */
  outside?: boolean;
  /**
   * 是否把「与目标同层级」的区域也作为外部轮廓画出（落在视图内的）。默认 `false`。
   * 单独给出即隐含 `outside`。仅当 `up <= 1` 或目标为省级以上时可用，否则 `generate` 报错。
   */
  outsideSameLevel?: boolean;
  /** 忽略缓存重新拉取（含重建全国索引）。 */
  refresh?: boolean;
}

/** 行政区引用（名称 / adcode / 级别）。 */
export interface RegionRef {
  name: string;
  adcode: string;
  level: string;
}

/** 当前这张图实际使用的跨度与版式（已填默认值）。 */
export interface MapSpan {
  up: number;
  down: 0 | 1;
  outside: boolean;
  outsideSameLevel: boolean;
  ratio: MapRatio;
  padding: number;
  title: boolean;
  contextLabels: boolean;
  targetLabels: boolean;
  targetBackground: boolean;
  center: boolean | "outline" | "target" | number;
  /** 仅在调用方给了 `colors` 时出现。 */
  colors?: ColorOptions;
}

/**
 * 图的元数据：既是 `GenerateResult.meta`，也序列化成 SVG 里内嵌的 `<metadata>` 元素
 * （JSON 文本），让 SVG 文件自带出处与画的是什么。**不含时间戳**，保证同一参数出图逐字节一致。
 */
export interface MapMeta {
  /** 生成器与版本，如 `@kuriyona/amap-box@0.2.0`。 */
  generator: string;
  /** 数据来源接口。 */
  source: string;
  /** 数据版权署名。 */
  attribution: string;
  /** 关键字命中的行政区。 */
  query: RegionRef;
  /** 实际落到的行政区。 */
  landed: RegionRef;
  /** 图上画到的层级链（国家级 → 目标），与副标题同源。 */
  chain: RegionRef[];
  /** 这张图实际用的跨度与版式。 */
  span: MapSpan;
}

/**
 * 出图过程的缓存统计（目前只含缓存命中情况）。只记**真的读了注入缓存**的调用：
 * 索引已在本实例内存里复用（同一次 `generate` 之外的第二次调用）不算缓存访问，两张列表里都不出现。
 */
export interface PerfStats {
  /** 命中缓存的键（`"index"` 与各 `<adcode>`），按首次访问顺序去重。 */
  cacheHits: string[];
  /** 未命中缓存、实际打了接口的键；`refresh` 强制绕过缓存时也记在这里。 */
  cacheMisses: string[];
}

/** `resolve()` 的返回值。 */
export interface ResolveResult {
  /** 命中的行政区（AMap 树里的节点）。 */
  regions: AmapDistrict[];
  /** 过程中的提示/警告。 */
  notes: string[];
}

/** `generate()` 单张图的结果。 */
export interface GenerateResult {
  /** 关键字命中的行政区。 */
  query: RegionRef;
  /** 实际落到的行政区（乡镇/街道级会退到所属区县）。 */
  landed: RegionRef;
  /** 解析后的往上级数（`up` 超过目标深度时会被夹到深度）。 */
  up: number;
  /** 往下级数。 */
  down: 0 | 1;
  /** 建议文件名 `[名称]-[adcode]-u<K>d<M>.svg`。 */
  file: string;
  /** SVG 文本；无法出图时为 `null`。 */
  svg: string | null;
  /** 元数据；与 SVG 里内嵌的 `<metadata>` 元素同源（后者是其 JSON 序列化）。 */
  meta: MapMeta;
  /** 这张图出的过程中缓存命中/未命中的键。 */
  perf: PerfStats;
  /** 区块数（不含整体轮廓）。 */
  blocks: number;
  /** 是否有整体轮廓。 */
  outline: boolean;
  /** 画出的外部轮廓区块数（`outside` 启用且视图内有同级相邻区域时 > 0）。 */
  neighbors: number;
  /** 这张图的提示/警告。解析层（索引构建、匹配上限、限流）的提示只在第一个结果里出现一次。 */
  notes: string[];
}
