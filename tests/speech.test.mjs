import { test } from 'node:test';
import assert from 'node:assert/strict';

// Web Speech API のモック
class MockSR {
  static last = null;
  constructor() { MockSR.last = this; }
  start() { this.started = true; }
  stop() { setTimeout(() => this.onend?.(), 5); }
  abort() { setTimeout(() => this.onend?.(), 5); }
  emit(results) {
    const list = results.map((r) => Object.assign(r.alts.map((t) => ({ transcript: t })), { isFinal: r.final }));
    this.onresult?.({ results: list });
  }
}
globalThis.window = { SpeechRecognition: MockSR };
const { Listener, canRecognize } = await import('../js/speech.js');

const listen = (extra = {}) => new Promise((resolve) => {
  const events = [];
  const l = new Listener({
    silenceMs: 30,
    onSpeech: () => events.push('speech'),
    onInterim: (t) => events.push(`interim:${t}`),
    onResult: (c) => resolve({ type: 'result', candidates: c, events }),
    onError: (code) => resolve({ type: 'error', code, events }),
    ...extra,
  });
  l.start();
  resolve.l = l;
  setTimeout(() => extra.drive?.(MockSR.last, l), 0);
});

test('音声認識APIを検出する', () => assert.equal(canRecognize, true));

test('途中経過を表示し、無音になったら別候補つきで結果を返す', async () => {
  const r = await listen({
    drive: (sr) => {
      sr.emit([{ final: false, alts: ["let's get"] }]);
      sr.emit([{ final: true, alts: ["let's get started", 'lets get started'] }]);
    },
  });
  assert.equal(r.type, 'result');
  assert.deepEqual(r.candidates, ["let's get started", 'lets get started']);
  assert.ok(r.events.includes('speech'));
  assert.ok(r.events.includes("interim:let's get"));
});

test('複数区間の認識結果を連結する', async () => {
  const r = await listen({
    drive: (sr) => sr.emit([{ final: true, alts: ['I see your point', 'I see you point'] }, { final: true, alts: ["but I'm concerned about the cost"] }]),
  });
  assert.equal(r.candidates[0], "I see your point but I'm concerned about the cost");
  assert.ok(r.candidates.includes("I see you point but I'm concerned about the cost"));
});

test('何も話さずに終わったら no-speech', async () => {
  const r = await listen({ drive: (sr) => sr.onend() });
  assert.deepEqual([r.type, r.code], ['error', 'no-speech']);
});

test('マイク拒否などのエラーコードを伝える', async () => {
  const r = await listen({ drive: (sr) => { sr.onerror({ error: 'not-allowed' }); sr.onend(); } });
  assert.deepEqual([r.type, r.code], ['error', 'not-allowed']);
});

test('abort 後はコールバックしない', async () => {
  let called = false;
  const l = new Listener({ onResult: () => { called = true; }, onError: () => { called = true; } });
  l.start();
  MockSR.last.emit([{ final: true, alts: ['hello'] }]);
  l.abort();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(called, false);
});
