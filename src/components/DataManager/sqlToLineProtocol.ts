/**
 * 把类 SQL 写法转换成 InfluxDB Line Protocol，供 /write 端点使用。
 *
 * 支持语法（每行一条）：
 *   INSERT INTO measurement(tag1=v1, tag2=v2) field1=v1, field2=v2 [timestamp]
 *
 * 规则：
 * - `measurement(tags)` 里的 tag：标签键=值（字符串无需引号，含空格/特殊字符用反斜杠或双引号）
 * - 括号外的 `field=value`：字段；一个或多个，逗号分隔
 * - 末尾可选时间戳（数字，纳秒/毫秒等，由 epoch 决定，默认不传用服务端时间）
 * - `--` 或 `#` 开头为注释，整行忽略
 * - 大小写不敏感识别 INSERT INTO
 *
 * 示例：
 *   INSERT INTO cpu(host=s1, region=us) value=0.64, temp=45
 *   INSERT INTO temperature(sensor=s1) value=23.5 1700000000000000000
 *   INSERT INTO log(level=info) msg="hello world"
 *
 * 转换结果：
 *   cpu,host=s1,region=us value=0.64,temp=45
 *   temperature,sensor=s1 value=23.5 1700000000000000000
 *   log,level=info msg="hello world"
 */

export interface ConvertResult {
  /** 转换出的 Line Protocol 行（成功项） */
  lines: string[];
  /** 转换失败的项：行号 + 原文 + 原因 */
  errors: { lineNo: number; raw: string; reason: string }[];
}

/** 转义 Line Protocol 中的 tag key/value（不含逗号、等号、空格） */
function escapeTag(s: string): string {
  return s.replace(/([,=\s])/g, '\\$1');
}
/** 转义 field key */
function escapeFieldKey(s: string): string {
  return s.replace(/([,\s])/g, '\\$1');
}

/**
 * 解析单个字段值，判断字符串/数字/布尔，输出 Line Protocol 形态。
 * 字符串字段需要加双引号；数字不加；布尔输出 true/false。
 */
function formatFieldValue(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  // 双引号包裹的字符串
  if (/^".*"$/.test(v)) {
    // 转义内部双引号
    const inner = v.slice(1, -1).replace(/"/g, '\\"');
    return `"${inner}"`;
  }
  // 单引号包裹 → 转成双引号字符串
  if (/^'.*'$/.test(v)) {
    const inner = v.slice(1, -1).replace(/"/g, '\\"');
    return `"${inner}"`;
  }
  // 布尔
  if (/^(true|false|t|f|T|F)$/i.test(v)) {
    return /^(t|true|T)$/i.test(v) ? 'true' : 'false';
  }
  // 数字（含科学计数、负号、小数）
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v)) {
    return v;
  }
  // 整数型标记（i 结尾）
  if (/^[+-]?\d+i$/.test(v)) {
    return v;
  }
  // 裸字符串（无引号）→ 当作字符串字段，补双引号
  return `"${v.replace(/"/g, '\\"')}"`;
}

/**
 * 从括号内容里提取 key=value 对（支持值含等号、逗号需转义；简化处理）。
 * 输入形如 "host=s1, region=us"，返回 [["host","s1"],["region","us"]]
 */
function parsePairs(inner: string): [string, string][] {
  const pairs: [string, string][] = [];
  // 按逗号拆分，但跳过转义的逗号（简化：不处理转义逗号，InfluxQL 写法通常不需要）
  const parts = inner.split(',');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) pairs.push([k, v]);
  }
  return pairs;
}

/** 转换单行类 SQL 为 Line Protocol，失败返回 null + 原因 */
function convertLine(rawLine: string): { ok: true; line: string } | { ok: false; reason: string } {
  const sql = rawLine.trim();
  // 去掉行尾分号
  const m = sql.match(/^\s*INSERT\s+INTO\s+(.+)$/i);
  if (!m) return { ok: false, reason: '需以 INSERT INTO 开头' };

  let rest = m[1].trim();
  // 解析 measurement 名（可能含括号 tags）
  // 两种情况：name(tags) fields...  或  name fields...
  let measurement = '';
  let tagPairs: [string, string][] = [];
  let afterName = '';

  const parenIdx = rest.indexOf('(');
  if (parenIdx > 0) {
    // name(tags) ...
    measurement = rest.slice(0, parenIdx).trim();
    const closeParen = rest.indexOf(')', parenIdx);
    if (closeParen < 0) return { ok: false, reason: '括号未闭合' };
    const tagInner = rest.slice(parenIdx + 1, closeParen);
    tagPairs = parsePairs(tagInner);
    afterName = rest.slice(closeParen + 1).trim();
  } else {
    // name 后跟空格再是 fields
    const sp = rest.search(/\s/);
    if (sp < 0) return { ok: false, reason: '缺少字段' };
    measurement = rest.slice(0, sp).trim();
    afterName = rest.slice(sp + 1).trim();
  }

  if (!measurement) return { ok: false, reason: '缺少 measurement 名' };
  if (!afterName) return { ok: false, reason: '缺少字段' };

  // afterName 形如 "f1=v1, f2=v2 [timestamp]"
  // 时间戳：末尾独立的纯数字 token
  let fieldsPart = afterName;
  let timestamp = '';
  const tsMatch = fieldsPart.match(/\s+(\d{10,})$/);
  if (tsMatch) {
    timestamp = tsMatch[1];
    fieldsPart = fieldsPart.slice(0, tsMatch.index).trim();
  }

  // 解析字段
  const fieldPairs = parsePairs(fieldsPart);
  if (fieldPairs.length === 0) return { ok: false, reason: '字段解析失败（需 field=value）' };

  const fieldParts: string[] = [];
  for (const [k, v] of fieldPairs) {
    const fv = formatFieldValue(v);
    if (fv === null) return { ok: false, reason: `字段 ${k} 的值无效` };
    fieldParts.push(`${escapeFieldKey(k)}=${fv}`);
  }

  // 组装 Line Protocol
  const tagStr = tagPairs.length
    ? ',' + tagPairs.map(([k, v]) => `${escapeTag(k)}=${escapeTag(v)}`).join(',')
    : '';
  const fieldStr = fieldParts.join(',');
  return { ok: true, line: `${measurement}${tagStr} ${fieldStr}${timestamp ? ' ' + timestamp : ''}` };
}

/** 主转换函数：把多行类 SQL 转成 Line Protocol 行数组 */
export function sqlToLineProtocol(input: string): ConvertResult {
  const lines: string[] = [];
  const errors: ConvertResult['errors'] = [];
  const rawLines = input.split('\n');
  rawLines.forEach((raw, idx) => {
    const trimmed = raw.trim();
    // 注释 / 空行跳过
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('--')) return;
    const res = convertLine(trimmed);
    if (res.ok) {
      lines.push(res.line);
    } else {
      errors.push({ lineNo: idx + 1, raw: trimmed, reason: res.reason });
    }
  });
  return { lines, errors };
}
