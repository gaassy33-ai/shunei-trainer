import { test } from 'node:test';
import assert from 'node:assert/strict';

// Web Speech API のモック
class MockSR {
  static count = 0;
  static last = null;
  constructor() { MockSR.count++; MockSR.last = this; this.started = false; this.hang = false; }
  start() {
    if (this.started) throw Object.assign(new Error('already started'), { name: 'InvalidStateError' });
    this.started = true;
    this.starts = (this.starts || 0) + 1;
    setTimeout(() => { this.onstart?.(); this.onaudiostart?.(); }, 2);
  }
  // 実際のブラウザと同じく、1回の動作につき終了イベントは1度だけ
  stop() { const run = this.starts; if (!this.hang) setTimeout(() => this.end(run), 5); }
  abort() { const run = this.starts; if (!this.hang) setTimeout(() => this.end(run), 5); }
  end(run = this.starts) { if (!this.started || run !== this.starts) return; this.started = false; this.onend?.(); }
  emit(results) {
    const list = results.map((r) => Object.assign(r.alts.map((t) => ({ transcript: t })), { isFinal: r.final }));
    this.onresult?.({ results: list });
  }
}
globalThis.window = { SpeechRecognition: MockSR };
const { Recognizer, canRecognize } = await import('../js/speech.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fast = { stopTimeoutMs: 30, abortTimeoutMs: 20, readyFallbackMs: 100 };

// 1回分の認識を開始し、結果かエラーで解決する
function session(rec, opts = {}, drive) {
  return new Promise((resolve) => {
    const events = [];
    rec.start({
      onStateChange: (s) => events.push(`state:${s}`),
      onReady: () => events.push('ready'),
      onSpeech: () => events.push('speech'),
      onInterim: (t) => events.push(`interim:${t}`),
      onResult: (c) => resolve({ type: 'result', candidates: c, events }),
      onError: (code) => resolve({ type: 'error', code, events }),
    }, opts);
    if (drive) setTimeout(() => drive(rec.sr), 10);
  });
}

test('音声認識APIを検出する', () => assert.equal(canRecognize, true));

test('マイクの準備完了を通知し、無音になったら別候補つきで結果を返す', async () => {
  const rec = new Recognizer(fast);
  const r = await session(rec, { silenceMs: 30 }, (sr) => {
    sr.emit([{ final: false, alts: ["let's get"] }]);
    sr.emit([{ final: true, alts: ["let's get started", 'lets get started'] }]);
  });
  assert.equal(r.type, 'result');
  assert.deepEqual(r.candidates, ["let's get started", 'lets get started']);
  assert.deepEqual(r.events.slice(0, 2), ['state:starting', 'ready']);
  assert.ok(r.events.includes('speech'));
  assert.ok(r.events.includes("interim:let's get"));
  assert.equal(r.events.at(-1), 'state:idle');
});

test('認識オブジェクトを使い回す', async () => {
  const before = MockSR.count;
  const rec = new Recognizer(fast);
  await session(rec, { silenceMs: 20 }, (sr) => sr.emit([{ final: true, alts: ['one'] }]));
  await session(rec, { silenceMs: 20 }, (sr) => sr.emit([{ final: true, alts: ['two'] }]));
  assert.equal(MockSR.count - before, 1);
  assert.equal(rec.sr.starts, 2);
});

test('前の認識が終わる前に開始しても、終了を待ってから始める', async () => {
  const rec = new Recognizer(fast);
  let firstCalled = false;
  rec.start({ onResult: () => { firstCalled = true; }, onError: () => { firstCalled = true; } }, { silenceMs: 20 });
  const r = await session(rec, { silenceMs: 20 }, (sr) => sr.emit([{ final: true, alts: ['second'] }]));
  assert.deepEqual(r.candidates, ['second']);
  assert.equal(firstCalled, false);
});

test('複数区間の認識結果を連結する', async () => {
  const rec = new Recognizer(fast);
  const r = await session(rec, { silenceMs: 20 }, (sr) => sr.emit([
    { final: true, alts: ['I see your point', 'I see you point'] },
    { final: true, alts: ["but I'm concerned about the cost"] },
  ]));
  assert.equal(r.candidates[0], "I see your point but I'm concerned about the cost");
  assert.ok(r.candidates.includes("I see you point but I'm concerned about the cost"));
});

test('何も話さずに終わったら no-speech', async () => {
  const rec = new Recognizer(fast);
  const r = await session(rec, {}, (sr) => sr.end());
  assert.deepEqual([r.type, r.code], ['error', 'no-speech']);
});

test('マイク拒否などのエラーコードを伝える', async () => {
  const rec = new Recognizer(fast);
  const r = await session(rec, {}, (sr) => { sr.onerror({ error: 'not-allowed' }); sr.end(); });
  assert.deepEqual([r.type, r.code], ['error', 'not-allowed']);
});

test('停止しても終了イベントが来ないときは、途中結果で判定する', async () => {
  const rec = new Recognizer(fast);
  const r = await session(rec, { silenceMs: 1000 }, (sr) => {
    sr.hang = true;
    sr.emit([{ final: false, alts: ['could you say that'] }]);
    rec.stop();
  });
  assert.deepEqual(r.candidates, ['could you say that']);
  assert.equal(rec.sr, null); // 固まった認識オブジェクトは作り直す
});

test('押して録音：無音でも止めず、途中で止まったら続きを認識して連結する', async () => {
  const rec = new Recognizer(fast);
  const done = session(rec, { hold: true, silenceMs: 20 });
  await sleep(10);
  const sr = rec.sr;
  sr.emit([{ final: true, alts: ['I think we need'] }]);
  await sleep(60); // 自動判定なら止まっている時間
  assert.equal(rec.busy, true);
  sr.end(); // iOS の単発認識が途中で止まった
  await sleep(200); // 再開を待つ
  assert.equal(sr.starts, 2);
  sr.emit([{ final: true, alts: ['more data'] }]);
  rec.stop(); // ボタンを離した
  const r = await done;
  assert.deepEqual(r.candidates, ['I think we need more data']);
});

test('abort 後は結果を通知しない', async () => {
  const rec = new Recognizer(fast);
  let called = false;
  rec.start({ onResult: () => { called = true; }, onError: () => { called = true; } }, { silenceMs: 20 });
  await sleep(5);
  rec.sr.emit([{ final: true, alts: ['hello'] }]);
  rec.abort();
  await sleep(60);
  assert.equal(called, false);
});

test('iOS 向け設定：録音のたびに新しい認識オブジェクトを使い、古いオブジェクトのイベントは無視する', async () => {
  const rec = new Recognizer({ ...fast, reuse: false });
  const before = MockSR.count;
  await session(rec, { silenceMs: 20 }, (sr) => sr.emit([{ final: true, alts: ['one'] }]));
  const first = MockSR.last;
  const r = await session(rec, { silenceMs: 20 }, (sr) => sr.emit([{ final: true, alts: ['two'] }]));
  assert.equal(MockSR.count - before, 2);
  assert.deepEqual(r.candidates, ['two']);
  assert.equal(first.onresult, null);
});

test('マイク入力が始まっても音が届かないときは、マイクを再起動してやり直す', async () => {
  const rec = new Recognizer({ ...fast, noAudioMs: 40 });
  let recovered = 0;
  rec.onRecover = () => { recovered++; return sleep(5); };
  const before = MockSR.count;
  const done = session(rec, { silenceMs: 20 });
  await sleep(120); // 準備完了から noAudioMs 経過 → 中止 → 復旧 → 新しいオブジェクトで再開
  assert.equal(recovered, 1);
  assert.equal(MockSR.count - before, 2);
  MockSR.last.emit([{ final: true, alts: ['it works now'] }]);
  const r = await done;
  assert.deepEqual(r.candidates, ['it works now']);
});

test('音が届いていればマイクを再起動しない', async () => {
  const rec = new Recognizer({ ...fast, noAudioMs: 40 });
  let recovered = 0;
  rec.onRecover = () => { recovered++; };
  const r = await session(rec, { silenceMs: 80 }, (sr) => sr.emit([{ final: true, alts: ['hello there'] }]));
  assert.equal(recovered, 0);
  assert.deepEqual(r.candidates, ['hello there']);
});

test('録音前の準備処理（Promise）は完了を待ち、不要なときはその場で開始する', async () => {
  const rec = new Recognizer(fast);
  let release;
  rec.beforeStart = () => new Promise((r) => { release = r; });
  rec.start({}, {});
  await sleep(10);
  assert.equal(rec.running, false);
  release();
  await sleep(5);
  assert.equal(rec.running, true);
  rec.abort();
  await sleep(20);
  rec.beforeStart = () => null;
  rec.start({}, {});
  assert.equal(rec.running, true); // 同期的に開始（タップ操作の中で start() できる）
  rec.abort();
  await sleep(20);
});
