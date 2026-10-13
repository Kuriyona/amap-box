/** 审阅页 HTML 模板（引用式：图片指向 `<out>`）。 */

export interface PageItem {
  id: string;
  k: string;
  file: string;
  paths: number;
  labels: number;
  cmd: string;
  warn: string[];
  landed: string;
  same?: string;
}

export interface PageGroup {
  name: string;
  adcode: string;
  d: number;
  items: PageItem[];
}

export function renderReviewPage({
  total,
  outDir,
  groups,
}: {
  total: number;
  outDir: string;
  groups: PageGroup[];
}): string {
  const page = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>SVG 审阅 · 全层级组合（__TOTAL__ 张）</title>
<style>
:root{--bg:#010409;--pan:#0d1117;--fg:#e6edf3;--dim:#8b949e;--line:#30363d;--acc:#58a6ff;--ok:#3fb950;--warn:#d29922}
*{box-sizing:border-box}
html,body{margin:0;height:100%;overflow:hidden;background:var(--bg);color:var(--fg);
  font:13px/1.55 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
button{font:inherit;color:var(--fg);background:#21262d;border:1px solid var(--line);border-radius:6px;
  padding:5px 10px;cursor:pointer}
button:hover{background:#30363d;border-color:#8b949e}
#app{display:flex;height:100%}
aside{flex:0 0 296px;display:flex;flex-direction:column;background:var(--pan);border-right:1px solid var(--line)}
aside h1{margin:0;padding:11px 14px;font-size:13px;font-weight:600;border-bottom:1px solid var(--line)}
aside h1 span{float:right;color:var(--dim);font-weight:400}
#list{flex:1;overflow:auto;padding:4px 0 12px}
.grp{padding:9px 14px 3px;color:var(--dim);font-size:11px;letter-spacing:.4px}
.it{padding:5px 14px;cursor:pointer;border-left:2px solid transparent;display:flex;gap:8px;align-items:baseline}
.it:hover{background:#161b22}
.it.on{background:#1f6feb26;border-left-color:var(--acc)}
.it .k{font-weight:600;min-width:46px;font-variant-numeric:tabular-nums}
.it.done .k::after{content:" ✓";color:var(--ok)}
.it .m{color:var(--dim);font-size:11px}
.foot{padding:10px 14px;border-top:1px solid var(--line);display:flex;gap:8px}
.foot button{flex:1}
main{flex:1;display:flex;flex-direction:column;min-width:0}
#bar{display:flex;align-items:center;gap:12px;padding:8px 14px;border-bottom:1px solid var(--line);background:var(--pan)}
#cap{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#cap b{font-weight:600}
#cap code{color:var(--dim);font-size:11px}
#tools{display:flex;gap:6px;flex:0 0 auto}
#view{position:relative;flex:1;overflow:hidden;cursor:grab;background:var(--bg);
  background-image:linear-gradient(#161b2233 1px,transparent 1px),linear-gradient(90deg,#161b2233 1px,transparent 1px);
  background-size:32px 32px,32px 32px}
#view.drag{cursor:grabbing}
#stage{position:absolute;left:0;top:0}
#stage img{display:block;box-shadow:0 0 0 1px #30363d}
#zoom{position:absolute;right:10px;bottom:10px;color:var(--dim);font-size:11px;background:#0d1117cc;
  padding:2px 7px;border-radius:5px;pointer-events:none}
#panel{border-top:1px solid var(--line);padding:9px 14px 12px;background:var(--pan)}
.row{display:flex;align-items:center;gap:10px;margin-bottom:7px}
.row label{color:var(--dim)}
#cmt{width:100%;height:74px;resize:vertical;background:#010409;color:var(--fg);border:1px solid var(--line);
  border-radius:6px;padding:8px 10px;font:inherit}
#cmt:focus{outline:none;border-color:var(--acc)}
#warn{color:var(--warn);font-size:11.5px;margin-top:6px;white-space:pre-wrap}
#warn:empty{display:none}
#modal{position:fixed;inset:0;background:#010409cc;display:flex;align-items:center;justify-content:center;padding:5vh 6vw}
#modal[hidden]{display:none}
#modal .box{background:var(--pan);border:1px solid var(--line);border-radius:10px;padding:16px;
  width:min(900px,90vw);display:flex;flex-direction:column;gap:10px}
#modal h2{margin:0;font-size:14px}
#out{width:100%;height:56vh;background:#010409;color:var(--fg);border:1px solid var(--line);border-radius:6px;
  padding:10px;font:12px/1.5 ui-monospace,Consolas,monospace;white-space:pre;overflow:auto}
#modal .b{display:flex;gap:8px;justify-content:flex-end}
</style>
</head>
<body>
<div id="app">
  <aside>
    <h1>审阅 __TOTAL__ 个组合<span id="prog">0/__TOTAL__</span></h1>
    <div id="list"></div>
    <div class="foot">
      <button id="export">生成返回文本</button>
      <button id="clear">清空评语</button>
    </div>
  </aside>
  <main>
    <div id="bar">
      <div id="cap"></div>
      <div id="tools">
        <button data-z="fit">适应窗口</button>
        <button data-z="1">1:1</button>
        <button data-z="in">＋</button>
        <button data-z="out">－</button>
      </div>
    </div>
    <div id="view"><div id="stage"></div><div id="zoom"></div></div>
    <div id="panel">
      <div class="row">
        <label for="cmt">这张的评价：</label>
        <button id="fine">✓ 没问题</button>
        <span id="who" style="color:var(--dim)"></span>
      </div>
      <textarea id="cmt" placeholder="有问题就写：哪里不对、期望什么。没问题可以直接点「✓ 没问题」。"></textarea>
      <div id="warn"></div>
    </div>
  </main>
</div>
<div id="modal" hidden><div class="box">
  <h2>把下面这段发回给我</h2>
  <textarea id="out" readonly></textarea>
  <div class="b"><button id="copy">复制</button><button id="dl">下载 .txt</button><button id="close">关闭</button></div>
</div></div>
<script>
const GROUPS = __DATA__;
const OUT = "__OUT__";
const ITEMS = GROUPS.flatMap((g) => g.items);
const STORE = "amap-svg-review-v1";
const $ = (s) => document.querySelector(s);
const list = $("#list"), stage = $("#stage"), view = $("#view"), cmt = $("#cmt");
let cur = ITEMS[0].id, vx = 0, vy = 0, vk = 1, drag = null;
let text = {};
try { text = JSON.parse(localStorage.getItem(STORE) || "{}") || {}; } catch {}
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(text)); } catch {} };
const item = (id) => ITEMS.find((i) => i.id === id);
const done = (id) => !!(text[id] || "").trim();

for (const g of GROUPS) {
  const t = document.createElement("div");
  t.className = "grp";
  t.textContent = g.name + "（d=" + g.d + "，共 " + g.items.length + " 张）";
  list.append(t);
  for (const it of g.items) {
    const d = document.createElement("div");
    d.className = "it";
    d.dataset.id = it.id;
    d.innerHTML = '<span class="k"></span><span class="m"></span>';
    d.querySelector(".k").textContent = it.k;
    d.querySelector(".m").textContent = it.paths + " 区块 / " + it.labels + " 标签";
    d.onclick = () => show(it.id);
    list.append(d);
  }
}

function paint() {
  let n = 0;
  for (const it of ITEMS) {
    const el = list.querySelector('[data-id="' + it.id + '"]');
    const ok = done(it.id);
    if (ok) n++;
    el.classList.toggle("on", it.id === cur);
    el.classList.toggle("done", ok);
  }
  $("#prog").textContent = n + "/" + ITEMS.length;
}

function apply() {
  // 缩放改 <img> 自身的 width/height（矢量重绘，永远清晰）；transform 只负责平移，
  // 否则合成层只把位图放大 -> 糊。
  const it = item(cur), img = stage.firstElementChild;
  if (img && it.W) {
    img.style.width = it.W * vk + "px";
    img.style.height = it.H * vk + "px";
  }
  stage.style.transform = "translate(" + vx + "px," + vy + "px)";
  $("#zoom").textContent = "缩放 " + (vk * 100).toFixed(0) + "%";
}
function fit() {
  const it = item(cur), r = view.getBoundingClientRect();
  if (!it.W) return;
  vk = Math.min((r.width - 28) / it.W, (r.height - 28) / it.H);
  vx = (r.width - it.W * vk) / 2;
  vy = (r.height - it.H * vk) / 2;
  apply();
}
function zoomAt(cx, cy, k) {
  if (!item(cur).W) return;
  const nk = Math.max(0.05, Math.min(40, vk * k));
  vx = cx - (cx - vx) * (nk / vk);
  vy = cy - (cy - vy) * (nk / vk);
  vk = nk;
  apply();
}

function show(id) {
  cur = id;
  const it = item(id);
  const g = GROUPS.find((x) => x.items.some((i) => i.id === id));
  const img = document.createElement("img");
  img.alt = it.file;
  img.onload = () => { it.W = img.naturalWidth; it.H = img.naturalHeight; fit(); };
  img.onerror = () => { it.W = 1000; it.H = 700; fit(); };
  img.src = OUT + "/" + it.file;
  stage.replaceChildren(img);
  $("#cap").innerHTML = "<b>" + g.name + "</b> · " + it.k + " · <code>" + it.cmd + "</code> · " + it.file +
    (it.landed !== g.name ? " · 落到 " + it.landed : "") +
    (it.same ? ' · <span style="color:var(--warn)">与 ' + it.same + " 输出完全相同</span>" : "");
  $("#who").textContent = it.file;
  $("#warn").textContent = it.warn.length ? "生成时提示：\\n" + it.warn.join("\\n") : "";
  cmt.value = text[id] || "";
  fit();
  paint();
}

cmt.oninput = () => { text[cur] = cmt.value; save(); paint(); };
$("#fine").onclick = () => { text[cur] = "没问题"; cmt.value = "没问题"; save(); paint(); };
view.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = view.getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
}, { passive: false });
view.addEventListener("pointerdown", (e) => {
  drag = { x: e.clientX, y: e.clientY };
  view.classList.add("drag");
  view.setPointerCapture(e.pointerId);
});
view.addEventListener("pointermove", (e) => {
  if (!drag) return;
  vx += e.clientX - drag.x;
  vy += e.clientY - drag.y;
  drag = { x: e.clientX, y: e.clientY };
  apply();
});
view.addEventListener("pointerup", (e) => { drag = null; view.classList.remove("drag"); view.releasePointerCapture(e.pointerId); });
view.addEventListener("dblclick", fit);
$("#tools").onclick = (e) => {
  const z = e.target.dataset.z;
  if (!z) return;
  const r = view.getBoundingClientRect();
  if (z === "fit") fit();
  else if (z === "1") { vk = 1; vx = (r.width - item(cur).W) / 2; vy = (r.height - item(cur).H) / 2; apply(); }
  else zoomAt(r.width / 2, r.height / 2, z === "in" ? 1.25 : 0.8);
};
$("#clear").onclick = () => {
  if (!confirm("清空全部评语？")) return;
  text = {};
  save();
  cmt.value = "";
  paint();
};
$("#export").onclick = () => {
  const L = [];
  const n = ITEMS.filter((i) => done(i.id)).length;
  L.push("SVG 审阅反馈");
  L.push("共 " + ITEMS.length + " 张，已评价 " + n + " 张，未评价 " + (ITEMS.length - n) + " 张");
  L.push("");
  for (const g of GROUPS) {
    L.push("## " + g.name + "（" + g.adcode + "，d=" + g.d + "）");
    for (const it of g.items) {
      L.push("- " + it.k + "  " + it.file + "  （" + it.paths + " 区块 / " + it.labels + " 标签）" +
        (it.landed !== g.name ? "  落到 " + it.landed : ""));
      if (it.same) L.push("    注：与 " + it.same + " 输出完全相同（down=1 时下级不可绘制，退化为只画自身）");
      for (const w of it.warn) L.push("    提示：" + w);
      const t = (text[it.id] || "").trim();
      L.push("    评价：" + (t ? t.replace(/\\n/g, "\\n    ") : "（未评价）"));
    }
    L.push("");
  }
  L.push("");
  $("#out").value = L.join("\\n");
  $("#modal").hidden = false;
};
$("#close").onclick = () => { $("#modal").hidden = true; };
$("#copy").onclick = async () => {
  const t = $("#out").value;
  try { await navigator.clipboard.writeText(t); } catch { $("#out").select(); document.execCommand("copy"); }
  $("#copy").textContent = "已复制";
  setTimeout(() => { $("#copy").textContent = "复制"; }, 1200);
};
$("#dl").onclick = () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([$("#out").value], { type: "text/plain;charset=utf-8" }));
  a.download = "svg-review.txt";
  a.click();
  URL.revokeObjectURL(a.href);
};
addEventListener("resize", fit);
addEventListener("keydown", (e) => {
  const i = ITEMS.findIndex((x) => x.id === cur);
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  show(ITEMS[Math.max(0, Math.min(ITEMS.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))].id);
});
show(ITEMS[0].id);
</script>
</body>
</html>`;
  return page
    .split("__TOTAL__")
    .join(String(total))
    .split("__OUT__")
    .join(outDir)
    .split("__DATA__")
    .join(JSON.stringify(groups));
}
