// AI添削（任意機能）：Claude API で回答の自然さ・正しさを判定する
// APIキーはこの端末の localStorage にのみ保存され、Anthropic の API へ直接送信される。
const SDK_URL = 'https://esm.sh/@anthropic-ai/sdk@0.131.0';

export const AI_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5（高精度・推奨）' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5（バランス）' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5（高速・低コスト）' },
];
// サーバー側フォールバック（安全分類器による拒否時に別モデルで再実行）に対応するモデル
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

const SYSTEM = `You are an English speaking coach for Japanese business professionals practicing "instant English composition" (瞬間英作文): the learner sees a Japanese sentence and must say it in English within a few seconds.

Evaluate the learner's answer against the Japanese sentence.
- The answer may come from speech recognition. Ignore capitalization and punctuation, and do not penalize plausible recognition errors (homophones, a dropped article).
- Judge whether the meaning matches the Japanese and whether the English is natural, grammatical, and appropriate for the scene. A different wording from the model answer is fine if it works.
- verdict "correct": natural and accurate; a native speaker could say it as is in this scene.
- verdict "acceptable": the meaning comes across, but there is a minor slip or it sounds a little unnatural or too casual/stiff for the scene.
- verdict "incorrect": the meaning differs, something important is missing, or a grammar error gets in the way.
- feedback_ja: 2-3 short sentences in Japanese for the learner. Say what works, then what to fix and why. Do not repeat the whole model answer.
- better: the most natural version that stays close to the learner's own wording (repeat their sentence if it is already correct).`;

const SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['correct', 'acceptable', 'incorrect'] },
    feedback_ja: { type: 'string' },
    better: { type: 'string' },
  },
  required: ['verdict', 'feedback_ja', 'better'],
  additionalProperties: false,
};

let sdk = null;
let cached = { key: '', client: null };

async function getClient(apiKey) {
  if (!sdk) {
    try {
      sdk = await import(SDK_URL);
    } catch {
      throw new Error('AI添削モジュールを読み込めませんでした。インターネット接続を確認してください。');
    }
  }
  if (cached.key !== apiKey) {
    const Anthropic = sdk.default;
    cached = { key: apiKey, client: new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 1, timeout: 30000 }) };
  }
  return { Anthropic: sdk.default, client: cached.client };
}

export async function reviewAnswer({ apiKey, model, item, sceneName, levelName, userText }) {
  if (!apiKey) throw new Error('APIキーが設定されていません（設定 → AI添削）。');
  const { Anthropic, client } = await getClient(apiKey);
  const payload = {
    scene: sceneName,
    level: levelName,
    japanese: item.ja,
    model_answer: item.en,
    other_accepted_answers: item.alt || [],
    learner_answer: userText,
  };
  const params = {
    model,
    max_tokens: 4096,
    system: SYSTEM,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: JSON.stringify(payload, null, 2) }],
  };
  if (FALLBACK_MODELS.has(model)) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  let res;
  try {
    res = await client.beta.messages.create(params);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('APIキーが無効です。設定を確認してください。');
    if (e instanceof Anthropic.PermissionDeniedError) throw new Error('このAPIキーでは選択したモデルを利用できません。');
    if (e instanceof Anthropic.RateLimitError) throw new Error('リクエストが集中しています。少し待ってから再度お試しください。');
    if (e instanceof Anthropic.BadRequestError) throw new Error(`リクエストエラー: ${e.message}`);
    if (e instanceof Anthropic.APIConnectionError) throw new Error('Claude API に接続できませんでした。通信状況を確認してください。');
    if (e instanceof Anthropic.APIError) throw new Error(`APIエラー（${e.status}）: ${e.message}`);
    throw e;
  }
  if (res.stop_reason === 'refusal') throw new Error('この回答はAIで判定できませんでした。');
  const text = res.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('AIから結果を受け取れませんでした。');
  const data = JSON.parse(text);
  return { verdict: data.verdict, feedback: data.feedback_ja, better: data.better, model: res.model };
}
