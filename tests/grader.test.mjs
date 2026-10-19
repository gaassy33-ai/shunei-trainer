import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeToken, tokenize, grade, hintText } from '../js/grader.js';
import { ITEMS } from '../js/data/index.js';

const norm = (s) => tokenize(s).norm.join(' ');
const item = (en, alt = []) => ({ en, alt });

test('短縮形・数字・記号を正規化する', () => {
  assert.equal(norm("Let's get started."), 'let us get started');
  assert.equal(norm("I'm afraid I can't agree."), 'i am afraid i can not agree');
  assert.equal(norm('Sales increased by 10%.'), 'sales increased by ten percent');
  assert.equal(norm('How about 9 a.m. Japan time?'), 'how about nine am japan time');
  assert.equal(norm('9AM'), 'nine am');
  assert.equal(norm('about 5,000,000 yen'), 'about five million yen');
  assert.equal(norm('our 1-on-1'), 'our one on one');
  assert.equal(norm("I should've gone"), 'i should have gone');
  assert.equal(norm('Mr. Smith'), 'mr smith');
  assert.equal(norm("today's agenda"), "today's agenda");
  assert.equal(norm('dont lets'), 'do not let us');
  assert.deepEqual(normalizeToken('e-mail'), ['email']);
});

test('完全一致と表記ゆれは正解', () => {
  const it = item("Let's get started.", ["Let's begin."]);
  assert.equal(grade(['lets get started'], it).verdict, 'correct');
  assert.equal(grade(['Let us get started'], it).verdict, 'correct');
  assert.equal(grade(['let us begin'], it).verdict, 'correct');
});

test("'s / 'd は is/has, would/had の両方に一致", () => {
  assert.equal(grade(['He has been here'], item("He's been here.")).score, 1);
  assert.equal(grade(['If I had known'], item("If I'd known")).score, 1);
});

test('冠詞やつなぎ言葉の有無は軽い減点', () => {
  const r = grade(['Just a moment'], item('Just a moment, please.'));
  assert.equal(r.verdict, 'correct');
  assert.ok(r.score < 1);
});

test('文法ミスは惜しい／不正解になる', () => {
  const it = item('I look forward to hearing from you.');
  const r1 = grade(['I look forward to hear from you'], it);
  assert.equal(r1.verdict, 'close');
  assert.equal(r1.userMarks[4], 'wrong');
  assert.equal(r1.refMarks[4], 'miss');
  assert.equal(grade(['I want to see you'], it).verdict, 'wrong');
  assert.equal(grade([''], it).verdict, 'wrong');
});

test('軽いタイプミスは許容', () => {
  assert.equal(grade(['Could you summarise the main points briefly'], item('Could you summarize the main points briefly?')).verdict, 'correct');
});

test('音声認識の候補から最良のものを選ぶ', () => {
  const r = grade(['you are on mute', 'your on mute'], item("You're on mute."));
  assert.equal(r.score, 1);
  assert.equal(r.userText, 'you are on mute');
});

test('別解に近い場合はその別解を基準に表示', () => {
  const r = grade(['Thanks for reaching out'], item('Thank you for reaching out.', ['Thanks for reaching out.']));
  assert.equal(r.isMain, false);
  assert.equal(r.score, 1);
});

test('ヒントの生成', () => {
  assert.equal(hintText("Let's get started.", 1), "Let's ___ _______.");
  assert.equal(hintText("Let's get started.", 2), "Let's g__ s______.");
});

test('教材データ：模範解答・別解はすべて自分自身に満点で一致し、key は本文に含まれる', () => {
  assert.ok(ITEMS.length >= 300, `items: ${ITEMS.length}`);
  for (const it of ITEMS) {
    assert.ok(it.ja && it.en, it.id);
    for (const a of [it.en, ...it.alt]) assert.equal(grade([a], it).score, 1, a);
    if (it.key) {
      const parts = it.key.split('...').map((s) => s.trim().toLowerCase()).filter(Boolean);
      for (const p of parts) assert.ok(it.en.toLowerCase().includes(p), `key "${it.key}" not in "${it.en}"`);
    }
  }
});
