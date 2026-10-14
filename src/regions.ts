/** 内置全国行政区划索引（随包发布、发版时冻结）的解码：紧凑行 → `AmapDistrict` 树。 */
import { LEVELS, REGIONS, type RegionRow } from "./data/regions.js";
import type { AmapDistrict } from "./types.js";

const decode = (row: RegionRow): AmapDistrict => {
  const [adcode, name, level, lon, lat, children] = row;
  const node: AmapDistrict = {
    name,
    adcode: String(adcode),
    level: LEVELS[level]!, // 生成器保证级别码在表内（未知级别直接报错）
    center: `${lon},${lat}`,
  };
  if (children?.length) node.districts = children.map(decode);
  return node;
};

let root: AmapDistrict | null = null;

/** 内置索引的根节点（惰性解码一次，实例间共用；调用方只读）。 */
export const bundledIndexRoot = (): AmapDistrict => (root ??= decode(REGIONS[0]!));
