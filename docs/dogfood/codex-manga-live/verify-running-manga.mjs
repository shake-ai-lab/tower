import fs from 'node:fs';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
const origin='http://127.0.0.1:5000';
const html=await(await fetch(origin+'/')).text();
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage();const errors=[];
page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(origin+'/?view=studio');
 await page.waitForFunction(()=>Boolean(document.querySelector('#work-select')?.value),{},{timeout:15000});
 await page.locator('.studio-hero h2').waitFor({state:'visible',timeout:15000});
 const result={passed:true,origin,cachedHtmlHasStatus:html.includes('id="work-navigation-status"'),statusElementCount:await page.locator('#work-navigation-status').count(),workSelected:Boolean(await page.locator('#work-select').inputValue()),studioVisible:await page.locator('.studio-hero h2').isVisible(),errors};
 assert.equal(result.statusElementCount,1);assert.deepEqual(errors,[]);
 fs.mkdirSync('docs/dogfood/codex-manga-live',{recursive:true});
 fs.writeFileSync('docs/dogfood/codex-manga-live/running-manga-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();}
