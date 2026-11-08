import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
const base=process.env.TOWER_TRIAL_ORIGIN||'http://127.0.0.1:4816';
const id=process.env.TOWER_TRIAL_SESSION||fs.readFileSync(new URL('session-id.txt',import.meta.url),'utf8');
const standalone=process.env.TOWER_TRIAL_STANDALONE==='1';
const dir=new URL('./',import.meta.url);
const file=(name)=>new URL(name,dir).pathname.replace(/^\/(.:)/,'$1');
const get=async()=> (await (await fetch(base+'/api/sessions')).json()).find(s=>s.id===id);
const evidence=[];
async function waitFor(label,predicate,ms=180000){const end=Date.now()+ms;while(Date.now()<end){const s=await get();if(predicate(s)){evidence.push({label,at:Date.now(),status:s.status,thread:s.agentSessionId,pending:s.pending,liveOutput:s.liveOutput});console.log(label);return s;}await new Promise(r=>setTimeout(r,250));}throw Error('Timeout: '+label);}
const browser=await chromium.launch({channel:'msedge',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1050}});
await context.addInitScript(id=>{localStorage.setItem('tower.layout',JSON.stringify({sidebar:false,main:'focus',chat:false}));localStorage.setItem('tower.focus-task',id);},id);
const page=await context.newPage();const errors=[],liveSamples=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
page.on('websocket',ws=>ws.on('framereceived',({payload})=>{try{const e=JSON.parse(String(payload));if(e.type==='session'&&e.session.id===id&&e.session.liveOutput?.length)liveSamples.push({at:Date.now(),items:e.session.liveOutput.map(x=>({kind:x.kind,text:x.text.slice(-300)}))});}catch{}}));
async function send(text){await page.locator('footer textarea').fill(text);await page.getByRole('button',{name:/^(送信|再開して送信)$/}).click();}
async function shot(name){await page.screenshot({path:file(name),fullPage:true});}
const original=await get();
try{
  await page.goto(base);await page.getByLabel('タスクの許可方針',{exact:true}).selectOption('default');
  await waitFor('permission-mode-default',s=>s.permissionMode==='default');
  await send(standalone?'同じ会話の操作検証です。最初の依頼で覚えた合言葉を述べてください。次にPythonでTOWER_LIVE_BEGINをflush付きで表示し、25秒待ち、TOWER_LIVE_ENDをflush付きで表示する単一コマンドを実行してください。必要な権限は通常の承認要求を出す。拒否された場合は迂回せず、そのことを報告して手番を終了。ファイルは一切変更不要です。':fs.readFileSync(file('lifecycle.txt'),'utf8'));
  await waitFor('real-command-approval',s=>s.pending?.kind==='permission');await shot('approval-deny.png');
  await page.getByRole('button',{name:'拒否',exact:true}).click();
  await waitFor('denied-turn-complete',s=>['idle','done','error'].includes(s.status));
  await shot('denied.png');
  await send('同じPythonコマンド（TOWER_LIVE_BEGINをflush、25秒待機、TOWER_LIVE_ENDをflush）をもう一度実行してください。今回は画面で許可します。ファイル変更不要。');
  await waitFor('approval-after-denial',s=>s.pending?.kind==='permission');await shot('approval-allow.png');
  await page.getByRole('button',{name:'許可',exact:true}).click();
  const live=await waitFor('live-command-before-completion',s=>s.liveOutput?.some(x=>x.kind==='command_output'&&x.text.includes('TOWER_LIVE_BEGIN')));
  assert.ok(!live.liveOutput.some(x=>x.text.includes('TOWER_LIVE_END')));
  await page.locator('pre').filter({hasText:'TOWER_LIVE_BEGIN'}).last().waitFor();await shot('live-command.png');
  await page.getByRole('button',{name:'停止',exact:true}).click();
  const stopped=await waitFor('stopped-clears-live',s=>s.status==='stopped'&&!s.liveOutput?.length);assert.equal(stopped.agentSessionId,original.agentSessionId);await shot('stopped.png');
  await page.getByLabel('タスクの許可方針',{exact:true}).selectOption('bypassPermissions');
  await waitFor('permission-mode-full',s=>s.permissionMode==='bypassPermissions');
  await send(standalone?'停止後の再開検証です。Pythonでprint("TOWER_RESUME_OK", flush=True)のみ実行してください。ファイル変更や長いテストは不要。最初の依頼で覚えた合言葉と今回のマーカーを短く報告して終了してください。':'停止後の再開検証です。直前のコマンドは停止されたので、Pythonでprint("TOWER_RESUME_OK", flush=True)のみ実行してください。これ以上のmanga編集や長いテストは不要です。先に実装したmangaの改善内容とレビューで直した2件を短く思い出し、停止後も同じ会話が保持されたことと今回のマーカーを報告して終了してください。');
  const resumed=await waitFor('same-thread-resumed-complete',s=>s.turns>stopped.turns&&['idle','done'].includes(s.status));assert.equal(resumed.agentSessionId,original.agentSessionId);
  await shot('resumed.png');assert.deepEqual(errors,[]);
  if(standalone)assert.ok(JSON.stringify(resumed.report).includes('TOWER_CONTEXT_9F31'));
  fs.writeFileSync(file('lifecycle-result.json'),JSON.stringify({passed:true,origin:base,sessionId:id,errors,evidence,liveSamples,report:resumed.report},null,2));
  console.log('PASS real UI: permission deny/allow, live command, stop/clear, same-thread resume');
}catch(e){await shot('lifecycle-failure.png');fs.writeFileSync(file('lifecycle-result.json'),JSON.stringify({passed:false,origin:base,sessionId:id,error:String(e),errors,evidence,liveSamples},null,2));console.error((await page.locator('body').innerText()).slice(-6000));throw e;}finally{await browser.close();}
