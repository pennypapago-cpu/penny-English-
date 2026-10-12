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
    created: now, updated: now, due: now, interval: 0, ease: 2.5, reps: 0, lapses: 0, flagged: false,
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
      <a class="tile" href="#add">${ICON.plus}<strong>新增卡片</strong><span class="muted">單字、句子、出處</span></a>
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
    <input type="search" id="q" placeholder="搜尋英文、中文或出處" aria-label="搜尋">
    <div class="stack" id="list"></div>
  `;
  const q = app.querySelector('#q');
  const list = app.querySelector('#list');
  const draw = () => {
    const k = q.value.trim().toLowerCase();
    const items = cards
      .filter((c) => !k || [c.en, c.zh, c.source, c.note, c.context].join(' ').toLowerCase().includes(k))
      .sort((a, b) => b.created - a.created);
    list.innerHTML = items.length ? items.map(listItem).join('') : '<div class="empty">找不到卡片</div>';
    bindListItems();
  };
  q.addEventListener('input', draw);
  draw();
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

    <label class="field">看到的原句（上下文）
      <textarea id="context">${esc(card.context)}</textarea>
    </label>

    <label class="field">出處
      <input type="text" id="source" placeholder="網站、影片、書名或網址" value="${esc(card.source)}">
    </label>

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
    card.context = $('#context').value.trim();
    card.source = $('#source').value.trim();
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
        ${card.context ? `<div style="font-size:14px">原句：${esc(card.context)}</div>` : ''}
        ${card.source ? `<div style="font-size:13px">出處：${esc(card.source)}</div>` : ''}
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
  const list = cards.slice().sort((a, b) => b.created - a.created).map((c) => c.id);
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
        await sleep(i < settings.enTimes - 1 ? 900 : settings.gap * 1000, token);
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
