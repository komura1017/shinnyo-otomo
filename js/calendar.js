// イベントカレンダー（公式サイトの月間「行事予定表」PDF）の読み込み。
// PDFの解析は同梱の pdf.js を使い、すべて端末内で行います（外部へ送信しません）。

import { db } from './db.js';
import { parseScheduleItems } from './calendar-parse.js';

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('./vendor/pdfjs/pdf.min.mjs').then(pdfjs => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

// 戻り値: { month: 'YYYY-MM', tentative, events: [{ date: 'YYYY-MM-DD', title }] }
export async function parseCalendarPdf(file) {
  if (file.size > 20 * 1024 * 1024) throw new Error('ファイルが大きすぎます');
  const buf = new Uint8Array(await file.arrayBuffer());
  const head = String.fromCharCode(...buf.slice(0, 5));
  if (head !== '%PDF-') throw new Error('PDFファイルではないようです');

  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({
    data: buf,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
  }).promise;
  try {
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = tc.items.filter(i => typeof i.str === 'string').map(i => {
      const [x, y] = pdfjs.Util.applyTransform([i.transform[4], i.transform[5]], vp.transform);
      return { x, y, str: i.str };
    });
    const res = parseScheduleItems(items);
    if (!res.events.length) throw new Error('行事が読み取れませんでした');
    return res;
  } finally {
    doc.destroy();
  }
}

// 解析結果を保存（同じ月は上書き）
export async function saveCalendar({ month, events, fileName, tentative }) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('月の指定が正しくありません');
  const clean = (events || [])
    .filter(e => e && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && typeof e.title === 'string')
    .map(e => ({ date: e.date, title: e.title.slice(0, 200) }));
  await db.put('calendars', { month, tentative: !!tentative, fileName: String(fileName || '').slice(0, 200), importedAt: new Date().toISOString(), events: clean });
}

// 行事名の先頭の時刻（10:00、10時、10時30分、10:00～12:00 など）を外す
const TIME = '(?:午前|午後)?\\s*\\d{1,2}\\s*(?::\\s*\\d{2}|時\\s*(?:\\d{1,2}\\s*分|半)?)';
const LEADING_TIME_RE = new RegExp(`^\\s*${TIME}(?:\\s*[~〜～\\-－–—]\\s*(?:${TIME})?)?\\s*`);
export function stripLeadingTime(title) {
  const s = String(title).normalize('NFKC');
  const rest = s.replace(LEADING_TIME_RE, '').trim();
  return rest || s.trim();
}

// 指定日のイベント（時刻を外し、同じ行事は1つにまとめて「／」区切り）。無ければ null。
export async function eventsForDate(dateStr) {
  const cal = await db.get('calendars', dateStr.slice(0, 7));
  if (!cal) return null;
  const list = [...new Set(cal.events.filter(e => e.date === dateStr).map(e => stripLeadingTime(e.title)))];
  return list.length ? list.join(' ／ ') : '';
}

// 今月分が未読込で、過去に一度でも読み込んだことがあれば「再読込を促す」
export async function calendarStatus(today) {
  const month = today.slice(0, 7);
  const all = await db.getAll('calendars');
  const current = all.find(c => c.month === month) || null;
  return { month, current, everLoaded: all.length > 0, needsReload: !current, tentative: !!(current && current.tentative) };
}
