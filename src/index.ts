/**
 * `@kuriyona/amap-box` —— 高德行政区划 → SVG 深色线稿地图。
 *
 * 用法：
 * ```ts
 * import { AmapBox } from "@kuriyona/amap-box";
 *
 * const box = new AmapBox({
 *   Key: process.env.AMAP_KEY!,
 *   fetch: (url) => fetch(url).then((r) => r.json()),
 *   cache: {
 *     read: (key) => fs.existsSync(`.cache/${key}.json`) ? fs.readFileSync(`.cache/${key}.json`, "utf8") : null,
 *     write: (key, value) => fs.writeFileSync(`.cache/${key}.json`, value),
 *   },
 * });
 *
 * const maps = await box.generate("杭州市", { up: 1, down: 1 });
 * for (const m of maps) console.log(m.file, m.svg?.length);
 * ```
 */
export { AmapBox, svgFileName } from "./amap-box.js";
export type {
  AmapDistrict,
  AmapFetch,
  AmapCache,
  AmapBoxOptions,
  SpanOptions,
  LayoutOptions,
  ColorOptions,
  RegionRef,
  MapMeta,
  MapSpan,
  PerfStats,
  MapRatio,
  ResolveResult,
  GenerateResult,
  Note,
} from "./types.js";
export {
  parsePolyline,
  toUnit,
  signedArea,
  centroid,
  pointInRing,
  simplify,
  type LonLat,
  type Point,
  type Ring,
  type Rings,
  type Unit,
} from "./geometry.js";
export {
  renderMap,
  wrapSvg,
  parseRatio,
  parseCenter,
  centerRatioViewBox,
  DEFAULT_CENTER_RATIO,
  BG,
  LINE,
  OUTLINE_STROKE,
  TARGET_FILL,
  TARGET_FILL_OPACITY,
  type CenterMode,
  type RenderUnit,
  type RenderInput,
  type RenderOutput,
} from "./render.js";
