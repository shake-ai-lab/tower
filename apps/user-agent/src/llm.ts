// 利用者役 / 審査役の頭脳。Agent SDK をツール無しで呼んで JSON を返させる（Max ログインで動く）。
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

const env = { ...process.env };
delete env.CLAUDECODE;
delete env.CLAUDE_CODE_ENTRYPOINT;
env.TOWER_MANAGED = '1'; // 判定用の呼び出しが VS Code 連携で「外部セッション」として拾われないように

export interface LlmImage {
  /** base64 */
  data: string;
  mediaType: 'image/png' | 'image/jpeg';
}

/** 画像を付ける時は、1メッセージだけ流す入力ストリームにする（文字列 prompt では画像を渡せない） */
function withImages(prompt: string, images: LlmImage[]): AsyncIterable<SDKUserMessage> {
  const content = [
    { type: 'text' as const, text: prompt },
    ...images.map((i) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: i.mediaType, data: i.data } })),
  ];
  return (async function* () {
    yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null } satisfies SDKUserMessage;
  })();
}

export async function llmJson<T>(
  system: string,
  prompt: string,
  schema: Record<string, unknown>,
  model = 'haiku',
  images: LlmImage[] = [],
): Promise<T> {
  let out: unknown;
  const q = query({
    prompt: images.length ? withImages(prompt, images) : prompt,
    options: {
      model,
      tools: [],
      settingSources: [],
      persistSession: false,
      maxTurns: 2,
      systemPrompt: system,
      outputFormat: { type: 'json_schema', schema },
      env,
    },
  });
  for await (const m of q) {
    if (m.type === 'result') {
      if (m.subtype === 'success') out = m.structured_output ?? tryParse(m.result);
      else throw new Error(`llm failed: ${m.subtype}`);
      break; // 入力ストリーム方式だと終わりを待ち続けるので、結果が来たら抜ける
    }
  }
  if (out === undefined) throw new Error('llm: no output');
  return out as T;
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    const m = s.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : undefined;
  }
}
