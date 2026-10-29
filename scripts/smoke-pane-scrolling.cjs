// Real Chromium wheel input against the production renderer, using disposable saved records.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'moolai-pane-scroll-'));
app.setPath('userData', path.join(data, 'electron'));
Object.assign(process.env, { MOOLAI_DATA_DIR: data, MOOLAI_MODE: 'fixture', MOOLAI_NATIVE_PATH: path.join(data, 'native-disabled') });
delete process.env.MOOLAI_DESKTOP_DEV_URL;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixtureText = '# Field observations\n\nBefore the table, this paragraph keeps normal vertical scrolling available.\n\n| Topic | Observation |\n| --- | --- |\n| Birds | Compare wing shape and flight. |\n| Trees | Compare leaf shape and branching. |\n\n' + Array.from({length: 25}, (_, i) => `### Observation ${i + 1}\n\nA longer explanation belongs to this observation. Keep its recorded uncertainty intact.\n\n\`\`\`text\nsource evidence ${i + 1}\n\`\`\`\n\n`).join('');
execFileSync(process.env.MOOLAI_NODE || 'node', ['--import', 'tsx', '--input-type=module', '-e', `
  import {SQLiteBrain} from ${JSON.stringify(pathToFileURL(path.join(root, 'packages/brain/src/index.ts')).href)};
  const b=new SQLiteBrain(${JSON.stringify(data)}), at='2026-10-02T00:00:00Z';
  const text=${JSON.stringify(fixtureText)};
  const session=await b.createRecord({id:'scroll-session',kind:'session',createdAt:at});
  // Moo speaks first: its turns render the Markdown tables and code, while the user's own words show as written.
  for(let i=0;i<30;i++) await b.upsertSegment(session.id,{id:'scroll-segment-'+i,turnId:'scroll-turn-'+i,text,speaker:i%2?'user':'assistant',revision:1,final:true,createdAt:at});
  for(let i=0;i<12;i++){const note=await b.createRecord({id:'scroll-note-'+i,kind:'note',createdAt:at});await b.updateRecord(note.id,note.revision,{title:'Scroll note '+i,body:text,summary:text,quality:'ready',manualFields:['title','summary']});}
  const connected=await b.getRecord('scroll-note-0');
  await b.updateRecord(connected.id,connected.revision,{links:Array.from({length:11},(_,i)=>({targetId:'scroll-note-'+(i+1),provenance:'manual',decision:'accepted'}))});
  await b.setState('agent',{sessionId:session.id,listening:false,busy:false,webAllowed:true});await b.close();
`], {cwd: root, stdio: ['ignore', 'ignore', 'pipe']});
const port = net.createServer();
port.listen(0, '127.0.0.1', () => {process.env.MOOLAI_PORT = String(port.address().port);port.close();});
let done = false;
const deadline = setTimeout(() => finish(1, Error('Pane smoke timed out')), 90_000);
let updatedSession;
const realFetch=globalThis.fetch;
globalThis.fetch=async(url,options)=>{
  const response=await realFetch(url,options);
  if(updatedSession && String(url).endsWith('/api/state') && response.ok){
    const snapshot=await response.json();snapshot.records=snapshot.records.map(record=>record.id===updatedSession.id?updatedSession:record);
    return new Response(JSON.stringify(snapshot),{status:200,headers:{'Content-Type':'application/json'}});
  }
  return response;
};
async function finish(code, error) {
  if(done)return;done=true;clearTimeout(deadline);
  if(error)console.error(error);
  try{const runtime=JSON.parse(fs.readFileSync(path.join(data,'runtime.json')));process.kill(runtime.pid,'SIGTERM');await delay(500);}catch{}
  fs.rmSync(data,{recursive:true,force:true});app.exit(code);
}
require(path.join(root,'apps/desktop/electron.cjs'));
app.whenReady().then(async()=>{
  try{
    const win=BrowserWindow.getAllWindows()[0];
    if(win.webContents.isLoading())await new Promise(resolve=>win.webContents.once('did-finish-load',resolve));
    const run=code=>win.webContents.executeJavaScript(code);
    for(let i=0;i<100 && !await run(`document.querySelectorAll('.utterance').length===30`);i++)await delay(50);
    assert.equal(await run(`document.querySelectorAll('.utterance').length`),30);
    win.show();win.focus();
    async function wheel(selector,deltaY=-90,deltaX=0,count=12,updates=false){
      const at=await run(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return{x:Math.round(r.left+Math.min(r.width/2,100)),y:Math.round(r.top+Math.min(r.height/2,35))};})()`);
      win.webContents.sendInputEvent({type:'mouseMove',...at});
      for(let i=0;i<count;i++){
        // Decreasing deltas exercise a precise-wheel burst and its momentum tail.
        const scale=i<count-4?1:(count-i)/4;
        win.webContents.sendInputEvent({type:'mouseWheel',...at,deltaY:deltaY*scale,deltaX:deltaX*scale,canScroll:true,hasPreciseScrollingDeltas:true});
        if(updates && i%3===0)win.webContents.send('moolai:event',{type:'voice',voice:{enabled:false,requestedOn:false,listening:false,phase:'off',speaking:false}});
        await delay(25);
      }
      await delay(220);
    }
    // Keep the same pointer over a table, where an unnecessary nested vertical
    // scroller can latch the gesture and stop its owning pane from moving.
    await run(`document.querySelector('.transcript').scrollTop=0`);await delay(100);
    const before=await run(`document.querySelector('.transcript').scrollTop`);
    await wheel('.transcript .markdown-table');
    const after=await run(`document.querySelector('.transcript').scrollTop`);
    console.log(JSON.stringify({check:'table-to-chat-wheel',before,after}));
    assert.ok(after>before+300,'Vertical wheel over a table must continue scrolling chat');
    const graph=await run(`(()=>{const cy=document.querySelector('.brain-graph')._cyreg.cy;return{pan:cy.pan(),zoom:cy.zoom()};})()`);
    async function position(pane,target){
      await run(`(()=>{const p=document.querySelector(${JSON.stringify(pane)}),t=document.querySelector(${JSON.stringify(target)});p.scrollTop+=t.getBoundingClientRect().top-p.getBoundingClientRect().top-35;})()`);
      await delay(80);
    }
    async function moves(pane,target,updates=false){
      await position(pane,target);
      const start=await run(`document.querySelector(${JSON.stringify(pane)}).scrollTop`);
      await wheel(target,-65,0,22,updates);
      assert.ok(await run(`document.querySelector(${JSON.stringify(pane)}).scrollTop`) > start+400,`${pane} continues over ${target} with live updates`);
    }
    await moves('.transcript','.transcript pre',true);
    await run(`Array.from(document.querySelectorAll('.note')).find(e=>e.textContent.includes('Scroll note 0')).click()`);await delay(200);
    await moves('.inspector-content','.inspector-content .markdown-table',true);
    await moves('.inspector-content','.inspector-content pre',true);
    await run(`document.querySelector('#note-tab-recorded').click()`);await delay(80);
    await moves('.inspector-content','.inspector-content .markdown-table',true);
    await run(`document.querySelector('#note-tab-connections').click()`);await delay(80);
    await wheel('.inspector-content',-60,0,15,true);
    assert.ok(await run(`document.querySelector('.inspector-content').scrollTop>250`),'Connections view scrolls under state updates');
    assert.deepEqual(await run(`(()=>{const cy=document.querySelector('.brain-graph')._cyreg.cy;return{pan:cy.pan(),zoom:cy.zoom()};})()`),graph,'Pane wheel input never zooms or pans the graph');
    assert.equal(await run(`document.scrollingElement.scrollTop`),0,'Only the owning pane scrolls');

    const state=await run(`window.moolai.request('GET','/api/state')`);
    updatedSession=structuredClone(state.records.find(record=>record.id==='scroll-session'));
    async function append(){
      updatedSession.sourceRevision++;updatedSession.revision++;
      updatedSession.segments.push({id:'new-'+updatedSession.sourceRevision,turnId:'turn-'+updatedSession.sourceRevision,revision:1,final:true,speaker:'user',text:'A new prompt while earlier messages remain readable.\n\n'+fixtureText.slice(0,1200),createdAt:'2026-10-02T00:01:00Z'});
      win.webContents.send('moolai:event',{type:'record',record:updatedSession});await delay(100);
    }
    assert.equal(await run(`document.querySelector('.chat-follow-controls input').checked`),false,'Follow is opt-in');
    await position('.transcript','.transcript pre');
    const reading=await run(`document.querySelector('.transcript').scrollTop`);
    await append();
    assert.equal(await run(`document.querySelector('.transcript').scrollTop`),reading,'New prompts never move the reader when follow is off');
    await run(`document.querySelector('.chat-follow-controls input').click()`);await delay(100);
    const bottom=()=>run(`(()=>{const p=document.querySelector('.transcript');return p.scrollHeight-p.clientHeight-p.scrollTop<3;})()`);
    assert.equal(await bottom(),true,'Enabling follow goes to latest prompt');
    await append();assert.equal(await bottom(),true,'New prompt is followed');
    await wheel('.transcript',70,0,12);const paused=await run(`document.querySelector('.transcript').scrollTop`);
    assert.equal(await bottom(),false,'Wheel up can leave latest prompt');
    assert.ok(await run(`document.querySelector('.chat-follow-controls').textContent.includes('Paused while reading')`));
    await append();assert.equal(await run(`document.querySelector('.transcript').scrollTop`),paused,'Follow pauses while reading');
    await run(`document.querySelector('.chat-follow-controls button').click()`);await delay(80);
    assert.equal(await bottom(),true,'Jump returns to latest');
    await append();assert.equal(await bottom(),true,'Jump resumes enabled following');
    win.webContents.reload();await new Promise(resolve=>win.webContents.once('did-finish-load',resolve));await delay(500);
    assert.equal(await run(`document.querySelector('.chat-follow-controls input').checked`),true,'Follow preference survives reload');
    await run(`document.querySelector('.chat-follow-controls input').click()`);
    win.setMinimumSize(620,560);win.setSize(850,720);await delay(200);
    await moves('.transcript','.transcript .markdown-table',true);
    await run(`Array.from(document.querySelectorAll('.note')).find(e=>e.textContent.includes('Scroll note 0')).click()`);await delay(150);
    await moves('.inspector-content','.inspector-content .markdown-table',true);
    await moves('.inspector-content','.inspector-content pre',true);
    await wheel('.notes',0,-70,16);
    assert.ok(await run(`document.querySelector('.notes').scrollLeft>400`),'Recent notes retain horizontal scrolling');
    const stable=await run(`document.querySelector('.transcript').scrollTop`);await delay(3400);
    assert.equal(await run(`document.querySelector('.transcript').scrollTop`),stable,'A polling refresh does not reset reading position');
    console.log('Pane scrolling smoke passed');
    await finish(0);
  }catch(error){await finish(1,error);}
});
