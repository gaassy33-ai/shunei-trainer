// 音声認識（Web Speech API）と読み上げ（speechSynthesis）
const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
export const canRecognize = !!SR;
export const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window;
// Android Chrome は continuous モードで結果が重複する既知の不具合があるため単発認識にする
const isAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);

export const RECOGNITION_ERRORS = {
  'not-allowed': 'マイクの使用が許可されていません。ブラウザの設定でマイクを許可するか、キーボード入力に切り替えてください。',
  'service-not-allowed': 'このブラウザでは音声認識が使えません。キーボード入力に切り替えてください。',
  'audio-capture': 'マイクが見つかりません。接続を確認してください。',
  network: '音声認識サービスに接続できません。通信状況を確認してください。',
  'no-speech': '声が聞き取れませんでした。もう一度話してください。',
  'start-failed': '録音を開始できませんでした。マイクボタンをタップしてください。',
};

export class Listener {
  constructor(handlers = {}) {
    this.h = handlers; // { onSpeech, onInterim, onResult(candidates), onError(code), onStateChange(active) }
    this.rec = null;
    this.active = false;
    this.silenceMs = handlers.silenceMs || 1500;
  }

  start() {
    if (!SR || this.active) return false;
    const rec = new SR();
    rec.lang = 'en-US';
    rec.interimResults = true;
    rec.maxAlternatives = 5;
    rec.continuous = !isAndroid;
    this.rec = rec;
    this.finals = [];
    this.lastText = '';
    this.error = null;
    this.spoke = false;
    this.aborted = false;

    const markSpoke = () => {
      if (!this.spoke) { this.spoke = true; this.h.onSpeech?.(); }
    };
    rec.onspeechstart = markSpoke;
    rec.onresult = (e) => {
      markSpoke();
      const finals = [];
      let interim = '';
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finals.push(Array.from(r, (a) => a.transcript.trim()).filter(Boolean));
        else interim += ' ' + r[0].transcript;
      }
      this.finals = finals;
      this.lastText = [...finals.map((f) => f[0] || ''), interim].join(' ').replace(/\s+/g, ' ').trim();
      this.h.onInterim?.(this.lastText);
      // 一定時間新しい認識結果がなければ発話終了とみなす
      clearTimeout(this.silenceTimer);
      if (this.lastText) this.silenceTimer = setTimeout(() => this.stop(), this.silenceMs);
    };
    rec.onerror = (e) => { this.error = e.error; };
    rec.onend = () => {
      clearTimeout(this.silenceTimer);
      clearTimeout(this.maxTimer);
      this.active = false;
      this.h.onStateChange?.(false);
      if (this.aborted) return;
      const candidates = this.candidates();
      if (candidates.length) this.h.onResult?.(candidates);
      else this.h.onError?.(this.error || 'no-speech');
    };
    try {
      rec.start();
    } catch {
      this.h.onError?.('start-failed');
      return false;
    }
    this.active = true;
    this.h.onStateChange?.(true);
    this.maxTimer = setTimeout(() => this.stop(), 25000);
    return true;
  }

  // 区間ごとの認識候補を組み合わせて回答候補リストを作る
  candidates() {
    const segs = this.finals.filter((s) => s.length);
    if (!segs.length) return this.lastText ? [this.lastText] : [];
    const base = segs.map((s) => s[0]);
    const out = [base.join(' ')];
    segs.forEach((s, i) => {
      for (const alt of s.slice(1)) {
        if (out.length >= 10) return;
        const v = [...base];
        v[i] = alt;
        out.push(v.join(' '));
      }
    });
    if (this.lastText && !out.includes(this.lastText)) out.push(this.lastText);
    return [...new Set(out.map((t) => t.replace(/\s+/g, ' ').trim()))].filter(Boolean);
  }

  stop() {
    if (this.rec && this.active) {
      try { this.rec.stop(); } catch { /* already stopped */ }
    }
  }

  abort() {
    this.aborted = true;
    clearTimeout(this.silenceTimer);
    clearTimeout(this.maxTimer);
    if (this.rec) {
      try { this.rec.abort(); } catch { /* already stopped */ }
    }
    this.active = false;
  }
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
    const finish = () => { if (!done) { done = true; clearTimeout(t); resolve(); } };
    u.onend = finish;
    u.onerror = finish;
    const t = setTimeout(finish, 2500 + text.length * 140 / rate);
    current = u;
    speechSynthesis.speak(u);
  });
}

export function stopSpeaking() {
  if (canSpeak) speechSynthesis.cancel();
  current = null;
}
