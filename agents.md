# agents.md

高德行政区划 → SVG 深色线稿地图。产物 = **JS API（`@kuriyona/amap-box`）+ CLI**。

- 核心库（`src/`，TypeScript，无运行时依赖）：构造 `new AmapBox({ Key, fetch, cache })`，取数与缓存全部由调用方注入。
- 两个 CLI（`src/cli/`）：`gen_svg.ts` 出图，`review.ts` 出人工审阅页 —— 都只是库的一层壳。
- 打包：`tsdown`（ESM + CJS + `.d.ts`）；测试：`vitest`。

## 安装 / 构建 / 测试

```bash
bun install
bun run build      # -> dist/（index + cli，ESM/.mjs、CJS/.cjs、.d.ts/.d.cts/.d.mts）
bun run test       # vitest（tests/*.test.ts）
bun run typecheck  # tsc --noEmit
```

`package.json` 里 `bin` 为 `amap-box`（出图）与 `amap-box-review`（审阅页），`exports` 指向 `dist/`。
开发时直接用 Bun 跑源码，无需先构建：`bun src/cli/gen_svg.ts ...`。

## JS API

```ts
import { AmapBox } from "@kuriyona/amap-box";

const box = new AmapBox({
  Key: process.env.AMAP_KEY!,
  // 给定完整 URL（已含 key），返回**已解析**的响应对象
  fetch: (url) => fetch(url).then((r) => r.json()),
  // 键值缓存，值一律是字符串（键："index" 与各 <adcode>）
  cache: {
    read: (key) => storage[key] ?? null,
    write: (key, value) => { storage[key] = value; },
  },
});

const maps = await box.generate("杭州市", { up: 1, down: 1 });
for (const m of maps) writeFile(m.file, m.svg!); // m.svg 为 null 表示这张没画出来
```

- **构造参数**（对象形式，只有这三个）：`Key`（string）、`fetch`（`(url) => object`）、`cache`（`{ read(key), write(key, value) }`，read/write 允许同步或返回 Promise）。
- `resolve(keyword, refresh?)` → `{ regions, notes }`：名称/adcode → 命中的行政区（索引优先，未命中回落在线查询）。
- `generate(keyword, { up?, down?, outside?, outsideSameLevel?, ratio?, padding?, title?, contextLabels?, targetLabels?, targetBackground?, colors?, center?, refresh? })` → `GenerateResult[]`：每个命中一张图。
  - `up` 默认 `0`（`"max"` = 到国家级，超过目标深度会被夹到深度）；`down` 只允许 `0 | 1`，默认 `0`。
  - `outside` 默认 `false`：拓展外部轮廓，把「最外层级」（`R(d-up)`，如 杭州 u1 / 浙江 u0 都是浙江省）同级、
    落在当前视图内的其他行政区轮廓也画出来（更细更淡、不加标签、不往下细分、不改变缩放）。
  - `outsideSameLevel` 默认 `false`：把「与目标同层级」（第 `d` 级）、落在视图内的区域也作为外部轮廓画出；单独给出即隐含 `outside`。
    为控成本，先筛出视图内的「上一层」（第 `d-1` 级）元素，再取其第 `d` 级下级。**仅当 `up <= 1` 或目标为省级以上时可用**，否则 `generate` 抛出。
  - 版式：`ratio` 默认 `"auto"`（画幅宽高比，可给正数或 `"16:9"`；给定时内容按长边 1000px 缩放后居中，
    多余空间作为留白补到画布）、`padding` 默认 `24`（内容四周留白 px）、`title` 默认 `true`（是否画标题）。
  - 分层：目标以外的节点按**图内相对层级**绘制 —— 整体轮廓最粗最亮（`OUTLINE_STROKE = 2.8`），
    区块越浅的层级越粗越亮（每层距 `CTX_BAND_STEP = 0.2`，同级内面积微调 ≤ `0.75×层距`），目标单独高亮（`HOT_TARGET`）。始终生效，无开关。
    `targetBackground` 默认 `true` —— 给目标节点所在区域填充半透明背景高亮（目标落到整体轮廓上时填充轮廓区域）。
  - 标签：`contextLabels` 默认 `true`（非目标节点/上下文的标签）、`targetLabels` 默认 `true`（目标节点自身的标签），可分别关闭。
  - 配色：`colors` 默认无（用内置常量），可给 `{ background?, line?, targetFill? }` 覆盖其中任意几项 ——
    背景（默认 `#0d1117`）、线条与文字（默认 `#ffffff`）、目标背景高亮（默认 `#1f6feb`）；空串或非对象报错。
  - 目标居中：`center` 默认 `false`（内容包围盒居中）。`true` / `"outline"` = 目标质心居中，并保证最外层轮廓
    `R(d-up)` 完整可见（目标偏居轮廓一角时留白较多；目标即轮廓时与默认一致）；`"target"` = 占比模式默认 `0.5`；
    数字（`0 < N <= 1`）= 目标包围盒长边占画幅可绘区长边的比例，目标质心居中、上下文超出画幅即裁掉，
    并默认开启 `outsideSameLevel`（仅在其可用条件满足时）。
  - 每项：`query` / `landed`（实际落到的行政区）、`up` / `down`（解析后）、`file`（建议文件名）、`svg`（文本，失败为 `null`）、`blocks`、`outline`、`neighbors`（画出的外部轮廓区块数）、`notes`。
  - 找不到匹配 → `throw`；某一张画不出来 → 该项 `svg: null` + `notes` 说明，不中断其余。
  - 解析层提示（索引构建、匹配上限、限流重试）只挂在第一个结果上，避免多命中时重复。
- `ready(refresh?)`：只预热全国索引。
- 另有纯函数导出：`svgFileName`、`parsePolyline` / `toUnit` / `signedArea` / `centroid` / `pointInRing` / `simplify`、`renderMap` / `wrapSvg` / `parseRatio` / `parseCenter` / `centerRatioViewBox`。

## CLI 运行

```bash
bun src/cli/gen_svg.ts <行政区名|adcode> [--up N|max] [--down 0|1] [--outside] [--ratio auto|W:H|N] [--padding N] [--no-title] [--no-context-labels] [--no-target-label] [--no-target-bg] [--center outline|target|N] [--out <dir>] [--cache <dir>] [--refresh]
# 或装好之后：amap-box <行政区名|adcode> [选项]
```

- Key 来源：环境变量 `AMAP_KEY`，或仓库根目录 `.env` 里的 `KEY=...`
- 输出目录默认 `out/`，边界+索引缓存默认 `districts/`

| 选项 | 含义 | 默认 |
|---|---|---|
| `--up <N\|max>` | 往上包含几级祖先（`max` = 一直到国家级） | `0` |
| `--down <0\|1>` | 往下细分几级（`0` = 只画目标自身） | `0` |
| `--chain` | 等价于 `--up max` | — |
| `--outside` | 拓展外部轮廓：把「最外层级」同级、视图内的其他行政区轮廓也画出（更细更淡，不往下细分） | — |
| `--outside-same-level` | 同时把「与目标同层级」、视图内的区域也画出（隐含 `--outside`；仅 `up<=1` 或目标为省级以上可用，否则报错） | — |
| `--ratio <auto\|W:H\|N>` | 画幅宽高比（`auto` = 按内容；如 `1`、`16:9`） | `auto` |
| `--padding <N>` | 内容四周留白（px） | `24` |
| `--no-title` | 不画标题 | — |
| `--no-context-labels` | 不画非目标节点（上下文）的标签 | — |
| `--no-target-label` | 不画目标节点自身的标签 | — |
| `--no-target-bg` | 不给目标节点所在区域填充背景高亮 | — |
| `--center [outline\|target\|N]` | 让目标居中：`outline` = 目标居中且整体轮廓完整；`target` = 目标占画幅长边 `0.5`；`N`（`0<N<=1`）= 目标占画幅长边比例（`target`/`N` 隐含 `--outside-same-level`） | — |
| `--out` / `--cache` | 输出目录 / 边界+索引缓存目录 | `out` / `districts` |
| `--refresh` | 忽略缓存重新拉取（含重建全国索引） | — |

CLI 的磁盘缓存把键映射成 `<cache>/<key>.json`（键 `index` 与 `<adcode>`），与库内缓存布局一致。

## 全国索引（首次运行生成，之后查找只查它）

**首次运行时生成一份全国完整行政区划的元数据（不含边界，所以一个 API 调用就能完成），
后续查找只从这份索引里查，除非明确要求刷新。**

- 那一次请求就是 `keywords=100000&subdistrict=3&extensions=base` —— 国家 → 省 → 地 → 县 整棵树
  （约 4065 个节点 / 490 KB，带 `center`、不带 `polyline`），缓存到 `<cache>/index.json`。
- 名称匹配、adcode 解析、以及往上/往下的层级链（`buildChain` → `fetchTree`）全部只读索引，
  不再逐级请求：原来一张图要 4~5 次请求，现在 0 次。
- 匹配规则：纯数字按 adcode 精确；否则先精确同名、再子串匹配（真正连续的片段，如 `浙江` → `浙江省`；
  `中国` 这种不连续缩写靠回落在线查询）；与 AMap 一样最多取 20 个（`安` 这类会打印“只取前 20 个”）。
- 索引只到县级，所以查不到的名字（乡镇/街道级）才回落在线查询 —— `bun src/cli/gen_svg.ts 千岛湖镇` 仍然可用。
  `--refresh` 会把索引一起重建。
- 省直辖/兵团（东莞、济源、仙桃……）的下级街镇与上级**同 adcode**，索引扁平化时保留上层那个。

## 层级模型

一共 4 级：**国家级(0) → 省级(1) → 地级(2) → 县级(3)**。目标在第 `d` 级。

```
绘制的级   ℓ ∈ [d-up+1, d+down]
整体轮廓   R(d-up)          // 本图最上层那个行政区
每级区块   R(ℓ-1) 的全部下级
```

- **往上只有目标那一条支线**：父级的同级会按整级画出来，但不再往下细分
- **往下是全分支**：目标的每个下级各自再展开
- **查询链高亮**：目标自身 + 图上画到的链路祖先，线更粗、不透明度拉满 —— 一眼看出"当前指的是哪个"。
  目标 `HOT_TARGET = 3.6`、祖先 `HOT_ANCESTOR = 2.4`
- **上下文分层**（始终生效，无开关）：目标以外的节点按**图内相对层级**绘制 —— 整体轮廓最粗（`OUTLINE_STROKE = 2.8`）
  且最亮，区块越浅的层级越粗越亮，目标仍单独高亮（不把上下文全部白洗）。
  「目标节点」= 查询命中的那个行政区，它要么是某个区块（`up` 足够小时），要么就是整体轮廓本身（如 `u0d1`）
- **目标背景高亮**（`targetBackground`，默认 `true`）：给目标节点所在区域填 `TARGET_FILL = #1f6feb`、
  `opacity 0.22`；目标落到整体轮廓上时填轮廓区域。只是同一 `<path>` 的 `fill` 属性，**不额外增加 path**（区块计数不变）
- **标签开关**：`contextLabels`（非目标节点/上下文）、`targetLabels`（目标节点自身），默认都开
- 线宽按**图内相对层级**（最上层 = 0）：单层级区块按面积铺满 `0.8~2.2`（`MIN_STROKE`~`MAX_STROKE`）；
  多层叠图按相对层级分档（越浅越粗，每层距 `CTX_BAND_STEP = 0.2`，同级内面积微调不超过 `0.75×层距`），
  整体轮廓 `2.8`（始终高于任何区块；目标落到轮廓上时按边框 `3.6`）。
  不透明度：区块 `0.45` 起、每浅一级 `+0.1`，整体轮廓 `0.75` —— 均低于目标/祖先的 `1.0`
- 字号**同级统一**，由该级"水平/垂直距离最短的那一对"决定
- **外部轮廓**（`--outside` / `outside: true`）：把「最外层级」`R(d-up)` 同级的其他行政区中，**投影后与画布相交**
  （即落在当前视图内）的那些轮廓也画出来，线细（`1.0`）、淡（`opacity 0.3`）、不加标签，也不参与缩放与层级推导；
  相邻区域与本图最外层共享边界，所以探进视图的邻居会被自然裁到画布边缘，形成"更完整地图"的感觉。
  `R(d-up)` 已是国家级（如 中国、浙江 u1）时没有同级，无效果。
- **目标同级外部轮廓**（`--outside-same-level` / `outsideSameLevel`）：再把「与目标同层级」`d`、落在视图内的区域也描一遍
  （样式同外部轮廓）。为控成本，先筛出视图内的「上一层」（第 `d-1` 级）元素，再取其第 `d` 级下级（`up=1` 时「上一层」= 已取回的
  「最外层同级」候选；`up=0` 时最外层同级已覆盖目标同级，去重后为空）。**仅当 `up <= 1` 或目标为省级以上可用**，否则报错。
- **目标居中**（`--center` / `center`，默认不居中）：默认按内容包围盒居中。`outline`（= `true`）改为按**目标质心**居中，
  并保证最外层轮廓 `R(d-up)` 完整可见（取以目标中心为中心、含轮廓的对称方框；目标偏居轮廓一角时留白较多，
  目标即轮廓时与默认一致）。数字占比（`target` = `0.5`）则按目标缩放取景：目标包围盒长边 = 比例 × 画幅可绘区长边，
  目标质心居中，上下文超出画幅即被裁掉；此时 `outsideSameLevel` 默认开启（在其可用条件满足时），`ratio` 决定取景框（可绘区）宽高比。
- **版式**：内容长边固定缩放到 `MAP_LONG = 1000px`，四周留白 `padding`（默认 `24`），顶部标题带 `CAPTION_H = 46`
  （`title: false` 时标题与标题带一起去掉）；`ratio`（默认 `"auto"`）只决定画布宽高比 —— 给定时内容**不重新缩放**，
  居中后把多余空间补成留白，所以 `auto` 与任何比例下内容的实际尺寸一致。

组合示例（目标 = 杭州市，d=2）：

| 参数 | 画什么 |
|---|---|
| `--up 0 --down 0` | 只有杭州市轮廓（默认） |
| `--up 0 --down 1` | 杭州市的 13 个区县 |
| `--up 1 --down 1` | 浙江省 11 个地级市 + 杭州市 13 个区县，轮廓 = 浙江省 |
| `--up max --down 1` | 34 省 + 11 市 + 13 区县，轮廓 = 国家级 |

## 输出命名

一律 `[名称]-[adcode]-u<K>d<M>.svg`。`adcode` 天然唯一，同名多结果与不同跨度都不会互相覆盖。库只给 `file` 字段，落盘与否交给调用方。

`[名称]-[adcode]` 取**实际落到的那个行政区**，不是查询词本身 —— 街道/乡镇级目标会退到所属区县，例如 `bun src/cli/gen_svg.ts 千岛湖镇` 产出 `淳安县-330127-u0d0.svg`（同时打印提示）。

## 基准测试数据

改动后**先用这 4 个目标跑一遍**：它们正好一一对应 4 个层级。

| 目标 | 级别 | `d` | 默认 `u0d0` | `--down 1`（`u0d1`） | `--up max --down 1` |
|---|---|---|---|---|---|
| 中国 | 国家级 | 0 | `中华人民共和国-100000-u0d0.svg`（1 / 1） | `…-u0d1.svg`（34 / 31） | 同 `u0d1`（up 已到顶） |
| 浙江省 | 省级 | 1 | `浙江省-330000-u0d0.svg`（1 / 1） | `…-u0d1.svg`（12 / 11） | `…-u1d1.svg`（45 / 31） |
| 杭州市 | 地级 | 2 | `杭州市-330100-u0d0.svg`（1 / 1） | `…-u0d1.svg`（14 / 13） | `…-u2d1.svg`（58 / 31） |
| 临安区 | 县级 | 3 | `临安区-330112-u0d0.svg`（1 / 1） | `…-u0d1.svg`（1 / 1） | `…-u3d1.svg`（58 / 31） |

（区块数 = SVG 里 `<path>` 个数，含整体轮廓那一条；标签数 = `<text text-anchor="middle">` 个数。）

## 验证步骤

```bash
bun run test        # 单元测试：几何 / 渲染 / AmapBox（假 fetch + 内存缓存）

rm -rf out
for r in 中国 浙江省 杭州市 临安区; do bun src/cli/gen_svg.ts "$r"; done           # 默认 up0/down0
for r in 中国 浙江省 杭州市 临安区; do bun src/cli/gen_svg.ts "$r" --down 1; done  # 基线
bun src/cli/gen_svg.ts 浙江省 --up max --down 1
bun src/cli/gen_svg.ts 杭州市  --up 1 --down 1
```

断言（XML 合法 + 区块/标签数）：

```bash
python - <<'EOF'
import glob, os, xml.etree.ElementTree as ET
ns = '{http://www.w3.org/2000/svg}'
want = {
    '中华人民共和国-100000-u0d0.svg': (1, 1),
    '浙江省-330000-u0d0.svg':         (1, 1),
    '杭州市-330100-u0d0.svg':         (1, 1),
    '临安区-330112-u0d0.svg':         (1, 1),
    '中华人民共和国-100000-u0d1.svg': (34, 31),
    '浙江省-330000-u0d1.svg':         (12, 11),
    '杭州市-330100-u0d1.svg':         (14, 13),
    '临安区-330112-u0d1.svg':         (1, 1),
}
for name, (nb, nl) in want.items():
    r = ET.parse(os.path.join('out', name)).getroot()
    got = (len(r.findall('.//' + ns + 'path')),
           len([t for t in r.findall('.//' + ns + 'text') if t.get('text-anchor') == 'middle']))
    print(('OK  ' if got == (nb, nl) else 'FAIL'), name, got)
EOF
```

最后一步 —— 出审阅页，人工过一遍全部跨度组合（见「审阅」一节）：

```bash
bun src/cli/review.ts   # -> review/ 40 张 + review.html，浏览器打开逐个看/写评语
```

必须覆盖到的边界行为：

- `--up 5`（超过目标深度）→ 打印警告并把 `up` 夹到 `d`
- `--down 2` → 报错退出（`--down` 只允许 0/1）
- `bun src/cli/gen_svg.ts 朝阳区` → 两个同名结果各出一张，靠 adcode 区分
- 县级目标 `--down 1` → 打印"下级是乡镇/街道级……这一层不画"，退化为只画自身轮廓
- 不存在的名字 → `没有匹配「…」的行政区`，退出码 1

## 审阅（`src/cli/review.ts`）

正式流程的最后一步：把一个目标的**全部跨度组合**出一遍，汇成一张可以在浏览器里逐张看、逐张写评语的页面。

```bash
bun src/cli/review.ts                       # 默认 = 基准四个层级：中国/浙江省/杭州市/临安区
bun src/cli/review.ts 杭州市 上海市 朝阳区    # 指定目标（同名多结果会各出一张）
bun src/cli/review.ts --out review --html review.html --cache districts --refresh
```

- 每个目标先跑一次 `up=max` 探出它在地级树里的深度 `d`（`up` 会被夹到 `d`，文件名里的 `u<K>` 就是它），
  再展开 `up ∈ [0..d] × down ∈ {0,1} × outside ∈ {off,on}`。4 个基准目标 = 4+8+12+16 = **40 张**
  （`outside` 变体文件名尾部加 `-o`，不影响库的命名规则）。
- 出图一律**走 `AmapBox` 本身**，所以缓存/索引/命名与正式出图完全一致，没有第二套逻辑。
- 产物：`<out>/<名称>-<adcode>-u<K>d<M>[-o].svg` + `<html>`（引用式页面，图片指向 `<out>`，HTML 本身只有 ~23 KB）。
- 页面操作：左侧列表点选（`↑`/`↓` 也行）→ 滚轮缩放（改 `<img>` 尺寸的矢量重绘，放到任意倍数都不糊）、
  拖动平移、双击或「适应窗口」复位，另有 `1:1` / `＋` / `－`；每张一个评语框，写进 `localStorage`
  （刷新不丢，`✓ 没问题` 一键填）；「生成返回文本」把全部评语汇成一段自带上下文（目标、跨度、命令、
  文件名、区块/标签数、生成提示）的文本，可复制或存 `.txt`，直接贴回来即可。
- 页面会标出**逐字节相同**的组合（如县级目标 `down=1` 退化为只画自身、`outside` 无同级可补时与不启用一致）与生成时的提示。
- `review/` 与 `review.html` 都是可再生产物，随时可删；只有线宽之类不影响计数时，重跑 40 张图后
  刷新页面即可（评语仍在），不必重新生成页面。


## 数据来源与已知限制

数据来自 `restapi.amap.com/v3/config/district`（`extensions=all`）。以下都是实测结论，改动时不要想当然：

- **子级 `polyline` 恒为空**：`subdistrict=1` 只给被查询那一级的边界，下级必须按 adcode 逐个再取。这是请求量的主要来源。
- **乡镇/街道级不可绘制**：接口不返回边界，且其 adcode 与所属区县**相同**，无法单独查询。`DRAWABLE` 只放行 `province` / `city` / `district`。
- **直辖市是三级**：AMap 的真实树是 `北京市 → 北京城区(110100) → 各区`，所以北京的区目标 `d=3`，`--up max` 会带出 `北京城区` 这一级。
- **目标可能对不上自身节点**：个别行政区（如 `711113 西湖乡`）在层级树里匹配不到，会退到实际落到的那个行政区（`花莲县`）并打印提示。
- **`--down` 最多 1**：再往下是几千个区块、几千次请求（接口 QPS 有限，超了返回 `CUQPS_HAS_EXCEEDED_THE_LIMIT`），不现实。
- **`--outside` 会取回同级的全部候选**：要判断邻居是否落在视图内，必须先拿到它们的边界，所以会额外拉「最外层级」
  同级的所有行政区（省级最多 34 个）；走缓存，第二次不再请求。
- **必须抽稀**：国家级边界原始 3.4MB / 2302 个环，34 个省级合计约 15MB。`simplify()`（道格拉斯-普克，0.75px）+ 丢弃小于 2px² 的环是必需的，不是优化。
- **缓存**：`districts/index.json`（全国索引，首次运行一次请求拿到，见上）+ `districts/<adcode>.json`
  （该区块自身边界，`subdistrict=0`）。`-tree.json` 已废弃 —— 层级链改由索引回答。
  首次全新目标只需拉目标那几级的边界，`--refresh` 强制重取。

## 代码结构

| 位置 | 作用 |
|---|---|
| `src/types.ts` | 公共类型：`AmapBoxOptions` / `AmapFetch` / `AmapCache` / `SpanOptions` / `GenerateResult` … |
| `src/amap-box.ts` | `AmapBox` 类：API 取数（`apiQuery` + 限流退避）、缓存读写、全国索引、`resolve` / `generate`；`svgFileName` |
| `src/geometry.ts` | 纯几何：`parsePolyline` / `toUnit` / `signedArea` / `centroid` / `pointInRing` / `simplify` |
| `src/render.ts` | `renderMap`（投影 → 抽稀 → 分层线宽 → 同级统一字号 → 版式/画幅 → 拼 SVG）与 `wrapSvg`、`parseRatio` |
| `src/index.ts` | 公共导出入口 |
| `src/cli/common.ts` | CLI 共用：`loadKey` / `diskCache` / `nodeFetch` |
| `src/cli/gen_svg.ts` | 出图 CLI（解析跨度参数、写文件） |
| `src/cli/review.ts` | 审阅页 CLI（`gen` → 写 `<out>` → 拼页面） |
| `src/cli/review-page.ts` | 审阅页 HTML 模板 |
| `tests/*.test.ts` | vitest：几何、渲染、`AmapBox`（假 fetch + 内存缓存） |

`AmapBox` 内部方法（原 CLI 里的同名函数）：`apiQuery`（单次请求 + 限流退避重试，非限流错误立即返回）、
`fetchRegion`（带缓存的区块边界 —— 唯一还会打接口的取数路径）、`ensureIndex`（读/重建全国索引并扁平化成
`byAdcode` / `allNodes`）、`searchIndex`（索引内名称/adcode 匹配，上限 20）、`fetchTree`、`buildChain`
（顺索引树从 `100000` 逐级下降）、`onPath`（adcode 去尾零当前缀），以及每个命中一张的 `renderOne`。
