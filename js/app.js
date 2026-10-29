// 瞬英トレーナー：画面とトレーニングの進行
import { LEVELS, CATEGORIES, SCENES, MIXES, ITEMS, ITEM_MAP, sceneById, levelById, scenesOf } from './data/index.js';
import { db, save, exportData, importData, resetProgress, addAiUsage, resetAiUsage } from './store.js';
import { grade, tokenize, hintText, STRICTNESS } from './grader.js';
import { recognizer, diag, isIOS, canRecognize, canSpeak, speak, stopSpeaking, speechCooldown, englishVoices, RECOGNITION_ERRORS } from './speech.js';
import { recordResult, buildQueue, poolCounts, overallStats, OUTCOMES, isCorrect, recordOf, MASTERED_BOX } from './srs.js';
import { reviewAnswer, AI_MODELS, USD_TO_JPY } from './ai.js';

const $app = document.getElementById('app');
const S = db.settings;
const isDesktop = matchMedia('(hover: hover) and (pointer: fine)').matches;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const svg = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const I = {
  mic: svg('<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10a7 7 0 0 1-14 0"/><path d="M12 17v4"/><path d="M8 21h8"/>'),
  kbd: svg('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>'),
  speaker: svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  book: svg('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>'),
  back: svg('<path d="m15 18-6-6 6-6"/>'),
  close: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  next: svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  retry: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
  bulb: svg('<path d="M9 18h6M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2z"/>'),
  spark: svg('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>'),
  play: svg('<path d="M7 4v16l13-8z"/>'),
};

const ui = {
  view: 'home',
  cat: 'business',
  setupScene: null,
  setupLevel: 'all',
  drill: null,
  lastSession: null,
  list: { scene: 'all', level: 'all', hide: false, q: '' },
};

// ---------------------------------------------------------------- 画面遷移
function go(view, { replace = false } = {}) {
  if (ui.view === 'drill' && view !== 'drill') teardownDrill();
  ui.view = view;
  history[replace ? 'replaceState' : 'pushState']({ view }, '');
  render();
  window.scrollTo(0, 0);
}

window.addEventListener('popstate', (e) => {
  const view = e.state?.view || 'home';
  if (ui.view === 'drill' && ui.drill) { quitDrill(view); return; }
  showView(view);
});

function showView(view) {
  ui.view = (view === 'drill' && !ui.drill) || (view === 'result' && !ui.lastSession) ? 'home' : view;
  render();
}

const VIEWS = { home: viewHome, setup: viewSetup, drill: viewDrill, result: viewResult, list: viewList, settings: viewSettings };
function render() {
  $app.innerHTML = (VIEWS[ui.view] || viewHome)();
  $app.dataset.view = ui.view;
  if (ui.view === 'drill') afterDrillRender();
}

let toastTimer = 0;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

const audioAllowed = () => canSpeak && !(S.inputMode === 'keyboard' && S.muteInKeyboard);
const speakEn = (text) => speak(text, { lang: 'en-US', rate: S.rate, voiceURI: S.voiceURI });

// ---------------------------------------------------------------- 共通パーツ
function keyRanges(text, key) {
  if (!key) return [];
  const lower = text.toLowerCase();
  const out = [];
  let from = 0;
  for (const part of key.toLowerCase().split('...').map((s) => s.trim()).filter(Boolean)) {
    const i = lower.indexOf(part, from);
    if (i >= 0) { out.push([i, i + part.length]); from = i + part.length; }
  }
  return out;
}

// 英文をトークン単位で描画（キーフレーズの強調・判定マーク付き）
function renderEn(text, key, marks) {
  const tok = tokenize(text);
  const ranges = keyRanges(text, key);
  let html = '';
  let inKey = false;
  tok.display.forEach((d, i) => {
    const k = ranges.some(([a, b]) => d.start < b && d.end > a);
    if (k && !inKey) { html += (i ? ' ' : '') + '<mark>'; inKey = true; } else if (!k && inKey) { html += '</mark> '; inKey = false; } else if (i) html += ' ';
    const m = marks?.[i];
    html += m && m !== 'ok' ? `<span class="m-${m}">${esc(d.text)}</span>` : esc(d.text);
  });
  if (inKey) html += '</mark>';
  return html;
}

const playBtn = (text, label = '音声を再生') => `<button class="icon-btn sm" data-act="play" data-text="${esc(text)}" aria-label="${label}">${I.speaker}</button>`;

function seg(items, current, act, extra = '', attrs = '') {
  return `<div class="seg ${extra}" role="radiogroup" ${attrs}>${items.map((it) => `<button role="radio" aria-checked="${String(it.value) === String(current)}" data-act="${act}" data-val="${esc(it.value)}">${it.html ?? esc(it.label)}</button>`).join('')}</div>`;
}

function inputModeSeg(size = '') {
  return seg([
    { value: 'voice', html: `${I.mic}<span>音声で答える</span>` },
    { value: 'keyboard', html: `${I.kbd}<span>キーボード<small>電車モード</small></span>` },
  ], S.inputMode, 'input-mode', `seg-icons ${size}`);
}

function voiceNotice() {
  if (S.inputMode !== 'voice') return '';
  if (!canRecognize) return '<p class="notice warn">このブラウザは音声認識に対応していません。Chrome（Android / PC）または Safari（iPhone）でお使いいただくか、キーボード入力をご利用ください。</p>';
  if (!window.isSecureContext) return '<p class="notice warn">音声入力には HTTPS（または localhost）での接続が必要です。</p>';
  return '';
}

// ---------------------------------------------------------------- ホーム
function viewHome() {
  const st = overallStats();
  const acc = st.today.n ? Math.round((st.today.ok / st.today.n) * 100) : null;
  const cats = [...CATEGORIES, { id: 'mix', name: 'おまかせ' }];
  const cards = ui.cat === 'mix'
    ? MIXES.map((m) => sceneCard(m, m.scenes)).join('')
    : SCENES.filter((s) => s.cat === ui.cat).map((s) => sceneCard(s, [s.id])).join('');
  return `
  <header class="topbar">
    <div class="brand"><span class="logo">瞬</span><div><h1>瞬英トレーナー</h1><p>ビジネス瞬間英作文</p></div></div>
    <nav class="top-actions">
      <button class="icon-btn" data-act="go" data-view="list" aria-label="フレーズ帳" title="フレーズ帳">${I.book}</button>
      <button class="icon-btn" data-act="go" data-view="settings" aria-label="設定" title="設定">${I.gear}</button>
    </nav>
  </header>

  <section class="card stats">
    <div class="stat"><b>${st.today.n}</b><span>今日の回答</span></div>
    <div class="stat"><b>${acc ?? '–'}${acc != null ? '<small>%</small>' : ''}</b><span>今日の正答率</span></div>
    <div class="stat"><b>${st.streak}<small>日</small></b><span>連続学習</span></div>
    <div class="stat"><b>${st.mastered}<small>/${st.total}</small></b><span>定着した文</span></div>
  </section>

  ${st.seen === 0 ? `
  <section class="card howto">
    <h2>使い方</h2>
    <ol>
      <li><b>シーンとレベルを選ぶ</b><span>ビジネス9シーン＋日常2シーン、各4レベル</span></li>
      <li><b>日本語を見たら、すぐ英語で話す</b><span>話し始めるまでの秒数を計測します</span></li>
      <li><b>判定と模範解答で確認</b><span>間違えた文は忘れかけた頃に再出題されます</span></li>
    </ol>
  </section>` : ''}

  ${st.due ? `
  <button class="card review-cta" data-act="quick-review">
    <span><b>復習待ち ${st.due}問</b><small>記憶が薄れかけた文をまとめて復習</small></span>${I.next}
  </button>` : ''}

  <section class="block">
    <h2 class="sec-title">回答方法</h2>
    ${inputModeSeg('seg-lg')}
    ${voiceNotice()}
  </section>

  <section class="block">
    <h2 class="sec-title">シーンを選ぶ</h2>
    <div class="tabs" role="tablist">
      ${cats.map((c) => `<button role="tab" aria-selected="${ui.cat === c.id}" data-act="cat" data-val="${c.id}">${c.name}</button>`).join('')}
    </div>
    <div class="scene-grid">${cards}</div>
  </section>
  <p class="foot">全${ITEMS.length}文 ・ 学習記録はこの端末に保存されます</p>`;
}

function sceneCard(s, ids) {
  const c = poolCounts(ids, 'all');
  const seen = Math.round((c.seen / c.total) * 100);
  const mastered = Math.round((c.mastered / c.total) * 100);
  return `
  <button class="scene-card" data-act="pick-scene" data-val="${s.id}">
    <span class="scene-icon" aria-hidden="true">${s.icon}</span>
    <span class="scene-name">${esc(s.name)}</span>
    <span class="scene-desc">${esc(s.desc)}</span>
    <span class="progress" aria-hidden="true"><span class="p-seen" style="width:${seen}%"></span><span class="p-master" style="width:${mastered}%"></span></span>
    <span class="scene-meta">${c.seen}/${c.total}文${c.due ? ` ・ <em>復習 ${c.due}</em>` : ''}</span>
  </button>`;
}

// ---------------------------------------------------------------- 出題設定
function viewSetup() {
  const s = sceneById(ui.setupScene);
  const ids = scenesOf(ui.setupScene);
  const counts = poolCounts(ids, ui.setupLevel);
  const modes = [
    { value: 'mix', html: `<b>おすすめ</b><small>復習＋新しい文</small>` },
    { value: 'new', html: `<b>新しい文</b><small>未学習 ${counts.fresh}</small>` },
    { value: 'review', html: `<b>復習</b><small>期限 ${counts.due}／学習済 ${counts.seen}</small>` },
    { value: 'weak', html: `<b>苦手</b><small>間違えた文 ${counts.weak}</small>` },
  ];
  return `
  <header class="topbar">
    <button class="icon-btn" data-act="back" aria-label="戻る">${I.back}</button>
    <h1 class="title"><span aria-hidden="true">${s.icon}</span> ${esc(s.name)}</h1>
    <span class="spacer"></span>
  </header>
  <p class="lead">${esc(s.desc)}</p>

  <section class="block">
    <h2 class="sec-title">レベル</h2>
    <div class="level-list">${[{ id: 'all' }, ...LEVELS].map((l) => levelOption(l, ids)).join('')}</div>
  </section>

  <section class="block">
    <h2 class="sec-title">出題方法</h2>
    ${seg(modes, S.sessionMode, 'session-mode', 'seg-grid')}
  </section>

  <section class="block">
    <h2 class="sec-title">問題数</h2>
    ${seg([5, 10, 20, 30].map((n) => ({ value: n, label: `${n}問` })), S.sessionSize, 'session-size')}
  </section>

  <section class="block">
    <h2 class="sec-title">回答方法</h2>
    ${inputModeSeg()}
    ${voiceNotice()}
  </section>

  <div class="action-bar">
    <button class="btn btn-primary btn-lg btn-block" data-act="start">${S.inputMode === 'voice' ? I.mic : I.kbd}<span>スタート</span></button>
  </div>`;
}

function levelOption(l, ids) {
  const c = poolCounts(ids, l.id);
  const sel = String(ui.setupLevel) === String(l.id);
  const count = `<span class="lv-count"><b>${c.mastered}</b>/${c.total}<small>定着</small></span>`;
  if (l.id === 'all') {
    return `<button class="level-opt ${sel ? 'sel' : ''}" data-act="set-level" data-val="all" aria-pressed="${sel}">
      <span class="lv-badge lv-all">ALL</span>
      <span class="lv-body"><b>全レベル</b><small>やさしいレベルから順に新しい文を出題</small></span>${count}</button>`;
  }
  return `<button class="level-opt ${sel ? 'sel' : ''}" data-act="set-level" data-val="${l.id}" aria-pressed="${sel}">
    <span class="lv-badge lv-${l.id}">Lv${l.id}</span>
    <span class="lv-body"><b>${l.ja} <em>${l.name}</em></b><small>${esc(l.goal)}</small><small class="lv-sub">${esc(l.target)} ・ ${esc(l.grammar)}</small></span>${count}</button>`;
}

// ---------------------------------------------------------------- トレーニング
let rafId = 0;
let autoNextTimer = 0;
let tokenSeq = 0;

const alive = (token) => ui.view === 'drill' && ui.drill?.cur?.token === token;

function startSession(sceneKey, level, { ids, mode } = {}) {
  const m = mode || S.sessionMode;
  const queue = ids || buildQueue(scenesOf(sceneKey), level, S.sessionSize, m);
  if (!queue.length) {
    toast(m === 'new' ? 'このレベルの新しい文はすべて学習済みです。「復習」を選んでください。'
      : m === 'weak' ? '苦手な文はまだありません。' : '出題できる文がありません。');
    return;
  }
  stopSpeaking();
  ui.drill = { sceneKey, level, queue: queue.map((id) => ({ id, retry: false })), idx: 0, results: [], requeued: new Set(), cur: null };
  prepareQuestion();
  go('drill');
  startQuestion();
}

function prepareQuestion() {
  const d = ui.drill;
  const q = d.queue[d.idx];
  d.cur = {
    item: ITEM_MAP.get(q.id), isRetry: q.retry, token: ++tokenSeq,
    phase: 'answer', attempt: 1, shownAt: 0, reactMs: null, firstReactMs: null,
    hint: 0, hintAtFirst: 0, grade: null, first: null, override: null, gaveUp: false,
    micState: 'idle', holding: false, manualStop: false, interim: '', micError: '', draft: '', ai: null, noSpeech: 0, committed: false,
  };
}

async function startQuestion() {
  const c = ui.drill.cur;
  const token = c.token;
  stopSpeaking();
  diag.mark(`問題 ${ui.drill.idx + 1}${c.attempt > 1 ? `（${c.attempt}回目）` : ''}`);
  if (S.readPrompt && audioAllowed()) {
    setTimerText('問題を読み上げ中…');
    await speak(c.item.ja, { lang: 'ja-JP', rate: 1.05 });
    if (!alive(token) || c.phase !== 'answer') return;
  }
  if (!c.shownAt) c.shownAt = performance.now();
  startTimerLoop(token);
  if (S.inputMode === 'voice' && S.autoMic && !holdMode() && canRecognize && window.isSecureContext) startListening();
}

function teardownDrill() {
  recognizer.abort();
  holdEnd(true);
  stopSpeaking();
  cancelAnimationFrame(rafId);
  clearTimeout(autoNextTimer);
}

// ---- タイマー（話し始めるまでの時間）
function setTimerText(text) {
  const label = document.getElementById('timerLabel');
  if (label) label.textContent = text;
}

function paintTimer(c) {
  const box = document.getElementById('timer');
  const fill = document.getElementById('timerFill');
  const label = document.getElementById('timerLabel');
  if (!box || !c.shownAt) return;
  const limit = S.timeLimit * 1000;
  if (c.reactMs != null) {
    const late = limit && c.reactMs > limit;
    box.className = `timer done${late ? ' late' : ''}`;
    fill.style.width = limit ? `${Math.max(0, 1 - c.reactMs / limit) * 100}%` : '100%';
    label.textContent = `反応 ${(c.reactMs / 1000).toFixed(1)}秒${late ? '（時間オーバー）' : ''}`;
    return;
  }
  const elapsed = performance.now() - c.shownAt;
  if (!limit) {
    box.className = 'timer nolimit';
    fill.style.width = '100%';
    label.textContent = `${(elapsed / 1000).toFixed(1)}秒`;
    return;
  }
  const remain = limit - elapsed;
  fill.style.width = `${Math.max(0, remain / limit) * 100}%`;
  box.className = `timer${remain < 0 ? ' over' : remain < limit * 0.35 ? ' low' : ''}`;
  label.textContent = remain >= 0 ? `残り ${(remain / 1000).toFixed(1)}秒` : `時間オーバー +${(-remain / 1000).toFixed(1)}秒`;
}

function startTimerLoop(token) {
  cancelAnimationFrame(rafId);
  const tick = () => {
    if (!alive(token)) return;
    const c = ui.drill.cur;
    if (c.phase !== 'answer') return;
    paintTimer(c);
    if (c.reactMs == null) rafId = requestAnimationFrame(tick);
  };
  tick();
}

function markReact() {
  const c = ui.drill?.cur;
  if (!c || c.phase !== 'answer' || c.reactMs != null || !c.shownAt) return;
  c.reactMs = performance.now() - c.shownAt;
  paintTimer(c);
}

// ---- 音声入力
const holdMode = () => S.recMode === 'hold';

function startListening({ hold = false } = {}) {
  const c = ui.drill?.cur;
  if (!c || c.phase !== 'answer' || c.micState !== 'idle') return;
  const token = c.token;
  c.micError = '';
  c.manualStop = false;
  // 模範解答の読み上げ直後はマイクへの切り替えを少し待つ（押して録音のときは待たない）
  const wait = hold ? 0 : speechCooldown();
  if (wait) {
    c.micState = 'starting';
    diag.push(`読み上げ直後のため ${wait}ms 待ってから録音`);
    patchVoice(c);
    setTimeout(() => {
      if (alive(token) && c.phase === 'answer' && c.micState === 'starting' && !recognizer.busy) beginListening(c, token, hold);
    }, wait);
    return;
  }
  beginListening(c, token, hold);
}

function beginListening(c, token, hold) {
  stopSpeaking();
  recognizer.start({
    onStateChange: (state) => {
      if (!alive(token)) return;
      c.micState = state === 'idle' ? 'idle' : 'starting';
      if (c.phase === 'answer') patchVoice(c);
    },
    onReady: () => {
      if (!alive(token) || c.phase !== 'answer') return;
      c.micState = 'ready';
      patchVoice(c);
    },
    onSpeech: () => { if (alive(token)) markReact(); },
    onInterim: (text) => {
      if (!alive(token)) return;
      c.interim = text;
      const el = document.getElementById('transcript');
      if (el) { el.textContent = text; el.classList.add('has-text'); }
    },
    onResult: (cands) => {
      if (alive(token) && c.phase === 'answer') submitAnswer(cands);
    },
    onError: (code) => {
      if (!alive(token) || c.phase !== 'answer') return;
      // 黙考中に認識が終わってしまった場合は、静かに待ち受けを再開する
      if (code === 'no-speech' && !hold && !c.manualStop && c.reactMs == null && c.noSpeech < 3) {
        c.noSpeech++;
        diag.push(`無音のため待ち受けを再開（${c.noSpeech}/3）`);
        setTimeout(() => { if (alive(token) && c.phase === 'answer' && c.micState === 'idle') startListening(); }, 100);
        return;
      }
      if (code === 'aborted') return;
      c.micError = code === 'no-speech' && hold
        ? '声が聞き取れませんでした。ボタンを押したまま話し、話し終えてから離してください。'
        : RECOGNITION_ERRORS[code] || `音声認識エラー（${code}）`;
      // iPhone では模範解答の読み上げのあとにマイクが使えなくなることがあるため、対処法を案内する
      c.micErrorAutoplay = code === 'no-speech' && isIOS && S.autoPlayAnswer && audioAllowed();
      render();
    },
  }, { hold, silenceMs: S.silenceMs });
}

// 自動判定モード：タップで録音開始／終了
function toggleMic() {
  const c = ui.drill?.cur;
  if (!c || c.phase !== 'answer' || holdMode()) return;
  if (c.micState !== 'idle') {
    c.manualStop = true;
    if (recognizer.busy) recognizer.stop();
    else { c.micState = 'idle'; patchVoice(c); }
    return;
  }
  if (!c.shownAt) { c.shownAt = performance.now(); startTimerLoop(c.token); }
  c.noSpeech = 0;
  startListening();
}

// 押して録音モード：押している間だけ録音し、離したら判定
function holdStart(e) {
  const c = ui.drill?.cur;
  if (!c || c.phase !== 'answer' || !holdMode() || c.holding || !canRecognize) return;
  e?.preventDefault?.();
  if (!c.shownAt) { c.shownAt = performance.now(); startTimerLoop(c.token); }
  c.holding = true;
  diag.push('ボタンを押した');
  document.addEventListener('pointerup', onHoldRelease);
  document.addEventListener('pointercancel', onHoldRelease);
  if (c.micState !== 'idle') recognizer.abort();
  c.micState = 'idle';
  startListening({ hold: true });
}
const onHoldRelease = () => holdEnd();

function holdEnd(silent = false) {
  document.removeEventListener('pointerup', onHoldRelease);
  document.removeEventListener('pointercancel', onHoldRelease);
  const c = ui.drill?.cur;
  if (!c?.holding) return;
  c.holding = false;
  if (silent) return;
  c.manualStop = true;
  diag.push('ボタンを離した');
  if (recognizer.busy) recognizer.stop();
  else if (c.phase === 'answer') { c.micState = 'idle'; patchVoice(c); }
}

// 録音状態の表示だけを更新する。マイクボタンの要素は差し替えない
// （押している最中にボタンを作り直すと、iOS で「離した」イベントが届かなくなるため）
function patchVoice(c) {
  const box = document.querySelector('.voice-box');
  const btn = box?.querySelector('.mic-btn');
  if (!box || !btn || btn.hasAttribute('data-hold-mic') !== holdMode()) { render(); return; }
  const tmp = document.createElement('div');
  tmp.innerHTML = voicePanel(c);
  const fresh = tmp.querySelector('.voice-box');
  const freshBtn = fresh.querySelector('.mic-btn');
  btn.className = freshBtn.className;
  btn.setAttribute('aria-label', freshBtn.getAttribute('aria-label'));
  const before = [];
  const after = [];
  let passed = false;
  for (const el of [...fresh.children]) {
    if (el === freshBtn) { passed = true; continue; }
    (passed ? after : before).push(el);
  }
  for (const el of [...box.children]) if (el !== btn) el.remove();
  btn.before(...before);
  btn.after(...after);
}

// ---- 回答・判定
function submitTyped() {
  const el = document.getElementById('kbdInput');
  const v = el?.value.trim();
  if (!v) { toast('英文を入力してください'); el?.focus(); return; }
  submitAnswer([v]);
}

function submitAnswer(cands) {
  const c = ui.drill.cur;
  if (c.phase !== 'answer') return;
  recognizer.abort();
  holdEnd(true);
  if (c.reactMs == null) markReact();
  c.grade = grade(cands, c.item, S.strictness);
  c.micState = 'idle';
  diag.push(`判定：${Math.round(c.grade.score * 100)}%（${c.grade.verdict}）`);
  if (c.attempt === 1) { c.first = c.grade; c.firstReactMs = c.reactMs; c.hintAtFirst = c.hint; }
  c.phase = 'result';
  render();
  afterGrade();
}

function giveUp() {
  const c = ui.drill.cur;
  if (c.phase !== 'answer') return;
  recognizer.abort();
  holdEnd(true);
  c.gaveUp = true;
  c.micState = 'idle';
  c.grade = grade([], c.item, S.strictness);
  if (c.attempt === 1) { c.first = c.grade; c.firstReactMs = null; c.hintAtFirst = c.hint; }
  c.phase = 'result';
  render();
  afterGrade();
}

async function afterGrade() {
  const c = ui.drill.cur;
  const token = c.token;
  const aiPending = S.ai.enabled && S.ai.auto && S.ai.apiKey && c.grade.userText && c.grade.verdict !== 'correct';
  if (aiPending) runAI();
  const autoplay = S.autoPlayAnswer && audioAllowed();
  if (autoplay) diag.push('模範解答を読み上げ');
  const playing = autoplay ? speakEn(c.item.en) : Promise.resolve();
  if (S.autoNext && isCorrect(attemptOutcome(c)) && !aiPending) {
    await playing;
    if (!alive(token) || c.phase !== 'result') return;
    clearTimeout(autoNextTimer);
    autoNextTimer = setTimeout(() => { if (alive(token) && c.phase === 'result') next(); }, 900);
  }
}

function outcomeOf(g, reactMs, hinted) {
  if (!g) return 'miss';
  if (g.verdict === 'correct') {
    const limit = S.timeLimit * 1000;
    return (limit && reactMs != null && reactMs > limit) || hinted ? 'good' : 'perfect';
  }
  return g.verdict === 'close' ? 'close' : 'miss';
}
// 表示用：今回の回答の判定
const attemptOutcome = (c) => c.override || outcomeOf(c.grade, c.reactMs, c.hint > 0);
// 記録用：1回目の回答の判定（手動修正があればそれを優先）
const recordedOutcome = (c) => c.override || outcomeOf(c.first, c.firstReactMs, c.hintAtFirst > 0);

function retry() {
  const c = ui.drill.cur;
  if (c.phase !== 'result') return;
  clearTimeout(autoNextTimer);
  stopSpeaking();
  Object.assign(c, { phase: 'answer', attempt: c.attempt + 1, grade: null, gaveUp: false, interim: '', draft: '', ai: null, micError: '', micState: 'idle', manualStop: false, reactMs: null, shownAt: 0, noSpeech: 0, token: ++tokenSeq });
  render();
  startQuestion();
}

function commitCurrent() {
  const d = ui.drill;
  const c = d.cur;
  if (c.committed || c.phase !== 'result') return;
  c.committed = true;
  const outcome = recordedOutcome(c);
  const ms = c.firstReactMs;
  recordResult(c.item.id, outcome, ms, { isRetry: c.isRetry });
  d.results.push({ id: c.item.id, outcome, ms, retry: c.isRetry });
  if (S.requeueMissed && !c.isRetry && !isCorrect(outcome) && !d.requeued.has(c.item.id)) {
    d.requeued.add(c.item.id);
    d.queue.push({ id: c.item.id, retry: true });
  }
}

function next() {
  const d = ui.drill;
  if (!d || d.cur.phase !== 'result') return;
  clearTimeout(autoNextTimer);
  stopSpeaking();
  commitCurrent();
  d.idx++;
  if (d.idx >= d.queue.length) { finishSession(); return; }
  prepareQuestion();
  render();
  window.scrollTo(0, 0);
  startQuestion();
}

function finishSession() {
  const d = ui.drill;
  ui.lastSession = { sceneKey: d.sceneKey, level: d.level, results: d.results };
  teardownDrill();
  ui.drill = null;
  go('result', { replace: true });
}

// popView: ブラウザの戻る操作で抜けた場合の遷移先
function quitDrill(popView = null) {
  const d = ui.drill;
  if (!d) return;
  if (d.cur.phase === 'result') commitCurrent();
  if (d.results.length) {
    if (popView) history.pushState({ view: 'drill' }, '');
    finishSession();
  } else {
    teardownDrill();
    ui.drill = null;
    if (popView) showView(popView);
    else history.back();
  }
}

function toggleInputMode() {
  const c = ui.drill?.cur;
  S.inputMode = S.inputMode === 'voice' ? 'keyboard' : 'voice';
  save();
  toast(S.inputMode === 'voice' ? '音声入力に切り替えました' : 'キーボード入力に切り替えました（電車モード）');
  if (!c) { render(); return; }
  recognizer.abort();
  holdEnd(true);
  c.micState = 'idle';
  c.micError = '';
  if (S.inputMode === 'keyboard') stopSpeaking();
  render();
  if (c.phase === 'answer' && S.inputMode === 'voice' && S.autoMic && !holdMode() && canRecognize && c.shownAt) startListening();
}

// ---- AI添削
async function runAI() {
  const d = ui.drill;
  const c = d?.cur;
  if (!c?.grade?.userText) return;
  if (!S.ai.apiKey) { toast('設定でAPIキーを登録してください'); return; }
  const token = c.token;
  const g = c.grade;
  c.ai = { status: 'loading' };
  if (c.phase === 'result') render();
  try {
    const data = await reviewAnswer({
      apiKey: S.ai.apiKey,
      model: S.ai.model,
      item: c.item,
      sceneName: sceneById(c.item.scene).name,
      levelName: `Lv${c.item.level} ${levelById(c.item.level).name}`,
      userText: g.userText,
    });
    addAiUsage(data.usage, data.costUSD);
    if (!alive(token)) return;
    c.ai = { status: 'done', data };
    // AIは判定の引き上げのみ行う（言い換え表現を正解として扱うため）
    if (data.verdict === 'correct' && g.verdict !== 'correct') { g.verdict = 'correct'; g.byAI = true; }
    else if (data.verdict === 'acceptable' && g.verdict === 'wrong') { g.verdict = 'close'; g.byAI = true; }
  } catch (e) {
    if (!alive(token)) return;
    c.ai = { status: 'error', error: e.message || String(e) };
  }
  if (c.phase === 'result') render();
}

function aiBlock(c) {
  if (!S.ai.enabled || !c.grade?.userText) return '';
  const a = c.ai;
  if (!a) return `<button class="btn btn-ghost btn-block ai-btn" data-act="ai">${I.spark}<span>AI添削を受ける</span></button>`;
  if (a.status === 'loading') return `<div class="ai-box loading">${I.spark}<span>AIが添削しています…</span></div>`;
  if (a.status === 'error') return `<div class="ai-box error"><span>${esc(a.error)}</span> <button class="link" data-act="ai">再試行</button></div>`;
  const head = { correct: '自然で正しい英語です', acceptable: '意味は通じます（改善の余地あり）', incorrect: '修正が必要です' }[a.data.verdict] || '';
  const same = a.data.better && tokenize(a.data.better).norm.join(' ') === tokenize(c.grade.userText).norm.join(' ');
  return `
  <div class="ai-box v-${esc(a.data.verdict)}">
    <div class="ai-head">${I.spark}<span>AI添削：${head}</span></div>
    <p>${esc(a.data.feedback)}</p>
    ${a.data.better && !same ? `<div class="ai-better"><span class="ai-tag">改善例</span><span>${esc(a.data.better)}</span>${playBtn(a.data.better)}</div>` : ''}
    <p class="ai-usage">今回：入力 ${a.data.usage.input.toLocaleString()}・出力 ${a.data.usage.output.toLocaleString()} トークン（約 ${yen(a.data.costUSD)}）</p>
  </div>`;
}

function yen(usd) {
  const v = usd * USD_TO_JPY;
  return `${v < 10 ? v.toFixed(2) : Math.round(v).toLocaleString()}円`;
}

// ---- 描画
function viewDrill() {
  const d = ui.drill;
  const c = d.cur;
  const it = c.item;
  const sc = sceneById(it.scene);
  const lv = levelById(it.level);
  const kb = S.inputMode === 'keyboard';
  const rec = recordOf(it.id);
  const status = c.isRetry ? '<span class="chip chip-warn">再挑戦</span>' : !rec ? '<span class="chip chip-new">NEW</span>' : rec.box >= MASTERED_BOX ? '<span class="chip">定着</span>' : '<span class="chip">復習</span>';
  return `
  <header class="drill-top">
    <button class="icon-btn" data-act="quit" aria-label="トレーニングを終了">${I.close}</button>
    <div class="drill-progress">
      <div class="bar"><span style="width:${(d.idx / d.queue.length) * 100}%"></span></div>
      <small>${d.idx + 1} / ${d.queue.length}</small>
    </div>
    <button class="icon-btn mode-toggle" data-act="toggle-input" aria-label="${kb ? '音声入力に切り替え' : 'キーボード入力に切り替え'}" title="${kb ? '音声入力に切り替え' : 'キーボード入力（電車モード）に切り替え'}">${kb ? I.mic : I.kbd}</button>
  </header>
  <div class="q-meta">
    <span class="chip"><span aria-hidden="true">${sc.icon}</span> ${esc(sc.short)}</span>
    <span class="chip lv-${it.level}">Lv${it.level} ${esc(lv.ja)}</span>
    ${status}
  </div>
  <section class="prompt">
    <p class="ja">${esc(it.ja)}</p>
    ${c.hint && c.phase === 'answer' ? `<p class="hint-text" aria-label="ヒント">${esc(hintText(it.en, c.hint))}</p>` : ''}
  </section>
  ${c.phase === 'answer' ? answerPanel(c, kb) : resultPanel(c)}`;
}

function answerPanel(c, kb) {
  const timer = `<div class="timer" id="timer"><div class="timer-track"><div class="timer-fill" id="timerFill"></div></div><span class="timer-label" id="timerLabel">${c.shownAt ? '' : '準備中…'}</span></div>`;
  const body = kb ? `
    <form class="kbd-form" id="kbdForm" autocomplete="off">
      <textarea id="kbdInput" rows="2" placeholder="英語で入力して Enter" autocapitalize="sentences" spellcheck="false" enterkeyhint="send" aria-label="英文を入力">${esc(c.draft)}</textarea>
      <button class="btn btn-primary" type="submit">回答</button>
    </form>` : voicePanel(c);
  return `
  ${timer}
  ${body}
  <div class="sub-actions">
    <button class="btn btn-ghost" data-act="hint" ${c.hint >= 2 ? 'disabled' : ''}>${I.bulb}<span>ヒント${c.hint ? `（${c.hint}/2）` : ''}</span></button>
    <button class="btn btn-ghost" data-act="giveup">答えを見る</button>
  </div>
  ${diagPanel()}`;
}

function voicePanel(c) {
  const hold = holdMode();
  const wait = c.micState === 'starting';
  const on = c.micState === 'ready';
  let placeholder;
  let caption;
  if (!canRecognize) {
    placeholder = 'このブラウザは音声認識に対応していません';
    caption = '';
  } else if (wait) {
    placeholder = 'マイクを準備しています…';
    caption = hold ? '準備中… そのまま押し続けてください' : '準備中…「話してください」と表示されてから話し始めてください';
  } else if (on) {
    placeholder = '話してください';
    caption = hold ? '話し終えたらボタンを離すと判定します' : '話し終えると自動で判定します（タップで終了）';
  } else {
    placeholder = hold ? 'ボタンを押している間だけ録音します' : 'マイクをタップして英語で話す';
    caption = hold ? `押したまま話して、離すと判定${isDesktop ? '（Space キーでも可）' : ''}` : `タップして話す${isDesktop ? '（Space キー）' : ''}`;
  }
  const label = hold ? '押している間だけ録音' : on || wait ? '録音を終了して判定' : '録音を開始';
  return `
    <div class="voice-box">
      <div class="transcript ${c.interim ? 'has-text' : ''} ${on ? 'live' : ''} ${wait ? 'wait' : ''}" id="transcript" aria-live="polite">${c.interim ? esc(c.interim) : `<span class="placeholder ${on ? 'go' : ''}">${placeholder}</span>`}</div>
      <button class="mic-btn ${on ? 'on' : ''} ${wait ? 'wait' : ''} ${hold ? 'hold' : ''}" ${hold ? 'data-hold-mic' : 'data-act="mic"'} ${canRecognize ? '' : 'disabled'} aria-label="${label}">${I.mic}</button>
      <p class="mic-caption ${on ? 'go' : ''}">${caption}</p>
      ${c.micError ? `<p class="notice warn">${esc(c.micError)}${c.micErrorAutoplay ? '<br>2問目以降で続く場合は、模範解答の読み上げのあとにマイクが止まっている可能性があります。' : ''}
        <span class="notice-actions">${c.micErrorAutoplay ? '<button class="link" data-act="disable-autoplay">模範解答の自動再生をオフにする</button>' : ''}<button class="link" data-act="toggle-input">キーボードで答える</button></span></p>` : ''}
    </div>`;
}

const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function diagEnv() {
  return [
    isIOS ? 'iOS' : isDesktop ? 'PC' : 'モバイル',
    recognizer.continuous ? '連続認識' : '単発認識',
    holdMode() ? '押して録音' : `自動判定（無音 ${(S.silenceMs / 1000).toFixed(1)}秒）`,
    isStandalone() ? 'ホーム画面から起動' : 'ブラウザで表示',
    canRecognize ? '認識APIあり' : '認識APIなし',
  ].join(' / ');
}

function diagPanel() {
  if (!S.diagnostics || S.inputMode !== 'voice') return '';
  return `
  <details class="diag" ${ui.diagOpen === false ? '' : 'open'}>
    <summary>診断ログ</summary>
    <p class="diag-env">${esc(diagEnv())}</p>
    <pre id="diagLog">${esc(diag.text())}</pre>
    <div class="inline">
      <button class="btn btn-secondary btn-sm" data-act="copy-diag">ログをコピー</button>
      <button class="btn btn-ghost btn-sm" data-act="clear-diag">クリア</button>
    </div>
  </details>`;
}

function resultPanel(c) {
  const d = ui.drill;
  const it = c.item;
  const g = c.grade;
  const outcome = attemptOutcome(c);
  const o = OUTCOMES[outcome];
  const tags = [];
  if (c.reactMs != null && !c.gaveUp) tags.push(`反応 ${(c.reactMs / 1000).toFixed(1)}秒`);
  if (!c.override && outcome === 'good') tags.push(c.hint ? 'ヒントあり' : '時間オーバー');
  if (g.byAI) tags.push('AI判定');
  if (c.override) tags.push('手動判定');
  const recorded = recordedOutcome(c);
  // AIが言い換えとして正解と判定した場合は、模範解答との差分表示を出さない
  const showDiff = !(g.byAI && g.verdict === 'correct');
  const userLine = g.userText
    ? `<p class="answer user">${renderEn(g.userText, null, showDiff ? g.userMarks : null)}</p>`
    : '<p class="answer user muted">（回答なし）</p>';
  const showNear = showDiff && g.userText && !g.isMain && g.score >= 0.5;
  const hasDiff = showDiff && g.userText && (g.userMarks.some((m) => m !== 'ok' && m !== 'soft') || (g.isMain && g.refMarks.some((m) => m === 'miss' || m === 'near')));
  const last = d.idx + 1 >= d.queue.length;
  return `
  <section class="result">
    <div class="verdict v-${o.cls}">
      <span class="v-mark" aria-hidden="true">${o.mark}</span>
      <span class="v-label">${o.label}</span>
      <span class="v-tags">${tags.map((t) => `<span>${esc(t)}</span>`).join('')}</span>
    </div>
    ${c.attempt > 1 && !c.override ? `<p class="record-note">学習記録には1回目の結果（${OUTCOMES[recorded].mark} ${OUTCOMES[recorded].label}）が保存されます</p>` : ''}

    <div class="ans-block">
      <div class="ans-label">あなたの回答${c.attempt > 1 ? `（${c.attempt}回目）` : ''}</div>
      ${userLine}
    </div>
    <div class="ans-block model">
      <div class="ans-label">模範解答 ${playBtn(it.en, '模範解答を再生')}</div>
      <p class="answer en">${renderEn(it.en, it.key, showDiff && g.isMain && g.userText ? g.refMarks : null)}</p>
    </div>
    ${showNear ? `
    <div class="ans-block">
      <div class="ans-label">あなたの回答に近い表現 ${playBtn(g.refText)}</div>
      <p class="answer en">${renderEn(g.refText, null, g.refMarks)}</p>
    </div>` : ''}
    ${hasDiff ? '<p class="legend"><span class="m-miss">赤</span>：違い・抜け <span class="m-near">黄</span>：つづり・発音が近い語</p>' : ''}
    ${it.note ? `<div class="note">${I.bulb}<p>${esc(it.note)}</p></div>` : ''}
    ${aiBlock(c)}
    ${it.alt.length ? `
    <details class="alts">
      <summary>別の言い方（${it.alt.length}）</summary>
      <ul>${it.alt.map((a) => `<li><span>${esc(a)}</span>${playBtn(a)}</li>`).join('')}</ul>
    </details>` : ''}
    <div class="judge-fix">
      <span>判定を修正</span>
      <button class="chip-btn ${c.override === 'perfect' ? 'on' : ''}" data-act="override" data-val="perfect">◎ 正解にする</button>
      <button class="chip-btn ${c.override === 'miss' ? 'on' : ''}" data-act="override" data-val="miss">× 不正解にする</button>
    </div>
    ${diagPanel()}
  </section>
  <div class="action-bar">
    <button class="btn btn-secondary" data-act="retry">${I.retry}<span>もう一度</span></button>
    <button class="btn btn-primary btn-grow" data-act="next">${last ? '結果を見る' : '次へ'}${I.next}</button>
  </div>`;
}

function afterDrillRender() {
  const log = document.getElementById('diagLog');
  if (log) log.scrollTop = log.scrollHeight;
  const c = ui.drill?.cur;
  if (!c || c.phase !== 'answer') return;
  paintTimer(c);
  if (S.inputMode === 'keyboard') {
    const el = document.getElementById('kbdInput');
    if (el) {
      el.focus({ preventScroll: true });
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }
}

// ---------------------------------------------------------------- 結果
function viewResult() {
  const s = ui.lastSession;
  if (!s) return viewHome();
  const main = s.results.filter((r) => !r.retry);
  const n = main.length;
  const counts = { perfect: 0, good: 0, close: 0, miss: 0 };
  main.forEach((r) => counts[r.outcome]++);
  const ok = counts.perfect + counts.good;
  const pct = n ? Math.round((ok / n) * 100) : 0;
  const ms = main.filter((r) => r.ms != null && isCorrect(r.outcome)).map((r) => r.ms);
  const avg = ms.length ? (ms.reduce((a, b) => a + b, 0) / ms.length / 1000).toFixed(1) : '–';
  const missed = [...new Set(main.filter((r) => !isCorrect(r.outcome)).map((r) => r.id))];
  const sc = sceneById(s.sceneKey);
  const R = 52;
  const circ = 2 * Math.PI * R;
  const msg = pct >= 90 ? 'すばらしい！この調子で続けましょう。' : pct >= 70 ? 'いい感じです。間違えた文をもう一度確認しましょう。' : pct >= 40 ? '少しずつ定着しています。復習で仕上げましょう。' : 'まずは模範解答を声に出して覚えましょう。';
  return `
  <header class="topbar">
    <span class="spacer"></span>
    <h1 class="title">トレーニング結果</h1>
    <button class="icon-btn" data-act="home" aria-label="ホームへ">${I.close}</button>
  </header>
  <section class="card summary">
    <div class="ring" role="img" aria-label="正答率 ${pct}%">
      <svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="${R}" class="ring-bg"/><circle cx="60" cy="60" r="${R}" class="ring-fg" stroke-dasharray="${circ}" stroke-dashoffset="${circ * (1 - pct / 100)}"/></svg>
      <div class="ring-text"><b>${pct}<small>%</small></b><span>正答率</span></div>
    </div>
    <div class="summary-side">
      <p class="summary-scene">${sc ? `${sc.icon} ${esc(sc.name)}` : ''}${s.level !== 'all' ? ` ・ Lv${s.level}` : ''}</p>
      <div class="summary-stats">
        <span><b>${n}</b>問</span>
        <span><b>${avg}</b>秒<small>平均反応</small></span>
      </div>
      <div class="outcome-row">
        ${Object.entries(counts).map(([k, v]) => `<span class="oc v-${k}"><i>${OUTCOMES[k].mark}</i>${v}</span>`).join('')}
      </div>
    </div>
  </section>
  <p class="summary-msg">${msg}</p>
  <ul class="result-list">
    ${main.map((r) => {
      const it = ITEM_MAP.get(r.id);
      return `<li class="v-${r.outcome}">
        <span class="rl-mark">${OUTCOMES[r.outcome].mark}</span>
        <div class="rl-body"><p class="rl-ja">${esc(it.ja)}</p><p class="rl-en">${renderEn(it.en, it.key)}</p></div>
        ${playBtn(it.en)}
      </li>`;
    }).join('')}
  </ul>
  <div class="action-bar stack">
    ${missed.length ? `<button class="btn btn-primary btn-block" data-act="retry-missed">${I.retry}<span>間違えた${missed.length}問をもう一度</span></button>` : ''}
    <div class="row">
      <button class="btn btn-secondary btn-grow" data-act="home">ホームへ</button>
      <button class="btn ${missed.length ? 'btn-secondary' : 'btn-primary'} btn-grow" data-act="continue">続けて学習${I.next}</button>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- フレーズ帳
function filteredItems() {
  const f = ui.list;
  const q = f.q.trim().toLowerCase();
  return ITEMS.filter((i) => (f.scene === 'all' || i.scene === f.scene)
    && (f.level === 'all' || i.level === +f.level)
    && (!q || i.ja.includes(q) || i.en.toLowerCase().includes(q) || i.alt.some((a) => a.toLowerCase().includes(q))));
}

function phraseRows(items) {
  if (!items.length) return '<li class="empty">該当する文がありません</li>';
  return items.map((it) => {
    const r = recordOf(it.id);
    const st = !r ? 'new' : r.box >= MASTERED_BOX ? 'mastered' : r.last === 'miss' || r.last === 'close' ? 'weak' : 'learning';
    const stLabel = { new: '未学習', mastered: '定着', weak: '苦手', learning: '学習中' }[st];
    return `<li class="phrase">
      <span class="dot st-${st}" title="${stLabel}" aria-label="${stLabel}"></span>
      <div class="ph-body">
        <p class="ph-ja">${esc(it.ja)}</p>
        <p class="ph-en ${ui.list.hide ? 'concealed' : ''}" data-act="reveal">${renderEn(it.en, it.key)}</p>
      </div>
      <div class="ph-side"><span class="chip lv-${it.level}">Lv${it.level}</span>${playBtn(it.en)}</div>
    </li>`;
  }).join('');
}

function viewList() {
  const f = ui.list;
  const items = filteredItems();
  return `
  <header class="topbar">
    <button class="icon-btn" data-act="back" aria-label="戻る">${I.back}</button>
    <h1 class="title">フレーズ帳</h1>
    <span class="spacer"></span>
  </header>
  <div class="filters">
    <select id="listScene" aria-label="シーン">
      <option value="all">すべてのシーン</option>
      ${SCENES.map((s) => `<option value="${s.id}" ${f.scene === s.id ? 'selected' : ''}>${s.icon} ${esc(s.name)}</option>`).join('')}
    </select>
    ${seg([{ value: 'all', label: '全' }, ...LEVELS.map((l) => ({ value: l.id, label: `Lv${l.id}` }))], f.level, 'list-level', 'seg-sm')}
    <div class="filter-row">
      <input id="listSearch" type="search" placeholder="日本語・英語で検索" value="${esc(f.q)}" aria-label="検索">
      <label class="switch-label"><input type="checkbox" id="listHide" ${f.hide ? 'checked' : ''}><span>英文を隠す</span></label>
    </div>
  </div>
  <p class="list-count" id="listCount">${items.length}文${f.hide ? ' ・ 英文をタップで表示' : ''}</p>
  <ul class="phrase-list" id="phraseList">${phraseRows(items)}</ul>
  <div class="action-bar">
    <button class="btn btn-primary btn-block" data-act="practice-list" ${items.length ? '' : 'disabled'}>${S.inputMode === 'voice' ? I.mic : I.kbd}<span>表示中の文で練習（最大${S.sessionSize}問）</span></button>
  </div>`;
}

function refreshPhraseList() {
  const items = filteredItems();
  document.getElementById('phraseList').innerHTML = phraseRows(items);
  document.getElementById('listCount').textContent = `${items.length}文${ui.list.hide ? ' ・ 英文をタップで表示' : ''}`;
  const btn = $app.querySelector('[data-act="practice-list"]');
  if (btn) btn.disabled = !items.length;
}

// ---------------------------------------------------------------- 設定
function toggleRow(key, label, desc = '') {
  const val = key.split('.').reduce((o, k) => o[k], S);
  return `<label class="set-row">
    <span class="set-text"><b>${label}</b>${desc ? `<small>${desc}</small>` : ''}</span>
    <input type="checkbox" class="switch" data-set="${key}" ${val ? 'checked' : ''}>
  </label>`;
}

function viewSettings() {
  const voices = englishVoices();
  return `
  <header class="topbar">
    <button class="icon-btn" data-act="back" aria-label="戻る">${I.back}</button>
    <h1 class="title">設定</h1>
    <span class="spacer"></span>
  </header>

  <section class="set-group">
    <h2>回答</h2>
    <div class="set-row col"><span class="set-text"><b>入力方法</b><small>トレーニング中も右上のボタンで切り替えられます</small></span>${inputModeSeg()}</div>
    <div class="set-row col"><span class="set-text"><b>録音のしかた</b><small>iPhone で途中で切れる・認識されないときは「押している間だけ」がおすすめです</small></span>
      ${seg([{ value: 'auto', label: '話し終えたら自動で判定' }, { value: 'hold', label: '押している間だけ録音' }], S.recMode, 'setting', 'seg-sm', 'data-key="recMode"')}
    </div>
    ${S.recMode === 'auto' ? `
    ${toggleRow('autoMic', '出題と同時に録音を開始', 'マイクボタンを押さずにそのまま答えられます')}
    <div class="set-row col"><span class="set-text"><b>話し終わりの判定時間</b><small>この時間、新しい言葉が認識されなければ話し終えたとみなします。途中で切れるときは長くしてください</small></span>
      ${seg([1200, 2000, 3000, 4000].map((v) => ({ value: v, label: `${v / 1000}秒` })), S.silenceMs, 'setting', 'seg-sm', 'data-key="silenceMs" data-num="1"')}
    </div>` : ''}
    <div class="set-row col"><span class="set-text"><b>制限時間</b><small>日本語が表示されてから話し始める（入力し始める）までの目安</small></span>
      ${seg([{ value: 3, label: '3秒' }, { value: 5, label: '5秒' }, { value: 8, label: '8秒' }, { value: 0, label: 'なし' }], S.timeLimit, 'setting', 'seg-sm', 'data-key="timeLimit" data-num="1"')}
    </div>
    <div class="set-row col"><span class="set-text"><b>判定の厳しさ</b><small>模範解答・別解との一致度の基準</small></span>
      ${seg(Object.entries(STRICTNESS).map(([k, v]) => ({ value: k, label: v.label })), S.strictness, 'setting', 'seg-sm', 'data-key="strictness"')}
    </div>
  </section>

  <section class="set-group">
    <h2>音声</h2>
    ${toggleRow('autoPlayAnswer', '判定後に模範解答を再生')}
    ${toggleRow('muteInKeyboard', 'キーボードモードでは自動再生しない', '電車など音を出せない場所向け（再生ボタンは使えます）')}
    ${toggleRow('readPrompt', '日本語の問題文を読み上げる', 'イヤホンで画面を見ずに練習するとき向け')}
    <div class="set-row col"><span class="set-text"><b>英語の読み上げ速度</b></span>
      ${seg([0.8, 0.9, 0.95, 1, 1.1].map((v) => ({ value: v, label: `${v}x` })), S.rate, 'setting', 'seg-sm', 'data-key="rate" data-num="1"')}
    </div>
    <div class="set-row col"><span class="set-text"><b>英語の音声</b></span>
      <div class="inline">
        <select data-set="voiceURI" aria-label="英語の音声">
          <option value="">自動（おすすめ）</option>
          ${voices.map((v) => `<option value="${esc(v.voiceURI)}" ${S.voiceURI === v.voiceURI ? 'selected' : ''}>${esc(v.name)}（${esc(v.lang)}）</option>`).join('')}
        </select>
        <button class="btn btn-secondary" data-act="play" data-text="I look forward to working with you.">${I.play}<span>試聴</span></button>
      </div>
    </div>
  </section>

  <section class="set-group">
    <h2>トラブルシューティング</h2>
    ${toggleRow('diagnostics', '音声認識の診断ログを表示', 'マイクの準備・声の検知・認識結果などのタイミングをトレーニング画面に表示します。うまく認識されないときの原因調査に使います')}
    <p class="set-desc">${esc(diagEnv())}</p>
  </section>

  <section class="set-group">
    <h2>学習</h2>
    ${toggleRow('requeueMissed', '間違えた文をセッションの最後にもう一度出す')}
    ${toggleRow('autoNext', '正解したら自動で次の問題へ')}
  </section>

  <section class="set-group">
    <h2>AI添削（任意）</h2>
    <p class="set-desc">模範解答と違う言い回しでも、Claude が意味と自然さを判定してフィードバックします。利用には <a href="https://console.anthropic.com/" target="_blank" rel="noopener">Anthropic の APIキー</a> が必要で、APIの利用料金がかかります。キーはこの端末にのみ保存され、回答文とともに Anthropic の API へ直接送信されます。</p>
    ${toggleRow('ai.enabled', 'AI添削を使う')}
    ${S.ai.enabled ? `
    <div class="set-row col"><span class="set-text"><b>APIキー</b></span>
      <input type="password" class="text-input" data-set-text="ai.apiKey" value="${esc(S.ai.apiKey)}" placeholder="sk-ant-..." autocomplete="off" spellcheck="false">
    </div>
    <div class="set-row col"><span class="set-text"><b>モデル</b></span>
      <select data-set="ai.model" aria-label="AIモデル">${AI_MODELS.map((m) => `<option value="${m.id}" ${S.ai.model === m.id ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select>
    </div>
    ${toggleRow('ai.auto', '不正解・惜しいときは自動で添削', 'オフの場合は結果画面のボタンで依頼します')}
    <div class="set-row col"><span class="set-text"><b>これまでの利用量</b><small>${db.aiUsage.since ? `${new Date(db.aiUsage.since).toLocaleDateString('ja-JP')} から` : 'まだ利用していません'}</small></span>
      <div class="usage-box">
        <div><b>${db.aiUsage.calls.toLocaleString()}</b><span>回</span></div>
        <div><b>${db.aiUsage.input.toLocaleString()}</b><span>入力トークン</span></div>
        <div><b>${db.aiUsage.output.toLocaleString()}</b><span>出力トークン</span></div>
        <div><b>${yen(db.aiUsage.usd)}</b><span>概算（$${db.aiUsage.usd.toFixed(3)}）</span></div>
      </div>
      <p class="set-note">1ドル＝${USD_TO_JPY}円で換算した概算です。実際の請求額は Anthropic Console で確認できます。 <button class="link" data-act="reset-ai-usage">利用量をリセット</button></p>
    </div>` : ''}
  </section>

  <section class="set-group">
    <h2>データ</h2>
    <p class="set-desc">学習記録はこのブラウザに保存されています。機種変更の際はバックアップを書き出して、新しい端末で読み込んでください。</p>
    <div class="inline wrap">
      <button class="btn btn-secondary" data-act="export">バックアップを書き出す</button>
      <label class="btn btn-secondary file-btn">バックアップを読み込む<input type="file" id="importFile" accept="application/json,.json" hidden></label>
      <button class="btn btn-danger" data-act="reset">学習記録をリセット</button>
    </div>
  </section>
  <p class="foot">瞬英トレーナー ・ 全${ITEMS.length}文（${SCENES.length}シーン × 4レベル）</p>`;
}

function setPath(path, val) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => o[k], S)[last] = val;
  save();
}

// ---------------------------------------------------------------- イベント
const actions = {
  go: (el) => go(el.dataset.view),
  back: () => history.back(),
  home: () => go('home', { replace: ui.view === 'result' }),
  cat: (el) => { ui.cat = el.dataset.val; render(); },
  'input-mode': (el) => { S.inputMode = el.dataset.val; save(); render(); },
  'pick-scene': (el) => {
    ui.setupScene = el.dataset.val;
    const lv = S.lastLevel[ui.setupScene];
    ui.setupLevel = lv == null ? 'all' : lv;
    go('setup');
  },
  'set-level': (el) => { ui.setupLevel = el.dataset.val === 'all' ? 'all' : +el.dataset.val; render(); },
  'session-mode': (el) => { S.sessionMode = el.dataset.val; save(); render(); },
  'session-size': (el) => { S.sessionSize = +el.dataset.val; save(); render(); },
  start: () => {
    S.lastLevel[ui.setupScene] = ui.setupLevel;
    save();
    startSession(ui.setupScene, ui.setupLevel);
  },
  'quick-review': () => startSession('mix-all', 'all', { mode: 'due' }),
  quit: () => quitDrill(),
  'toggle-input': () => toggleInputMode(),
  mic: () => toggleMic(),
  hint: () => {
    const c = ui.drill.cur;
    if (c.phase !== 'answer' || c.hint >= 2) return;
    c.hint++;
    render();
  },
  giveup: () => giveUp(),
  retry: () => retry(),
  next: () => next(),
  override: (el) => {
    const c = ui.drill.cur;
    c.override = c.override === el.dataset.val ? null : el.dataset.val;
    clearTimeout(autoNextTimer);
    render();
  },
  ai: () => runAI(),
  play: (el) => { if (recognizer.busy) recognizer.abort(); speakEn(el.dataset.text); },
  'disable-autoplay': () => {
    S.autoPlayAnswer = false;
    save();
    const c = ui.drill?.cur;
    if (c) { c.micError = ''; c.micErrorAutoplay = false; }
    toast('模範解答の自動再生をオフにしました（🔊 ボタンで再生できます）');
    render();
  },
  'copy-diag': () => {
    const text = `${diagEnv()}\n${navigator.userAgent}\n${diag.text()}`;
    (navigator.clipboard?.writeText(text) || Promise.reject())
      .then(() => toast('診断ログをコピーしました'))
      .catch(() => {
        const pre = document.getElementById('diagLog');
        if (pre) getSelection().selectAllChildren(pre);
        toast('ログを選択しました。長押しでコピーしてください');
      });
  },
  'clear-diag': () => { diag.lines.length = 0; diag.push('ログをクリア'); },
  'reset-ai-usage': () => {
    if (!confirm('AI添削の利用量の記録をリセットしますか？')) return;
    resetAiUsage();
    render();
  },
  'retry-missed': () => {
    const s = ui.lastSession;
    const ids = [...new Set(s.results.filter((r) => !r.retry && !isCorrect(r.outcome)).map((r) => r.id))];
    startSession(s.sceneKey, s.level, { ids });
  },
  continue: () => startSession(ui.lastSession.sceneKey, ui.lastSession.level),
  'list-level': (el) => { ui.list.level = el.dataset.val; render(); },
  reveal: (el) => el.classList.remove('concealed'),
  'practice-list': () => {
    const items = filteredItems().map((i) => i.id);
    for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }
    const sceneKey = ui.list.scene === 'all' ? 'mix-all' : ui.list.scene;
    startSession(sceneKey, ui.list.level === 'all' ? 'all' : +ui.list.level, { ids: items.slice(0, S.sessionSize) });
  },
  setting: (el) => {
    const group = el.closest('.seg');
    const v = group.dataset.num ? +el.dataset.val : el.dataset.val;
    setPath(group.dataset.key, v);
    render();
  },
  export: () => {
    const blob = new Blob([exportData()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `shunei-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  reset: () => {
    if (!confirm('学習記録（進捗・履歴）をすべて削除します。よろしいですか？')) return;
    resetProgress();
    toast('学習記録をリセットしました');
    render();
  },
};

$app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  fn(el, e);
});

$app.addEventListener('input', (e) => {
  const el = e.target;
  if (el.id === 'kbdInput') {
    const c = ui.drill?.cur;
    if (c) { c.draft = el.value; if (el.value.trim()) markReact(); }
  } else if (el.id === 'listSearch') {
    ui.list.q = el.value;
    refreshPhraseList();
  } else if (el.dataset.setText) {
    setPath(el.dataset.setText, el.value.trim());
  }
});

$app.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.set) {
    setPath(el.dataset.set, el.type === 'checkbox' ? el.checked : el.value);
    if (el.dataset.set === 'ai.enabled') render();
  } else if (el.id === 'listScene') {
    ui.list.scene = el.value;
    render();
  } else if (el.id === 'listHide') {
    ui.list.hide = el.checked;
    refreshPhraseList();
  } else if (el.id === 'importFile' && el.files[0]) {
    el.files[0].text().then((txt) => {
      importData(txt);
      toast('バックアップを読み込みました');
      setTimeout(() => location.reload(), 600);
    }).catch((err) => toast(`読み込めませんでした：${err.message}`));
  }
});

$app.addEventListener('keydown', (e) => {
  if (e.target.id === 'kbdInput' && e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    submitTyped();
  }
});
$app.addEventListener('submit', (e) => {
  if (e.target.id === 'kbdForm') { e.preventDefault(); submitTyped(); }
});

// PC 向けショートカット
document.addEventListener('keydown', (e) => {
  if (ui.view !== 'drill' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = e.target.tagName;
  if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
  if (tag === 'BUTTON' && (e.key === 'Enter' || e.code === 'Space')) return;
  const c = ui.drill.cur;
  if (c.phase === 'answer') {
    if (e.code === 'Space' && S.inputMode === 'voice') { e.preventDefault(); if (holdMode()) holdStart(); else toggleMic(); }
    else if (e.key === 'h') actions.hint();
  } else if (e.key === 'Enter' || e.code === 'Space' || e.key === 'ArrowRight') {
    e.preventDefault();
    next();
  } else if (e.key === 'r') retry();
  else if (e.key === 'p') speakEn(c.item.en);
});

document.addEventListener('keyup', (e) => {
  if (ui.view === 'drill' && e.code === 'Space' && holdMode()) holdEnd();
});

$app.addEventListener('pointerdown', (e) => {
  const btn = e.target.closest('[data-hold-mic]');
  if (btn && !btn.disabled) holdStart(e);
});
$app.addEventListener('contextmenu', (e) => {
  if (e.target.closest('[data-hold-mic]')) e.preventDefault();
});
// details の開閉状態を再描画後も保つ（toggle はバブリングしないためキャプチャで受ける）
$app.addEventListener('toggle', (e) => {
  if (e.target.classList?.contains('diag')) ui.diagOpen = e.target.open;
}, true);

diag.subscribe(() => {
  const el = document.getElementById('diagLog');
  if (el) { el.textContent = diag.text(); el.scrollTop = el.scrollHeight; }
});

if (canSpeak) speechSynthesis.addEventListener?.('voiceschanged', () => { if (ui.view === 'settings') render(); });

// バックグラウンドに回ったら録音を止める（iOS でマイクが残るのを防ぐ）
document.addEventListener('visibilitychange', () => {
  if (document.hidden && recognizer.busy) {
    diag.push('バックグラウンドに移動したため録音を停止');
    recognizer.stop();
  }
});

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

history.replaceState({ view: 'home' }, '');
render();
