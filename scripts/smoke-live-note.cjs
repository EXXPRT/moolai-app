// Production renderer, synthetic IPC: no private records, provider calls, or microphone.
const {app,BrowserWindow}=require('electron');const path=require('node:path');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'moolai-live-note-'));app.setPath('userData',temp);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deadline=setTimeout(()=>app.exit(2),30000);
app.whenReady().then(async()=>{
 const window=new BrowserWindow({show:false,width:1240,height:860,webPreferences:{preload:path.join(__dirname,'fixtures/live-note-preload.cjs'),contextIsolation:true,sandbox:false}});
 const evaluate=source=>window.webContents.executeJavaScript(source);
 async function until(condition){for(let n=0;n<100;n++){if(await evaluate(condition))return;await pause(40);}throw Error(`Timed out: ${condition}`);}
 const click=text=>evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(text)})?.click()`);
 const selectedTitle=()=>evaluate("document.querySelector('.inspector-header h3')?.textContent");
 try{
  await window.loadFile(path.resolve(__dirname,'../apps/desktop/dist/index.html'));await until("!!document.querySelector('.note')");
  assert.equal(await evaluate("document.querySelector('.live-note-controls input').checked"),true);
  assert.equal(await evaluate("!!document.querySelector('.brain-document')"),false,'historical pending note does not reopen');
  await evaluate("document.querySelector('#input').focus();window.fixture.preview(null,'Check what Ian said','provisional-1')");
  await until("!!document.querySelector('[aria-label=\"Live thought preview\"]')");
  assert.equal(await evaluate('document.activeElement.id'),'input','provisional view leaves composer focus alone');
  assert.equal(await evaluate("document.querySelectorAll('.note').length"),2,'provisional words do not create a knowledge note');
  await evaluate("window.fixture.preview(null,'Check what John said','provisional-2')");
  await until("document.querySelector('.live-thought-preview').textContent.includes('John')");
  assert.doesNotMatch(await evaluate("document.querySelector('.live-thought-preview').textContent"),/Ian/);
  await evaluate("window.fixture.publish('fresh','A growing thought');window.fixture.preview('fresh','Check what John said','final-1',true)");
  await until("document.querySelector('.inspector-header h3')?.textContent==='A growing thought'");
  assert.equal(await evaluate('document.activeElement.id'),'input','new note leaves composer focus alone');
  assert.match(await evaluate("document.querySelector('.inspector-content').textContent"),/Accepted summary paragraph 18/);
  await evaluate("document.querySelector('.inspector-content').scrollTop=180");
  const scroll=await evaluate("document.querySelector('.inspector-content').scrollTop");assert.ok(scroll>0);
  await evaluate("window.fixture.preview('fresh','A further detail that is not summarized yet','final-2',true)");
  await until("document.querySelector('.live-thought-preview').textContent.includes('further detail')");
  assert.equal(await evaluate("document.querySelector('.inspector-content').scrollTop"),scroll,'same note preserves scroll');
  await click('Recorded text');
  await evaluate("window.fixture.preview('fresh','Another correction','final-3',true)");await pause(70);
  assert.equal(await evaluate("document.querySelector('[role=tab][aria-selected=true]').textContent"),'Recorded text');
  await evaluate("Array.from(document.querySelectorAll('.note')).find(note=>note.textContent.includes('Another note')).click()");
  await until("document.querySelector('.inspector-header h3')?.textContent==='Another note'");
  await evaluate("window.fixture.preview('fresh','An update after navigation','final-4',true)");await pause(70);
  assert.equal(await selectedTitle(),'Another note','manual selection is not reclaimed');
  await click('Resume live note');await until("document.querySelector('.inspector-header h3')?.textContent==='A growing thought'");
  await click('Edit');await until("!!document.querySelector('.note-editor')");
  await evaluate("window.fixture.publish('next','Next topic');window.fixture.preview('next','New topic source','topic-1',true)");await pause(70);
  assert.equal(await evaluate("document.querySelector('.note-editor input').value"),'A growing thought','new topic does not interrupt editing');
  await click('Cancel');await click('Resume live note');await until("document.querySelector('.inspector-header h3')?.textContent==='Next topic'");
  await evaluate("document.querySelector('[aria-label=\"Close note\"]').click();window.fixture.preview('next','More source','topic-2',true)");await pause(70);
  assert.equal(await evaluate("!!document.querySelector('.brain-document')"),false,'closing pauses following');
  await click('Resume live note');await until("!!document.querySelector('.brain-document')");
  await evaluate("document.querySelector('.live-note-controls input').click();window.fixture.preview('fresh','Changed while disabled','disabled',true)");await pause(70);
  assert.equal(await selectedTitle(),'Next topic');
  assert.equal(await evaluate("localStorage.getItem('moolai.live-note-follow.v1')"),'false');
  await evaluate("document.querySelector('.live-note-controls input').click()");await until("document.querySelector('.inspector-header h3')?.textContent==='A growing thought'");
  await evaluate("window.fixture.suppress('fresh')");await until("!document.querySelector('.brain-document')");
  assert.equal(await evaluate("Array.from(document.querySelectorAll('.note')).some(note=>note.textContent.includes('A growing thought'))"),false);
  assert.equal(await evaluate('window.fixture.requests().length'),0,'following and viewing make no mutation requests');
  window.setSize(920,760);await pause(80);
  await evaluate("window.fixture.preview('next','Narrow window source','narrow',true)");await until("!!document.querySelector('.brain-document')");
  assert.ok(await evaluate("document.querySelector('.conversation').getBoundingClientRect().width>200 && document.querySelector('.brain-document').getBoundingClientRect().width>200"));
  await window.reload();await until("!!document.querySelector('.note')");await pause(80);
  assert.equal(await evaluate("document.querySelector('.live-note-controls input').checked"),true);
  assert.equal(await evaluate("!!document.querySelector('.brain-document')"),false,'restart does not reopen the historical note');
  console.log('PASS: live-note corrections, provisional-only preview, accepted summary, focus, tab, scroll, manual pause/resume, preference, suppression, narrow layout and restart in Electron');
 }catch(error){console.error(error);process.exitCode=1;}
 finally{clearTimeout(deadline);window.destroy();fs.rmSync(temp,{recursive:true,force:true});app.exit(process.exitCode||0);}
});
