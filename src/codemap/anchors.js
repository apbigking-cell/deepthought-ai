// 锚点规范 —— CodeMap 的 md 文档用 HTML 注释锚点界定可精准操作的区块。
// 锚点在 markdown 渲染中不可见，不破坏文档结构，且便于正则定位。
//
// 区块类型：
//   <!-- @node id=<id> kind=<kind> hash=<hash> ... --> ... <!-- @/node id=<id> -->
//   <!-- @edges id=<id> --> ```mermaid ... ``` (属于某个 node 的连线，写在 node 内部)
//   <!-- @meta key=val ... -->                  (单行元信息，无闭合)
//   <!-- @overview --> ```mermaid ... ``` <!-- @/overview -->  (总览连线块)
//
// 设计要点：
// - id 可含 / . : 等路径字符，用空白分隔属性，value 不含空格（路径用 / 不含空格）
// - 字段统一写成 markdown 列表行 `- key: value`，便于按字段精准 patch

export const ANCHOR = {
  nodeOpen: (attrs) => `<!-- @node ${serializeAttrs(attrs)} -->`,
  nodeClose: (id) => `<!-- @/node id=${id} -->`,
  edgesOpen: (id) => `<!-- @edges id=${id} -->`,
  overviewOpen: () => `<!-- @overview -->`,
  overviewClose: () => `<!-- @/overview -->`,
  meta: (attrs) => `<!-- @meta ${serializeAttrs(attrs)} -->`,
};

// 正则（带 g 标志的在使用处重建，避免 lastIndex 复用问题）
export const RE = {
  nodeOpen: /<!--\s*@node\s+([^>]*?)\s*-->/,
  nodeClose: /<!--\s*@\/node\s+id=(\S+)\s*-->/,
  edgesOpen: /<!--\s*@edges\s+id=(\S+)\s*-->/,
  meta: /<!--\s*@meta\s+([^>]*?)\s*-->/,
  overviewOpen: /<!--\s*@overview\s*-->/,
  overviewClose: /<!--\s*@\/overview\s*-->/,
};

// 把 {id, kind, hash} 序列化为 `id=x kind=y hash=z`（保持稳定顺序）
export function serializeAttrs(attrs = {}) {
  const order = ['id', 'kind', 'hash'];
  const keys = [...order.filter(k => k in attrs), ...Object.keys(attrs).filter(k => !order.includes(k))];
  return keys
    .filter(k => attrs[k] !== undefined && attrs[k] !== null && attrs[k] !== '')
    .map(k => `${k}=${sanitizeVal(attrs[k])}`)
    .join(' ');
}

// 解析 `id=x kind=y hash=z` → 对象
export function parseAttrs(str = '') {
  const out = {};
  const re = /(\w+)=(\S+)/g;
  let m;
  while ((m = re.exec(str)) !== null) out[m[1]] = m[2];
  return out;
}

// 属性值不能含空格/换行/尖括号（保持锚点单行可解析）
function sanitizeVal(v) {
  return String(v).replace(/[\s<>]+/g, '_');
}

// 字段行：`- key: value`
export const FIELD_RE = /^- (\w[\w-]*): ?(.*)$/;

export function fieldLine(key, value) {
  return `- ${key}: ${value ?? ''}`;
}

// 生成稳定的短哈希（用于判断节点内容是否变化，避免无谓重写）
export function shortHash(str = '') {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36).slice(0, 8);
}
