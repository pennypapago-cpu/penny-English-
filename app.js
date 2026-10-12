'use strict';

/* ========== 資料存放（只存在這支手機的瀏覽器裡） ========== */

const CARDS_KEY = 'ec.cards.v1';
const SETTINGS_KEY = 'ec.settings.v1';
const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;

const DEFAULT_SETTINGS = {
  zhTimes: 1,
  enTimes: 3,
  gap: 2,
  enRate: 0.9,
  lastBackup: 0,
};

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

let cards = loadJSON(CARDS_KEY, []);
// 例句是一個清單 [{ en, zh }]；舊版的單一例句或「看到的原句」自動搬進來
function normalizeCard(c) {
  if (!Array.isArray(c.examples)) {
    c.examples = [];
    const en = c.exampleEn || c.context;
    if (en) c.examples.push({ en, zh: c.exampleZh || '' });
  }
  delete c.exampleEn;
  delete c.exampleZh;
  return c;
}
cards.forEach(normalizeCard);
let settings = Object.assign({}, DEFAULT_SETTINGS, loadJSON(SETTINGS_KEY, {}));

function saveCards() {
  try {
    localStorage.setItem(CARDS_KEY, JSON.stringify(cards));
  } catch (e) {
    toast('儲存失敗：手機空間不足或瀏覽器不允許儲存');
  }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* 忽略 */ }
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function getCard(id) {
  return cards.find((c) => c.id === id);
}

// 卡片順序：手動排過的照 order，沒排過的（新卡）用建立時間排在最上面
function sortKey(c) {
  return typeof c.order === 'number' ? c.order : -c.created;
}
function orderedCards() {
  return cards.slice().sort((a, b) => sortKey(a) - sortKey(b));
}

function upsertCard(card) {
  card.updated = Date.now();
  const i = cards.findIndex((c) => c.id === card.id);
  if (i >= 0) cards[i] = card; else cards.unshift(card);
  saveCards();
}

function deleteCard(id) {
  cards = cards.filter((c) => c.id !== id);
  saveCards();
  imgDel(id);
}

/* ========== 圖片（存在 IndexedDB，空間比 localStorage 大很多） ========== */

let imgDbPromise = null;
function imgDb() {
  if (!imgDbPromise) {
    imgDbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('ec-images', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('images');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return imgDbPromise;
}
async function imgTx(mode, fn) {
  const db = await imgDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('images', mode);
    const req = fn(tx.objectStore('images'));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
  });
}
const imgCache = {}; // 讀過的圖片留在記憶體，畫面重畫時不會閃
async function imgGet(id) {
  if (imgCache[id]) return imgCache[id];
  const d = await imgTx('readonly', (st) => st.get(id)).catch(() => null);
  if (d) imgCache[id] = d;
  return d;
}
function imgPut(id, dataUrl) {
  imgCache[id] = dataUrl;
  return imgTx('readwrite', (st) => st.put(dataUrl, id));
}
function imgDel(id) {
  delete imgCache[id];
  return imgTx('readwrite', (st) => st.delete(id)).catch(() => {});
}
async function imgAll() {
  const out = {};
  for (const c of cards) {
    if (!c.hasImage) continue;
    const d = await imgGet(c.id);
    if (d) out[c.id] = d;
  }
  return out;
}

// 把照片縮小再存（最長邊 900px），一張大約 100KB 上下
function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => {
      const scale = Math.min(1, 900 / Math.max(im.width, im.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(im.width * scale);
      cv.height = Math.round(im.height * scale);
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(im, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      resolve(cv.toDataURL('image/jpeg', 0.8));
    };
    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
    im.src = url;
  });
}

// 畫面畫好後，把 <img data-img="卡片id"> 補上圖片
function loadImages(root) {
  (root || app).querySelectorAll('img[data-img]').forEach(async (el) => {
    const d = await imgGet(el.dataset.img);
    if (d) { el.src = d; el.hidden = false; }
  });
}
function cardImage(card, cls) {
  if (!card || !card.hasImage) return '';
  const cached = imgCache[card.id];
  return cached
    ? `<img class="${cls}" src="${cached}" alt="${esc(card.en)} 的圖片">`
    : `<img class="${cls}" data-img="${esc(card.id)}" alt="${esc(card.en)} 的圖片" hidden>`;
}

function blankCard(type) {
  const now = Date.now();
  return {
    id: newId(), type: type || 'word', en: '', zh: '', context: '', source: '', note: '',
    examples: [], created: now, updated: now, due: now, interval: 0, ease: 2.5, reps: 0, lapses: 0, flagged: false,
  };
}

/* ========== 間隔重複（簡化版 SM-2） ========== */

function nextState(card, grade) {
  const c = Object.assign({}, card);
  const now = Date.now();
  if (grade === 'again') {
    c.reps = 0;
    c.lapses = (c.lapses || 0) + 1;
    c.interval = 0;
    c.ease = Math.max(1.3, c.ease - 0.2);
    c.due = now + 10 * MIN;
  } else if (grade === 'hard') {
    c.interval = Math.max(1, Math.round((c.interval || 1) * 1.2));
    c.ease = Math.max(1.3, c.ease - 0.15);
    c.due = now + c.interval * DAY;
  } else {
    if (c.reps === 0) c.interval = 1;
    else if (c.reps === 1) c.interval = 4;
    else c.interval = Math.round(c.interval * c.ease);
    c.reps += 1;
    c.due = now + c.interval * DAY;
  }
  return c;
}

function describeWait(card, grade) {
  if (grade === 'again') return '10 分鐘後';
  const d = nextState(card, grade).interval;
  if (d <= 1) return '明天';
  if (d < 30) return d + ' 天後';
  return Math.round(d / 30) + ' 個月後';
}

function dueCards() {
  const now = Date.now();
  return cards.filter((c) => c.due <= now).sort((a, b) => a.due - b.due);
}

/* ========== 語音：朗讀與辨識 ========== */

const synth = window.speechSynthesis;
let voices = [];
function refreshVoices() { voices = synth ? synth.getVoices() : []; }
if (synth) {
  refreshVoices();
  synth.addEventListener && synth.addEventListener('voiceschanged', refreshVoices);
}

function pickVoice(lang) {
  const prefs = lang === 'zh' ? ['zh-TW', 'zh-HK', 'zh-CN', 'zh'] : ['en-US', 'en-GB', 'en'];
  for (const p of prefs) {
    const v = voices.find((x) => x.lang && x.lang.replace('_', '-').startsWith(p));
    if (v) return v;
  }
  return null;
}

let lastSpeechStart = 0;

function speak(text, lang, rate) {
  return new Promise((resolve) => {
    if (!synth || !text) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang === 'zh' ? 'zh-TW' : 'en-US';
    const v = pickVoice(lang);
    if (v) u.voice = v;
    u.rate = rate || 1;
    u.onstart = () => { lastSpeechStart = Date.now(); };
    u.onend = () => resolve();
    u.onerror = () => resolve();
    synth.speak(u);
  });
}

function stopSpeaking() {
  if (synth) synth.cancel();
}

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let activeRecognition = null;

function recognize(lang) {
  return new Promise((resolve, reject) => {
    if (!Recognition) {
      reject(new Error('unsupported'));
      return;
    }
    stopSpeaking();
    const r = new Recognition();
    r.lang = lang === 'zh' ? 'zh-TW' : 'en-US';
    r.interimResults = false;
    r.maxAlternatives = 1;
    let text = '';
    r.onresult = (e) => { text = Array.from(e.results).map((x) => x[0].transcript).join(' '); };
    r.onerror = (e) => { activeRecognition = null; reject(new Error(e.error || 'error')); };
    r.onend = () => { activeRecognition = null; resolve(text.trim()); };
    activeRecognition = r;
    r.start();
  });
}

// 按下麥克風按鈕：開始聽，結果交給 onText；再按一次可提早結束
function micButton(btn, lang, onText) {
  btn.addEventListener('click', async () => {
    if (activeRecognition) { activeRecognition.stop(); return; }
    btn.classList.add('listening');
    try {
      const text = await recognize(lang);
      if (text) onText(text);
      else toast('沒有聽到聲音，再試一次');
    } catch (e) {
      if (e.message === 'unsupported') toast('這個瀏覽器不支援語音輸入，請改用鍵盤上的麥克風');
      else if (e.message === 'not-allowed') toast('請允許網頁使用麥克風');
      else toast('語音辨識失敗，請再試一次');
    } finally {
      btn.classList.remove('listening');
    }
  });
}

/* ========== 小工具 ========== */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function sleep(ms, token) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (token && token.cancelled) return resolve();
      if (Date.now() - start >= ms) return resolve();
      setTimeout(tick, 100);
    };
    tick();
  });
}

// 文字框跟著內容自動變高，長段落也能一次看完
function fitTextarea(t) {
  t.style.height = 'auto';
  t.style.height = t.scrollHeight + 2 + 'px';
}
function fitAllTextareas() {
  app.querySelectorAll('textarea').forEach(fitTextarea);
}
document.addEventListener('input', (e) => {
  if (e.target.tagName === 'TEXTAREA') fitTextarea(e.target);
});

const TYPE_LABEL = { word: '單字', phrase: '片語', sentence: '句子' };

const ICON = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  speaker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z"/></svg>',
  headphones: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg>',
  prev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 5v14M19 5L9 12l10 7V5z"/></svg>',
  grip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 8h14M5 12h14M5 16h14"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 5v14M5 5l10 7-10 7V5z"/></svg>',
};

const app = document.getElementById('app');

function topbar(title, backHash, backIcon) {
  return `<div class="topbar">
    <a class="icon-btn plain" href="${backHash || '#'}" aria-label="返回">${backIcon || ICON.back}</a>
    <h1>${esc(title)}</h1>
    <span style="width:44px"></span>
  </div>`;
}

/* ========== 路由 ========== */

let leaveView = null;

function route() {
  if (leaveView) { leaveView(); leaveView = null; }
  document.body.classList.remove('dark');
  const hash = location.hash.replace(/^#/, '');
  const [path, query] = hash.split('?');
  const parts = path.split('/');
  const params = new URLSearchParams(query || '');
  window.scrollTo(0, 0);
  switch (parts[0]) {
    case 'add': return viewEdit(null, params);
    case 'edit': return viewEdit(parts[1], params);
    case 'review': return viewReview(params);
    case 'translate': return viewTranslate();
    case 'listen': return viewListen();
    case 'cards': return viewCards();
    case 'settings': return viewSettings();
    default: return viewHome();
  }
}
window.addEventListener('hashchange', route);

function go(hash) {
  if (location.hash === hash) route(); else location.hash = hash;
}

/* ========== 首頁 ========== */

function viewHome() {
  const due = dueCards().length;
  const minutes = Math.max(1, Math.round(due / 3));
  const recent = cards.slice().sort((a, b) => b.created - a.created).slice(0, 5);
  const needBackup = cards.length > 0 && Date.now() - (settings.lastBackup || 0) > 7 * DAY;
  const d = new Date();
  const week = '日一二三四五六'[d.getDay()];

  app.innerHTML = `
    <div class="row between">
      <div class="stack" style="gap:2px">
        <span class="muted">${d.getMonth() + 1} 月 ${d.getDate()} 日 星期${week}</span>
        <h1>今天也來練英文</h1>
      </div>
      <a class="icon-btn" href="#settings" aria-label="設定與備份">${ICON.gear}</a>
    </div>

    ${needBackup ? `<a class="card" href="#settings" style="text-decoration:none;background:var(--warn-soft);color:var(--warn)">已超過 7 天沒備份，點這裡匯出備份，避免資料遺失。</a>` : ''}

    <section class="hero">
      <span>今天要複習</span>
      <div class="row" style="align-items:baseline"><span class="count">${due}</span><span>張卡片${due ? '・約 ' + minutes + ' 分鐘' : ''}</span></div>
      <a class="btn" href="#review?restart=1">${due ? '開始複習' : '今天的複習完成了'}</a>
      <a class="btn outline" href="#listen">${ICON.headphones}連續播放（自動開始）</a>
    </section>

    <div class="grid2">
      <a class="tile" href="#add">${ICON.plus}<strong>新增卡片</strong><span class="muted">單字、例句、圖片</span></a>
      <a class="tile" href="#translate">${ICON.mic}<strong>中文怎麼說</strong><span class="muted">講中文，學英文說法</span></a>
    </div>

    <div class="row between">
      <h2>最近收集</h2>
      <a href="#cards" class="muted">全部 ${cards.length} 張 ›</a>
    </div>
    <div class="stack">
      ${recent.length ? recent.map(listItem).join('') : '<div class="empty">還沒有卡片。按「新增卡片」記下第一個單字吧。</div>'}
    </div>
  `;
  bindListItems();
}

function listItem(c) {
  const tagClass = c.type === 'sentence' ? 'tag sentence' : 'tag';
  return `<button class="list-item" data-id="${esc(c.id)}">
    <span class="row"><span class="en">${esc(c.en || '（未填英文）')}</span><span class="${tagClass}">${TYPE_LABEL[c.type] || '單字'}</span>${c.hasImage ? '<span class="tag grey">圖</span>' : ''}${c.flagged ? '<span class="tag grey">不熟</span>' : ''}</span>
    <span class="sub">${esc(c.zh)}${c.source ? '・' + esc(c.source) : ''}</span>
  </button>`;
}

function bindListItems() {
  app.querySelectorAll('.list-item').forEach((el) => {
    el.addEventListener('click', () => go('#edit/' + el.dataset.id + '?back=' + encodeURIComponent(location.hash || '#')));
  });
}

/* ========== 全部卡片 ========== */

function viewCards() {
  app.innerHTML = `
    ${topbar('全部卡片', '#')}
    <input type="search" id="q" placeholder="搜尋英文、中文或例句" aria-label="搜尋">
    <p class="muted" id="sort-hint" style="margin:0">按住右邊的 ≡ 上下拖曳，可以調整順序（連續播放也照這個順序）</p>
    <div class="stack" id="list"></div>
  `;
  const q = app.querySelector('#q');
  const list = app.querySelector('#list');
  const draw = () => {
    const k = q.value.trim().toLowerCase();
    const items = orderedCards()
      .filter((c) => !k || [c.en, c.zh, c.source, c.note].concat((c.examples || []).map((x) => x.en + ' ' + x.zh)).join(' ').toLowerCase().includes(k));
    // 搜尋時只顯示部分卡片，不開放拖曳，避免順序亂掉
    app.querySelector('#sort-hint').hidden = !!k || items.length < 2;
    list.innerHTML = items.length
      ? items.map((c) => `<div class="sort-row" data-id="${esc(c.id)}">${listItem(c)}${k ? '' : `<span class="drag-handle" aria-label="拖曳調整順序" role="button" tabindex="0">${ICON.grip}</span>`}</div>`).join('')
      : '<div class="empty">找不到卡片</div>';
    bindListItems();
    if (!k) enableDrag(list);
  };
  q.addEventListener('input', draw);
  draw();
}

function enableDrag(list) {
  list.querySelectorAll('.drag-handle').forEach((handle) => {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const row = handle.closest('.sort-row');
      row.classList.add('dragging');
      const pid = e.pointerId;
      let scrollTimer = null;

      // 監聽整個視窗：卡片在清單裡移位時，瀏覽器會中斷對把手的追蹤
      const move = (ev) => {
        if (ev.pointerId !== pid) return;
        const y = ev.clientY;
        // 拖到畫面邊緣時自動捲動
        clearInterval(scrollTimer);
        if (y < 90) scrollTimer = setInterval(() => window.scrollBy(0, -8), 16);
        else if (y > window.innerHeight - 90) scrollTimer = setInterval(() => window.scrollBy(0, 8), 16);
        for (const other of list.querySelectorAll('.sort-row:not(.dragging)')) {
          const r = other.getBoundingClientRect();
          if (y >= r.top && y <= r.bottom) {
            if (y < r.top + r.height / 2) list.insertBefore(row, other);
            else list.insertBefore(row, other.nextSibling);
            break;
          }
        }
      };
      const up = (ev) => {
        if (ev.pointerId !== pid) return;
        clearInterval(scrollTimer);
        row.classList.remove('dragging');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        const ids = Array.from(list.querySelectorAll('.sort-row')).map((x) => x.dataset.id);
        ids.forEach((id, i) => { const c = getCard(id); if (c) c.order = i; });
        saveCards();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  });
}

/* ========== 新增／編輯卡片 ========== */

function viewEdit(id, params) {
  const existing = id ? getCard(id) : null;
  if (id && !existing) { go('#'); return; }
  const card = existing ? Object.assign({}, existing) : blankCard(params.get('type'));
  if (!existing) {
    if (params.get('en')) card.en = params.get('en');
    if (params.get('zh')) card.zh = params.get('zh');
    if (params.get('note')) card.note = params.get('note');
  }
  const back = params.get('back') || '#';

  app.innerHTML = `
    ${topbar(existing ? '編輯卡片' : '新增卡片', back)}
    <div class="seg" role="group" aria-label="卡片類型">
      ${['word', 'phrase', 'sentence'].map((t) => `<button type="button" data-type="${t}" class="${card.type === t ? 'on' : ''}">${TYPE_LABEL[t]}</button>`).join('')}
    </div>

    <label class="field">英文
      <span class="field-row">
        <input type="text" id="en" class="big-en" autocomplete="off" autocapitalize="off" value="${esc(card.en)}">
        <button type="button" class="icon-btn" id="mic-en" aria-label="用說的輸入英文">${ICON.mic}</button>
        <button type="button" class="icon-btn" id="say-en" aria-label="播放英文發音">${ICON.speaker}</button>
      </span>
    </label>
    <button type="button" class="btn secondary" id="lookup" style="min-height:46px;font-size:15px">${ICON.search}找解釋和生活例句</button>
    <div id="lookup-box" class="stack" hidden></div>

    <label class="field">中文意思
      <span class="field-row">
        <input type="text" id="zh" value="${esc(card.zh)}">
        <button type="button" class="icon-btn" id="mic-zh" aria-label="用說的輸入中文">${ICON.mic}</button>
      </span>
    </label>

    <div class="field">圖片（幫助記憶）
      <div class="img-slot" id="img-slot">
        <img id="img-preview" class="card-img" alt="卡片圖片預覽" hidden>
        <div id="paste-zone" class="paste-zone" contenteditable="true" role="textbox" aria-label="貼上圖片的地方" data-placeholder="長按這裡 → 貼上圖片"></div>
        <div class="row">
          <label class="btn ghost" style="flex:1;cursor:pointer;min-height:44px;font-size:15px">從相簿選擇<input type="file" id="img-file" accept="image/*" hidden></label>
          <button type="button" class="btn danger" id="img-remove" style="min-height:44px;font-size:15px" hidden>移除圖片</button>
        </div>
      </div>
    </div>

    <div class="field">例句
      <div class="stack" id="ex-list"></div>
      <button type="button" class="btn ghost" id="ex-add" style="min-height:46px;font-size:15px;width:100%">${ICON.plus}新增例句</button>
    </div>

    <label class="field">我的筆記
      <textarea id="note" class="tall">${esc(card.note)}</textarea>
    </label>

    <label class="row" style="min-height:44px"><input type="checkbox" id="flagged" ${card.flagged ? 'checked' : ''} style="width:22px;height:22px">標記為「還不熟」</label>

    <div class="spacer"></div>
    <button class="btn" id="save">${existing ? '儲存修改' : '存成卡片'}</button>
    ${existing ? '<button class="btn danger" id="delete">刪除這張卡片</button>' : ''}
  `;

  const $ = (s) => app.querySelector(s);
  fitAllTextareas();
  app.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
    card.type = b.dataset.type;
    app.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
  }));
  micButton($('#mic-en'), 'en', (t) => { $('#en').value = t; });
  micButton($('#mic-zh'), 'zh', (t) => { $('#zh').value = t; });
  // 例句清單：可以自由新增、刪除
  const exs = (card.examples || []).map((x) => ({ en: x.en, zh: x.zh || '' }));
  const drawExamples = (focusLast) => {
    const box = $('#ex-list');
    box.innerHTML = exs.length ? exs.map((x, i) => `
      <div class="ex-edit" data-i="${i}">
        <div class="row between"><span class="muted">例句 ${i + 1}</span>
          <button type="button" class="btn danger ex-del" style="min-height:36px;font-size:13px;padding:0 12px">刪除</button></div>
        <span class="field-row">
          <textarea class="ex-en" placeholder="英文例句" aria-label="例句 ${i + 1} 英文" style="min-height:56px">${esc(x.en)}</textarea>
          <span class="stack" style="gap:6px">
            <button type="button" class="icon-btn ex-mic-en" aria-label="用說的輸入英文例句">${ICON.mic}</button>
            <button type="button" class="icon-btn ex-say" aria-label="播放例句發音">${ICON.speaker}</button>
          </span>
        </span>
        <span class="field-row">
          <textarea class="ex-zh" placeholder="中文翻譯" aria-label="例句 ${i + 1} 中文" style="min-height:56px">${esc(x.zh)}</textarea>
          <button type="button" class="icon-btn ex-mic-zh" aria-label="用說的輸入中文例句">${ICON.mic}</button>
        </span>
      </div>`).join('') : '<span class="muted">還沒有例句。按下面「新增例句」，或用上面的「找解釋和生活例句」。</span>';
    box.querySelectorAll('.ex-edit').forEach((row) => {
      const i = Number(row.dataset.i);
      const en = row.querySelector('.ex-en');
      const zh = row.querySelector('.ex-zh');
      en.addEventListener('input', () => { exs[i].en = en.value; });
      zh.addEventListener('input', () => { exs[i].zh = zh.value; });
      row.querySelector('.ex-del').addEventListener('click', () => { exs.splice(i, 1); drawExamples(); });
      row.querySelector('.ex-say').addEventListener('click', () => { stopSpeaking(); speak(en.value.trim(), 'en', settings.enRate); });
      micButton(row.querySelector('.ex-mic-en'), 'en', (t) => { en.value = t; exs[i].en = t; fitTextarea(en); });
      micButton(row.querySelector('.ex-mic-zh'), 'zh', (t) => { zh.value = t; exs[i].zh = t; fitTextarea(zh); });
      fitTextarea(en);
      fitTextarea(zh);
    });
    if (focusLast) { const last = box.querySelector('.ex-edit:last-child .ex-en'); if (last) last.focus(); }
  };
  $('#ex-add').addEventListener('click', () => { exs.push({ en: '', zh: '' }); drawExamples(true); });
  drawExamples();
  // 給「找解釋和生活例句」用：把選中的例句加進清單
  addExampleToForm = (ex) => {
    if (exs.some((x) => x.en.trim() === ex.en.trim())) { toast('這個例句已經在清單裡'); return; }
    exs.push({ en: ex.en, zh: ex.zh || '' });
    drawExamples();
    toast('已加入例句');
  };
  bindLookup($);

  // 圖片：undefined = 沒動、null = 移除、字串 = 新圖片
  let newImage;
  const showImage = (d) => {
    $('#img-preview').hidden = !d;
    if (d) $('#img-preview').src = d;
    $('#img-remove').hidden = !d;
    $('#paste-zone').dataset.placeholder = d ? '長按這裡 → 貼上換一張' : '長按這裡 → 貼上圖片';
  };
  const takeImage = async (file) => {
    try {
      newImage = await shrinkImage(file);
      showImage(newImage);
    } catch (e) {
      toast('這張圖片讀不出來，換一張試試');
    }
  };
  if (card.hasImage) imgGet(card.id).then((d) => { if (d && newImage === undefined) showImage(d); });
  $('#img-file').addEventListener('change', (e) => { if (e.target.files[0]) takeImage(e.target.files[0]); e.target.value = ''; });
  $('#img-remove').addEventListener('click', () => { newImage = null; showImage(null); });
  $('#paste-zone').addEventListener('paste', (e) => {
    e.preventDefault();
    const item = Array.from((e.clipboardData && e.clipboardData.items) || []).find((x) => x.type.startsWith('image/'));
    if (item) takeImage(item.getAsFile());
    else toast('剪貼簿裡沒有圖片。先在相簿或網頁長按圖片 → 拷貝');
    e.target.textContent = '';
  });
  $('#paste-zone').addEventListener('input', (e) => { e.target.textContent = ''; });
  $('#say-en').addEventListener('click', () => { stopSpeaking(); speak($('#en').value.trim(), 'en', settings.enRate); });

  $('#save').addEventListener('click', () => {
    card.en = $('#en').value.trim();
    card.zh = $('#zh').value.trim();
    card.examples = exs.map((x) => ({ en: x.en.trim(), zh: x.zh.trim() })).filter((x) => x.en);
    card.note = $('#note').value.trim();
    card.flagged = $('#flagged').checked;
    if (!card.en) { toast('請先填英文'); return; }
    if (newImage) { card.hasImage = true; imgPut(card.id, newImage).catch(() => toast('圖片儲存失敗')); }
    else if (newImage === null) { card.hasImage = false; imgDel(card.id); }
    upsertCard(card);
    toast(existing ? '已儲存' : '已新增，今天就會出現在複習裡');
    if (existing) go(back);
    else go('#add?type=' + card.type + '&back=' + encodeURIComponent(back));
  });

  if (existing) {
    $('#delete').addEventListener('click', () => {
      if (!confirm('確定要刪除這張卡片嗎？')) return;
      deleteCard(card.id);
      if (review) review.queue = review.queue.filter((x) => x !== card.id);
      toast('已刪除');
      go(back);
    });
  }
}

/* ========== 找解釋和例句 ========== */

// 免費線上字典：先查維基詞典（Wiktionary），查不到或連不上再查 Free Dictionary
async function fetchJSON(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('http ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function htmlToText(html) {
  const doc = new DOMParser().parseFromString('<div>' + (html || '') + '</div>', 'text/html');
  return doc.body.textContent.replace(/\s+/g, ' ').trim();
}

async function lookupWiktionary(word) {
  const title = word.trim().replace(/\s+/g, '_');
  let data = await fetchJSON('https://en.wiktionary.org/api/rest_v1/page/definition/' + encodeURIComponent(title), 10000);
  // 維基詞典區分大小寫，句首大寫的字再用小寫查一次
  if (!data && title !== title.toLowerCase()) data = await fetchJSON('https://en.wiktionary.org/api/rest_v1/page/definition/' + encodeURIComponent(title.toLowerCase()), 10000);
  const entries = (data && data.en) || [];
  if (!entries.length) return null;
  const out = { found: true, phonetic: '', defs: [], examples: [], source: 'Wiktionary' };
  entries.forEach((e) => (e.definitions || []).forEach((d) => {
    const text = htmlToText(d.definition);
    if (text && out.defs.length < 4) out.defs.push({ pos: (e.partOfSpeech || '').toLowerCase(), text });
    const exs = (d.parsedExamples || []).map((x) => x.example).concat(d.examples || []);
    exs.forEach((ex) => {
      const t = htmlToText(ex);
      // 只留短句，跳過長篇的文學引文
      if (t && t.length <= 140 && out.examples.length < 6 && !out.examples.some((x) => x.en === t)) out.examples.push({ en: t, zh: '' });
    });
  }));
  return out.defs.length ? out : null;
}

async function lookupFreeDictionary(word) {
  const data = await fetchJSON('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word), 10000);
  if (!Array.isArray(data)) return null;
  const out = { found: true, phonetic: '', defs: [], examples: [], source: 'Free Dictionary' };
  data.forEach((entry) => {
    if (!out.phonetic) out.phonetic = entry.phonetic || (entry.phonetics || []).map((x) => x.text).find(Boolean) || '';
    (entry.meanings || []).forEach((m) => (m.definitions || []).forEach((d) => {
      if (out.defs.length < 4 && d.definition) out.defs.push({ pos: m.partOfSpeech || '', text: d.definition });
      if (d.example && out.examples.length < 6 && !out.examples.some((e) => e.en === d.example)) out.examples.push({ en: d.example, zh: '' });
    }));
  });
  return out.defs.length ? out : null;
}

// 回傳 { found, ... }；兩個來源都連不上才丟出錯誤
async function lookupWord(word) {
  let networkFailures = 0;
  for (const source of [lookupWiktionary, lookupFreeDictionary]) {
    try {
      const r = await source(word);
      if (r) return r;
    } catch (e) {
      networkFailures++;
    }
  }
  if (networkFailures === 2) throw new Error('offline');
  return { found: false, defs: [], examples: [] };
}

function buildExamplePrompt(word) {
  return `請給我 3 個使用「${word}」的日常生活英文例句，要簡短自然、真的會在生活中聽到的說法。
每句一行，格式：英文例句｜繁體中文翻譯
不要加編號、符號或其他說明。`;
}

function parseExamples(text) {
  return text.split(/\n+/).map((line) => line.replace(/[*_#>`]/g, '').replace(/^\s*\d+[.)、]\s*/, '').trim())
    .map((line) => {
      const parts = line.split(/\s*[｜|]\s*/);
      return parts.length >= 2 && /[a-z]/i.test(parts[0]) ? { en: parts[0].trim(), zh: parts.slice(1).join(' ').trim() } : null;
    })
    .filter(Boolean)
    .slice(0, 6);
}

let addExampleToForm = () => {};

// 編輯畫面上的「找解釋和生活例句」
function bindLookup($) {
  const box = $('#lookup-box');
  let examples = [];

  const useExample = (ex) => addExampleToForm(ex);

  const exampleList = (list, source) => list.map((ex, i) => `
    <div class="ex-row" data-i="${i}" data-src="${esc(source)}">
      <div style="flex:1;min-width:0"><div style="font-size:16px">${esc(ex.en)}</div>${ex.zh ? `<div class="muted">${esc(ex.zh)}</div>` : ''}</div>
      <button type="button" class="icon-btn ex-say" aria-label="播放這個例句">${ICON.speaker}</button>
      <button type="button" class="btn ghost ex-use" style="min-height:44px;font-size:14px;padding:0 12px">用這句</button>
    </div>`).join('');

  const bindRows = (root, list) => {
    root.querySelectorAll('.ex-row').forEach((row) => {
      const ex = list[Number(row.dataset.i)];
      row.querySelector('.ex-say').addEventListener('click', () => { stopSpeaking(); speak(ex.en, 'en', settings.enRate); });
      row.querySelector('.ex-use').addEventListener('click', () => useExample(ex, row.dataset.src));
    });
  };

  const claudePart = (word) => `
    <div class="stack" style="border-top:1px solid var(--line);padding-top:12px">
      <span class="muted">想要更生活化的例句？請 Claude 寫幾句，再把回答整段貼回來：</span>
      <button type="button" class="btn ghost" id="ask-ex" style="min-height:44px;font-size:15px">${ICON.copy}複製問題並打開 Claude</button>
      <textarea id="ex-paste" placeholder="長按這裡 → 貼上 Claude 的回答" aria-label="貼上 Claude 給的例句" style="min-height:70px"></textarea>
      <div class="stack" id="ex-claude"></div>
    </div>`;

  const bindClaude = (word) => {
    $('#ask-ex').addEventListener('click', async () => {
      const prompt = buildExamplePrompt(word);
      const copying = copyText(prompt);
      window.open('https://claude.ai/new?q=' + encodeURIComponent(prompt), '_blank');
      toast((await copying) ? '已複製，如果 Claude 沒有自動帶入，貼上後送出' : '複製失敗，請手動複製');
    });
    $('#ex-paste').addEventListener('input', (e) => {
      examples = parseExamples(e.target.value);
      const out = $('#ex-claude');
      out.innerHTML = e.target.value.trim() && !examples.length
        ? '<span class="muted">看不懂這段格式，可以直接把例句貼到下面的「例句」欄。</span>'
        : exampleList(examples, 'Claude 生活例句');
      bindRows(out, examples);
    });
  };

  $('#lookup').addEventListener('click', async () => {
    const word = $('#en').value.trim();
    if (!word) { toast('請先輸入英文'); return; }
    box.hidden = false;
    box.className = 'card stack';
    box.innerHTML = '<span class="muted">查詢中…</span>';
    let result = null;
    let failed = false;
    try { result = await lookupWord(word); } catch (e) { failed = true; }

    let html = '';
    if (failed) html += '<span class="muted">兩個線上字典都連不上（可能網路不穩）。可以等一下再按一次，或改用下面的 Claude。</span>';
    else if (!result.found) html += `<span class="muted">字典裡查不到「${esc(word)}」。片語或句子可以改用下面的 Claude。</span>`;
    else {
      html += `<div class="row" style="gap:10px"><strong style="font-size:18px">${esc(word)}</strong>${result.phonetic ? `<span class="muted">${esc(result.phonetic)}</span>` : ''}</div>`;
      html += result.defs.map((d) => `<div style="font-size:14px"><span class="tag grey">${esc(d.pos)}</span> ${esc(d.text)}</div>`).join('');
      html += result.examples.length
        ? `<span class="muted" style="margin-top:6px">字典例句（${esc(result.source)}）</span>` + exampleList(result.examples, result.source)
        : '<span class="muted">字典沒有這個字的例句。</span>';
    }
    html += claudePart(word);
    box.innerHTML = html;
    if (result && result.examples.length) bindRows(box, result.examples);
    bindClaude(word);
  });
}

/* ========== 每日複習 ========== */

let review = null; // { queue: [id], index, revealed, said, total }

function normWords(s) {
  return String(s || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean);
}

function markSaid(said, answer) {
  const target = new Set(normWords(answer));
  return said.split(/\s+/).filter(Boolean).map((w) => {
    const n = normWords(w)[0];
    return n && !target.has(n) ? `<mark>${esc(w)}</mark>` : esc(w);
  }).join(' ');
}

function viewReview(params) {
  if (!review || params.get('restart') === '1' || review.index >= review.queue.length) {
    const queue = dueCards().map((c) => c.id);
    review = { queue, index: 0, revealed: false, said: '', total: queue.length };
  }
  drawReview();
}

function drawReview() {
  // 跳過已被刪除的卡片
  while (review.index < review.queue.length && !getCard(review.queue[review.index])) review.index++;

  if (review.index >= review.queue.length) {
    const done = review.total;
    review = null;
    app.innerHTML = `
      ${topbar('每日複習', '#', ICON.close)}
      <div class="empty"><h2 style="color:var(--ink)">${done ? '今天的複習完成了' : '今天沒有要複習的卡片'}</h2>
      <p>${done ? '辛苦了。想多練習的話，可以用「連續播放」再聽一輪。' : '新增卡片後，它會馬上出現在這裡。'}</p></div>
      <a class="btn secondary" href="#listen">${ICON.headphones}用聽的（連續播放）</a>
      <a class="btn" href="#">回首頁</a>
    `;
    return;
  }

  const card = getCard(review.queue[review.index]);
  const askZh = !!card.zh; // 有中文就看中文說英文；沒有就看英文回想意思
  const pct = Math.round((review.index / review.queue.length) * 100);
  const back = encodeURIComponent('#review');

  app.innerHTML = `
    <div class="row">
      <a class="icon-btn plain" href="#" aria-label="結束複習">${ICON.close}</a>
      <div class="progress"><div style="width:${pct}%"></div></div>
      <span class="muted">${review.index + 1} / ${review.queue.length}</span>
    </div>

    <section class="card">
      <div class="row between">
        <span class="${card.type === 'sentence' ? 'tag sentence' : 'tag'}">${TYPE_LABEL[card.type] || '單字'}・${askZh ? '用講的' : '想意思'}</span>
        <a class="btn ghost" style="min-height:36px;font-size:13px;padding:0 12px" href="#edit/${esc(card.id)}?back=${back}">${ICON.edit}編輯</a>
      </div>
      <span class="muted">${askZh ? '請用英文說：' : '這是什麼意思？'}</span>
      ${cardImage(card, 'card-img')}
      <div class="prompt-zh">${esc(askZh ? card.zh : card.en)}</div>
    </section>

    ${review.said ? `<section class="card"><span class="muted">你剛剛說的</span><div class="said">${markSaid(review.said, card.en)}</div></section>` : ''}

    ${review.revealed ? `
      <section class="card answer">
        <div class="row between">
          <span style="font-size:13px">參考答案</span>
          <span class="row">
            <button class="icon-btn" id="play" aria-label="播放" style="background:var(--accent);border-color:var(--accent);color:#fff">${ICON.speaker}</button>
            <button class="btn ghost" id="slow" style="min-height:44px;font-size:14px;padding:0 14px">慢速</button>
          </span>
        </div>
        <div class="answer-en">${esc(card.en)}</div>
        ${!askZh && card.zh ? `<div>${esc(card.zh)}</div>` : ''}
        ${(card.examples || []).map((x, i) => `<div class="row" style="align-items:flex-start;gap:10px;border-top:1px solid rgba(15,62,62,0.2);padding-top:8px"><div style="flex:1"><div style="font-size:16px;font-weight:500;white-space:pre-line">${esc(x.en)}</div>${x.zh ? `<div style="font-size:14px;white-space:pre-line">${esc(x.zh)}</div>` : ''}</div><button class="icon-btn play-ex" data-i="${i}" aria-label="播放例句 ${i + 1}" style="width:40px;height:40px">${ICON.speaker}</button></div>`).join('')}
        ${card.note ? `<div style="font-size:15px;line-height:1.6;white-space:pre-line;border-top:1px solid rgba(15,62,62,0.2);padding-top:8px">${esc(card.note)}</div>` : ''}
      </section>` : ''}

    <div class="spacer"></div>

    ${askZh ? `<div class="stack" style="align-items:center">
      <button class="icon-btn big dark" id="speak" aria-label="開口說英文">${ICON.mic}</button>
      <span class="muted">${review.said ? '再講一次' : '按下後開口說英文'}</span>
    </div>` : ''}

    ${review.revealed ? `
      <div class="grid3 grade">
        <button class="again" data-g="again"><strong>忘了</strong><span>${describeWait(card, 'again')}</span></button>
        <button data-g="hard"><strong>模糊</strong><span>${describeWait(card, 'hard')}</span></button>
        <button class="good" data-g="good"><strong>記得</strong><span>${describeWait(card, 'good')}</span></button>
      </div>` : `<button class="btn secondary" id="reveal">看答案</button>`}
  `;

  loadImages();
  const $ = (s) => app.querySelector(s);
  if ($('#reveal')) $('#reveal').addEventListener('click', () => {
    review.revealed = true;
    drawReview();
    speak(card.en, 'en', settings.enRate);
  });
  if ($('#play')) $('#play').addEventListener('click', () => { stopSpeaking(); speak(card.en, 'en', settings.enRate); });
  if ($('#slow')) $('#slow').addEventListener('click', () => { stopSpeaking(); speak(card.en, 'en', 0.6); });
  app.querySelectorAll('.play-ex').forEach((b) => b.addEventListener('click', () => { stopSpeaking(); speak(card.examples[Number(b.dataset.i)].en, 'en', settings.enRate); }));
  if ($('#speak')) micButton($('#speak'), 'en', (t) => {
    const firstTry = !review.revealed;
    review.said = t;
    review.revealed = true;
    drawReview();
    if (firstTry) speak(card.en, 'en', settings.enRate);
  });
  app.querySelectorAll('.grade button').forEach((b) => b.addEventListener('click', () => {
    stopSpeaking();
    const updated = nextState(card, b.dataset.g);
    upsertCard(updated);
    if (b.dataset.g === 'again') review.queue.push(card.id); // 這輪結束前再出現一次
    review.index++;
    review.revealed = false;
    review.said = '';
    drawReview();
  }));
}

/* ========== 中文怎麼說 ========== */

let translateDraft = { zh: '', pasted: '', options: [], tip: '', picked: -1 };

function buildPrompt(zh) {
  return `我想用英文表達下面這句中文，請給我三種自然的英文說法：口語、一般、正式。
請只用以下格式回覆，每種一行，不要加其他說明或符號：
口語：（英文）
一般：（英文）
正式：（英文）
重點：（用繁體中文，一兩句說明最值得學的用字）

中文：${zh}`;
}

function parseAnswer(text) {
  const options = [];
  let tip = '';
  text.split(/\n+/).forEach((line) => {
    const m = line.replace(/[*_#>`]/g, '').trim().match(/^(口語|一般|正式|重點)\s*[:：]\s*(.+)$/);
    if (!m) return;
    if (m[1] === '重點') tip = m[2].trim();
    else options.push({ style: m[1], en: m[2].trim() });
  });
  return { options, tip };
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
    ta.remove();
    return ok;
  }
}

function viewTranslate() {
  const d = translateDraft;
  app.innerHTML = `
    ${topbar('中文怎麼說', '#')}

    <div class="step"><b>1</b>說出你想表達的中文</div>
    <div class="field-row">
      <textarea id="zh" placeholder="例如：我最近工作很忙，忙到沒時間運動。" aria-label="中文" style="min-height:70px">${esc(d.zh)}</textarea>
      <button class="icon-btn dark" id="mic" aria-label="用說的輸入中文">${ICON.mic}</button>
    </div>

    <div class="step"><b>2</b>複製問題，到 Claude 貼上</div>
    <button class="btn secondary" id="ask">${ICON.copy}複製並打開 Claude</button>

    <div class="step"><b>3</b>把 Claude 的回答整段貼回來</div>
    <textarea id="pasted" placeholder="長按這裡 → 貼上" aria-label="貼上 Claude 的回答">${esc(d.pasted)}</textarea>

    <div class="stack" id="options"></div>
    <div class="spacer"></div>
    <button class="btn" id="save" ${d.picked < 0 ? 'disabled' : ''}>存成卡片，之後練習</button>
  `;

  const $ = (s) => app.querySelector(s);
  const drawOptions = () => {
    const box = $('#options');
    if (!d.pasted.trim()) { box.innerHTML = ''; return; }
    if (!d.options.length) {
      box.innerHTML = '<div class="muted">看不懂這段回答的格式。你也可以直接到「新增卡片」手動輸入。</div>';
      return;
    }
    box.innerHTML = d.options.map((o, i) => `
      <button class="card selectable ${d.picked === i ? 'selected' : ''}" data-i="${i}">
        <span class="row between"><span class="${i === 0 ? 'tag' : 'tag grey'}">${esc(o.style)}</span>${d.picked === i ? '<span style="color:var(--accent);font-weight:700;font-size:13px">已選</span>' : ''}</span>
        <span style="font-size:16px;font-weight:${d.picked === i ? 700 : 400}">${esc(o.en)}</span>
      </button>`).join('') + (d.tip ? `<div class="card" style="font-size:14px">重點：${esc(d.tip)}</div>` : '');
    box.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => {
      d.picked = Number(b.dataset.i);
      $('#save').disabled = false;
      drawOptions();
      speak(d.options[d.picked].en, 'en', settings.enRate);
    }));
  };

  $('#zh').addEventListener('input', (e) => { d.zh = e.target.value; });
  micButton($('#mic'), 'zh', (t) => { d.zh = t; $('#zh').value = t; fitTextarea($('#zh')); });

  $('#ask').addEventListener('click', async () => {
    const zh = $('#zh').value.trim();
    if (!zh) { toast('請先說或輸入中文'); return; }
    d.zh = zh;
    const prompt = buildPrompt(zh);
    // 先開視窗再等複製結果，避免手機瀏覽器擋掉彈出視窗
    const copying = copyText(prompt);
    window.open('https://claude.ai/new?q=' + encodeURIComponent(prompt), '_blank');
    const ok = await copying;
    toast(ok ? '已複製，如果 Claude 沒有自動帶入，貼上後送出' : '複製失敗，請手動複製');
  });

  $('#pasted').addEventListener('input', (e) => {
    d.pasted = e.target.value;
    const r = parseAnswer(d.pasted);
    d.options = r.options;
    d.tip = r.tip;
    d.picked = d.options.length ? 0 : -1;
    $('#save').disabled = d.picked < 0;
    drawOptions();
  });

  $('#save').addEventListener('click', () => {
    const o = d.options[d.picked];
    if (!o) return;
    const card = blankCard('sentence');
    card.en = o.en;
    card.zh = d.zh.trim();
    card.source = '中文怎麼說';
    card.note = o.style + (d.tip ? '・' + d.tip : '');
    upsertCard(card);
    translateDraft = { zh: '', pasted: '', options: [], tip: '', picked: -1 };
    toast('已存成卡片');
    viewTranslate();
  });

  drawOptions();
  fitAllTextareas();
}

/* ========== 連續播放：一進來就自動播，播完從頭循環，不放按鈕 ========== */

let player = null; // { list:[id], index, enDone, phase, token }
let wakeLock = null;

async function lockScreenOn() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) { wakeLock = null; }
}
function releaseScreen() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && player && player.token) lockScreenOn();
});

// iPhone 的瀏覽器只允許在「點擊當下」開始朗讀，所以在點進連續播放的那一下先解鎖
function unlockSpeech() {
  if (!synth) return;
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  synth.speak(u);
}
document.addEventListener('click', (e) => {
  if (e.target.closest && e.target.closest('a[href="#listen"]')) unlockSpeech();
}, true);

function viewListen() {
  document.body.classList.add('dark');
  const list = orderedCards().map((c) => c.id);
  player = { list, index: 0, enDone: 0, phase: 'idle', token: null, needTap: false };
  leaveView = () => { stopPlayer(); releaseScreen(); };
  drawListen();
  if (list.length) runPlayer();
}

function drawListen() {
  const p = player;
  const card = getCard(p.list[p.index]);
  const nextCard = getCard(p.list[(p.index + 1) % p.list.length]);
  const dots = Array.from({ length: settings.enTimes }, (_, i) => `<span class="${i < p.enDone ? 'on' : ''}"></span>`).join('');

  app.innerHTML = `
    <div class="listen stack" id="listen" style="gap:18px;flex-grow:1">
      <div class="topbar">
        <a class="icon-btn plain" href="#" aria-label="返回首頁">${ICON.back}</a>
        <h1>連續播放</h1>
        <span class="label" style="width:44px;text-align:right">${p.list.length ? (p.index + 1) + ' / ' + p.list.length : ''}</span>
      </div>
      ${card ? `
        <div class="stack" style="gap:24px;flex-grow:1;justify-content:center">
          ${cardImage(card, 'card-img listen-img')}
          <div class="stack"><span class="label">中文</span><div class="zh">${esc(card.zh || '（沒有中文）')}</div></div>
          <div class="stack" style="gap:10px">
            <span class="label">英文${p.phase === 'en' ? '・第 ' + Math.min(p.enDone + 1, settings.enTimes) + ' 次' : ''}</span>
            <div class="en">${esc(card.en)}</div>
            <div class="dots">${dots}</div>
          </div>
          ${(card.examples || []).length ? `<div class="stack" style="gap:10px">
            <span class="label">例句</span>
            ${card.examples.map((x, i) => { const on = p.phase === 'ex' && p.exIndex === i; return `<div class="stack" style="gap:2px">
              <div style="font-size:18px;line-height:1.45;${on ? 'color:#fff;font-weight:700' : 'color:#D9E6E7'}">${esc(x.en)}</div>
              ${x.zh ? `<div style="font-size:14px;color:#B9CCCF">${esc(x.zh)}</div>` : ''}
            </div>`; }).join('')}
          </div>` : ''}
          ${p.list.length > 1 ? `<span class="label">下一張：${esc(nextCard.en)}</span>` : ''}
        </div>
        <p class="label" style="text-align:center;margin:0">${p.needTap ? '沒有聲音的話，點一下畫面開始' : '會一直循環播放，按左上角離開'}</p>
      ` : `<div class="empty" style="color:#B9CCCF">還沒有卡片。<br>先到「新增卡片」記幾個單字吧。</div>`}
    </div>
  `;

  // 備援：如果手機擋住了自動朗讀，點畫面任何地方就重新開始
  loadImages();
  const box = app.querySelector('#listen');
  if (card) box.addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    if (!p.needTap) return;
    unlockSpeech();
    p.needTap = false;
    runPlayer();
  });
}

function stopPlayer() {
  if (!player) return;
  if (player.token) player.token.cancelled = true;
  player.token = null;
  player.phase = 'idle';
  stopSpeaking();
}

async function runPlayer() {
  const p = player;
  stopPlayer();
  const token = { cancelled: false };
  p.token = token;
  p.enDone = 0;
  lockScreenOn();

  // 兩秒內都沒開始發聲，代表手機擋住了自動朗讀，顯示「點一下畫面」提示
  const startedAt = Date.now();
  setTimeout(() => {
    if (!token.cancelled && lastSpeechStart < startedAt) { p.needTap = true; drawListen(); }
  }, 2000);

  while (!token.cancelled) {
    if (!p.list.length) return;
    const card = getCard(p.list[p.index]);
    if (card) {
      p.phase = 'zh';
      p.enDone = 0;
      drawListen();
      for (let i = 0; i < settings.zhTimes && card.zh && !token.cancelled; i++) {
        await speak(card.zh, 'zh', 1);
        await sleep(700, token);
      }
      p.phase = 'en';
      for (let i = 0; i < settings.enTimes && !token.cancelled; i++) {
        drawListen();
        await speak(card.en, 'en', settings.enRate);
        if (token.cancelled) break;
        p.enDone = i + 1;
        drawListen();
        const last = i === settings.enTimes - 1;
        const hasEx = (card.examples || []).length > 0;
        await sleep(!last ? 900 : hasEx ? 1000 : settings.gap * 1000, token);
      }
      // 每個例句：中文 1 次、英文 2 次
      const exList = card.examples || [];
      for (let e = 0; e < exList.length && !token.cancelled; e++) {
        p.phase = 'ex';
        p.exIndex = e;
        drawListen();
        if (exList[e].zh) { await speak(exList[e].zh, 'zh', 1); await sleep(700, token); }
        for (let i = 0; i < 2 && !token.cancelled; i++) {
          await speak(exList[e].en, 'en', settings.enRate);
          await sleep(i === 0 || e < exList.length - 1 ? 1000 : settings.gap * 1000, token);
        }
      }
    }
    if (token.cancelled) return;
    p.index = (p.index + 1) % p.list.length; // 播完最後一張就回到第一張
  }
}

/* ========== 設定與備份 ========== */

function viewSettings() {
  const last = settings.lastBackup ? new Date(settings.lastBackup).toLocaleString('zh-TW') : '從未備份';
  const voiceInfo = Recognition ? '支援' : '不支援（請用鍵盤上的麥克風輸入）';
  app.innerHTML = `
    ${topbar('設定與備份', '#')}
    <section class="card">
      <h2>備份</h2>
      <p class="muted" style="margin:0">卡片只存在這支手機的瀏覽器裡。清除瀏覽器資料或換手機時會不見，請定期匯出備份檔，存到雲端硬碟或傳給自己。</p>
      <span class="muted">上次備份：${esc(last)}・共 ${cards.length} 張</span>
      <button class="btn" id="export">匯出備份檔</button>
      <label class="btn ghost" style="cursor:pointer">匯入備份檔<input type="file" id="import" accept="application/json,.json" style="display:none"></label>
    </section>
    <section class="card">
      <h2>這支手機的語音功能</h2>
      <span class="muted">朗讀：${synth ? '支援' : '不支援'}</span>
      <span class="muted">語音輸入：${voiceInfo}</span>
      <button class="btn ghost" id="test">測試朗讀</button>
    </section>
    <section class="card">
      <h2>加到主畫面</h2>
      <p class="muted" style="margin:0">iPhone：用 Safari 打開，按分享 → 加入主畫面。Android：用 Chrome 打開，按右上角選單 → 加到主畫面。之後就能像 App 一樣打開。</p>
    </section>
  `;
  const $ = (s) => app.querySelector(s);
  $('#export').addEventListener('click', async () => {
    const images = await imgAll();
    const data = JSON.stringify({ app: 'english-cards', version: 2, exported: Date.now(), cards, images }, null, 1);
    const blob = new Blob([data], { type: 'application/json' });
    const a = document.createElement('a');
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    a.href = URL.createObjectURL(blob);
    a.download = `english-cards-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    settings.lastBackup = Date.now();
    saveSettings();
    toast('已匯出備份檔');
    viewSettings();
  });
  $('#import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const incoming = Array.isArray(data) ? data : data.cards;
      if (!Array.isArray(incoming)) throw new Error('format');
      let added = 0;
      let updated = 0;
      incoming.forEach((c) => {
        if (!c || !c.id || !c.en) return;
        const cur = getCard(c.id);
        normalizeCard(c);
        if (!cur) { cards.push(Object.assign(blankCard(c.type), c)); added++; }
        else if ((c.updated || 0) > (cur.updated || 0)) { Object.assign(cur, c); updated++; }
      });
      const imgs = (data && data.images) || {};
      for (const id of Object.keys(imgs)) {
        if (getCard(id) && typeof imgs[id] === 'string' && imgs[id].startsWith('data:image/')) {
          await imgPut(id, imgs[id]);
          imgCache[id] = imgs[id];
        }
      }
      saveCards();
      toast(`匯入完成：新增 ${added} 張，更新 ${updated} 張`);
      viewSettings();
    } catch (err) {
      toast('這個檔案不是有效的備份檔');
    }
  });
  $('#test').addEventListener('click', async () => {
    await speak('你好，這是中文測試。', 'zh', 1);
    await speak('Hello, this is an English test.', 'en', settings.enRate);
  });
}

/* ========== 啟動 ========== */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
route();
