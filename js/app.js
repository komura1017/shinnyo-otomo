import { db, newId, requestPersist } from './db.js';
import { buildBackupFile, shareBackupFile, readBackupFile, restoreBackup } from './backup.js';
import { parseCalendarPdf, saveCalendar, eventsForDate, calendarStatus } from './calendar.js';

const APP_VERSION = '0.4.0'; // version.json と必ずそろえる
const DEFAULT_SESSHIN_TYPES = ['向上接心', '相談接心'];

// ---------- 小さな道具 ----------

// DOM を組み立てる。文字列は必ず textContent で入れる（innerHTML は使わない）
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const WD = ['日', '月', '火', '水', '木', '金', '土'];
function fmtDate(s) {
  if (!s) return '';
  const [y, m, d] = s.split('-').map(Number);
  const w = WD[new Date(y, m - 1, d).getDay()];
  return `${y}年${m}月${d}日（${w}）`;
}
function fmtShort(s) {
  if (!s) return '';
  const [y, m, d] = s.split('-').map(Number);
  return `${y}/${m}/${d}`;
}
function yen(n) { return `${Number(n || 0).toLocaleString('ja-JP')}円`; }
function daysSince(s) {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((t - new Date(y, m - 1, d)) / 86400000);
}
function byDateDesc(a, b) { return (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || ''); }

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

// 削除は簡単にできないよう「削除」と打ち込んでもらう
function confirmDelete(what) {
  const v = prompt(`${what}を削除します。元には戻せません。\n削除する場合は「削除」と入力してください。`);
  if (v === null) return false;
  if (v.trim() !== '削除') { toast('削除を取り消しました'); return false; }
  return true;
}

function isStandalone() {
  return window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
}

async function getSesshinTypes() {
  return db.getSetting('sesshinTypes', DEFAULT_SESSHIN_TYPES);
}

// 人別の集計（excludeId の記録は除外。編集中の記録を数えないため）
async function personStats(excludeId) {
  const [persons, records] = await Promise.all([db.getAll('persons'), db.getAll('segaki')]);
  const stats = new Map(persons.map(p => [p.id, { person: p, total: 0, count: 0, last: null }]));
  for (const r of records) {
    if (r.id === excludeId) continue;
    for (const e of r.entries) {
      const s = stats.get(e.personId);
      if (!s) continue;
      s.total += Number(e.amount) || 0;
      s.count += 1;
      if (!s.last || r.date > s.last) s.last = r.date;
    }
  }
  return { persons, records, stats };
}

// 最終実施日が古い順（未実施が先頭）。同じなら登録順。
function sortOldestFirst(list) {
  return list.sort((a, b) => {
    if (a.last === b.last) return (a.person.createdAt || '').localeCompare(b.person.createdAt || '');
    if (!a.last) return -1;
    if (!b.last) return 1;
    return a.last.localeCompare(b.last);
  });
}

// ---------- 画面の枠 ----------

const viewEl = document.getElementById('view');
const titleEl = document.getElementById('title');
const backBtn = document.getElementById('backBtn');

function setFrame(title, tab, backTo) {
  titleEl.textContent = title;
  document.title = `${title}｜真如苑のお供`;
  document.querySelectorAll('.tabbar a').forEach(a => a.classList.toggle('active', a.dataset.tab === tab));
  if (backTo) { backBtn.hidden = false; backBtn.onclick = () => { location.hash = backTo; }; }
  else backBtn.hidden = true;
}

function render(...nodes) {
  viewEl.replaceChildren(...nodes.filter(n => n != null && n !== false));
  window.scrollTo(0, 0);
}

function card(...children) { return h('section', { class: 'card' }, ...children); }
function empty(text) { return h('p', { class: 'empty' }, text); }

// ---------- ホーム ----------

async function viewHome() {
  setFrame('真如苑のお供', 'home');
  const t = today();
  const nodes = [];

  if (!isStandalone() && localGet('hideInstallGuide') !== '1') {
    const guide = h('section', { class: 'banner info' },
      h('strong', {}, 'ホーム画面に追加してお使いください'),
      h('ol', {},
        h('li', {}, 'Safariの下にある共有ボタン（□に↑）をタップ'),
        h('li', {}, '「ホーム画面に追加」を選ぶ'),
        h('li', {}, 'ホーム画面の「お供」から開く')),
      h('p', { class: 'small' }, 'ホーム画面から使うと、記録が消えにくくなります。'),
      h('button', { type: 'button', class: 'btn small', onclick: () => { localSet('hideInstallGuide', '1'); guide.remove(); } }, '追加済みなので表示しない'));
    nodes.push(guide);
  }

  const cal = await calendarStatus(t);
  if (cal.needsReload && cal.everLoaded) {
    nodes.push(h('a', { class: 'banner warn', href: '#/settings' },
      h('strong', {}, `${Number(cal.month.slice(5))}月のイベントカレンダーが未読込です`),
      h('span', {}, '公式サイトから今月の行事予定表（PDF）をダウンロードして、設定から読み込んでください。')));
  } else if (cal.tentative) {
    nodes.push(h('a', { class: 'banner warn', href: '#/settings' },
      h('strong', {}, `${Number(cal.month.slice(5))}月のカレンダーは「ご参考」版です`),
      h('span', {}, '確定版が出たら、設定から読み込み直してください。')));
  }

  nodes.push(h('div', { class: 'actions' },
    h('a', { class: 'btn primary big', href: '#/segaki/new' }, 'お施餓鬼を記録'),
    h('a', { class: 'btn primary big', href: '#/sesshin/new' }, '接心を記録')));

  const { records, stats } = await personStats();
  records.sort(byDateDesc);
  const last = records[0];
  nodes.push(card(h('h2', {}, '前回のお施餓鬼'), last ? segakiSummary(last, stats) : empty('まだ記録がありません')));

  const ss = (await db.getAll('sesshin')).sort(byDateDesc);
  nodes.push(card(h('h2', {}, '最近の接心'), ss.length ? h('ul', { class: 'list' }, ss.slice(0, 3).map(sesshinRow)) : empty('まだ記録がありません')));

  render(...nodes);
}

// ---------- お施餓鬼 ----------

function segakiSummary(r, stats) {
  const total = r.entries.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  return h('a', { class: 'summary', href: `#/segaki/edit/${encodeURIComponent(r.id)}` },
    h('div', { class: 'row' }, h('span', { class: 'date' }, fmtDate(r.date)), h('span', { class: 'amount' }, `計 ${yen(total)}`)),
    h('ul', { class: 'chips' }, r.entries.map(e => {
      const p = stats.get(e.personId);
      return h('li', {}, `${p ? p.person.name : '（削除済み）'} ${yen(e.amount)}`);
    })));
}

async function viewSegakiList() {
  setFrame('お施餓鬼', 'segaki');
  const { records, stats } = await personStats();
  records.sort(byDateDesc);
  const [last, ...rest] = records;
  render(
    h('div', { class: 'actions' }, h('a', { class: 'btn primary big', href: '#/segaki/new' }, '＋ 新しく記録')),
    card(h('h2', {}, '前回の記録'), last ? segakiSummary(last, stats) : empty('まだ記録がありません')),
    rest.length ? card(h('h2', {}, 'これまでの記録'), h('div', { class: 'stack' }, rest.map(r => segakiSummary(r, stats)))) : null,
  );
}

async function viewSegakiForm(id) {
  const editing = id ? await db.get('segaki', id) : null;
  if (id && !editing) { location.hash = '#/segaki'; return; }
  setFrame(editing ? 'お施餓鬼を編集' : 'お施餓鬼を記録', 'segaki', '#/segaki');

  const { records, stats } = await personStats(editing ? editing.id : undefined);
  const prev = records.filter(r => !editing || r.id !== editing.id).sort(byDateDesc)[0];

  // 選択状態: personId -> 金額文字列。新規はだれも選ばない（アプリは自動で選ばない）
  const selected = new Map();
  if (editing) for (const e of editing.entries) selected.set(e.personId, String(e.amount));

  const dateInput = h('input', { type: 'date', value: editing ? editing.date : today(), required: true });
  const listEl = h('div', { class: 'pick-list' });
  const totalEl = h('span', { class: 'amount' });
  const countEl = h('span', {});
  const showHidden = h('input', { type: 'checkbox' });

  function updateTotal() {
    let sum = 0;
    for (const v of selected.values()) sum += Number(v) || 0;
    totalEl.textContent = yen(sum);
    countEl.textContent = `${selected.size}人選択`;
  }

  function drawList() {
    const all = sortOldestFirst([...stats.values()])
      .filter(s => !s.person.hidden || showHidden.checked || selected.has(s.person.id));
    if (!all.length) { listEl.replaceChildren(empty('まず下の欄から対象者を登録してください')); return; }
    listEl.replaceChildren(...all.map(s => {
      const pid = s.person.id;
      const on = selected.has(pid);
      const amt = h('input', {
        type: 'text', inputmode: 'numeric', pattern: '[0-9]*', class: 'amt', placeholder: '金額',
        value: selected.get(pid) || '', 'aria-label': `${s.person.name}の金額`,
        oninput: e => { e.target.value = e.target.value.replace(/[^0-9]/g, ''); selected.set(pid, e.target.value); updateTotal(); },
      });
      const cb = h('input', {
        type: 'checkbox', checked: on, 'aria-label': `${s.person.name}を選ぶ`,
        onchange: e => { if (e.target.checked) selected.set(pid, ''); else selected.delete(pid); drawList(); updateTotal(); },
      });
      const ds = daysSince(s.last);
      return h('div', { class: 'pick' + (on ? ' on' : ''), 'data-pid': pid },
        h('label', { class: 'pick-main' }, cb,
          h('span', { class: 'pick-name' }, s.person.name, s.person.hidden ? h('small', {}, '（非表示中）') : null),
          h('span', { class: 'pick-meta' },
            s.last ? `前回 ${fmtShort(s.last)}（${ds}日前）` : '未実施',
            ` ・ 累計 ${yen(s.total)}`)),
        on ? h('div', { class: 'pick-amt' }, amt, h('span', {}, '円')) : null);
    }));
  }

  const bulk = h('input', { type: 'text', inputmode: 'numeric', pattern: '[0-9]*', placeholder: '例：1000', oninput: e => { e.target.value = e.target.value.replace(/[^0-9]/g, ''); } });
  const newName = h('input', { type: 'text', placeholder: '名前', maxlength: 50, autocomplete: 'off' });

  async function addPerson() {
    const name = newName.value.trim();
    if (!name) return;
    if ([...stats.values()].some(s => s.person.name === name)) { toast('同じ名前がすでに登録されています'); return; }
    const p = { id: newId(), name, createdAt: new Date().toISOString() };
    await db.put('persons', p);
    stats.set(p.id, { person: p, total: 0, count: 0, last: null });
    newName.value = '';
    // 登録した人は今回の対象に入れ、そのまま金額入力へ
    selected.set(p.id, '');
    drawList();
    updateTotal();
    const amt = listEl.querySelector(`[data-pid="${CSS.escape(p.id)}"] .amt`);
    if (amt) { amt.scrollIntoView({ block: 'center' }); amt.focus(); }
    toast(`${name}さんを登録しました。金額を入れてください`);
  }

  async function save() {
    const date = dateInput.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { toast('日付を入れてください'); return; }
    if (!selected.size) { toast('対象者を選んでください'); return; }
    const entries = [];
    for (const [personId, v] of selected) {
      if (v === '' || !/^\d+$/.test(v)) { toast(`${stats.get(personId).person.name}さんの金額を入れてください`); return; }
      entries.push({ personId, amount: Number(v) });
    }
    const now = new Date().toISOString();
    await db.put('segaki', { id: editing ? editing.id : newId(), date, entries, createdAt: editing ? editing.createdAt : now, updatedAt: now });
    toast('保存しました');
    location.hash = '#/segaki';
  }

  async function remove() {
    if (!confirmDelete('このお施餓鬼の記録')) return;
    await db.delete('segaki', editing.id);
    toast('削除しました');
    location.hash = '#/segaki';
  }

  drawList();
  updateTotal();
  showHidden.addEventListener('change', drawList);

  render(
    card(h('h2', {}, '前回の記録'), prev ? segakiSummary(prev, stats) : empty('まだ記録がありません')),
    card(
      h('label', { class: 'field' }, h('span', {}, '日付'), dateInput),
      h('h2', {}, '対象者', h('small', {}, '（前回が古い順）')),
      listEl,
      h('label', { class: 'check small' }, showHidden, '非表示の人も出す'),
      h('details', { class: 'sub' },
        h('summary', {}, '選んだ全員に同じ金額を入れる'),
        h('div', { class: 'inline' }, bulk, h('span', {}, '円'),
          h('button', { type: 'button', class: 'btn', onclick: () => {
            if (!bulk.value) return;
            for (const k of selected.keys()) selected.set(k, bulk.value);
            drawList(); updateTotal();
          } }, '入れる'))),
      h('details', { class: 'sub', open: stats.size === 0 },
        h('summary', {}, '対象者を新しく登録'),
        h('div', { class: 'inline' }, newName, h('button', { type: 'button', class: 'btn', onclick: addPerson }, '登録'))),
    ),
    h('div', { class: 'savebar' },
      h('div', { class: 'row' }, countEl, h('span', {}, '合計 ', totalEl)),
      h('button', { type: 'button', class: 'btn primary big', onclick: save }, '保存'),
      editing ? h('details', { class: 'danger-zone' }, h('summary', {}, '削除について'), h('button', { type: 'button', class: 'btn danger', onclick: remove }, 'この記録を削除')) : null),
  );
}

// ---------- 人別 ----------

async function viewPeople() {
  setFrame('人別の記録', 'people');
  const { stats } = await personStats();
  const sortSel = h('select', {},
    h('option', { value: 'old' }, '前回が古い順'),
    h('option', { value: 'total' }, '累計金額が多い順'),
    h('option', { value: 'name' }, '名前順'));
  sortSel.value = sessionStorageGet('peopleSort') || 'old';
  const listEl = h('ul', { class: 'list' });

  function draw() {
    sessionStorageSet('peopleSort', sortSel.value);
    let list = [...stats.values()];
    if (sortSel.value === 'old') sortOldestFirst(list);
    else if (sortSel.value === 'total') list.sort((a, b) => b.total - a.total);
    else list.sort((a, b) => a.person.name.localeCompare(b.person.name, 'ja'));
    if (!list.length) { listEl.replaceChildren(h('li', {}, empty('お施餓鬼の記録画面から対象者を登録できます'))); return; }
    listEl.replaceChildren(...list.map(s => h('li', {},
      h('a', { href: `#/people/${encodeURIComponent(s.person.id)}`, class: 'item' + (s.person.hidden ? ' muted' : '') },
        h('div', { class: 'row' }, h('strong', {}, s.person.name, s.person.hidden ? '（非表示）' : ''), h('span', { class: 'amount' }, yen(s.total))),
        h('div', { class: 'meta' }, `${s.count}回 ・ `, s.last ? `前回 ${fmtShort(s.last)}` : '未実施')))));
  }
  sortSel.addEventListener('change', draw);
  draw();
  const grand = [...stats.values()].reduce((a, s) => a + s.total, 0);
  render(
    card(h('div', { class: 'row' }, h('span', {}, '全期間の合計'), h('strong', { class: 'amount' }, yen(grand)))),
    h('label', { class: 'field' }, h('span', {}, '並び順'), sortSel),
    card(listEl),
  );
}

async function viewPerson(id) {
  const p = await db.get('persons', id);
  if (!p) { location.hash = '#/people'; return; }
  setFrame(p.name, 'people', '#/people');
  const { records, stats } = await personStats();
  const s = stats.get(id);
  const mine = records.filter(r => r.entries.some(e => e.personId === id)).sort(byDateDesc);
  const nameInput = h('input', { type: 'text', value: p.name, maxlength: 50 });

  render(
    card(
      h('div', { class: 'row' }, h('span', {}, '累計金額（全期間）'), h('strong', { class: 'amount' }, yen(s.total))),
      h('div', { class: 'row' }, h('span', {}, '回数'), h('strong', {}, `${s.count}回`)),
      h('div', { class: 'row' }, h('span', {}, '前回'), h('strong', {}, s.last ? fmtDate(s.last) : '未実施'))),
    card(h('h2', {}, '履歴'), mine.length
      ? h('ul', { class: 'list' }, mine.map(r => {
        const e = r.entries.find(x => x.personId === id);
        return h('li', {}, h('a', { class: 'item', href: `#/segaki/edit/${encodeURIComponent(r.id)}` },
          h('div', { class: 'row' }, h('span', {}, fmtDate(r.date)), h('span', { class: 'amount' }, yen(e.amount)))));
      }))
      : empty('まだ記録がありません')),
    card(h('h2', {}, 'この人の設定'),
      h('label', { class: 'field' }, h('span', {}, '名前'), nameInput),
      h('button', { type: 'button', class: 'btn', onclick: async () => {
        const name = nameInput.value.trim();
        if (!name) return;
        await db.put('persons', { ...p, name });
        toast('名前を変更しました'); viewPerson(id);
      } }, '名前を変更'),
      h('p', { class: 'small' }, '非表示にすると、お施餓鬼の対象者一覧に出なくなります（記録と累計は残ります）。'),
      h('button', { type: 'button', class: 'btn', onclick: async () => {
        await db.put('persons', { ...p, hidden: !p.hidden });
        toast(p.hidden ? '表示に戻しました' : '非表示にしました'); viewPerson(id);
      } }, p.hidden ? '表示に戻す' : '非表示にする'),
      mine.length ? null : h('button', { type: 'button', class: 'btn danger', onclick: async () => {
        if (!confirmDelete(`${p.name}さん`)) return;
        await db.delete('persons', id); toast('削除しました'); location.hash = '#/people';
      } }, 'この人を削除')),
  );
}

function localGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
function localSet(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* 無視 */ } }
function sessionStorageGet(k) { try { return sessionStorage.getItem(k); } catch (_) { return null; } }
function sessionStorageSet(k, v) { try { sessionStorage.setItem(k, v); } catch (_) { /* 無視 */ } }

// ---------- 接心 ----------

function sesshinRow(r) {
  return h('li', {}, h('a', { class: 'item', href: `#/sesshin/edit/${encodeURIComponent(r.id)}` },
    h('div', { class: 'row' }, h('strong', {}, fmtDate(r.date)), h('span', { class: 'tag' }, r.type || '')),
    h('div', { class: 'meta' }, r.staff ? `担当：${r.staff}` : '担当：なし', r.event ? ` ・ ${r.event}` : ''),
    r.content ? h('div', { class: 'snippet' }, r.content.slice(0, 80)) : null));
}

async function viewSesshinList() {
  setFrame('接心の記録', 'sesshin');
  const all = (await db.getAll('sesshin')).sort(byDateDesc);
  const types = await getSesshinTypes();
  const q = h('input', { type: 'search', placeholder: '言葉で探す', autocomplete: 'off' });
  const typeSel = h('select', {}, h('option', { value: '' }, 'すべての種類'), types.map(t => h('option', { value: t }, t)));
  const listEl = h('ul', { class: 'list' });
  function draw() {
    const kw = q.value.trim();
    const list = all.filter(r => (!typeSel.value || r.type === typeSel.value) &&
      (!kw || [r.content, r.staff, r.event, r.type].some(x => x && x.includes(kw))));
    listEl.replaceChildren(...(list.length ? list.map(sesshinRow) : [h('li', {}, empty(all.length ? '見つかりません' : 'まだ記録がありません'))]));
  }
  q.addEventListener('input', draw);
  typeSel.addEventListener('change', draw);
  draw();
  render(
    h('div', { class: 'actions' }, h('a', { class: 'btn primary big', href: '#/sesshin/new' }, '＋ 新しく記録')),
    all.length ? h('div', { class: 'filters' }, q, typeSel) : null,
    card(listEl),
  );
}

async function viewSesshinForm(id) {
  const editing = id ? await db.get('sesshin', id) : null;
  if (id && !editing) { location.hash = '#/sesshin'; return; }
  setFrame(editing ? '接心を編集' : '接心を記録', 'sesshin', '#/sesshin');

  // 新規のときは書きかけ（下書き）を復元する
  const draft = editing ? null : await db.getSetting('sesshinDraft', null);
  const src = editing || draft || {};
  const types = await getSesshinTypes();
  const typeOptions = [...types];
  if (src.type && !typeOptions.includes(src.type)) typeOptions.push(src.type);

  const dateInput = h('input', { type: 'date', value: src.date || today(), required: true });
  const typeSel = h('select', {}, typeOptions.map(t => h('option', { value: t }, t)));
  typeSel.value = src.type || typeOptions[0];
  const staffInput = h('input', { type: 'text', value: src.staff || '', placeholder: '空欄でもかまいません', maxlength: 50, autocomplete: 'off' });
  const eventInput = h('input', { type: 'text', value: src.event || '', placeholder: '未設定', maxlength: 600, autocomplete: 'off' });
  const eventNote = h('p', { class: 'small' });
  const content = h('textarea', { rows: 12, placeholder: '言われたことを書き留めましょう' });
  content.value = src.content || '';
  let eventSource = src.eventSource || (src.event ? 'manual' : 'none');

  async function applyCalendar(force) {
    const ev = await eventsForDate(dateInput.value);
    if (ev === null) {
      eventNote.textContent = `${Number(dateInput.value.slice(5, 7))}月のカレンダーは未読込です。必要なら手で入力してください。`;
      if (eventSource === 'calendar') { eventInput.value = ''; eventSource = 'none'; }
      return;
    }
    if (force || eventSource !== 'manual') {
      eventInput.value = ev;
      eventSource = ev ? 'calendar' : 'none';
    }
    eventNote.textContent = ev ? 'カレンダーから自動で設定しました（書き換えもできます）' : 'カレンダーにこの日のイベントはありません';
  }
  eventInput.addEventListener('input', () => { eventSource = eventInput.value.trim() ? 'manual' : 'none'; eventNote.textContent = '手で入力しています'; });
  dateInput.addEventListener('change', () => { applyCalendar(false); saveDraft(); });

  let draftTimer;
  function saveDraft() {
    if (editing) return;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => db.setSetting('sesshinDraft', collect()), 400);
  }
  for (const el of [typeSel, staffInput, eventInput, content]) el.addEventListener('input', saveDraft);
  typeSel.addEventListener('change', saveDraft);

  function collect() {
    return { date: dateInput.value, type: typeSel.value, staff: staffInput.value.trim(), event: eventInput.value.trim(), eventSource, content: content.value };
  }

  async function save() {
    const v = collect();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date)) { toast('日付を入れてください'); return; }
    clearTimeout(draftTimer);
    const now = new Date().toISOString();
    await db.put('sesshin', { ...v, id: editing ? editing.id : newId(), createdAt: editing ? editing.createdAt : now, updatedAt: now });
    if (!editing) await db.setSetting('sesshinDraft', null);
    toast('保存しました');
    location.hash = '#/sesshin';
  }

  async function remove() {
    if (!confirmDelete('この接心の記録')) return;
    await db.delete('sesshin', editing.id);
    toast('削除しました');
    location.hash = '#/sesshin';
  }

  async function discardDraft() {
    if (!confirm('書きかけの内容を消しますか？')) return;
    clearTimeout(draftTimer);
    await db.setSetting('sesshinDraft', null);
    viewSesshinForm();
  }

  if (!editing) await applyCalendar(false);
  else eventNote.textContent = eventSource === 'calendar' ? 'カレンダーから設定済み' : '';

  render(
    draft && !editing ? h('section', { class: 'banner info' }, '書きかけの記録を復元しました。',
      h('button', { type: 'button', class: 'btn small', onclick: discardDraft }, '消して最初から')) : null,
    card(
      h('label', { class: 'field' }, h('span', {}, '日付'), dateInput),
      h('label', { class: 'field' }, h('span', {}, '接心の種類'), typeSel),
      h('label', { class: 'field' }, h('span', {}, '担当者'), staffInput),
      h('div', { class: 'field' },
        h('label', {}, h('span', {}, 'イベント'), eventInput),
        eventNote,
        h('button', { type: 'button', class: 'btn small', onclick: () => applyCalendar(true) }, 'カレンダーから入れ直す')),
    ),
    card(h('label', { class: 'field' }, h('span', {}, '言われたこと'), content),
      editing ? null : h('p', { class: 'small' }, '書いている内容は自動で下書き保存されます。')),
    h('div', { class: 'savebar' },
      h('button', { type: 'button', class: 'btn primary big', onclick: save }, '保存'),
      editing ? h('details', { class: 'danger-zone' }, h('summary', {}, '削除について'), h('button', { type: 'button', class: 'btn danger', onclick: remove }, 'この記録を削除')) : null),
  );
}

// ---------- 設定 ----------

async function viewSettings() {
  setFrame('設定', 'settings');
  const types = await getSesshinTypes();
  const t = today();
  const cal = await calendarStatus(t);
  const cals = (await db.getAll('calendars')).sort((a, b) => b.month.localeCompare(a.month));

  // 接心の種類
  const typeList = h('ul', { class: 'list' }, types.map((ty, i) => h('li', {}, h('div', { class: 'row item' },
    h('span', {}, ty),
    h('span', {},
      i > 0 ? h('button', { type: 'button', class: 'btn small', 'aria-label': '上へ', onclick: async () => {
        const n = [...types]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; await db.setSetting('sesshinTypes', n); viewSettings();
      } }, '↑') : null,
      types.length > 1 ? h('button', { type: 'button', class: 'btn small', onclick: async () => {
        if (!confirm(`「${ty}」を選択肢から外しますか？（これまでの記録はそのまま残ります）`)) return;
        await db.setSetting('sesshinTypes', types.filter(x => x !== ty)); viewSettings();
      } }, '外す') : null)))));
  const newType = h('input', { type: 'text', placeholder: '種類の名前', maxlength: 30 });

  // カレンダー読み込み
  const fileInput = h('input', { type: 'file', accept: 'application/pdf,.pdf', class: 'file' });
  const calMsg = h('p', { class: 'small' });
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    try {
      calMsg.textContent = '読み取り中…';
      const res = await parseCalendarPdf(f);
      await saveCalendar({ ...res, fileName: f.name });
      toast(`${Number(res.month.slice(5))}月の${res.tentative ? '「ご参考」' : ''}カレンダーを読み込みました（${res.events.length}件）`);
      viewSettings();
    } catch (e) {
      calMsg.textContent = `読み込めませんでした：${e.message}`;
    } finally {
      fileInput.value = '';
    }
  });

  // バックアップ用ファイルは先に用意しておく（iPhoneではタップ直後でないと共有シートが開けないため）
  const backupFile = await buildBackupFile();
  const lastBackup = await db.getSetting('lastBackupAt', null);
  const restoreInput = h('input', { type: 'file', accept: 'application/json,.json', class: 'file' });
  const backupMsg = h('p', { class: 'small' });
  restoreInput.addEventListener('change', async () => {
    const f = restoreInput.files && restoreInput.files[0];
    restoreInput.value = '';
    if (!f) return;
    try {
      const { dump, exportedAt, counts } = await readBackupFile(f);
      const when = exportedAt ? new Date(exportedAt).toLocaleString('ja-JP') : '不明';
      const v = prompt(`${when} のバックアップです。\n（対象者${counts.persons}人・お施餓鬼${counts.segaki}件・接心${counts.sesshin}件）\n\n今の記録はすべてこの内容に置き換わります。\n復元する場合は「復元」と入力してください。`);
      if (v === null) return;
      if (v.trim() !== '復元') { toast('復元を取り消しました'); return; }
      await restoreBackup(dump);
      toast('復元しました');
      viewSettings();
    } catch (e) {
      backupMsg.textContent = `復元できませんでした：${e.message}`;
    }
  });

  const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted().catch(() => false) : false;

  render(
    card(h('h2', {}, 'イベントカレンダー'),
      h('p', {}, cal.current ? `${Number(cal.month.slice(5))}月分は読込済みです${cal.tentative ? '（ご参考版）' : ''}。` : `${Number(cal.month.slice(5))}月分はまだ読み込んでいません。`),
      h('p', { class: 'small' }, '公式サイトから月間の行事予定表（PDF）をiPhoneにダウンロードし、ここで選んでください。同じ月を読み込むと置き換わります（「ご参考」版のあと確定版を読み込む場合など）。PDFは端末の中だけで読み取ります。'),
      h('label', { class: 'btn' }, 'PDFを選ぶ', fileInput),
      calMsg,
      cals.length ? h('ul', { class: 'list' }, cals.map(c => h('li', {}, h('div', { class: 'row item' },
        h('details', { class: 'cal-month' },
          h('summary', {}, `${c.month.replace('-', '年')}月${c.tentative ? '（ご参考）' : ''}`),
          h('ul', { class: 'cal-events' }, c.events.map(e => h('li', {}, h('span', { class: 'd' }, fmtShort(e.date).slice(5)), e.title)))),
        h('button', { type: 'button', class: 'btn small', onclick: async () => {
          if (!confirmDelete(`${c.month.replace('-', '年')}月のカレンダー`)) return;
          await db.delete('calendars', c.month); viewSettings();
        } }, '削除'))))) : null),
    card(h('h2', {}, '接心の種類'), typeList,
      h('div', { class: 'inline' }, newType, h('button', { type: 'button', class: 'btn', onclick: async () => {
        const v = newType.value.trim();
        if (!v) return;
        if (types.includes(v)) { toast('すでにあります'); return; }
        await db.setSetting('sesshinTypes', [...types, v]); toast('追加しました'); viewSettings();
      } }, '追加'))),
    card(h('h2', {}, 'お施餓鬼の対象者'),
      h('p', { class: 'small' }, '名前の変更や非表示は「人別」から人を選んで行えます。'),
      h('a', { class: 'btn', href: '#/people' }, '人別を開く')),
    card(h('h2', {}, 'データについて'),
      h('p', {}, '記録はすべてこのiPhoneの中だけに保存され、インターネットには送信されません。'),
      persisted || isStandalone() ? null : h('p', { class: 'small' }, 'ホーム画面に追加して使うと、記録が消えにくくなります。'),
      h('p', { class: 'small' }, `バージョン ${APP_VERSION}`),
      h('button', { type: 'button', class: 'btn', onclick: async e => {
        e.target.disabled = true;
        const latest = await checkForUpdate();
        e.target.disabled = false;
        if (latest === null) { toast('確認できませんでした（通信を確認してください）'); return; }
        if (latest === APP_VERSION) { toast('最新の版です'); return; }
        applyUpdate();
      } }, 'アプリを更新'),
      h('p', { class: 'small' }, '更新しても記録は消えません。'),
      h('details', { class: 'sub' },
        h('summary', {}, 'バックアップと復元'),
        h('p', { class: 'small' }, '「書き出す」を押すと共有画面が開きます。「ファイルに保存」を選ぶと、iPhoneの「ファイル」アプリやiCloud Driveに保存できます。'),
        h('p', { class: 'small' }, lastBackup ? `前回の書き出し：${new Date(lastBackup).toLocaleString('ja-JP')}` : 'まだ書き出していません'),
        h('button', { type: 'button', class: 'btn', onclick: async () => {
          try {
            const r = await shareBackupFile(backupFile);
            if (r === 'cancelled') return;
            if (r === 'needs-tap') { toast('もう一度押してください'); return; }
            await db.setSetting('lastBackupAt', new Date().toISOString());
            toast(r === 'shared' ? 'バックアップを渡しました' : 'バックアップを書き出しました');
          } catch (e) { backupMsg.textContent = `書き出せませんでした：${e.message}`; }
        } }, 'バックアップを書き出す'),
        h('p', { class: 'small' }, '機種変更などで戻したいときは、保存したファイルを選んでください。今の記録は置き換わります。'),
        h('label', { class: 'btn' }, 'バックアップから復元', restoreInput),
        backupMsg)),
  );
}

// ---------- ルーター ----------

async function route() {
  const parts = (location.hash.replace(/^#\/?/, '') || '').split('/').map(decodeURIComponent);
  try {
    switch (parts[0]) {
      case '': return await viewHome();
      case 'segaki':
        if (parts[1] === 'new') return await viewSegakiForm();
        if (parts[1] === 'edit' && parts[2]) return await viewSegakiForm(parts[2]);
        return await viewSegakiList();
      case 'people':
        if (parts[1]) return await viewPerson(parts[1]);
        return await viewPeople();
      case 'sesshin':
        if (parts[1] === 'new') return await viewSesshinForm();
        if (parts[1] === 'edit' && parts[2]) return await viewSesshinForm(parts[2]);
        return await viewSesshinList();
      case 'settings': return await viewSettings();
      default: location.hash = '#/';
    }
  } catch (e) {
    console.error(e);
    render(card(h('h2', {}, 'エラーが発生しました'), h('p', {}, String(e && e.message || e))));
  }
}

window.addEventListener('hashchange', route);
route();
requestPersist();

// ---------- 更新 ----------

// 公開中の版番号を取得（失敗したら null）
async function checkForUpdate() {
  try {
    const res = await fetch('version.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const v = (await res.json()).version;
    if (typeof v !== 'string') return null;
    showUpdateBar(v !== APP_VERSION);
    return v;
  } catch (_) { return null; }
}

function showUpdateBar(show) {
  const bar = document.getElementById('updateBar');
  if (!bar) return;
  bar.hidden = !show;
}

// アプリ本体だけを入れ替える（記録データ＝IndexedDBには触れない）
async function applyUpdate() {
  toast('更新しています…');
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) await reg.update().catch(() => {});
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  } finally {
    location.reload();
  }
}

document.getElementById('updateBtn').addEventListener('click', applyUpdate);
checkForUpdate();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForUpdate(); });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* オフライン機能なしでも動く */ });
}
