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

/** 出图跨度。 */
export interface SpanOptions {
  /** 往上包含几级祖先；`"max"` = 一直到国家级。默认 `0`。 */
  up?: number | "max";
  /** 往下细分几级，只允许 `0 | 1`。默认 `1`。 */
  down?: 0 | 1;
  /** 忽略缓存重新拉取（含重建全国索引）。 */
  refresh?: boolean;
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
  query: { name: string; adcode: string; level: string };
  /** 实际落到的行政区（乡镇/街道级会退到所属区县）。 */
  landed: { name: string; adcode: string; level: string };
  /** 解析后的往上级数（`up` 超过目标深度时会被夹到深度）。 */
  up: number;
  /** 往下级数。 */
  down: 0 | 1;
  /** 建议文件名 `[名称]-[adcode]-u<K>d<M>.svg`。 */
  file: string;
  /** SVG 文本；无法出图时为 `null`。 */
  svg: string | null;
  /** 区块数（不含整体轮廓）。 */
  blocks: number;
  /** 是否有整体轮廓。 */
  outline: boolean;
  /** 这张图的提示/警告。解析层（索引构建、匹配上限、限流）的提示只在第一个结果里出现一次。 */
  notes: string[];
}
