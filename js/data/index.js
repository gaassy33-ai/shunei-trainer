// 教材データの定義と集約
// 新しいシーンを追加するには scenes/ にファイルを作り、SCENES に1行追加するだけでよい。
import meeting from './scenes/meeting.js';
import phone from './scenes/phone.js';
import email from './scenes/email.js';
import presentation from './scenes/presentation.js';
import negotiation from './scenes/negotiation.js';
import office from './scenes/office.js';
import management from './scenes/management.js';
import customer from './scenes/customer.js';
import trip from './scenes/trip.js';
import daily from './scenes/daily.js';
import travel from './scenes/travel.js';

// ビジネスでの到達目標を軸にしたレベル設計
export const LEVELS = [
  { id: 1, name: 'Basic', ja: 'ベーシック', goal: '定型表現で挨拶・依頼・確認ができる', grammar: '基本文型・命令文・Can/Could', target: 'TOEIC ~550 / CEFR A2' },
  { id: 2, name: 'Standard', ja: 'スタンダード', goal: '状況や自分の意見を簡潔に説明できる', grammar: '助動詞・不定詞・動名詞・現在完了', target: 'TOEIC 550-750 / CEFR B1' },
  { id: 3, name: 'Advanced', ja: 'アドバンス', goal: '根拠を示しながら提案・調整ができる', grammar: '仮定法・関係詞・間接疑問・クッション言葉', target: 'TOEIC 750-900 / CEFR B2' },
  { id: 4, name: 'Expert', ja: 'エキスパート', goal: '交渉や進行でニュアンスを使い分けられる', grammar: '婉曲表現・イディオム・複文の組み立て', target: 'TOEIC 900+ / CEFR C1' },
];

export const CATEGORIES = [
  { id: 'business', name: 'ビジネス' },
  { id: 'daily', name: '日常' },
];

export const SCENES = [
  { id: 'meeting', cat: 'business', name: '会議・ディスカッション', short: '会議', icon: '🗣️', desc: '進行・意見・合意形成', data: meeting },
  { id: 'phone', cat: 'business', name: '電話・Web会議', short: '電話・Web会議', icon: '📞', desc: '取り次ぎ・接続トラブル・オンライン進行', data: phone },
  { id: 'email', cat: 'business', name: 'メール・チャット', short: 'メール', icon: '✉️', desc: '依頼・催促・お詫び・結びの定型', data: email },
  { id: 'presentation', cat: 'business', name: 'プレゼン・報告', short: 'プレゼン', icon: '📊', desc: '構成・数字の説明・質疑応答', data: presentation },
  { id: 'negotiation', cat: 'business', name: '交渉・商談', short: '交渉', icon: '🤝', desc: '価格・条件・譲歩・合意', data: negotiation },
  { id: 'office', cat: 'business', name: '社内コミュニケーション', short: '社内', icon: '🏢', desc: '依頼・相談・報連相・お詫び', data: office },
  { id: 'management', cat: 'business', name: 'マネジメント・1on1', short: 'マネジメント', icon: '🧭', desc: '目標設定・フィードバック・評価', data: management },
  { id: 'customer', cat: 'business', name: '顧客対応・接客', short: '顧客対応', icon: '🛎️', desc: '案内・クレーム対応・お詫び', data: customer },
  { id: 'trip', cat: 'business', name: '出張・会食', short: '出張・会食', icon: '✈️', desc: '名刺交換・会食・ネットワーキング', data: trip },
  { id: 'daily', cat: 'daily', name: '日常会話・雑談', short: '日常会話', icon: '☕', desc: '趣味・近況・気持ちを伝える', data: daily },
  { id: 'travel', cat: 'daily', name: '旅行・外出', short: '旅行', icon: '🧳', desc: '交通・ホテル・レストラン・トラブル', data: travel },
];

// 複数シーンをまとめて出題する「おまかせ」コース
export const MIXES = [
  { id: 'mix-business', name: 'ビジネス総合', icon: '💼', desc: 'ビジネス9シーンからランダム出題', scenes: SCENES.filter((s) => s.cat === 'business').map((s) => s.id) },
  { id: 'mix-daily', name: '日常総合', icon: '🌤️', desc: '日常会話・旅行からランダム出題', scenes: SCENES.filter((s) => s.cat === 'daily').map((s) => s.id) },
  { id: 'mix-all', name: '全シーン', icon: '🎲', desc: 'すべてのシーンからランダム出題', scenes: SCENES.map((s) => s.id) },
];

// 日本語文から安定したIDを作る（並び替えても学習履歴が引き継がれる）
function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export const ITEMS = [];
export const ITEM_MAP = new Map();

for (const scene of SCENES) {
  for (const level of LEVELS) {
    for (const raw of scene.data[level.id] || []) {
      let id = `${scene.id}-${hash(raw.ja)}`;
      while (ITEM_MAP.has(id)) id += 'x';
      const alt = [...new Set((raw.alt || []).filter((a) => a !== raw.en))];
      const item = { ...raw, alt, id, scene: scene.id, level: level.id };
      ITEMS.push(item);
      ITEM_MAP.set(id, item);
    }
  }
}

export const sceneById = (id) => SCENES.find((s) => s.id === id) || MIXES.find((m) => m.id === id);
export const levelById = (id) => LEVELS.find((l) => l.id === id);
export const scenesOf = (id) => (MIXES.find((m) => m.id === id)?.scenes) || [id];
