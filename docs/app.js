'use strict';

/* ================= helpers ================= */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pick = a => a[Math.floor(Math.random() * a.length)];
const today = () => Math.floor((Date.now() - new Date().getTimezoneOffset() * 60000) / 86400000);
const dayLabel = d => { const t = new Date(d * 86400000); return `${t.getUTCMonth() + 1}/${t.getUTCDate()}`; };
const TIER = { 1: '核心', 2: '進階', 3: '冷僻' };
const MASTERED = 21; // interval (days) at which a word counts as mastered

function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ================= state ================= */
const KEY = 'satvocab.v1';
const DEFAULTS = { dailyNew: 20, tiers: [1, 2, 3], cloze: true, listen: true, rate: 0.85, voice: '', autoSpeak: true };
let S = loadState();

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && s.cards) return { settings: { ...DEFAULTS, ...s.settings }, cards: s.cards, log: s.log || {}, seed: s.seed || 'x' };
  } catch (e) { /* storage unavailable or corrupt: start fresh */ }
  return { settings: { ...DEFAULTS }, cards: {}, log: {}, seed: Math.random().toString(36).slice(2) };
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast('無法儲存進度'); }
}
function logToday() { const d = today(); return (S.log[d] ||= { n: 0, r: 0, ok: 0, bad: 0 }); }
function status(w) { const c = S.cards[w]; return !c ? 'new' : c.ivl >= MASTERED ? 'mastered' : 'learning'; }

/* ================= data ================= */
let W = [];
const byWord = new Map();
const families = new Map(); // root key -> [entries]

function rootKeys(e) {
  return (e.root?.parts || [])
    .filter(p => !p.p.startsWith('-') && !/加強語氣/.test(p.m))
    .map(p => p.p.toLowerCase());
}

async function loadWords() {
  const res = await fetch('words.json');
  W = await res.json();
  for (const e of W) {
    byWord.set(e.w.toLowerCase(), e);
    for (const k of rootKeys(e)) { if (!families.has(k)) families.set(k, []); families.get(k).push(e); }
  }
}
const find = w => byWord.get(String(w).toLowerCase());

/* ================= speech ================= */
const tts = { ok: 'speechSynthesis' in window, voices: [] };
// macOS/iOS ship novelty voices (robotic, singing, whispering) that sound awful for learning.
const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Wobble|Fred|Good News|Jester|Junior|Kathy|Organ|Superstar|Ralph|Trinoids|Whisper|Zarvox|Eddy|Flo|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley)\b/i;
const PREFERRED = ['Ava', 'Samantha', 'Allison', 'Susan', 'Zoe', 'Evan', 'Nathan', 'Tom', 'Joelle', 'Noelle', 'Nicky', 'Alex',
  'Google US English', 'Microsoft Aria', 'Microsoft Jenny', 'Microsoft Guy', 'Microsoft Zira', 'Daniel', 'Karen', 'Moira'];
function voiceScore(v) {
  let s = 0;
  if (/premium/i.test(v.name)) s += 60;
  else if (/enhanced|siri|natural|neural/i.test(v.name)) s += 40;
  const k = PREFERRED.findIndex(n => v.name.startsWith(n));
  if (k >= 0) s += 30 - k;
  if (/^en[-_]US/i.test(v.lang)) s += 10;
  if (v.localService) s += 5; // works offline
  return s;
}
function loadVoices() {
  if (!tts.ok) return;
  tts.voices = speechSynthesis.getVoices()
    .filter(v => /^en[-_]/i.test(v.lang) && !NOVELTY.test(v.name))
    .sort((a, b) => voiceScore(b) - voiceScore(a));
}
if (tts.ok) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }
function voice() {
  return tts.voices.find(v => v.voiceURI === S.settings.voice) || tts.voices[0];
}
function speak(text, rate) {
  if (!tts.ok) return toast('這個瀏覽器不支援發音');
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const v = voice();
  if (v) u.voice = v;
  u.lang = v?.lang || 'en-US';
  u.rate = rate || S.settings.rate;
  speechSynthesis.speak(u);
}

/* ================= scheduling ================= */
function newCard() { return { ivl: 0, ease: 2.5, reps: 0, due: today(), lapses: 0, right: 0, wrong: 0, mk: 0, intro: today() }; }
function grade(c, ok) {
  if (ok) {
    c.reps++;
    c.ivl = c.reps === 1 ? 1 : c.reps === 2 ? 3 : Math.round(c.ivl * c.ease);
    c.ease = Math.min(3, c.ease + 0.05);
  } else {
    c.reps = 0; c.ivl = 1; c.lapses++;
    c.ease = Math.max(1.3, c.ease - 0.2);
  }
  c.due = today() + c.ivl;
}
function newQueue() {
  const t = S.settings.tiers;
  return W.filter(e => !S.cards[e.w] && t.includes(e.tier))
    .sort((a, b) => a.tier - b.tier || hash(a.w + S.seed) - hash(b.w + S.seed));
}
const dueList = () => W.filter(e => S.cards[e.w] && S.cards[e.w].due <= today())
  .sort((a, b) => S.cards[a.w].due - S.cards[b.w].due);
const newLeft = () => Math.max(0, S.settings.dailyNew - logToday().n);

/* ================= quiz generation ================= */
function bigrams(s) { s = s.toLowerCase(); const r = []; for (let i = 0; i < s.length - 1; i++) r.push(s.slice(i, i + 2)); return r; }
function sim(a, b) {
  const A = bigrams(a), B = bigrams(b); if (!A.length || !B.length) return 0;
  const m = new Map(); A.forEach(x => m.set(x, (m.get(x) || 0) + 1));
  let n = 0; B.forEach(x => { if (m.get(x) > 0) { n++; m.set(x, m.get(x) - 1); } });
  let p = 0; while (p < a.length && p < b.length && a[p].toLowerCase() === b[p].toLowerCase()) p++;
  return 2 * n / (A.length + B.length) + Math.min(p, 4) * 0.08;
}
function distractors(e, type) {
  const me = e.w.toLowerCase();
  const syn = new Set(e.syn.map(s => s.toLowerCase()));
  const pos = e.senses[0].pos;
  // Exclude words that could also fit: listed synonyms, or words sharing a synonym with the target.
  const ok = x => x !== e && !syn.has(x.w.toLowerCase())
    && !x.syn.some(s => s.toLowerCase() === me || syn.has(s.toLowerCase()));
  let pool = W.filter(x => ok(x) && (type === 'listen' || x.senses[0].pos === pos));
  if (pool.length < 3) pool = W.filter(ok);
  const noise = type === 'listen' ? 0.25 : 0.6;
  return pool.map(x => ({ x, s: sim(e.w, x.w) + (x.tier === e.tier ? 0.1 : 0) + Math.random() * noise }))
    .sort((a, b) => b.s - a.s).slice(0, 3).map(o => o.x);
}
function quizTypes() {
  const t = [];
  if (S.settings.cloze) t.push('cloze');
  if (S.settings.listen && tts.ok) t.push('listen');
  return t.length ? t : ['cloze'];
}
function makeQuiz(e, force) {
  const type = force === 'listen' && !tts.ok ? 'cloze' : force || pick(quizTypes());
  return { type, e, options: shuffle([e, ...distractors(e, type)]) };
}
function clozeHTML(e) {
  const re = new RegExp(`(?<![A-Za-z])${escRe(e.w)}(?![A-Za-z])`, 'i');
  const [before, after] = e.ex[0].en.split(re);
  return `${esc(before)}<span class="blank">&nbsp;</span>${esc(after ?? '')}`;
}
function exampleHTML(x, w) {
  const re = new RegExp(`(?<![A-Za-z])(${escRe(w)})(?![A-Za-z])`, 'gi');
  return esc(x.en).replace(re, '<mark>$1</mark>');
}

/* ================= shared renderers ================= */
function speakBtn(text, cls = '') {
  return `<button class="icon-btn ${cls}" data-speak="${esc(text)}" aria-label="播放發音">🔊</button>`;
}
function tierBadge(t) { return `<span class="tier t${t}">${TIER[t]}</span>`; }
function sensesHTML(e) {
  return e.senses.map(s => `<div class="sense"><span class="pos">${esc(s.pos)}</span><span class="zh">${esc(s.zh)}</span><div class="en">${esc(s.en)}</div></div>`).join('');
}
function examplesHTML(e) {
  return e.ex.map(x => `<div class="example"><div class="row"><div class="en" style="flex:1">${exampleHTML(x, e.w)}</div>${speakBtn(x.en)}</div><div class="zh">${esc(x.zh)}</div></div>`).join('');
}
function wordLink(w) {
  const e = find(w);
  return e ? `<a class="chip" href="#/word/${encodeURIComponent(e.w)}">${esc(w)}</a>` : `<span class="chip">${esc(w)}</span>`;
}
function rootHTML(e) {
  if (!e.root) return '';
  const parts = e.root.parts.map(p => `<div class="root"><b>${esc(p.p)}</b><span>${esc(p.m)}</span></div>`).join('<span class="root-plus">+</span>');
  let fam = '';
  for (const k of rootKeys(e)) {
    const others = (families.get(k) || []).filter(x => x !== e).slice(0, 12);
    if (others.length) fam += `<div class="small muted" style="margin-top:10px">同樣有 <b>${esc(k)}</b> 的字</div><div class="chips" style="margin-top:4px">${others.map(x => wordLink(x.w)).join('')}</div>`;
  }
  return `<div class="section-title">字根拆解</div><div class="roots">${parts}</div>${e.root.note ? `<p class="small" style="margin:8px 0 0">${esc(e.root.note)}</p>` : ''}${fam}`;
}
function wordDetailHTML(e, { compact = false } = {}) {
  const syn = e.syn.length ? `<div class="section-title">同義字</div><div class="chips">${e.syn.map(wordLink).join('')}</div>` : '';
  const ant = e.ant.length ? `<div class="section-title">反義字</div><div class="chips">${e.ant.map(wordLink).join('')}</div>` : '';
  const mn = e.mn ? `<div class="section-title">記憶口訣</div><div class="mn">${esc(e.mn)}</div>` : '';
  return `
    <div class="hw"><span class="word">${esc(e.w)}</span>${speakBtn(e.w)}</div>
    <div class="row" style="margin:6px 0 4px"><span class="kk">${esc(e.kk)}</span>${tierBadge(e.tier)}</div>
    ${sensesHTML(e)}
    <div class="section-title">例句</div>${examplesHTML(e)}
    ${compact ? '' : rootHTML(e) + syn + ant}
    ${mn}`;
}

/* ================= router ================= */
const routes = {};
let cleanup = null;
function go(hash) { location.hash = hash; }
function render() {
  if (cleanup) { cleanup(); cleanup = null; }
  if (tts.ok) speechSynthesis.cancel();
  const [, name = 'home', arg] = location.hash.match(/^#\/([^/]*)\/?(.*)$/) || [];
  const fn = routes[name] || routes.home;
  document.body.classList.toggle('focus', ['session', 'flash', 'spell', 'quiz'].includes(name));
  const tab = { word: 'words', mistakes: 'practice', quiz: 'practice', flash: 'practice', spell: 'practice' }[name] || name;
  $$('#tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  fn(decodeURIComponent(arg || ''));
  window.scrollTo(0, 0);
}
const view = html => { $('#view').innerHTML = html; };

document.addEventListener('click', e => {
  const b = e.target.closest('[data-speak]');
  if (b) { e.preventDefault(); e.stopPropagation(); speak(b.dataset.speak); }
  const back = e.target.closest('[data-back]');
  if (back) { e.preventDefault(); history.length > 1 ? history.back() : go('#/home'); }
});

/* ================= home ================= */
routes.home = () => {
  const due = dueList().length;
  const nl = Math.min(newLeft(), newQueue().length);
  const learned = Object.keys(S.cards).length;
  const mastered = Object.values(S.cards).filter(c => c.ivl >= MASTERED).length;
  const mistakes = Object.values(S.cards).filter(c => c.mk).length;
  const done = due === 0 && nl === 0;
  view(`
    <h1>今日學習</h1>
    <div class="hero">
      <div class="stat"><b>${due}</b><span>待複習</span></div>
      <div class="stat"><b>${nl}</b><span>新字（每日 ${S.settings.dailyNew}）</span></div>
      <div class="stat"><b>${streak()}</b><span>連續天數</span></div>
      <div class="stat"><b>${mastered}<small class="muted" style="font-size:1rem"> / ${learned}</small></b><span>已精熟 / 已學</span></div>
    </div>
    ${done
      ? `<div class="card center stack"><div style="font-size:2rem">🎉</div><div><b>今天的進度完成了！</b></div>
         <button class="btn block" id="more" ${newQueue().length ? '' : 'disabled'}>再多學 5 個新字</button></div>`
      : `<button class="btn primary block" id="start" style="min-height:56px;font-size:1.1rem">開始學習</button>`}
    <h2>練習</h2>
    <div class="links">
      <a class="tile" href="#/quiz"><span class="ti">✓</span>測驗</a>
      <a class="tile" href="#/flash"><span class="ti">❏</span>閃卡</a>
      <a class="tile" href="#/spell"><span class="ti">✎</span>拼字</a>
      <a class="tile" href="#/mistakes"><span class="ti">✕</span>錯題本<br><small>${mistakes} 個字</small></a>
    </div>
    <p class="small muted center" style="margin-top:24px">單字庫：${W.length} / 5002 字</p>`);
  $('#start')?.addEventListener('click', () => go('#/session'));
  $('#more')?.addEventListener('click', () => go('#/session/extra'));
};

function streak() {
  let d = today(), n = 0;
  const active = x => S.log[x] && (S.log[x].n + S.log[x].r) > 0;
  if (!active(d)) d--;
  while (active(d)) { n++; d--; }
  return n;
}

/* ================= study session ================= */
// Items: {k:'learn', e} shows a new word; {k:'quiz', e, graded, isNew} asks a question.
function buildSession(extra) {
  const reviews = extra ? [] : shuffle(dueList());
  const fresh = newQueue().slice(0, extra ? 5 : newLeft());
  const q = [];
  for (let i = 0; i < fresh.length; i += 5) {
    const chunk = fresh.slice(i, i + 5);
    chunk.forEach(e => q.push({ k: 'learn', e }));
    const group = chunk.map(e => ({ k: 'quiz', e, isNew: true }));
    group.push(...reviews.splice(0, 5).map(e => ({ k: 'quiz', e })));
    q.push(...shuffle(group));
  }
  q.push(...reviews.map(e => ({ k: 'quiz', e })));
  return q;
}

routes.session = arg => {
  const q = buildSession(arg === 'extra');
  const total = q.length;
  const res = { ok: 0, bad: 0, wrong: new Set(), learned: 0 };
  let i = 0;
  if (!total) { go('#/home'); return; }

  const onKey = ev => {
    if (ev.target.tagName === 'INPUT') return;
    const n = parseInt(ev.key, 10);
    const opts = $$('.opt:not(:disabled)');
    if (n >= 1 && n <= 4 && opts[n - 1]) opts[n - 1].click();
    else if (ev.key === 'Enter' || ev.key === ' ') { const b = $('#next'); if (b) { ev.preventDefault(); b.click(); } }
  };
  document.addEventListener('keydown', onKey);
  cleanup = () => document.removeEventListener('keydown', onKey);

  const top = () => `<div class="topbar"><button class="back" data-back>✕</button>
    <div class="progress"><div style="width:${Math.round(i / total * 100)}%"></div></div>
    <span class="small muted">${Math.min(i + 1, total)}/${total}</span></div>`;

  function next() {
    if (i >= q.length) return finish();
    const it = q[i];
    it.k === 'learn' ? showLearn(it) : showQuiz(it);
  }

  function showLearn(it) {
    const e = it.e;
    if (!S.cards[e.w]) { S.cards[e.w] = newCard(); logToday().n++; res.learned++; save(); }
    view(`${top()}<div class="qlabel">新字</div><div class="card">${wordDetailHTML(e)}</div>
      <button class="btn primary block sticky-next" id="next">記住了，下一個</button>`);
    if (S.settings.autoSpeak) speak(e.w);
    $('#next').onclick = () => { i++; next(); };
  }

  function showQuiz(it) {
    const qz = makeQuiz(it.e), e = it.e;
    const prompt = qz.type === 'cloze'
      ? `<div class="qlabel">例句填空・選出最適合的字</div><div class="cloze">${clozeHTML(e)}</div>`
      : `<div class="qlabel">聽音選字・選出你聽到的字</div><div class="listen-box">${speakBtn(e.w, 'big')}<button class="btn small" id="slow">慢速再聽一次</button></div>`;
    view(`${top()}${prompt}
      <div class="options">${qz.options.map((o, n) => `<button class="opt" data-w="${esc(o.w)}"><kbd>${n + 1}</kbd>${esc(o.w)}</button>`).join('')}</div>
      <div id="fb"></div>`);
    if (qz.type === 'listen') {
      $('#slow').onclick = () => speak(e.w, 0.5);
      speak(e.w);
    }
    $$('.opt').forEach(b => b.onclick = () => answer(it, qz, b));
  }

  function answer(it, qz, btn) {
    const e = it.e, ok = btn.dataset.w === e.w, c = S.cards[e.w] ||= newCard();
    $$('.opt').forEach(b => { b.disabled = true; if (b.dataset.w === e.w) b.classList.add('ok'); });
    if (!ok) btn.classList.add('bad');
    const lg = logToday();
    if (ok) { res.ok++; lg.ok++; c.right++; } else { res.bad++; lg.bad++; c.wrong++; c.mk = 1; c.mks = 0; res.wrong.add(e); }
    if (!it.graded) {
      it.graded = true;
      if (!it.isNew) lg.r++;
      grade(c, ok);
    }
    if (!ok) q.splice(Math.min(q.length, i + 3 + Math.floor(Math.random() * 3)), 0, { k: 'quiz', e, graded: true });
    save();
    if (qz.type === 'cloze' || !ok) speak(e.w);
    const wrongPick = !ok ? find(btn.dataset.w) : null;
    $('#fb').innerHTML = `<div class="feedback card">
      <div class="verdict ${ok ? 'ok' : 'bad'}">${ok ? '✓ 答對了' : '✗ 答錯了，等一下會再考一次'}</div>
      ${wordDetailHTML(e, { compact: true })}
      ${wrongPick ? `<div class="section-title">你選的字</div><div><a href="#/word/${encodeURIComponent(wrongPick.w)}"><b>${esc(wrongPick.w)}</b></a>　${esc(wrongPick.senses[0].zh)}</div>` : ''}
      </div><button class="btn primary block sticky-next" id="next">下一題</button>`;
    $('#next').onclick = () => { i++; next(); };
    $('#next').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function finish() {
    const wrong = [...res.wrong];
    view(`<h1>完成！</h1>
      <div class="hero">
        <div class="stat"><b style="color:var(--ok)">${res.ok}</b><span>答對</span></div>
        <div class="stat"><b style="color:var(--bad)">${res.bad}</b><span>答錯</span></div>
      </div>
      ${res.learned ? `<p>這一輪學了 <b>${res.learned}</b> 個新字。</p>` : ''}
      ${wrong.length ? `<h2>這次答錯的字</h2><div class="list">${wrong.map(itemHTML).join('')}</div>` : '<p>全部答對，太棒了！</p>'}
      <a class="btn primary block" href="#/home" style="margin-top:20px">回到首頁</a>`);
  }
  next();
};

/* ================= practice hub ================= */
routes.practice = () => {
  const mistakes = Object.values(S.cards).filter(c => c.mk).length;
  view(`<h1>練習</h1>
    <p class="muted small">練習模式不會影響複習排程，可以隨時做。</p>
    <div class="list">
      <a class="item" href="#/quiz"><span class="ti" style="font-size:1.4rem">✓</span><div class="main"><div><b>選擇題測驗</b></div><div class="z">直接出題：例句填空、聽音選字</div></div>›</a>
      <a class="item" href="#/flash"><span class="ti" style="font-size:1.4rem">❏</span><div class="main"><div><b>閃卡</b></div><div class="z">翻卡瀏覽單字，適合考前快速複習</div></div>›</a>
      <a class="item" href="#/spell"><span class="ti" style="font-size:1.4rem">✎</span><div class="main"><div><b>拼字</b></div><div class="z">聽發音、看意思，拼出單字</div></div>›</a>
      <a class="item" href="#/mistakes"><span class="ti" style="font-size:1.4rem">✕</span><div class="main"><div><b>錯題本</b>　<span class="muted small">${mistakes} 個字</span></div><div class="z">專攻答錯過的字</div></div>›</a>
    </div>`);
};

function sourceWords(src) {
  const d = today();
  const has = e => S.cards[e.w];
  const m = {
    today: () => W.filter(e => has(e) && S.cards[e.w].intro === d),
    learning: () => W.filter(e => status(e.w) === 'learning'),
    learned: () => W.filter(has),
    mistakes: () => W.filter(e => has(e) && S.cards[e.w].mk),
    all: () => W.filter(e => S.settings.tiers.includes(e.tier)),
  };
  return (m[src] || m.learned)();
}
const SOURCES = [['today', '今天學的'], ['learning', '學習中'], ['learned', '全部已學'], ['mistakes', '錯題本'], ['all', '全部單字']];
function sourcePicker(cur, base, suffix = '') {
  return `<div class="seg" style="margin-bottom:16px">${SOURCES.map(([k, l]) => `<button class="${k === cur ? 'on' : ''}" onclick="location.hash='${base}/${k}${suffix}'">${l}</button>`).join('')}</div>`;
}

/* ================= flashcards ================= */
routes.flash = src => {
  src ||= S.cards && Object.keys(S.cards).length ? 'learned' : 'all';
  const list = shuffle(sourceWords(src));
  let i = 0, back = false;
  const draw = () => {
    if (!list.length) {
      view(`<div class="topbar"><button class="back" data-back>✕</button><b>閃卡</b></div>${sourcePicker(src, '#/flash')}<p class="muted center">這個分類目前沒有單字。</p>`);
      return;
    }
    const e = list[i];
    view(`<div class="topbar"><button class="back" data-back>✕</button><b>閃卡</b><span class="spacer"></span><span class="small muted">${i + 1}/${list.length}</span></div>
      ${sourcePicker(src, '#/flash')}
      <div class="card flash ${back ? 'back' : ''}" id="fc">
        ${back ? wordDetailHTML(e, { compact: true })
               : `<div class="word">${esc(e.w)}</div><div class="kk" style="margin:8px 0 16px">${esc(e.kk)}</div>${speakBtn(e.w)}<p class="small muted" style="margin-top:24px">點卡片看解釋</p>`}
      </div>
      <div class="row" style="margin-top:14px">
        <button class="btn" id="prev" ${i ? '' : 'disabled'}>‹ 上一張</button><span class="spacer"></span>
        <button class="btn primary" id="nx" ${i < list.length - 1 ? '' : 'disabled'}>下一張 ›</button>
      </div>`);
    $('#fc').onclick = ev => { if (ev.target.closest('a,button')) return; back = !back; draw(); };
    $('#prev').onclick = () => { i--; back = false; draw(); };
    $('#nx').onclick = () => { i++; back = false; draw(); if (S.settings.autoSpeak) speak(list[i].w); };
  };
  const onKey = ev => {
    if (ev.key === 'ArrowRight') $('#nx')?.click();
    else if (ev.key === 'ArrowLeft') $('#prev')?.click();
    else if (ev.key === ' ') { ev.preventDefault(); back = !back; draw(); }
  };
  document.addEventListener('keydown', onKey);
  cleanup = () => document.removeEventListener('keydown', onKey);
  draw();
};

/* ================= spelling ================= */
routes.spell = src => {
  src ||= Object.keys(S.cards).length ? 'learned' : 'all';
  const q = shuffle(sourceWords(src)).slice(0, 10).map(e => ({ e, tries: 0 }));
  const total = q.length;
  let i = 0, ok = 0, hint = 0;
  const head = () => `<div class="topbar"><button class="back" data-back>✕</button><b>拼字</b><span class="spacer"></span><span class="small muted">${Math.min(i + 1, q.length)}/${q.length}</span></div>`;
  const norm = s => s.trim().toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ');

  function draw() {
    if (!q.length) { view(`${head()}${sourcePicker(src, '#/spell')}<p class="muted center">這個分類目前沒有單字。</p>`); return; }
    if (i >= q.length) {
      view(`${head()}<h1>完成！</h1><p>一次拼對 <b>${ok}</b> / ${total} 個字。</p>
        <button class="btn primary block" onclick="render()">再來一輪</button>
        <a class="btn block" href="#/practice" style="margin-top:10px">回到練習</a>`);
      return;
    }
    const e = q[i].e;
    const shown = e.w.slice(0, hint);
    const mask = [...e.w].map((ch, n) => n < hint ? ch : /[a-z]/i.test(ch) ? '_' : ch).join('');
    view(`${head()}${sourcePicker(src, '#/spell')}
      <div class="card stack center">
        <div>${speakBtn(e.w, 'big')}</div>
        <div>${e.senses.map(s => `<span class="pos" style="font-style:italic;color:var(--ink)">${esc(s.pos)}</span> <b>${esc(s.zh)}</b>`).join('<br>')}</div>
        <div class="letters">${esc(mask)}</div>
        <input class="spell-input" id="inp" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(shown)}" aria-label="輸入單字">
        <div class="row"><button class="btn" id="hint">提示一個字母</button><span class="spacer"></span><button class="btn primary" id="chk">確認</button></div>
      </div><div id="fb"></div>`);
    const inp = $('#inp');
    inp.focus();
    inp.setSelectionRange(inp.value.length, inp.value.length);
    inp.onkeydown = ev => { if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); $('#chk').click(); } };
    $('#hint').onclick = () => { hint = Math.min(e.w.length, hint + 1); draw(); };
    $('#chk').onclick = () => check(e, inp.value);
    speak(e.w);
  }

  function check(e, val) {
    const good = norm(val) === norm(e.w);
    const it = q[i];
    if (good && it.tries === 0 && hint === 0) ok++;
    if (!good && it.tries === 0) q.push({ e, tries: 1 });
    it.tries++;
    const diff = [...e.w].map((ch, n) => (val[n] || '').toLowerCase() === ch.toLowerCase() ? esc(ch) : `<span class="x">${esc(ch)}</span>`).join('');
    $('#fb').innerHTML = `<div class="card feedback">
      <div class="verdict ${good ? 'ok' : 'bad'}">${good ? '✓ 拼對了' : '✗ 正確拼法'}</div>
      <div class="hw"><span class="word diff">${good ? esc(e.w) : diff}</span></div>
      ${good ? '' : `<p class="small muted">你輸入：${esc(val) || '（空白）'}</p>`}
      <div class="kk">${esc(e.kk)}</div></div>
      <button class="btn primary block sticky-next" id="next">下一個</button>`;
    $('#chk').disabled = true; $('#hint').disabled = true; $('#inp').disabled = true;
    $('#next').onclick = () => { i++; hint = 0; draw(); };
  }
  const onKey = ev => { if (ev.key === 'Enter' && ev.target.tagName !== 'INPUT') { const b = $('#next'); if (b) { ev.preventDefault(); b.click(); } } };
  document.addEventListener('keydown', onKey);
  cleanup = () => document.removeEventListener('keydown', onKey);
  draw();
};

/* ================= mistakes ================= */
routes.mistakes = () => {
  const list = W.filter(e => S.cards[e.w]?.mk).sort((a, b) => S.cards[b.w].wrong - S.cards[a.w].wrong);
  view(`<button class="back" data-back>‹ 返回</button><h1>錯題本</h1>
    <p class="small muted">在錯題練習裡連續答對 2 次，這個字就會移出錯題本。</p>
    ${list.length ? `<button class="btn primary block" id="drill">練習錯題（${Math.min(list.length, 20)} 題）</button>
      <div class="list" style="margin-top:16px">${list.map(e => itemHTML(e, `<span class="small muted">錯 ${S.cards[e.w].wrong} 次</span>`)).join('')}</div>`
      : '<div class="card center muted">目前沒有錯題，繼續保持！</div>'}`);
  $('#drill')?.addEventListener('click', () => go('#/quiz/mistakes/mix'));
};

// Practice quiz: does not touch the review schedule, but feeds the mistake book.
// arg = "<source>/<type>", type is mix | cloze | listen.
const QTYPES = [['mix', '混合'], ['cloze', '例句填空'], ['listen', '聽音選字']];
routes.quiz = arg => {
  let [src, type] = (arg || '').split('/');
  src = SOURCES.some(([k]) => k === src) ? src : (Object.keys(S.cards).length ? 'learned' : 'all');
  type = QTYPES.some(([k]) => k === type) ? type : 'mix';
  const q = shuffle(sourceWords(src)).slice(0, 20);
  let i = 0, ok = 0;
  const pickers = () => `${sourcePicker(src, '#/quiz', '/' + type)}
    <div class="seg" style="margin:-8px 0 16px">${QTYPES.map(([k, l]) => `<button class="${k === type ? 'on' : ''}" onclick="location.hash='#/quiz/${src}/${k}'">${l}</button>`).join('')}</div>`;
  const onKey = ev => {
    const n = parseInt(ev.key, 10), opts = $$('.opt:not(:disabled)');
    if (n >= 1 && n <= 4 && opts[n - 1]) opts[n - 1].click();
    else if (ev.key === 'Enter') { const b = $('#next'); if (b) { ev.preventDefault(); b.click(); } }
  };
  document.addEventListener('keydown', onKey);
  cleanup = () => document.removeEventListener('keydown', onKey);

  function draw() {
    const bar = `<div class="topbar"><button class="back" data-back>✕</button><div class="progress"><div style="width:${q.length ? i / q.length * 100 : 0}%"></div></div><span class="small muted">${Math.min(i + 1, q.length)}/${q.length}</span></div>`;
    if (!q.length) { view(`${bar}${pickers()}<p class="muted center">這個分類目前沒有單字。</p>`); return; }
    if (i >= q.length) {
      const left = W.filter(e => S.cards[e.w]?.mk).length;
      view(`<h1>完成！</h1><p>答對 <b>${ok}</b> / ${q.length} 題。錯題本目前有 <b>${left}</b> 個字。</p>
        <button class="btn primary block" onclick="render()">再來一輪</button>
        <a class="btn block" href="#/practice" style="margin-top:10px">回到練習</a>`);
      return;
    }
    const e = q[i], qz = makeQuiz(e, type === 'mix' ? null : type);
    const prompt = qz.type === 'cloze'
      ? `<div class="qlabel">例句填空・選出最適合的字</div><div class="cloze">${clozeHTML(e)}</div>`
      : `<div class="qlabel">聽音選字・選出你聽到的字</div><div class="listen-box">${speakBtn(e.w, 'big')}<button class="btn small" id="slow">慢速再聽一次</button></div>`;
    view(`${bar}${i === 0 ? pickers() : ''}${prompt}
      <div class="options">${qz.options.map((o, n) => `<button class="opt" data-w="${esc(o.w)}"><kbd>${n + 1}</kbd>${esc(o.w)}</button>`).join('')}</div><div id="fb"></div>`);
    if (qz.type === 'listen') { $('#slow').onclick = () => speak(e.w, 0.5); speak(e.w); }
    $$('.opt').forEach(b => b.onclick = () => {
      const good = b.dataset.w === e.w, c = S.cards[e.w];
      $$('.opt').forEach(x => { x.disabled = true; if (x.dataset.w === e.w) x.classList.add('ok'); });
      let note = '';
      if (good) {
        ok++;
        if (c?.mk) { c.mks = (c.mks || 0) + 1; if (c.mks >= 2) { c.mk = 0; c.mks = 0; note = '，已移出錯題本'; } else note = '，再對一次就移出錯題本'; }
      } else {
        b.classList.add('bad');
        if (c) { c.mk = 1; c.mks = 0; c.wrong++; note = '，已加入錯題本'; }
      }
      save();
      if (qz.type === 'cloze' || !good) speak(e.w);
      $('#fb').innerHTML = `<div class="feedback card"><div class="verdict ${good ? 'ok' : 'bad'}">${good ? '✓ 答對了' : '✗ 答錯了'}${note}</div>${wordDetailHTML(e, { compact: true })}</div>
        <button class="btn primary block sticky-next" id="next">下一題</button>`;
      $('#next').onclick = () => { i++; draw(); };
    });
  }
  draw();
};

/* ================= word list & detail ================= */
function itemHTML(e, right = '') {
  return `<a class="item" href="#/word/${encodeURIComponent(e.w)}"><span class="dot ${status(e.w)}"></span>
    <div class="main"><div class="w">${esc(e.w)}</div><div class="z">${esc(e.senses.map(s => s.zh).join('；'))}</div></div>${right || tierBadge(e.tier)}</a>`;
}

const listState = { q: '', tier: 0, st: 'all', limit: 100 };
routes.words = () => {
  view(`<h1>單字</h1>
    <input type="search" id="q" placeholder="搜尋英文或中文" value="${esc(listState.q)}" autocomplete="off" autocapitalize="off">
    <div class="seg" style="margin-top:10px" id="tiers">${[[0, '全部'], [1, '核心'], [2, '進階'], [3, '冷僻']].map(([k, l]) => `<button data-k="${k}" class="${listState.tier === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="seg" style="margin-top:8px" id="sts">${[['all', '全部'], ['new', '未學'], ['learning', '學習中'], ['mastered', '已精熟']].map(([k, l]) => `<button data-k="${k}" class="${listState.st === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <p class="small muted" id="count" style="margin:12px 2px 6px"></p>
    <div class="list" id="list"></div>
    <button class="btn block" id="moreBtn" style="margin-top:12px">顯示更多</button>`);
  const draw = () => {
    const s = listState.q.trim().toLowerCase();
    const res = W.filter(e => (!listState.tier || e.tier === listState.tier)
      && (listState.st === 'all' || status(e.w) === listState.st)
      && (!s || e.w.toLowerCase().includes(s) || e.senses.some(x => x.zh.includes(s))));
    if (s) res.sort((a, b) => (b.w.toLowerCase().startsWith(s)) - (a.w.toLowerCase().startsWith(s)));
    $('#count').textContent = `${res.length} 個字`;
    $('#list').innerHTML = res.slice(0, listState.limit).map(e => itemHTML(e)).join('') || '<div class="item muted">沒有符合的字</div>';
    $('#moreBtn').hidden = res.length <= listState.limit;
  };
  $('#q').oninput = ev => { listState.q = ev.target.value; listState.limit = 100; draw(); };
  $('#tiers').onclick = ev => { const b = ev.target.closest('button'); if (!b) return; listState.tier = +b.dataset.k; $$('#tiers button').forEach(x => x.classList.toggle('on', x === b)); draw(); };
  $('#sts').onclick = ev => { const b = ev.target.closest('button'); if (!b) return; listState.st = b.dataset.k; $$('#sts button').forEach(x => x.classList.toggle('on', x === b)); draw(); };
  $('#moreBtn').onclick = () => { listState.limit += 200; draw(); };
  draw();
};

routes.word = w => {
  const e = find(w);
  if (!e) { view(`<button class="back" data-back>‹ 返回</button><p>找不到「${esc(w)}」。</p>`); return; }
  const c = S.cards[e.w];
  const info = c
    ? `下次複習：${c.due <= today() ? '今天' : dayLabel(c.due)}　·　答對 ${c.right} 次、答錯 ${c.wrong} 次`
    : '還沒學過';
  view(`<button class="back" data-back>‹ 返回</button>
    <div class="card">${wordDetailHTML(e)}</div>
    <p class="small muted" style="margin:12px 4px">${info}</p>
    ${c ? `<button class="btn block" id="mk">${c.mk ? '移出錯題本' : '加入錯題本'}</button>` : ''}`);
  $('#mk')?.addEventListener('click', () => { c.mk = c.mk ? 0 : 1; c.mks = 0; save(); toast(c.mk ? '已加入錯題本' : '已移出錯題本'); routes.word(w); });
};

/* ================= stats ================= */
routes.stats = () => {
  const d = today();
  const cards = Object.values(S.cards);
  const days = Array.from({ length: 14 }, (_, k) => d - 13 + k);
  const act = days.map(x => (S.log[x]?.n || 0) + (S.log[x]?.r || 0));
  const max = Math.max(1, ...act);
  let ok = 0, bad = 0;
  for (let x = d - 6; x <= d; x++) { ok += S.log[x]?.ok || 0; bad += S.log[x]?.bad || 0; }
  const tierRows = [1, 2, 3].map(t => {
    const all = W.filter(e => e.tier === t);
    const learned = all.filter(e => S.cards[e.w]).length;
    const mastered = all.filter(e => status(e.w) === 'mastered').length;
    const pct = all.length ? learned / all.length * 100 : 0;
    return `<div class="tier-row"><div class="row"><span>${tierBadge(t)} ${all.length} 字</span><span class="muted">已學 ${learned}・精熟 ${mastered}</span></div>
      <div class="progress"><div style="width:${pct}%"></div></div></div>`;
  }).join('');
  view(`<h1>統計</h1>
    <div class="hero">
      <div class="stat"><b>${cards.length}</b><span>已學單字</span></div>
      <div class="stat"><b>${cards.filter(c => c.ivl >= MASTERED).length}</b><span>已精熟（間隔 ≥ ${MASTERED} 天）</span></div>
      <div class="stat"><b>${streak()}</b><span>連續天數</span></div>
      <div class="stat"><b>${ok + bad ? Math.round(ok / (ok + bad) * 100) + '%' : '—'}</b><span>近 7 天正確率</span></div>
    </div>
    <h2>近 14 天學習量</h2>
    <div class="card"><div class="bars">${days.map((x, k) => `<div><i class="${x === d ? 'today' : ''}" style="height:${act[k] / max * 100}%" title="${act[k]}"></i><small>${k % 2 ? '' : dayLabel(x)}</small></div>`).join('')}</div></div>
    <h2>各層級進度</h2><div class="card">${tierRows}</div>
    <h2>接下來要複習</h2>
    <div class="card"><div class="row"><span>明天</span><span class="spacer"></span><b>${cards.filter(c => c.due === d + 1).length}</b></div>
    <div class="row"><span>未來 7 天</span><span class="spacer"></span><b>${cards.filter(c => c.due > d && c.due <= d + 7).length}</b></div></div>`);
};

/* ================= settings ================= */
routes.settings = () => {
  const st = S.settings;
  const voices = tts.voices;
  view(`<h1>設定</h1>
    <div class="list">
      <div class="setting"><label for="dn">每日新字數</label><b id="dnv">${st.dailyNew}</b><input type="range" id="dn" min="5" max="60" step="5" value="${st.dailyNew}"></div>
      <div class="setting"><label style="flex:none">包含的層級</label><div class="row">${[1, 2, 3].map(t => `<label class="row small"><input type="checkbox" data-tier="${t}" ${st.tiers.includes(t) ? 'checked' : ''}>${TIER[t]}</label>`).join('')}</div></div>
      <div class="setting"><label for="cz">例句填空題</label><input type="checkbox" id="cz" ${st.cloze ? 'checked' : ''}></div>
      <div class="setting"><label for="ls">聽音選字題</label><input type="checkbox" id="ls" ${st.listen ? 'checked' : ''} ${tts.ok ? '' : 'disabled'}></div>
    </div>
    <h2>發音</h2>
    <div class="list">
      <div class="setting"><label for="as">自動播放發音</label><input type="checkbox" id="as" ${st.autoSpeak ? 'checked' : ''}></div>
      <div class="setting"><label for="rt">語速</label><b id="rtv">${st.rate}</b><input type="range" id="rt" min="0.5" max="1.2" step="0.05" value="${st.rate}"></div>
      <div class="setting" style="flex-wrap:wrap"><label for="vc">聲音</label>
        <select id="vc" style="max-width:220px"><option value="">自動（挑選最自然的聲音）</option>
        ${voices.map(v => `<option value="${esc(v.voiceURI)}" ${v.voiceURI === st.voice ? 'selected' : ''}>${esc(v.name)}（${esc(v.lang)}${v.localService ? '・離線可用' : ''}）</option>`).join('')}</select>
        <button class="btn small" data-speak="benevolent">試聽</button></div>
    </div>
    <p class="small muted" style="margin:6px 4px">發音由裝置內建的語音合成產生。標示「離線可用」的聲音不用連網也能唸。</p>
    <h2>進度備份</h2>
    <div class="list">
      <div class="setting"><label>匯出進度成檔案，可以在另一台裝置匯入</label><button class="btn small" id="exp">匯出</button></div>
      <div class="setting"><label>從檔案匯入進度（會取代目前的進度）</label><button class="btn small" id="imp">匯入</button><input type="file" id="file" accept="application/json,.json" hidden></div>
      <div class="setting"><label>清除所有學習進度</label><button class="btn small danger" id="reset">清除</button></div>
    </div>
    <p class="small muted center" style="margin-top:24px">單字庫：${W.length} / 5002 字</p>`);
  const upd = () => { save(); };
  $('#dn').oninput = ev => { st.dailyNew = +ev.target.value; $('#dnv').textContent = st.dailyNew; upd(); };
  $$('[data-tier]').forEach(b => b.onchange = () => {
    const t = $$('[data-tier]').filter(x => x.checked).map(x => +x.dataset.tier);
    if (!t.length) { b.checked = true; return toast('至少要選一個層級'); }
    st.tiers = t; upd();
  });
  $('#cz').onchange = ev => { st.cloze = ev.target.checked; if (!st.cloze && !st.listen) { st.listen = true; $('#ls').checked = true; } upd(); };
  $('#ls').onchange = ev => { st.listen = ev.target.checked; if (!st.cloze && !st.listen) { st.cloze = true; $('#cz').checked = true; } upd(); };
  $('#as').onchange = ev => { st.autoSpeak = ev.target.checked; upd(); };
  $('#rt').oninput = ev => { st.rate = +ev.target.value; $('#rtv').textContent = st.rate; upd(); };
  $('#vc').onchange = ev => { st.voice = ev.target.value; upd(); speak('benevolent'); };
  $('#exp').onclick = () => {
    const blob = new Blob([JSON.stringify({ app: 'sat-vocab', version: 1, exported: new Date().toISOString(), ...S })], { type: 'application/json' });
    const a = document.createElement('a');
    const d = new Date();
    a.href = URL.createObjectURL(blob);
    a.download = `sat-vocab-progress-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('#imp').onclick = () => $('#file').click();
  $('#file').onchange = async ev => {
    const f = ev.target.files[0]; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.app !== 'sat-vocab' || !data.cards) throw new Error('bad file');
      if (!confirm(`要匯入 ${Object.keys(data.cards).length} 個字的進度嗎？目前的進度會被取代。`)) return;
      S = { settings: { ...DEFAULTS, ...data.settings }, cards: data.cards, log: data.log || {}, seed: data.seed || S.seed };
      save(); toast('匯入完成'); render();
    } catch (e) { toast('檔案格式不正確'); }
  };
  $('#reset').onclick = () => {
    if (!confirm('確定要清除所有學習進度嗎？這個動作無法復原，建議先匯出備份。')) return;
    S = { settings: S.settings, cards: {}, log: {}, seed: S.seed };
    save(); toast('已清除'); render();
  };
};

/* ================= boot ================= */
window.addEventListener('hashchange', render);
(async () => {
  try { await loadWords(); }
  catch (e) { view('<p class="loading">單字資料載入失敗，請重新整理。</p>'); return; }
  if (!location.hash) location.replace('#/home');
  render();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.storage?.persist?.();
})();
