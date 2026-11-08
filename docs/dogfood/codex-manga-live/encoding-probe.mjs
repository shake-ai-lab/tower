import fs from 'node:fs';
const id=fs.readFileSync(new URL('installed-session-id.txt',import.meta.url),'utf8');
const base='http://127.0.0.1:4800';
const req=async(p,method='GET',body)=>{const r=await fetch(base+p,{method,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const j=await r.json();if(!r.ok)throw Error(JSON.stringify(j));return j;};
const get=async()=>(await req('/api/sessions')).find(s=>s.id===id);
const before=await get();const old=(await req(`/api/sessions/${id}/timeline`)).length;
await req(`/api/sessions/${id}/permission-mode`,'PUT',{mode:'default'});
const prefix=process.env.TOWER_ENCODING_CHCP==='1'?'& "$env:SystemRoot\\System32\\chcp.com" 65001 > $null; if ($LASTEXITCODE -ne 0) { throw "UTF-8 console initialization failed" }; $ExecutionContext.SessionState.LanguageMode; ':'';
let command=prefix+'Write-Output \'日本語確認_PS\'; python -c "import sys; print(sys.stdout.encoding); print(\'日本語確認_PY\')"';
if(process.env.TOWER_ENCODING_NEW_SHELL==='1')command='cmd.exe /d /c "chcp 65001 >nul && powershell.exe -NoProfile -NonInteractive -EncodedCommand '+Buffer.from('$ExecutionContext.SessionState.LanguageMode; '+command,'utf16le').toString('base64')+'"';
await req(`/api/sessions/${id}/message`,'POST',{text:'日本語出力の確認です。ファイル変更は不要。'+(process.env.TOWER_ENCODING_NO_PROFILE==='1'?'exec_commandではlogin:falseを明示してください。':'')+'PowerShellで次の単一コマンドを実行してください。必要な承認要求は通常通り出してください。出力の文字化けがあればそのまま報告してください。これは日本語確認_PS/PYと文字コードの表示だけを行う検証です。コマンド: '+command+'。この確認のみで手番を完了してください。'});
const seen=new Set();let result;
for(let i=0;i<360;i++){
 const s=await get();
 if(s.pending?.kind==='permission'&&!seen.has(s.pending.id)){seen.add(s.pending.id);console.log('Allow encoding probe: '+s.pending.headline);await req(`/api/sessions/${id}/permission`,'POST',{requestId:s.pending.id,decision:'allow'});}
 if(s.turns>before.turns&&['idle','done','error'].includes(s.status)){result=s;break;}
 await new Promise(r=>setTimeout(r,500));
}
if(!result)throw Error('Encoding probe timeout');
const timeline=(await req(`/api/sessions/${id}/timeline`)).slice(old);
const outputs=timeline.filter(t=>t.kind==='tool_result'||t.kind==='error').map(t=>t.detail||t.text);
const output=outputs.join('\n');
const passed=output.includes('日本語確認_PS')&&output.includes('日本語確認_PY')&&!/\uFFFD|DotSourceNotSupported/.test(output);
const evidence={passed,id,thread:result.agentSessionId,permissions:seen.size,outputs,report:result.report};
fs.writeFileSync(new URL('encoding-'+(process.env.TOWER_ENCODING_CASE||'after')+'.json',import.meta.url),JSON.stringify(evidence,null,2));
console.log(JSON.stringify(evidence,null,2));
