// 設定・学習記録の永続化（localStorage）
const KEY = 'shunei-trainer.v1';

export const DEFAULT_SETTINGS = {
  inputMode: 'voice', // 'voice' | 'keyboard'
  autoMic: true, // 出題と同時に録音を開始
  timeLimit: 5, // 話し始めるまでの制限秒数（0=なし）
  readPrompt: false, // 日本語の問題文を読み上げる
  autoPlayAnswer: true, // 判定後に模範解答を再生
  muteInKeyboard: true, // キーボードモードでは音声を再生しない
  rate: 0.95,
  voiceURI: '',
  requeueMissed: true, // 間違えた問題をセッションの最後にもう一度
  autoNext: false, // 正解なら自動で次へ
  strictness: 'normal',
  sessionSize: 10,
  sessionMode: 'mix',
  lastLevel: {},
  ai: { enabled: false, apiKey: '', model: 'claude-opus-5-5', auto: true },
};

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    return {
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}), ai: { ...DEFAULT_SETTINGS.ai, ...(raw.settings?.ai || {}) } },
      progress: raw.progress || {},
      log: raw.log || {},
    };
  } catch {
    return { settings: structuredClone(DEFAULT_SETTINGS), progress: {}, log: {} };
  }
}

export const db = load();

export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(db));
  } catch (e) {
    console.warn('save failed', e);
  }
}

export function exportData() {
  return JSON.stringify({ app: 'shunei-trainer', version: 1, exportedAt: new Date().toISOString(), progress: db.progress, log: db.log, settings: { ...db.settings, ai: { ...db.settings.ai, apiKey: '' } } }, null, 2);
}

export function importData(json) {
  const data = JSON.parse(json);
  if (!data || typeof data.progress !== 'object') throw new Error('形式が正しくありません');
  db.progress = data.progress;
  db.log = data.log || {};
  if (data.settings) {
    const apiKey = db.settings.ai.apiKey;
    db.settings = { ...DEFAULT_SETTINGS, ...data.settings, ai: { ...DEFAULT_SETTINGS.ai, ...(data.settings.ai || {}), apiKey } };
  }
  save();
}

export function resetProgress() {
  db.progress = {};
  db.log = {};
  save();
}

export const todayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
