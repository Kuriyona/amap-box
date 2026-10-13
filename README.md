# @kuriyona/amap-box

高德行政区划 → SVG 深色线稿地图。同一份核心逻辑，两种用法：**JS API** 与 **CLI**。

给一个行政区名或 adcode（`杭州市`、`330100`），得到深色底、白色线稿的行政区划图：
可以往上带若干级祖先，也可以往下细分一级。

- **JS API**：`new AmapBox({ Key, fetch, cache })` —— 取数与缓存都由调用方注入，Node / Bun / 浏览器 / 测试里同一套逻辑。
- **CLI**：`amap-box` 出图，`amap-box-review` 出人工审阅页。
- 无运行时依赖（只用平台原生 `fetch` 与你注入的缓存）；ESM + CJS + 类型声明。
- 首次运行拉一份**全国行政区划索引**（一次请求，不含边界），之后名称查找与层级链 **0 请求**。
- 接口限流自动退避重试。

## 安装

```bash
npm install @kuriyona/amap-box
# 或
bun add @kuriyona/amap-box
```

## JS API

```ts
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { AmapBox } from "@kuriyona/amap-box";

const box = new AmapBox({
  Key: process.env.AMAP_KEY!,
  // 输入完整 URL（已含 key），返回**已解析**的响应对象
  fetch: (url) => fetch(url).then((r) => r.json()),
  // 键值缓存，值一律是字符串
  cache: {
    read: (key) => (existsSync(`.amap/${key}.json`) ? readFileSync(`.amap/${key}.json`, "utf8") : null),
    write: (key, value) => {
      mkdirSync(".amap", { recursive: true });
      writeFileSync(`.amap/${key}.json`, value);
    },
  },
});

const maps = await box.generate("杭州市", { up: 1, down: 1 });
for (const m of maps) if (m.svg) writeFileSync(m.file, m.svg);
```

### 构造参数

| 参数 | 类型 | 说明 |
|---|---|---|
| `Key` | `string` | 高德 Web 服务 key |
| `fetch` | `(url: string) => object \| Promise<object>` | 给定完整 URL（已含 key），返回**已解析**的响应对象 |
| `cache` | `{ read(key), write(key, value) }` | 键值缓存。`read` 返回 `string \| null \| undefined \| Promise<…>`，`write` 返回 `void \| Promise<void>`；值一律是字符串（库内部 JSON 序列化）。键为 `"index"`（全国索引）与各 `<adcode>` |

### 方法

| 方法 | 说明 |
|---|---|
| `resolve(keyword, refresh?)` | 名称 / adcode → `{ regions, notes }`。先查索引，索引里没有的（乡镇 / 街道级）回落在线查询 |
| `generate(keyword, { up?, down?, outside?, outsideSameLevel?, ratio?, padding?, title?, contextLabels?, targetLabels?, targetBackground?, colors?, center?, refresh? })` | 每个命中出一张图，返回 `GenerateResult[]`（不落盘，`svg` 给你自己写） |
| `ready(refresh?)` | 只预热全国索引 |

`GenerateResult` 字段：

| 字段 | 说明 |
|---|---|
| `query` / `landed` | 关键字命中的行政区 / **实际落到**的行政区（乡镇、街道级会退到所属区县） |
| `up` / `down` | 解析后的跨度（`up` 超过目标深度时会被夹到深度） |
| `file` | 建议文件名 `[名称]-[adcode]-u<K>d<M>.svg` |
| `svg` | SVG 文本；这张画不出来时为 `null` |
| `meta` | 图的元数据（生成器+版本、数据来源、署名、`query` / `landed`、`chain` 层级链、实际 `span`）；同一份 JSON 内嵌在 SVG 开头的 `<metadata>` 里 |
| `perf` | `{ cacheHits, cacheMisses }`：这张图出图过程中命中 / 未命中缓存的键（`"index"` 与各 `<adcode>`） |
| `blocks` / `outline` | 区块数 / 是否带整体轮廓 |
| `neighbors` | 画出的外部轮廓区块数（`outside` 启用且视图内有同级相邻区域时 > 0） |
| `notes` | 提示与警告（索引构建、匹配上限、限流重试、无边界数据…） |

跨度选项：

- `up`：往上包含几级祖先，默认 `0`；`"max"` = 一直到国家级。
- `down`：往下细分几级，只允许 `0 | 1`，默认 `0`；`1` = 再画一级下级。
- `outside`：是否拓展外部轮廓，默认 `false`。启用后把**最外层级**（`R(d-up)`，如 杭州 u1 / 浙江 u0 都是浙江省）
  同级的其他行政区中、落在当前视图内的那些轮廓也画出来（更细更淡、不加标签、不往下细分、不改变缩放），让图更完整。
- `outsideSameLevel`：是否把**与目标同层级**（第 `d` 级）的区域也作为外部轮廓画出（落在视图内的才画）。默认 `false`。
  单独给出即隐含 `outside`。为控成本，先筛出落在视图内的「上一层」（第 `d-1` 级）元素，再取它们的第 `d` 级下级。
  **仅当 `up <= 1` 或目标为省级以上时可用**，否则 `generate` 报错。
- `ratio`：画幅宽高比，默认 `"auto"`（按内容）。可给正数或 `"16:9"`；给定时内容按长边 `1000px` 缩放后居中，
  多余空间补成留白，内容本身不重新缩放。
- `padding`：内容四周留白（px），默认 `24`。
- `title`：是否绘制标题（含副标题），默认 `true`。
- `contextLabels`：是否绘制**非目标节点**（上下文）的标签，默认 `true`。
- `targetLabels`：是否绘制**目标节点自身**的标签，默认 `true`。
- `colors`：配色覆盖，默认无（用内置常量）。可给 `{ background?, line?, targetFill? }` 覆盖任意几项：
  画布背景（默认 `#0d1117`）、线条与文字（默认 `#ffffff`）、目标节点背景高亮（默认 `#1f6feb`）。
  值为任意非空字符串（如 `"#101820"`、`"none"`、`"transparent"`）；空串或非对象会报错。
- 层级分层（**始终生效，没有开关**）：目标以外的节点按**图内相对层级**绘制 —— 整体轮廓最粗最亮（`OUTLINE_STROKE = 2.8`），
  区块越浅的层级越粗越亮；目标（与图上画到的链路祖先）单独高亮。`MIN_STROKE`~`MAX_STROKE` 给出区块线宽范围。
- `targetBackground`：是否给**目标节点所在区域**填充半透明背景高亮，默认 `true`（目标落到整体轮廓上时填充轮廓区域）。
- `center`：是否让**目标**（而非内容包围盒）居中，默认 `false`（内容居中）。
  - `true` / `"outline"`（方案一）：目标质心居中，并保证最外层轮廓 `R(d-up)` 完整可见（多余空间补成留白）。
    目标偏居轮廓一角时留白较多；目标即轮廓（如 `u0d0`）时与默认一致。
  - `"target"`（方案二）：目标质心居中，目标包围盒长边占画幅可绘区长边的 `0.5`。
  - 数字（`0 < N <= 1`）：同方案二，比例取 `N`。此时上下文（如上级轮廓）超出画幅会被裁掉，
    且 `outsideSameLevel` 默认开启（在其可用条件满足时，如 `up <= 1`）；`ratio` 决定取景框（可绘区）的宽高比。
- `refresh`：忽略缓存重新拉取（含重建全国索引）。

失败语义：**没有匹配** → `throw`；某个命中**画不出来** → 该项 `svg: null` 并附 `notes`，不影响其余。

### 纯函数导出

`svgFileName`、`parseRatio` / `parseCenter` / `centerRatioViewBox`、`parsePolyline` / `toUnit` / `signedArea` / `centroid` / `pointInRing` / `simplify`、
`renderMap` / `wrapSvg`（`wrapSvg(output, meta?)` 第二个参数可选，给了就把 `meta` 的 JSON 内嵌成 `<metadata>`），以及 `AmapBoxOptions` / `AmapCache` / `AmapFetch` / `SpanOptions` / `LayoutOptions` /
`ColorOptions` / `MapMeta` / `MapSpan` / `PerfStats` / `RegionRef` / `MapRatio` / `CenterMode` / `GenerateResult` 等类型。

## CLI

```bash
npm install -g @kuriyona/amap-box   # 提供 amap-box 与 amap-box-review
amap-box <行政区名|adcode> [选项]
```

| 选项 | 含义 | 默认 |
|---|---|---|
| `--up <N\|max>` | 往上包含几级祖先（`max` = 一直到国家级） | `0` |
| `--down <0\|1>` | 往下细分几级（`0` = 只画目标自身） | `0` |
| `--chain` | 等价于 `--up max` | — |
| `--outside` | 拓展外部轮廓：把「最外层级」同级、视图内的其他行政区轮廓也画出（更细更淡，不往下细分） | — |
| `--outside-same-level` | 同时画出「与目标同层级」、视图内的区域（隐含 `--outside`；仅 `up<=1` 或目标为省级以上可用，否则报错） | — |
| `--ratio <auto\|W:H\|N>` | 画幅宽高比（`auto` = 按内容；如 `1`、`16:9`） | `auto` |
| `--padding <N>` | 内容四周留白（px） | `24` |
| `--no-title` | 不画标题 | — |
| `--no-context-labels` | 不画非目标节点（上下文）的标签 | — |
| `--no-target-label` | 不画目标节点自身的标签 | — |
| `--no-target-bg` | 不给目标节点所在区域填充背景高亮 | — |
| `--center [outline\|target\|N]` | 让目标居中：`outline` = 目标居中且整体轮廓完整；`target` = 目标占画幅长边 `0.5`；`N`（`0<N<=1`）= 目标占画幅长边比例（`target`/`N` 隐含 `--outside-same-level`） | — |
| `--out <dir>` | 输出目录 | `out` |
| `--cache <dir>` | 边界 + 索引缓存目录 | `districts` |
| `--refresh` | 忽略缓存重新拉取（含重建全国索引） | — |

Key 来源：环境变量 `AMAP_KEY`，或当前目录 `.env` 里的 `KEY=...`。
出图名一律 `[名称]-[adcode]-u<K>d<M>.svg`，写入 `--out`；`adcode` 天然唯一，重名与不同跨度都不会互相覆盖。

```bash
amap-box 杭州市                 # 默认 up0/down0：只有杭州市轮廓
amap-box 杭州市 --down 1        # 杭州市的 13 个区县
amap-box 杭州市 --up 1 --down 1 # 浙江省 11 市 + 杭州市 13 区县，轮廓 = 浙江省
amap-box 杭州市 --up max --down 1 # 34 省 + 11 市 + 13 区县，轮廓 = 国家级
amap-box 杭州市 --up 1 --down 1 --outside # 上面那张再补上视图内的相邻省份
amap-box 杭州市 --ratio 1 --no-title  # 1:1 画幅、不画标题（适合当图标/贴图）
amap-box 杭州市 --up 1 --center outline # 目标居中，且浙江省完整可见
amap-box 杭州市 --up 1 --center 0.5     # 目标居中并占画幅长边一半，同级相邻区域一并画出
amap-box 朝阳区                 # 同名多结果各出一张，靠 adcode 区分
bun src/cli/gen_svg.ts 杭州市   # 仓库内开发：直接跑源码，无需构建
```

Key 来源：环境变量 `AMAP_KEY`，或当前目录 `.env` 里的 `KEY=...`。
出图名一律 `[名称]-[adcode]-u<K>d<M>.svg`，写入 `--out`；`adcode` 天然唯一，重名与不同跨度都不会互相覆盖。
版式类选项（`ratio` / `padding` / `center` …）不体现在文件名里，同名同跨度会互相覆盖。

### 审阅页

```bash
amap-box-review                        # 默认 = 中国 / 浙江省 / 杭州市 / 临安区
amap-box-review 杭州市 上海市 朝阳区    # 指定目标（同名多结果会各出一张）
```

把一个目标的**全部跨度组合**（`up ∈ [0..d] × down ∈ {0,1} × outside ∈ {off,on}`，`outside` 变体文件名尾部加 `-o`）出一遍，汇成一个可在浏览器里逐张查看、
缩放平移、逐张写评语的页面（评语存 `localStorage`，可一键导出汇总文本）。产物 `review/` 与 `review.html`
都是可再生产物，随时可删。

## 层级模型

一共 4 级：**国家级(0) → 省级(1) → 地级(2) → 县级(3)**。目标是第 `d` 级。

```
绘制的级   ℓ ∈ [d-up+1, d+down]
整体轮廓   R(d-up)          // 本图最上层那个行政区
每级区块   R(ℓ-1) 的全部下级
```

- **往上只有目标那一条支线**：父级的同级会按整级画出来，但不再往下细分。
- **往下是全分支**：目标的每个下级各自再展开。
- **查询链高亮**：目标自身与图上画到的链路祖先，线更粗、不透明度拉满。
- **上下文分层**（始终生效，没有开关）：目标以外的节点按**图内相对层级**绘制 —— 整体轮廓最粗最亮、
  越浅的层级越粗越亮，仍只有目标（与图上画到的链路祖先）单独高亮。目标节点所在区域默认填充半透明背景高亮
  （`targetBackground`）。
- **标签**：非目标节点（`contextLabels`）与目标节点自身（`targetLabels`）的标签可分别开关，默认都画。
- **外部轮廓**（`outside`）：把最外层级 `R(d-up)` 同级、落在视图内的相邻区域也描一遍（更细更淡、无标签）；
  `R(d-up)` 已是国家级时没有同级。
- **目标同级外部轮廓**（`outsideSameLevel`）：再把**与目标同层级** `d`、落在视图内的区域也描一遍（样式同上）。
  先筛出视图内的「上一层」（`d-1` 级）元素，再取它们的第 `d` 级下级，避免整棵展开；仅 `up<=1` 或目标为省级以上可用。
- **目标居中**（`center`，默认不居中）：默认按内容包围盒居中。`"outline"`（= `true`）改为按**目标质心**居中，
  并保证最外层轮廓 `R(d-up)` 完整可见（目标偏居一角时留白较多）。数字占比（`"target"` = `0.5`）则按目标缩放取景：
  目标包围盒长边 = 比例 × 画幅可绘区长边、目标质心居中，上下文超出画幅即被裁掉，同级外部轮廓默认开启，
  `ratio` 决定取景框宽高比。
- **版式**：内容长边固定 `1000px`，留白 `padding`（默认 `24`），顶部标题带（`title: false` 时去掉）；
  `ratio` 只决定画布宽高比，给定时内容不重新缩放，居中后把多余空间补成留白。
- 线宽、字号都按图内相对层级统一推导。

## 缓存

库本身不碰 IO —— 所有缓存读写都走你注入的 `cache`。约定两类键：

- `"index"`：全国行政区划索引（国家 → 省 → 地 → 县 整棵树，约 4065 个节点，带 `center`、不含边界），
  首次运行一次请求拿到。
- `<adcode>`：单个行政区自身的边界（`subdistrict=0`）。

CLI 把键映射成 `<cache>/<adcode>.json` 与 `<cache>/index.json`。

各文件体量（JSON，实测**约**数，只作量级参考）：

| 键 | 约 | 说明 |
|---|---|---|
| `index` | **0.5 MB** | 全国索引，一次请求，始终存在 |
| `100000` | **3.4 MB** | 国家级边界，单个最大（原始 2302 个环） |
| 省级 `<xx0000>` | 0.3 – 1.0 MB | 如 北京市 0.32 MB、浙江省 0.71 MB、内蒙古 1.0 MB |
| 地级 `<xxyy00>` | 0.05 – 0.3 MB | 如 杭州市 0.13 MB |
| 县级 | 0.01 – 0.15 MB | 中位数约 0.07 MB |

整轮出图的累计量级：`杭州市 u0d0` ≈ 0.6 MB（索引 + 1 个地级）；`杭州市 u0d1` ≈ 1 MB；
`浙江省 u0d1` ≈ 2.5 MB；`中国 u0d1`（国家 + 34 省）≈ **20 MB**。跑完基准四目标 + 审阅页后
`districts/` 目录实测约 **41 MB**（260 个文件，另有已废弃的 `-tree.json` 约 4 MB，可随时删）。

## 数据来源与已知限制

数据来自高德 [行政区划查询 API](https://lbs.amap.com/api/webservice/guide/api/district)
（`restapi.amap.com/v3/config/district`，`extensions=all`）。以下均为实测结论：

- **子级 `polyline` 恒为空**：`subdistrict=1` 只给被查询那一级的边界，下级必须按 adcode 逐个再取 —— 请求量的主要来源。
- **乡镇 / 街道级不可绘制**：接口不返回边界，且其 adcode 与所属区县相同，无法单独查询；目标会退到所属区县并给出提示。
- **直辖市是三级**：真实树是 `北京市 → 北京城区(110100) → 各区`，所以北京的区目标 `d=3`。
- **`--down` 最多 1**：再往下是几千个区块、几千次请求（接口有 QPS 限制），不现实。
- **必须抽稀**：国家级边界原始 3.4 MB / 2302 个环；道格拉斯-普克抽稀（0.75px）与丢弃小于 2px² 的环是必需的，不是优化。
- **`outside` 会取回同级的全部候选**：要判断邻居是否在视图内，必须先拿到它们的边界，所以会额外拉「最外层级」同级的
  所有行政区（省级最多 34 个）；走缓存，第二次不再请求。
- 覆盖范围与字段以高德接口为准。

## 开发

```bash
bun install
bun run build      # tsdown -> dist/（ESM .mjs + CJS .cjs + .d.ts）
bun run test       # vitest
bun run typecheck  # tsc --noEmit
bun run gen --help # 等价 bun src/cli/gen_svg.ts --help
```

## License

MIT © Kuriyona
