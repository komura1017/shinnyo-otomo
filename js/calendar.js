// イベントカレンダー（公式サイトの月間カレンダーPDF）の読み込み。
//
// PDFの実物サンプルを受け取ったら、parseCalendarPdf() の中身だけを差し替えます。
// 戻り値の形さえ守れば、他の画面はそのまま動きます。
//
//   { month: 'YYYY-MM', events: [{ date: 'YYYY-MM-DD', title: '…' }, …] }
//
// 解析はすべて端末内で行い、ファイルを外部に送信しません。

import { db } from './db.js';

export async function parseCalendarPdf(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  // PDFかどうかだけ確認（先頭が %PDF-）
  const head = String.fromCharCode(...buf.slice(0, 5));
  if (head !== '%PDF-') throw new Error('PDFファイルではないようです');

  // TODO: サンプルPDF受領後に、日付とイベント名の抽出処理を実装する。
  return { month: null, events: [], pending: true };
}

// 解析結果を保存（同じ月は上書き）
export async function saveCalendar({ month, events, fileName }) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('月の指定が正しくありません');
  const clean = (events || [])
    .filter(e => e && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && typeof e.title === 'string')
    .map(e => ({ date: e.date, title: e.title.slice(0, 200) }));
  await db.put('calendars', { month, fileName: String(fileName || '').slice(0, 200), importedAt: new Date().toISOString(), events: clean });
}

// 指定日のイベント（複数あれば「・」区切り）。無ければ null。
export async function eventsForDate(dateStr) {
  const cal = await db.get('calendars', dateStr.slice(0, 7));
  if (!cal) return null;
  const list = cal.events.filter(e => e.date === dateStr).map(e => e.title);
  return list.length ? list.join('・') : '';
}

// 今月分が未読込で、過去に一度でも読み込んだことがあれば「再読込を促す」
export async function calendarStatus(today) {
  const month = today.slice(0, 7);
  const all = await db.getAll('calendars');
  const current = all.find(c => c.month === month) || null;
  return { month, current, everLoaded: all.length > 0, needsReload: !current };
}
