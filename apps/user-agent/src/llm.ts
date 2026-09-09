// 利用者役 / 審査役の頭脳。Agent SDK をツール無しで呼んで JSON を返させる（Max ログインで動く）。
import { query } from '@anthropic-ai/claude-agent-sdk';

const env = { ...process.env };
delete env.CLAUDECODE;
delete env.CLAUDE_CODE_ENTRYPOINT;
env.TOWER_MANAGED = '1'; // 判定用の呼び出しが VS Code 連携で「外部セッション」として拾われないように

export async function llmJson<T>(system: string, prompt: string, schema: Record<string, unknown>, model = 'haiku'): Promise<T> {
  let out: unknown;
  for await (const m of query({
    prompt,
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
  })) {
    if (m.type === 'result') {
      if (m.subtype === 'success') out = m.structured_output ?? tryParse(m.result);
      else throw new Error(`llm failed: ${m.subtype}`);
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
