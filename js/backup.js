// バックアップと復元。ファイルはiOSの共有シート（「ファイルに保存」など）で
// 利用者自身が保存先を選びます。アプリからどこかへ送信することはありません。

import { db, STORES } from './db.js';

export const BACKUP_FILE_NAME = 'otomo-backup.json';

export async function buildBackupFile() {
  const dump = await db.exportAll();
  // 書きかけの下書きはバックアップに含めない
  dump.data.settings = (dump.data.settings || []).filter(s => s.key !== 'sesshinDraft');
  const json = JSON.stringify(dump);
  return new File([json], BACKUP_FILE_NAME, { type: 'application/json' });
}

// 共有シートでファイルを渡す。非対応ならダウンロード。
// 戻り値: 'shared' | 'downloaded' | 'cancelled' | 'needs-tap'
export async function shareBackupFile(file) {
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'お供のバックアップ' });
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
      // 保存処理に時間がかかり「タップ直後」と見なされなかった場合
      if (e && e.name === 'NotAllowedError') return 'needs-tap';
      throw e;
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'downloaded';
}

// ---- 復元 ----

const isStr = v => typeof v === 'string';
const isDate = v => isStr(v) && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isMonth = v => isStr(v) && /^\d{4}-\d{2}$/.test(v);
const optStr = v => v == null || isStr(v);

const VALIDATORS = {
  persons: r => isStr(r.id) && isStr(r.name) && optStr(r.createdAt) && (r.hidden == null || typeof r.hidden === 'boolean'),
  segaki: r => isStr(r.id) && isDate(r.date) && Array.isArray(r.entries) &&
    r.entries.every(e => e && isStr(e.personId) && Number.isFinite(e.amount) && e.amount >= 0),
  sesshin: r => isStr(r.id) && isDate(r.date) && optStr(r.type) && optStr(r.staff) && optStr(r.event) && optStr(r.content),
  goma: r => isStr(r.id) && isDate(r.date) && (r.kind === 'standard' || r.kind === 'taisai') && optStr(r.taisaiId) && optStr(r.taisaiName) &&
    Array.isArray(r.entries) && r.entries.every(e => e && isStr(e.name) && optStr(e.itemId) && optStr(e.target) && optStr(e.detail)),
  calendars: r => isMonth(r.month) && Array.isArray(r.events) && r.events.every(e => e && isDate(e.date) && isStr(e.title)),
  settings: r => isStr(r.key),
};

// 中身を確かめ、件数を返す（壊れたファイルや別アプリのファイルは拒否）
export async function readBackupFile(file) {
  if (file.size > 20 * 1024 * 1024) throw new Error('ファイルが大きすぎます');
  let dump;
  try { dump = JSON.parse(await file.text()); } catch (_) { throw new Error('バックアップファイルではないようです'); }
  if (!dump || dump.app !== 'shinnyo-otomo' || typeof dump.data !== 'object' || dump.data === null) {
    throw new Error('お供のバックアップファイルではありません');
  }
  for (const s of STORES) {
    const rows = dump.data[s] || [];
    if (!Array.isArray(rows) || !rows.every(r => r && typeof r === 'object' && VALIDATORS[s](r))) {
      throw new Error('ファイルの中身が壊れているようです');
    }
  }
  return {
    dump,
    exportedAt: isStr(dump.exportedAt) ? dump.exportedAt : '',
    counts: { persons: (dump.data.persons || []).length, segaki: (dump.data.segaki || []).length, sesshin: (dump.data.sesshin || []).length, goma: (dump.data.goma || []).length },
  };
}

export async function restoreBackup(dump) {
  // 今の下書きは残す
  const draft = await db.get('settings', 'sesshinDraft');
  await db.importAll(dump);
  if (draft) await db.put('settings', draft);
}
