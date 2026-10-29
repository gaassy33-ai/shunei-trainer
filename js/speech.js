// 音声認識（Web Speech API）と読み上げ（speechSynthesis）
const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
export const canRecognize = !!SR;
export const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window;

const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
// iPadOS の Safari は Mac と同じ UA を返すため、タッチ対応かどうかでも判定する
export const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1);
const isAndroid = /Android/i.test(ua);

export const RECOGNITION_ERRORS = {
  'not-allowed': 'マイクの使用が許可されていません。ブラウザの設定でマイクを許可するか、キーボード入力に切り替えてください。',
  'service-not-allowed': '音声認識が使えません。iPhone の場合は「設定 → 一般 → キーボード → 音声入力」がオンか確認してください。ホーム画面から起動している場合は Safari で直接開いてください。',
  'audio-capture': 'マイクが見つかりません。接続を確認してください。',
  network: '音声認識サービスに接続できません。通信状況を確認してください。',
  'no-speech': '声が聞き取れませんでした。もう一度話してください。',
  'start-failed': '録音を開始できませんでした。マイクボタンをタップしてください。',
};

// ---- 診断ログ（認識イベントの時刻を記録して画面に表示する）
export const diag = {
  lines: [],
  t0: typeof performance !== 'undefined' ? performance.now() : 0,
  listeners: new Set(),
  mark(label) {
    this.t0 = performance.now();
    this.push(`── ${label}`);
  },
  push(msg) {
    const t = ((performance.now() - this.t0) / 1000).toFixed(2);
    this.lines.push(`+${t}s ${msg}`);
    if (this.lines.length > 80) this.lines.splice(0, this.lines.length - 80);
    for (const fn of this.listeners) fn();
  },
  text() { return this.lines.join('\n'); },
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
};

// 1回の発話ごとに「セッション」として認識を管理する。
// - iOS では連続認識（continuous）が不安定なため、1発話ずつ認識する。
// - iOS では読み上げ（speechSynthesis）のあと、同じ認識オブジェクトにマイク音声が届かなくなることがあるため、
//   毎回新しい認識オブジェクトを作る（reuse: false）。
// - マイク入力が始まっても音が届かない場合は、マイクを再起動して1度だけやり直す（noAudioMs）。
export class Recognizer {
  constructor({ lang = 'en-US', continuous = !(isIOS || isAndroid), reuse = !isIOS, stopTimeoutMs = 2000, abortTimeoutMs = 800, readyFallbackMs = 1200, maxMs = 25000, noAudioMs = 3000 } = {}) {
    Object.assign(this, { lang, continuous, reuse, stopTimeoutMs, abortTimeoutMs, readyFallbackMs, maxMs, noAudioMs });
    this.beforeStart = null; // 録音開始前に実行する処理（Promise を返すと完了を待つ）
    this.onRecover = null; // 音が届かないときの復旧処理
    this.sr = null;
    this.running = false; // エンジンが動作中（onend 待ち）
    this.session = null;
    this.pending = null; // 前のセッションの終了待ちで開始を保留しているセッション
    this.seq = 0;
  }

  get busy() { return !!this.session && !this.session.ended; }

  _ensure() {
    if (this.sr) return this.sr;
    const sr = new SR();
    diag.push('認識オブジェクトを作成');
    const cur = () => this.session;
    sr.onstart = () => {
      const s = cur();
      diag.push('start（認識開始）');
      if (s && !s.ended) s.readyTimer = setTimeout(() => this._ready(s, 'start+600ms'), 600);
    };
    sr.onaudiostart = () => { diag.push('audiostart（マイク入力開始）'); const s = cur(); if (s) this._ready(s, 'audiostart'); };
    sr.onsoundstart = () => { diag.push('soundstart（音を検知）'); const s = cur(); if (s && !s.ended) this._heard(s); };
    sr.onspeechstart = () => { diag.push('speechstart（声を検知）'); const s = cur(); if (s && !s.ended) this._spoke(s); };
    sr.onspeechend = () => diag.push('speechend');
    sr.onaudioend = () => diag.push('audioend');
    sr.onresult = (e) => this._onResult(cur(), e);
    sr.onerror = (e) => { diag.push(`error: ${e.error}`); const s = cur(); if (s && !s.ended) s.error = e.error; };
    sr.onend = () => this._onEnd();
    this.sr = sr;
    return sr;
  }

  // 認識オブジェクトを捨てる。後から古いオブジェクトのイベントが届いても影響しないよう、ハンドラも外す
  _discard() {
    const old = this.sr;
    if (!old) return;
    for (const k of ['onstart', 'onaudiostart', 'onsoundstart', 'onspeechstart', 'onspeechend', 'onaudioend', 'onresult', 'onerror', 'onend']) old[k] = null;
    this.sr = null;
  }

  // handlers: { onStateChange('starting'|'idle'), onReady, onSpeech, onInterim(text), onResult(candidates), onError(code) }
  // opts: { hold: 押している間だけ録音, silenceMs: 話し終わりとみなす無音時間 }
  start(handlers = {}, { hold = false, silenceMs = 2000 } = {}) {
    if (!SR) return false;
    if (this.busy) this.abort();
    const s = {
      id: ++this.seq, h: handlers, hold, holding: hold, silenceMs,
      finals: [], lastText: '', accum: '', error: null, spoke: false, ready: false,
      ended: false, aborted: false, stopRequested: false, startedAt: performance.now(),
    };
    this.session = s;
    handlers.onStateChange?.('starting');
    if (this.running) {
      // 前の認識がまだ終わっていない：終了を待ってから開始する（固まっていたら作り直す）
      this.pending = s;
      diag.push('前の認識の終了待ち');
      this._halt();
      s.pendingTimer = setTimeout(() => {
        if (this.pending !== s) return;
        diag.push('前の認識が終了しないため作り直し');
        this._discard();
        this.running = false;
        this.halting = false;
        this.pending = null;
        this._begin(s);
      }, this.abortTimeoutMs);
    } else {
      let prep = null;
      try { prep = this.beforeStart?.(); } catch { prep = null; }
      if (prep && typeof prep.then === 'function') {
        // 準備が必要なときだけ非同期にする（不要なときはタップ操作の中でそのまま開始する）
        prep.catch(() => {}).then(() => this._begin(s));
      } else {
        this._begin(s);
      }
    }
    return true;
  }

  _begin(s, isRestart = false) {
    if (s.ended || this.session !== s) return;
    if (s.stopRequested) { this._finish(s); return; }
    if (!this.reuse) this._discard();
    let sr = this._ensure();
    sr.lang = this.lang;
    sr.interimResults = true;
    sr.maxAlternatives = 5;
    sr.continuous = this.continuous;
    try {
      sr.start();
    } catch (err) {
      diag.push(`start() 失敗: ${err?.name || err}`);
      // 状態不整合のときは作り直して1回だけ再試行
      this._discard();
      sr = this._ensure();
      sr.lang = this.lang;
      sr.interimResults = true;
      sr.maxAlternatives = 5;
      sr.continuous = this.continuous;
      try {
        sr.start();
      } catch (err2) {
        diag.push(`start() 再試行も失敗: ${err2?.name || err2}`);
        this._finish(s, 'start-failed');
        return;
      }
    }
    this.running = true;
    diag.push(isRestart ? 'start() 再開' : `start() 呼び出し（${this.continuous ? '連続' : '単発'}認識${s.hold ? '・押して録音' : ''}${this.reuse ? '' : '・毎回新規'}）`);
    clearTimeout(s.readyFallback);
    s.readyFallback = setTimeout(() => this._ready(s, 'fallback'), this.readyFallbackMs);
    if (!isRestart) s.maxTimer = setTimeout(() => { diag.push('最大録音時間に到達'); this.stop(); }, s.hold ? this.maxMs + 5000 : this.maxMs);
  }

  _ready(s, how) {
    if (!s || s.ready || s.ended || this.session !== s) return;
    s.ready = true;
    clearTimeout(s.readyTimer);
    clearTimeout(s.readyFallback);
    diag.push(`準備完了（${how}）`);
    s.h.onReady?.();
    if (this.noAudioMs && !s.heard && !s.recovered) s.noAudioTimer = setTimeout(() => this._noAudio(s), this.noAudioMs);
  }

  _heard(s) {
    if (s.heard) return;
    s.heard = true;
    clearTimeout(s.noAudioTimer);
  }

  _spoke(s) {
    this._heard(s);
    if (s.spoke) return;
    s.spoke = true;
    this._ready(s, 'speech');
    s.h.onSpeech?.();
  }

  // マイク入力開始後しばらく音がまったく届かない：マイクを再起動して1度だけやり直す
  _noAudio(s) {
    if (s.ended || s.heard || s.recovered || this.session !== s) return;
    s.recovered = true;
    diag.push(`${this.noAudioMs}ms 音が届かないため、マイクを再起動`);
    s.restarting = true;
    if (this.running) this._halt();
    else this._restartFresh(s);
  }

  _restartFresh(s) {
    s.restarting = false;
    this._discard();
    Promise.resolve().then(() => this.onRecover?.()).catch(() => {}).then(() => this._begin(s, true));
  }

  _onResult(s, e) {
    if (!s || s.ended) return;
    this._spoke(s);
    const finals = [];
    let interim = '';
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finals.push(Array.from(r, (a) => a.transcript.trim()).filter(Boolean));
      else interim += ' ' + r[0].transcript;
    }
    s.finals = finals;
    s.lastText = [...finals.map((f) => f[0] || ''), interim].join(' ').replace(/\s+/g, ' ').trim();
    const shown = [s.accum, s.lastText].filter(Boolean).join(' ');
    diag.push(`result（${finals.length ? '確定' : '途中'}）"${shown.slice(-60)}"`);
    s.h.onInterim?.(shown);
    // 自動判定モード：一定時間新しい結果がなければ話し終えたとみなす
    clearTimeout(s.silenceTimer);
    if (!s.hold && s.lastText) s.silenceTimer = setTimeout(() => { if (this.session === s) { diag.push(`無音 ${s.silenceMs}ms で終了`); this.stop(); } }, s.silenceMs);
  }

  // 動作中のエンジンを止める（1回の動作につき1度だけ abort を送る）
  _halt() {
    if (!this.running || this.halting) return;
    this.halting = true;
    try { this.sr.abort(); } catch { /* noop */ }
  }

  _onEnd() {
    this.running = false;
    this.halting = false;
    const s = this.session;
    diag.push('end（認識終了）');
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      clearTimeout(p.pendingTimer);
      this._begin(p);
      return;
    }
    if (!s || s.ended) return;
    clearTimeout(s.silenceTimer);
    if (s.restarting) { this._restartFresh(s); return; }
    // 押したまま話している途中でエンジンが止まった場合は、続きを認識する
    if (s.hold && s.holding && !s.stopRequested && performance.now() - s.startedAt < this.maxMs) {
      const text = this._bestText(s);
      if (text) s.accum = [s.accum, text].filter(Boolean).join(' ');
      s.finals = [];
      s.lastText = '';
      setTimeout(() => this._begin(s, true), 150);
      return;
    }
    this._finish(s);
  }

  _bestText(s) {
    const segs = s.finals.filter((f) => f.length);
    return segs.length ? segs.map((f) => f[0]).join(' ') : s.lastText;
  }

  // 区間ごとの認識候補を組み合わせて回答候補リストを作る
  _candidates(s) {
    const segs = s.finals.filter((f) => f.length);
    const pre = s.accum ? s.accum + ' ' : '';
    let out;
    if (!segs.length) {
      out = s.lastText ? [s.lastText] : [];
    } else {
      const base = segs.map((f) => f[0]);
      out = [base.join(' ')];
      segs.forEach((f, i) => {
        for (const alt of f.slice(1)) {
          if (out.length >= 10) return;
          const v = [...base];
          v[i] = alt;
          out.push(v.join(' '));
        }
      });
      if (s.lastText && !out.includes(s.lastText)) out.push(s.lastText);
    }
    if (!out.length && s.accum) out = [''];
    return [...new Set(out.map((t) => (pre + t).replace(/\s+/g, ' ').trim()))].filter(Boolean);
  }

  _finish(s, errorCode = null) {
    if (s.ended) return;
    s.ended = true;
    for (const k of ['silenceTimer', 'maxTimer', 'readyTimer', 'readyFallback', 'stopTimer', 'pendingTimer', 'noAudioTimer']) clearTimeout(s[k]);
    s.h.onStateChange?.('idle');
    if (s.aborted) return;
    const candidates = errorCode ? [] : this._candidates(s);
    if (candidates.length) {
      diag.push(`判定へ（候補 ${candidates.length} 件）`);
      s.h.onResult?.(candidates);
    } else {
      diag.push(`結果なし: ${errorCode || s.error || 'no-speech'}`);
      s.h.onError?.(errorCode || s.error || 'no-speech');
    }
  }

  // 録音を終えて判定する。終了イベントが来ない場合に備えて保険をかける
  stop() {
    const s = this.session;
    if (!s || s.ended) return;
    s.stopRequested = true;
    s.holding = false;
    clearTimeout(s.silenceTimer);
    if (!this.running) { this._finish(s); return; }
    try { this.sr.stop(); } catch { /* noop */ }
    clearTimeout(s.stopTimer);
    s.stopTimer = setTimeout(() => {
      if (s.ended) return;
      diag.push(`停止後 ${this.stopTimeoutMs}ms 終了イベントなし → 強制停止`);
      try { this.sr?.abort(); } catch { /* noop */ }
      s.stopTimer = setTimeout(() => {
        if (s.ended) return;
        diag.push('強制停止にも応答なし → 認識オブジェクトを作り直し、途中結果で判定');
        this._discard();
        this.running = false;
        this.halting = false;
        this._finish(s);
      }, this.abortTimeoutMs);
    }, this.stopTimeoutMs);
  }

  // 結果を使わずに中止する（画面遷移・入力切替など）
  abort() {
    const s = this.session;
    if (s && !s.ended) {
      s.aborted = true;
      this._finish(s);
      diag.push('中止');
    }
    if (this.pending) { clearTimeout(this.pending.pendingTimer); this.pending = null; }
    this._halt();
  }
}

export const recognizer = new Recognizer();

// iOS Safari では読み上げ（speechSynthesis）のあとにマイク入力が止まったままになる既知の不具合がある
// （WebKit Bug 218815）。読み上げのあとは、録音の前にマイクを一度開いて閉じ、入力を復帰させる。
let spokeSinceRec = false;

export async function resetMicInput() {
  spokeSinceRec = false;
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : null;
  if (!md?.getUserMedia) return;
  const t0 = performance.now();
  const req = md.getUserMedia({ audio: true }).then((stream) => { stream.getTracks().forEach((t) => t.stop()); });
  try {
    await Promise.race([req, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500))]);
    diag.push(`マイク入力をリセット（${Math.round(performance.now() - t0)}ms）`);
  } catch (e) {
    diag.push(`マイク入力のリセットに失敗: ${e?.name || e?.message || e}`);
  }
}

if (isIOS) {
  recognizer.beforeStart = () => (spokeSinceRec ? resetMicInput() : null);
  recognizer.onRecover = resetMicInput;
}

// ---- 読み上げ ----
let voices = [];
const loadVoices = () => { voices = canSpeak ? speechSynthesis.getVoices() : []; };
if (canSpeak) {
  loadVoices();
  speechSynthesis.addEventListener?.('voiceschanged', loadVoices);
}

const PREFERRED_EN = ['Samantha', 'Google US English', 'Microsoft Aria', 'Microsoft Jenny', 'Ava', 'Allison', 'Alex', 'Microsoft Guy', 'Karen', 'Daniel'];
const PREFERRED_JA = ['Kyoko', 'O-ren', 'Google 日本語', 'Microsoft Nanami', 'Microsoft Ayumi', 'Otoya'];

export function englishVoices() {
  return voices.filter((v) => v.lang.replace('_', '-').toLowerCase().startsWith('en'));
}

function pickVoice(lang, uri) {
  if (uri) {
    const v = voices.find((x) => x.voiceURI === uri);
    if (v) return v;
  }
  const prefix = lang.slice(0, 2);
  const list = voices.filter((v) => v.lang.replace('_', '-').toLowerCase().startsWith(prefix));
  const prefs = prefix === 'ja' ? PREFERRED_JA : PREFERRED_EN;
  for (const name of prefs) {
    const v = list.find((x) => x.name.includes(name) && (prefix !== 'en' || /en[-_]US/i.test(x.lang)));
    if (v) return v;
  }
  return list.find((v) => v.lang.replace('_', '-') === lang) || list[0] || null;
}

let current = null; // GC で onend が発火しない Chrome の不具合対策として参照を保持
let speaking = false;
let lastSpeechEnd = 0;

export function speak(text, { lang = 'en-US', rate = 1, voiceURI = '' } = {}) {
  return new Promise((resolve) => {
    if (!canSpeak || !text) return resolve();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = rate;
    const v = pickVoice(lang, lang.startsWith('en') ? voiceURI : '');
    if (v) u.voice = v;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      if (current === u) { speaking = false; lastSpeechEnd = performance.now(); }
      resolve();
    };
    u.onend = finish;
    u.onerror = finish;
    const t = setTimeout(finish, 2500 + text.length * 140 / rate);
    current = u;
    speaking = true;
    spokeSinceRec = true;
    speechSynthesis.speak(u);
  });
}

export function stopSpeaking() {
  if (speaking) { speaking = false; lastSpeechEnd = performance.now(); }
  if (canSpeak) speechSynthesis.cancel();
  current = null;
}

// 読み上げの直後はマイクの切り替えが間に合わないことがあるため、録音開始を待つべき時間（ms）
export function speechCooldown(gapMs = 500) {
  if (speaking) return gapMs;
  const since = performance.now() - lastSpeechEnd;
  return since < gapMs ? Math.ceil(gapMs - since) : 0;
}
