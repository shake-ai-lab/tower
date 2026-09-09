#!/usr/bin/env node
// Claude Code の hook から呼ばれ、標準入力の JSON を Tower に転送する。
// - Tower が落ちていても Claude Code の邪魔をしない（必ず exit 0、短いタイムアウト）
// - Tower 自身が動かしているセッション（TOWER_MANAGED=1）は何もしない
// - PermissionRequest の時だけ Tower の返答（許可/拒否）を標準出力に返す
//
// 使い方（~/.claude/settings.json の hooks に Tower が自動で書く）:
//   node tower-hook.mjs --port 4800 [--wait 90]

if (process.env.TOWER_MANAGED) process.exit(0);

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const port = opt('--port', '4800');
const wait = Number(opt('--wait', '0'));

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', async () => {
  let input;
  try {
    input = JSON.parse(data);
  } catch {
    process.exit(0);
  }
  const isPermission = input.hook_event_name === 'PermissionRequest';
  const url = `http://127.0.0.1:${port}/api/hooks/${isPermission ? 'permission' : 'event'}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), isPermission ? wait * 1000 + 5000 : 2500);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: data,
      signal: ctl.signal,
    });
    if (isPermission) {
      const text = (await res.text()).trim();
      // 決定があれば hook の出力として返す。空 {} なら Claude Code 側の通常の許可画面へ
      if (text.startsWith('{') && text !== '{}') process.stdout.write(text);
    }
  } catch {
    /* Tower が居ない: 何もしない */
  }
  clearTimeout(timer);
  process.exit(0);
});
