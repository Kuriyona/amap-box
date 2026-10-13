/** CLI 共用：key 读取、磁盘缓存、原生 fetch 适配。 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AmapCache, AmapFetch } from "../types.js";

/** 从环境变量 `AMAP_KEY` 或当前目录 `.env` 的 `KEY=...` 读 key。 */
export function loadKey(): string | null {
  const env = process.env.AMAP_KEY;
  if (env) return env;
  if (!existsSync(".env")) return null;
  return readFileSync(".env", "utf8").match(/^\s*(?:AMAP_)?KEY\s*=\s*(.+)$/m)?.[1].trim() ?? null;
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
