// 回答判定エンジン
// 音声認識・キーボード入力のゆれ（短縮形、数字表記、記号、軽い綴りミス）を吸収したうえで
// 単語単位の重み付き編集距離で模範解答（＋別解）と照合する。

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES = [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']];

function intWords(n) {
  if (!Number.isFinite(n) || n >= 1e12) return [String(n)];
  if (n < 20) return [ONES[n]];
  if (n < 100) return n % 10 ? [TENS[Math.floor(n / 10)], ONES[n % 10]] : [TENS[n / 10]];
  if (n < 1000) return [ONES[Math.floor(n / 100)], 'hundred', ...(n % 100 ? intWords(n % 100) : [])];
  for (const [v, w] of SCALES) {
    if (n >= v) return [...intWords(Math.floor(n / v)), w, ...(n % v ? intWords(n % v) : [])];
  }
  return [String(n)];
}

const ORD_IRREG = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };
function ordinalWords(n) {
  const w = intWords(n);
  const last = w.pop();
  const ord = ORD_IRREG[last] || (last.endsWith('y') ? last.slice(0, -1) + 'ieth' : last + 'th');
  return [...w, ord];
}

// 短縮形は展開して比較する。'_s'(is/has) と '_d'(would/had) は文脈で決まるので両方に一致させる
const CONTRACTIONS = {
  "i'm": ['i', 'am'], "let's": ['let', 'us'], "can't": ['can', 'not'], cannot: ['can', 'not'],
  "won't": ['will', 'not'], "shan't": ['shall', 'not'], "ain't": ['am', 'not'],
  gonna: ['going', 'to'], wanna: ['want', 'to'], gotta: ['got', 'to'], "o'clock": ['oclock'],
};
const SUFFIX = { ll: 'will', ve: 'have', re: 'are', d: '_d', s: '_s', m: 'am' };
// 's を is/has として展開する語（名詞の所有格 today's などは展開しない）
const S_HOSTS = new Set(['he', 'she', 'it', 'that', 'there', 'here', 'what', 'who', 'where', 'how', 'when', 'why', 'this', 'everyone', 'everything', 'nothing', 'something', 'someone', 'everybody', 'nobody']);

const VARIANTS = {
  okay: 'ok', alright: 'all right', mister: 'mr', cancelled: 'canceled', cancelling: 'canceling',
  travelled: 'traveled', travelling: 'traveling', colour: 'color', favour: 'favor', favourite: 'favorite',
  centre: 'center', organise: 'organize', organisation: 'organization', realise: 'realize',
  recognise: 'recognize', apologise: 'apologize', prioritise: 'prioritize', analyse: 'analyze',
  programme: 'program', behaviour: 'behavior', labour: 'labor', till: 'until',
  // アポストロフィを省いたキーボード入力
  im: 'i am', ive: 'i have', youre: 'you are', theyre: 'they are', lets: 'let us', thats: 'that _s',
  whats: 'what _s', theres: 'there _s', dont: 'do not', doesnt: 'does not', didnt: 'did not',
  cant: 'can not', isnt: 'is not', arent: 'are not', wasnt: 'was not', werent: 'were not',
  havent: 'have not', hasnt: 'has not', hadnt: 'had not', couldnt: 'could not', wouldnt: 'would not',
  shouldnt: 'should not', youve: 'you have', weve: 'we have', theyve: 'they have', youll: 'you will',
};

// 足し引きしても意味がほぼ変わらない語は低コストにする
const SOFT = new Set(['a', 'an', 'the', 'please', 'just', 'so', 'really', 'actually', 'well', 'um', 'uh', 'er', 'oh', 'ok', 'oclock', 'very', 'also']);
const EQUIV = { _s: new Set(['is', 'has']), _d: new Set(['would', 'had']) };
const HOMOPHONES = [['to', 'too', 'two'], ['for', 'four'], ['there', 'their'], ['here', 'hear'], ['right', 'write'],
  ['know', 'no'], ['by', 'buy', 'bye'], ['week', 'weak'], ['see', 'sea'], ['won', 'one'], ['ate', 'eight'], ['meet', 'meat']];
const HOMO = new Map();
for (const group of HOMOPHONES) for (const w of group) HOMO.set(w, new Set(group));

function numberToWords(p) {
  const out = [];
  let dollar = false;
  let percent = false;
  if (p.startsWith('$')) { dollar = true; p = p.slice(1); }
  if (p.endsWith('%')) { percent = true; p = p.slice(0, -1); }
  let m;
  if ((m = p.match(/^(\d+)(st|nd|rd|th)$/))) {
    out.push(...ordinalWords(+m[1]));
  } else if ((m = p.match(/^(\d{1,2}):(\d{2})$/))) {
    out.push(...intWords(+m[1]));
    const mm = +m[2];
    if (mm) out.push(...(mm < 10 ? ['oh', ONES[mm]] : intWords(mm)));
  } else if ((m = p.match(/^(\d+)\.(\d+)$/))) {
    out.push(...intWords(+m[1]), 'point', ...m[2].split('').map((d) => ONES[+d]));
  } else {
    for (const seg of p.match(/\d+|[^\d]+/g) || []) {
      if (/^\d+$/.test(seg)) out.push(...intWords(+seg));
      else out.push(...normalizeWord(seg.replace(/[^a-z']/g, '')));
    }
  }
  if (dollar) out.push('dollars');
  if (percent) out.push('percent');
  return out;
}

function normalizeWord(p) {
  p = p.replace(/^[.':]+|[.':]+$/g, '');
  if (!p) return [];
  if (/^[a-z](\.[a-z])+$/.test(p)) p = p.replace(/\./g, '');
  if (CONTRACTIONS[p]) return [...CONTRACTIONS[p]];
  let m;
  if ((m = p.match(/^([a-z]+)n't$/))) return [m[1], 'not'];
  if (/\d/.test(p)) return numberToWords(p);
  if ((m = p.match(/^([a-z]+)'(ll|ve|re|d|m)$/))) return [m[1], SUFFIX[m[2]]];
  if ((m = p.match(/^([a-z]+)'s$/)) && S_HOSTS.has(m[1])) return [m[1], '_s'];
  p = p.replace(/\.+/g, '');
  const v = VARIANTS[p];
  return v ? v.split(' ') : [p];
}

// 表示用トークン1つを、比較用の単語列に変換する
export function normalizeToken(tok) {
  let t = tok.toLowerCase().replace(/[’‘`´ʼ]/g, "'");
  t = t.replace(/(\d),(?=\d{3}(\D|$))/g, '$1');
  t = t.replace(/(^|[^a-z])([ap])\.m\.?/g, '$1$2m');
  t = t.replace(/^e-mail/, 'email');
  t = t.replace(/[^\p{L}\p{N}'$%:.\-–—/]/gu, ' ');
  const out = [];
  for (const part of t.split(/[\s\-–—/]+/)) {
    if (part) out.push(...normalizeWord(part));
  }
  return out;
}

const tokenCache = new Map();
export function tokenize(text) {
  const hit = tokenCache.get(text);
  if (hit) return hit;
  const display = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text))) display.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  const norm = [];
  const owner = [];
  display.forEach((d, i) => {
    for (const w of normalizeToken(d.text)) { norm.push(w); owner.push(i); }
  });
  const res = { text, display, norm, owner };
  if (tokenCache.size > 2000) tokenCache.clear();
  tokenCache.set(text, res);
  return res;
}

function lev(a, b) {
  if (a === b) return 0;
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

function isNear(a, b) {
  const len = Math.min(a.length, b.length);
  if (len < 4) return false;
  const d = lev(a, b);
  return d <= 1 || (len >= 8 && d <= 2);
}

// 置換コストと、その一致の種類
function subCost(r, h) {
  if (r === h) return [0, 'ok'];
  if (EQUIV[r]?.has(h) || EQUIV[h]?.has(r)) return [0, 'ok'];
  if (HOMO.get(r)?.has(h)) return [0.25, 'near'];
  if (isNear(r, h)) return [0.35, 'near'];
  return [1, 'wrong'];
}
const gapCost = (w) => (SOFT.has(w) ? 0.4 : 1);

// 重み付き編集距離で整列し、各単語の一致状態を返す
export function align(ref, hyp) {
  const n = ref.length;
  const m = hyp.length;
  const D = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const B = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1)); // 1=diag 2=up(del) 3=left(ins)
  for (let i = 1; i <= n; i++) { D[i][0] = D[i - 1][0] + gapCost(ref[i - 1]); B[i][0] = 2; }
  for (let j = 1; j <= m; j++) { D[0][j] = D[0][j - 1] + gapCost(hyp[j - 1]); B[0][j] = 3; }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const diag = D[i - 1][j - 1] + subCost(ref[i - 1], hyp[j - 1])[0];
      const up = D[i - 1][j] + gapCost(ref[i - 1]);
      const left = D[i][j - 1] + gapCost(hyp[j - 1]);
      if (diag <= up && diag <= left) { D[i][j] = diag; B[i][j] = 1; } else if (up <= left) { D[i][j] = up; B[i][j] = 2; } else { D[i][j] = left; B[i][j] = 3; }
    }
  }
  const refMarks = new Array(n).fill('ok');
  const hypMarks = new Array(m).fill('ok');
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const b = B[i][j];
    if (b === 1) {
      const kind = subCost(ref[i - 1], hyp[j - 1])[1];
      refMarks[i - 1] = kind === 'wrong' ? 'miss' : kind;
      hypMarks[j - 1] = kind;
      i--; j--;
    } else if (b === 2) {
      refMarks[i - 1] = SOFT.has(ref[i - 1]) ? 'soft' : 'miss';
      i--;
    } else {
      hypMarks[j - 1] = SOFT.has(hyp[j - 1]) ? 'soft' : 'extra';
      j--;
    }
  }
  return { cost: D[n][m], refMarks, hypMarks };
}

const RANK = { ok: 0, soft: 1, near: 2, extra: 3, wrong: 3, miss: 3 };
function displayMarks(tok, marks) {
  const out = tok.display.map(() => 'ok');
  tok.owner.forEach((di, k) => {
    if (RANK[marks[k]] > RANK[out[di]]) out[di] = marks[k];
  });
  return out;
}

export const STRICTNESS = {
  easy: { label: 'やさしい', correct: 0.85, close: 0.6 },
  normal: { label: '標準', correct: 0.9, close: 0.7 },
  strict: { label: 'きびしい', correct: 0.97, close: 0.8 },
};

// candidates: ユーザー回答の候補（音声認識の別候補を含む）
// 戻り値: { score, verdict: 'correct'|'close'|'wrong', userText, refText, isMain, userMarks, refMarks }
export function grade(candidates, item, strictness = 'normal') {
  const refs = [item.en, ...(item.alt || [])];
  const th = STRICTNESS[strictness] || STRICTNESS.normal;
  let best = null;
  for (const raw of candidates) {
    const userText = (raw || '').trim();
    if (!userText) continue;
    const u = tokenize(userText);
    for (let r = 0; r < refs.length; r++) {
      const ref = tokenize(refs[r]);
      const { cost, refMarks, hypMarks } = align(ref.norm, u.norm);
      const score = Math.max(0, 1 - cost / Math.max(ref.norm.length, 1));
      if (!best || score > best.score + 1e-9) {
        best = { score, userText, refText: refs[r], isMain: r === 0, userMarks: displayMarks(u, hypMarks), refMarks: displayMarks(ref, refMarks) };
      }
    }
  }
  if (!best) {
    return { score: 0, verdict: 'wrong', userText: '', refText: item.en, isMain: true, userMarks: [], refMarks: tokenize(item.en).display.map(() => 'miss') };
  }
  best.verdict = best.score >= th.correct ? 'correct' : best.score >= th.close ? 'close' : 'wrong';
  return best;
}

// ヒント：段階1=先頭の単語のみ、段階2=各単語の頭文字
export function hintText(en, step) {
  let wordIndex = 0;
  return en.replace(/[A-Za-z0-9][A-Za-z0-9'’]*/g, (w) => {
    const idx = wordIndex++;
    if (step >= 1 && idx === 0) return w;
    const keep = step >= 2 ? 1 : 0;
    return w.slice(0, keep) + w.slice(keep).replace(/[A-Za-z0-9]/g, '_');
  });
}
