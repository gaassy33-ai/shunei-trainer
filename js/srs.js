// 間隔反復（SRS）と出題キューの組み立て
import { ITEMS } from './data/index.js';
import { db, save, todayKey } from './store.js';

const DAY = 24 * 60 * 60 * 1000;
// box ごとの次回出題までの日数
export const INTERVAL_DAYS = [0, 1, 3, 7, 14, 30, 60];
export const MASTERED_BOX = 4;

// outcome: 'perfect'（時間内に正解）| 'good'（正解だが時間超過・ヒント使用）| 'close'（惜しい）| 'miss'
export const OUTCOMES = {
  perfect: { mark: '◎', label: 'Perfect', cls: 'perfect' },
  good: { mark: '○', label: '正解', cls: 'good' },
  close: { mark: '△', label: '惜しい', cls: 'close' },
  miss: { mark: '×', label: '不正解', cls: 'miss' },
};
export const isCorrect = (o) => o === 'perfect' || o === 'good';

export function recordResult(id, outcome, reactMs, { isRetry = false } = {}) {
  const now = Date.now();
  const rec = db.progress[id] || { box: 0, due: 0, seen: 0, correct: 0, lapses: 0 };
  let box = rec.box || 0;
  if (outcome === 'perfect') box = Math.min(box + 1, INTERVAL_DAYS.length - 1);
  else if (outcome === 'good') box = Math.max(box, 1);
  else if (outcome === 'close') box = 1;
  else box = 0;
  // セッション内の再出題では昇格を控えめにする
  if (isRetry) box = Math.min(box, 1);
  rec.box = box;
  rec.due = now + INTERVAL_DAYS[box] * DAY;
  if (!isRetry) {
    rec.seen = (rec.seen || 0) + 1;
    if (isCorrect(outcome)) rec.correct = (rec.correct || 0) + 1;
    if (outcome === 'miss') rec.lapses = (rec.lapses || 0) + 1;
  }
  rec.last = outcome;
  rec.lastAt = now;
  if (reactMs != null) {
    rec.lastMs = reactMs;
    if (isCorrect(outcome)) rec.bestMs = Math.min(rec.bestMs ?? Infinity, reactMs);
  }
  db.progress[id] = rec;

  if (!isRetry) {
    const key = todayKey();
    const day = db.log[key] || { n: 0, ok: 0, ms: 0, msN: 0 };
    day.n++;
    if (isCorrect(outcome)) day.ok++;
    if (reactMs != null) { day.ms += reactMs; day.msN++; }
    db.log[key] = day;
  }
  save();
}

export const recordOf = (id) => db.progress[id];
export const isDue = (rec, now = Date.now()) => !!rec && rec.due <= now;

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function poolOf(sceneIds, level) {
  return ITEMS.filter((i) => sceneIds.includes(i.scene) && (level === 'all' || i.level === level));
}

export function poolCounts(sceneIds, level) {
  const now = Date.now();
  const pool = poolOf(sceneIds, level);
  let fresh = 0, due = 0, weak = 0, mastered = 0, seen = 0;
  for (const it of pool) {
    const r = db.progress[it.id];
    if (!r) { fresh++; continue; }
    seen++;
    if (isDue(r, now)) due++;
    if (r.lapses > 0 || r.last === 'miss' || r.last === 'close') weak++;
    if (r.box >= MASTERED_BOX) mastered++;
  }
  return { total: pool.length, fresh, due, weak, mastered, seen };
}

// mode: 'mix'（復習＋新規）| 'new' | 'review' | 'weak'
export function buildQueue(sceneIds, level, size, mode) {
  const now = Date.now();
  const pool = poolOf(sceneIds, level);
  const rec = (i) => db.progress[i.id];
  const fresh = shuffle(pool.filter((i) => !rec(i))).sort((a, b) => a.level - b.level);
  const due = pool.filter((i) => isDue(rec(i), now)).sort((a, b) => rec(a).box - rec(b).box || rec(a).due - rec(b).due);
  const weak = shuffle(pool.filter((i) => { const r = rec(i); return r && (r.lapses > 0 || r.last === 'miss' || r.last === 'close'); }))
    .sort((a, b) => rec(a).box - rec(b).box);
  const learned = pool.filter((i) => rec(i) && !isDue(rec(i), now)).sort((a, b) => rec(a).box - rec(b).box || (rec(a).lastAt || 0) - (rec(b).lastAt || 0));

  let picked = [];
  const add = (list) => { for (const i of list) { if (picked.length >= size) break; if (!picked.includes(i)) picked.push(i); } };
  if (mode === 'new') add(fresh);
  else if (mode === 'review') { add(due); add(learned); }
  else if (mode === 'weak') add(weak);
  else if (mode === 'due') add(due);
  else {
    // 復習は最大で7割まで。残りを新規で埋め、足りなければ定着度の低い順に補う
    add(due.slice(0, Math.ceil(size * 0.7)));
    add(fresh);
    add(due);
    add(learned);
  }
  return shuffle(picked).map((i) => i.id);
}

export function overallStats() {
  const days = Object.keys(db.log).sort();
  const today = db.log[todayKey()] || { n: 0, ok: 0 };
  // 連続学習日数（今日まだ学習していなくても昨日まで続いていれば継続扱い）
  let streak = 0;
  const d = new Date();
  if (!db.log[todayKey(d)]) d.setDate(d.getDate() - 1);
  while (db.log[todayKey(d)]?.n > 0) { streak++; d.setDate(d.getDate() - 1); }
  const now = Date.now();
  const recs = Object.values(db.progress);
  const due = Object.keys(db.progress).filter((id) => isDue(db.progress[id], now) && ITEMS.some((i) => i.id === id)).length;
  return {
    today,
    streak,
    days: days.length,
    due,
    seen: recs.length,
    mastered: recs.filter((r) => r.box >= MASTERED_BOX).length,
    total: ITEMS.length,
  };
}
