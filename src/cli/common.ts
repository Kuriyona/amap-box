/** CLI 共用：key 读取、磁盘缓存、原生 fetch 适配。 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AmapCache, AmapFetch } from "../types.js";

/** 从显式值、环境变量 `AMAP_KEY` 或当前目录 `.env` 的 `KEY=...` 读 key。 */
export function loadKey(explicit?: string): string | null {
  if (explicit) return explicit;
  const env = process.env.AMAP_KEY;
  if (env) return env;
  if (!existsSync(".env")) return null;
  return readFileSync(".env", "utf8").match(/^\s*(?:AMAP_)?KEY\s*=\s*(.+)$/m)?.[1].trim() ?? null;
}

/** `--name` 模板 -> 文件名：替换 `{name}` / `{adcode}` / `{up}` / `{down}`，非法字符换 `_`，缺 `.svg` 后缀补齐。 */
export function renderNameTemplate(
  template: string,
  region: { name: string; adcode: string; up: number; down: number },
): string {
  const filled = template.replace(/\{(name|adcode|up|down)\}/g, (_m, k: "name" | "adcode" | "up" | "down") =>
    String(region[k]),
  );
  const safe = filled.replace(/[\\/:*?"<>|\s]/g, "_");
  return safe.endsWith(".svg") ? safe : `${safe}.svg`;
}

/** 磁盘缓存：键 -> `<dir>/<key>.json`。 */
export function diskCache(dir: string): AmapCache {
  const fileOf = (key: string) => join(dir, `${key}.json`);
  return {
    read(key) {
      const file = fileOf(key);
      if (!existsSync(file)) return null;
      try {
        return readFileSync(file, "utf8");
      } catch {
        return null;
      }
    },
    write(key, value) {
      const file = fileOf(key);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, value);
    },
  };
}

/** 原生 fetch -> 已解析对象。 */
export const nodeFetch: AmapFetch = async (url) => (await globalThis.fetch(url)).json();
