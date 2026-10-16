// Real renderer with synthetic IPC only: never opens a user workspace or microphone.
const {app,BrowserWindow}=require('electron');const path=require('node:path');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'moolai-ui-regression-'));app.setPath('userData',temp);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deadline=setTimeout(()=>app.exit(2),20000);
app.whenReady().then(async()=>{
 const window=new BrowserWindow({show:false,width:1240,height:860,webPreferences:{preload:path.join(__dirname,'fixtures/desktop-regressions-preload.cjs'),contextIsolation:true,sandbox:false}});
 const evaluate=source=>window.webContents.executeJavaScript(source);
 async function until(condition){for(let n=0;n<100;n++){if(await evaluate(condition))return;await pause(40);}throw Error(`Timed out: ${condition}`);}
 const click=text=>evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(text)})?.click()`);
 try{
  await window.loadFile(path.resolve(__dirname,'../apps/desktop/dist/index.html'));await until("!!document.querySelector('.note')");
  await evaluate("document.querySelector('.note').click()");await click('Edit');await until("!!document.querySelector('.note-editor input')");
  await evaluate(`(()=>{const input=document.querySelector('.note-editor input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Submitted edit');input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();})()`);
  await click('Save');await until('window.fixture.pendingSave()');
  assert.equal(await evaluate("document.querySelector('.note-editor input').disabled"),true);
  await window.webContents.insertText('Should not replace saved draft');
  assert.equal(await evaluate("document.querySelector('.note-editor input').value"),'Submitted edit');
  await evaluate('window.fixture.finishSave()');await until("!document.querySelector('.note-editor')");
  assert.equal(await evaluate("document.querySelector('.note strong').textContent"),'Submitted edit');
  assert.equal(await evaluate("document.querySelector('.markdown a').href"),'https://example.com/evidence');
  await evaluate('window.fixture.holdFetch()');await until('window.fixture.fetchHeld()');
  await evaluate('window.fixture.newTitle()');await until("document.querySelector('.note strong').textContent==='Newer event title'");
  await evaluate('window.fixture.releaseFetch()');await pause(100);
  assert.equal(await evaluate("document.querySelector('.note strong').textContent"),'Newer event title');
  await until("!!document.querySelector('.brain-graph')?._cyreg?.cy");
  const graphBefore=await evaluate("(()=>{const cy=document.querySelector('.brain-graph')._cyreg.cy;cy.getElementById('fixture-note').position({x:73,y:119});return {position:cy.getElementById('fixture-note').position(),pan:cy.pan(),zoom:cy.zoom()};})()");
  await evaluate('window.fixture.addNote()');
  await until("document.querySelector('.brain-graph')._cyreg.cy.nodes().length===2");
  assert.deepEqual(await evaluate("(()=>{const cy=document.querySelector('.brain-graph')._cyreg.cy;return {position:cy.getElementById('fixture-note').position(),pan:cy.pan(),zoom:cy.zoom()};})()"),graphBefore,'Incoming notes preserve user-positioned nodes, pan and zoom');
  assert.equal(await evaluate("document.querySelector('.brain-graph')._cyreg.cy.getElementById('fixture-note').hasClass('selected')"),true);
  await evaluate("document.querySelector('.inspector-content').scrollTop=160");
  assert.equal(await evaluate("document.querySelector('.inspector-content').scrollTop"),160);
  await evaluate("Array.from(document.querySelectorAll('.note')).find(note=>note.textContent.includes('A new growing thought')).click()");
  await until("document.querySelector('.inspector-header h3').textContent==='A new growing thought'");
  assert.equal(await evaluate("document.querySelector('.inspector-content').scrollTop"),0,'Selecting a different note starts at the top of Summary');
  assert.equal(await evaluate("document.querySelector('[role=tab][aria-selected=true]').textContent"),'Summary');
  await evaluate("window.fixture.interpret('Ask Ian for help studying Python.')");await until("!!document.querySelector('.understood-request')");
  assert.match(await evaluate("document.querySelector('.understood-request').textContent"),/Moo understood: Ask Ian/);
  await evaluate("window.fixture.interpret('')");await until("!document.querySelector('.understood-request')");
  for (const [kind,question] of [['note_suppression','Should I stop keeping the current note? The transcript is retained.'],['close','Are you finished with this conversation?']]) {
    await evaluate(`window.fixture.offer(${JSON.stringify(kind)},${JSON.stringify(question)})`);
    await until(`document.querySelector('.offer p')?.textContent===${JSON.stringify(question)}`);
    assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.offer button')).map(button=>button.textContent)"),['Yes','No']);
  }
  console.log('PASS: corrected-request feedback, pending edit protection, inspectable citations, event/poll ordering, and stable graph positions in Electron');
 }catch(error){console.error(error);process.exitCode=1;}
 finally{clearTimeout(deadline);window.destroy();fs.rmSync(temp,{recursive:true,force:true});app.exit(process.exitCode||0);}
});
