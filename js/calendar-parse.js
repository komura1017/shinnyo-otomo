// 公式「行事予定表」PDFの文字（位置つき）から、日ごとの行事を取り出す。
// PDFの読み込みには依存しないので、単体で試験できる。
//
// items: [{ x, y, str }]  （ページを正しい向きにしたときの座標。y は下向きに増える）
// 戻り値: { month: 'YYYY-MM', tentative: boolean, events: [{ date, title }] }

const DATE_RE = /^\s*(\d{1,2})\s*[（(]\s*([日月火水木金土祝])\s*[)）]\s*(.*)$/;
const LINE_TOL = 3; // 同じ行とみなす縦方向のずれ

function nfkc(s) { return String(s).normalize('NFKC'); }

export function parseScheduleItems(items) {
  const list = items
    .map(i => ({ x: i.x, y: i.y, str: String(i.str || '') }))
    .filter(i => i.str.trim());

  // 年月（例：「１１月（2026年 令和8年）」）と「ご参考」版かどうか
  let year = null; let month = null; let tentative = false;
  // 上の方の文字を行ごとにつなげて探す
  const headLines = [];
  for (const i of list.filter(i => i.y < 120).sort((a, b) => a.y - b.y || a.x - b.x)) {
    const l = headLines.find(l => Math.abs(l.y - i.y) <= 1.5);
    if (l) l.items.push(i); else headLines.push({ y: i.y, items: [i] });
  }
  for (const l of headLines) {
    const text = l.items.sort((a, b) => a.x - b.x).map(i => nfkc(i.str)).join('');
    const m = text.match(/(\d{1,2})月\s*[(]\s*(\d{4})年/);
    if (m) {
      month = Number(m[1]); year = Number(m[2]);
      if (/参考/.test(text)) tentative = true;
      break;
    }
  }
  if (!year || !month || month < 1 || month > 12) throw new Error('年月が読み取れませんでした（行事予定表のPDFか確認してください）');

  // 「法要・行事」欄の右端 ＝ 「向上」見出しの左
  const hdr = list.find(i => i.str.trim() === '向上');
  const rightEdge = hdr ? hdr.x - 3 : 300;
  // 日付欄の左端の目安
  const dateCells = list.filter(i => i.x < 80 && DATE_RE.test(nfkc(i.str)));
  if (!dateCells.length) throw new Error('日付の欄が見つかりませんでした');
  const leftEdge = Math.min(...dateCells.map(i => i.x)) - 5;

  // 行事欄の文字を行ごとにまとめる
  const cells = list.filter(i => i.x >= leftEdge && i.x < rightEdge).sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const c of cells) {
    const line = lines.find(l => Math.abs(l.y - c.y) <= LINE_TOL);
    if (line) line.items.push(c); else lines.push({ y: c.y, items: [c] });
  }
  lines.sort((a, b) => a.y - b.y);

  const lastDay = new Date(year, month, 0).getDate();
  const byDay = new Map();
  let current = null;
  let lastDateY = null;
  for (const line of lines) {
    const parts = line.items.sort((a, b) => a.x - b.x).map(i => nfkc(i.str).trim());
    let text = parts.join(' ').replace(/\s+/g, ' ').trim();
    const dm = text.match(DATE_RE);
    if (dm && line.items[0].x < leftEdge + 40) {
      const d = Number(dm[1]);
      if (d >= 1 && d <= lastDay) { current = d; lastDateY = line.y; text = dm[3].trim(); }
    } else if (current == null) {
      continue; // 見出しなど
    } else if (lastDateY != null && line.y - lastDateY > 60) {
      continue; // 表の下の注記など（最後の日付から離れすぎ）
    }
    if (current == null) continue;
    if (!byDay.has(current)) byDay.set(current, []);
    if (text) byDay.get(current).push(text);
  }

  const mm = String(month).padStart(2, '0');
  const events = [];
  for (let d = 1; d <= lastDay; d++) {
    const lines = byDay.get(d) || [];
    for (const t of lines) events.push({ date: `${year}-${mm}-${String(d).padStart(2, '0')}`, title: t.slice(0, 200) });
  }
  return { month: `${year}-${mm}`, tentative, events, days: byDay.size };
}
