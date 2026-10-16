// Run with Electron. Exercises the production renderer, preload and local runtime.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const assert = require("node:assert/strict");
const {execFileSync} = require("node:child_process");
const {pathToFileURL} = require("node:url");

const root = path.resolve(__dirname, "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moolai-desktop-"));
const evidenceDir = path.join(root, ".data/validation");
process.env.MOOLAI_DATA_DIR = dataDir;
process.env.MOOLAI_MODE = "fixture";
// This fixture test must never open a microphone or capture the real desktop.
process.env.MOOLAI_NATIVE_PATH = path.join(dataDir, "native-disabled-for-desktop-test");
delete process.env.MOOLAI_DESKTOP_DEV_URL;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
let finished = false;
async function finish(code) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  try {
    const { pid } = JSON.parse(
      fs.readFileSync(path.join(dataDir, "runtime.json"), "utf8"),
    );
    process.kill(pid, "SIGTERM");
    for (
      let n = 0;
      n < 30 && fs.existsSync(path.join(dataDir, "runtime.json"));
      n++
    )
      await delay(100);
  } catch {
    /* The fixture runtime may not have started. */
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
  app.exit(code);
}
const deadline = setTimeout(() => {
  console.error("Desktop smoke timed out");
  void finish(1);
}, 75_000);

// Reserve an unused loopback port before Electron's ready event.
const listener = net.createServer();
listener.listen(0, "127.0.0.1", () => {
  process.env.MOOLAI_PORT = String(listener.address().port);
  listener.close();
});
// Seed only this disposable fixture database; the public app has no import/create-note endpoint.
execFileSync(process.env.MOOLAI_NODE || "node", ["--import", "tsx", "--input-type=module", "-e", `
  import {SQLiteBrain} from ${JSON.stringify(pathToFileURL(path.join(root,'packages/brain/src/index.ts')).href)};
  const brain=new SQLiteBrain(${JSON.stringify(dataDir)}), at='2026-09-28T00:00:00Z';
  const segment=(id,turnId,text,speaker='user')=>({id,turnId,text,speaker,revision:1,final:true,createdAt:at});
  async function note(id,title,body,extra={}) {let r=await brain.createRecord({id,kind:'note',createdAt:at});return await brain.updateRecord(id,r.revision,{title,body,summary:body,purpose:'Reference',quality:'ready',topics:['Birds'],manualFields:['title'],...extra});}
  await note('fixture-field-note','Field observation','Swifts catch insects while flying.',{quality:'pending',error:'Backend 502: incomplete output'});
  await brain.putOperation({id:'enrich:fixture-field-note:1',kind:'enrich',recordId:'fixture-field-note',sourceRevision:1,status:'failed',attempts:1,error:'Backend 502: incomplete output'});
  const related=await note('fixture-related-note','Flight observation','Swifts can remain airborne for long periods.',{links:[{targetId:'fixture-field-note',provenance:'suggested',decision:'accepted',confidence:.94}]});
  // Writing source resets assessment to pending; a subsequent assessment supplies review status.
  await brain.updateRecord(related.id,related.revision,{quality:'needs_review',qualityReasons:['Check the uncertain observation against its source.']});
  await note('fixture-long-note','Field journal',['# Field notes','**Important**','', '1. First point','   - Supporting observation','', '| Material | Quantity |','| --- | --- |','| Salt | 5 g |','', '> Uncertain observation',''].join(String.fromCharCode(10))+Array.from({length:90},(_,i)=>'Observation '+i+': distinguish a measured result from a hypothesis.').join(String.fromCharCode(10,10)));
  for(let i=0;i<8;i++)await note('fixture-recent-'+i,'Recent thought '+i,'An independent observation '+i+'.');
  let original=await brain.createRecord({id:'fixture-original-request',kind:'dictation',createdAt:at});
  original=await brain.upsertSegment(original.id,segment('source-question','bird-question','What breed is this bird?'));
  await brain.updateRecord(original.id,original.revision,{title:'Original bird question',sourceOnly:true});
  let c=await brain.createRecord({id:'fixture-source-conversation',kind:'conversation',createdAt:at});
  c=await brain.upsertSegment(c.id,segment('conv-user','bird-followup','Yes, please help me identify it.'));
  c=await brain.upsertSegment(c.id,segment('conv-moo','bird-answer','Moo suggests comparing the wing shape.','assistant'));
  await brain.updateRecord(c.id,c.revision,{title:'Bird discussion',sourceOnly:true,links:[{targetId:original.id,provenance:'reply'}]});
  let mixed=await brain.createRecord({id:'fixture-mixed-note',kind:'dictation',createdAt:at});
  for(const part of [segment('mixed-dictation','personal-thought','I noticed a bird by the window.'),segment('mixed-user','bird-followup','Yes, please help me identify it.'),segment('mixed-moo','bird-answer','Moo suggests comparing the wing shape.','assistant')])mixed=await brain.upsertSegment(mixed.id,part);
  await brain.updateRecord(mixed.id,mixed.revision,{title:'A bird at the window',summary:'A personal observation followed by a discussion with Moo.',quality:'ready',links:[{targetId:c.id,provenance:'source'}]});
  await brain.close();
`], {cwd:root,stdio:['ignore','ignore','pipe']});

// Simulate transport and backend outages around the real fixture renderer/IPC.
let simulateProcessingOffline=false, simulateTransportFailure=false, simulateContinuation=false, simulateSettledOrganizationFailure=false;
let previewSegment;
const actualFetch=globalThis.fetch;
globalThis.fetch=async (url,options)=>{
  const stateRequest=String(url).endsWith('/api/state') && options?.headers?.['Content-Type']==='application/json';
  if(stateRequest && simulateTransportFailure)throw Error('fetch failed');
  const response=await actualFetch(url,options);
  if(stateRequest && (simulateProcessingOffline || simulateContinuation || simulateSettledOrganizationFailure || previewSegment) && response.ok) {
    const value=await response.json();
    if(previewSegment) value.records=value.records.map(record=>record.id===value.state.conversationId
      ? {...record,sourceRevision:record.sourceRevision+previewSegment.revision,segments:[...record.segments,previewSegment]} : record);
    if(simulateProcessingOffline)value.processing={status:'unavailable'};
    if(simulateContinuation) {
      value.thoughtProcessing={status:'failed',error:'More saved text remains',pending:true,continuationRequired:true,recordId:'fixture-field-note'};
      // A later successful quality check can clear a record error, but not its remaining source.
      value.records=value.records.map(record=>record.id==='fixture-field-note'?{...record,error:null}:record);
    }
    if(simulateSettledOrganizationFailure) {
      value.thoughtProcessing={status:'failed',error:'Organization incomplete',pending:true,recordId:'fixture-field-note'};
      value.records=value.records.map(record=>record.id==='fixture-field-note'?{...record,thoughtStatus:'settled'}:record);
    }
    return new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
  }
  return response;
};
require(path.join(root, "apps/desktop/electron.cjs"));
app.whenReady().then(async () => {
  try {
    while (!process.env.MOOLAI_PORT) await delay(10);
    const window = BrowserWindow.getAllWindows()[0];
    if (window.webContents.isLoading())
      await new Promise((done) =>
        window.webContents.once("did-finish-load", done),
      );
    const run = (code) => window.webContents.executeJavaScript(code);
    // Exercise real wheel/keyboard input: setting scrollTop alone cannot reproduce a stuck pane.
    const verifyChatInput = async () => {
      window.show();window.focus();
      await run(`document.querySelector('.transcript').scrollTop=0`);
      await delay(150); // Allow resize/disclosure hit-test regions to reach the compositor.
      const before=await run(`(() => {const e=document.querySelector('.transcript'),r=e.getBoundingClientRect(),cy=document.querySelector('.brain-graph')._cyreg.cy;return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),height:e.clientHeight,overflow:e.scrollHeight-e.clientHeight,pan:cy.pan(),zoom:cy.zoom()};})()`);
      assert.ok(before.height>80 && before.overflow>100,'Long chat has a bounded scrollable area');
      window.webContents.sendInputEvent({type:'mouseMove',x:before.x,y:before.y});
      window.webContents.sendInputEvent({type:'mouseWheel',x:before.x,y:before.y,deltaX:0,deltaY:-180,canScroll:true});
      for(let n=0;n<30 && !await run(`document.querySelector('.transcript').scrollTop>0`);n++)await delay(50);
      assert.ok(await run(`document.querySelector('.transcript').scrollTop>0`),'Wheel input scrolls chat: '+await run(`document.elementFromPoint(${before.x},${before.y})?.outerHTML.slice(0,180)`));
      await run(`document.querySelector('.transcript').focus();document.querySelector('.transcript').scrollTop=0`);
      window.webContents.sendInputEvent({type:'keyDown',keyCode:'PageDown'});
      window.webContents.sendInputEvent({type:'keyUp',keyCode:'PageDown'});
      for(let n=0;n<30 && !await run(`document.querySelector('.transcript').scrollTop>0`);n++)await delay(50);
      let offset=-1,stable=0;
      for(let n=0;n<40 && stable<4;n++){
        await delay(50);
        const next=await run(`document.querySelector('.transcript').scrollTop`);
        stable=next===offset?stable+1:0;offset=next;
      }
      assert.equal(stable,4,'Keyboard scroll animation settles before checking polling');
      assert.ok(offset>0,'Focused chat supports keyboard scrolling');
      await delay(3200);
      assert.equal(await run(`document.querySelector('.transcript').scrollTop`),offset,'Polling does not reset chat scroll');
      assert.deepEqual(await run(`document.querySelector('.brain-graph')._cyreg.cy.pan()`),before.pan,'Chat scrolling does not pan graph');
      assert.equal(await run(`document.querySelector('.brain-graph')._cyreg.cy.zoom()`),before.zoom,'Chat scrolling does not zoom graph');
      assert.equal(await run(`document.scrollingElement.scrollTop`),0);
    };
    const verifyGraphLabels = async () => {
      const overlaps = await run(`(() => {
        const nodes=document.querySelector('.brain-graph')._cyreg.cy.nodes().map(n=>({id:n.id(),box:n.renderedBoundingBox({includeLabels:true,includeOverlays:false})}));
        const overlaps=[];
        for(let a=0;a<nodes.length;a++)for(let b=a+1;b<nodes.length;b++) {
          const x=nodes[a].box,y=nodes[b].box;
          if(Math.min(x.x2,y.x2)-Math.max(x.x1,y.x1)>1 && Math.min(x.y2,y.y2)-Math.max(x.y1,y.y1)>1)overlaps.push([nodes[a].id,nodes[b].id]);
        }
        return overlaps;
      })()`);
      assert.deepEqual(overlaps,[], 'Graph node and label bounds remain separate');
      const smallestLabel = await run(`(() => {const cy=document.querySelector('.brain-graph')._cyreg.cy;return Math.min(...cy.nodes().map(n=>parseFloat(n.style('font-size'))*cy.zoom()));})()`);
      assert.ok(smallestLabel>=10,'Default graph labels remain readable instead of shrinking to fit');
    };
    const request = (method, route, body) =>
      run(
        `window.moolai.request(${JSON.stringify(method)},${JSON.stringify(route)},${JSON.stringify(body ?? {})})`,
      );
    assert.equal(window.webContents.getURL(), "moolai://app/index.html");
    assert.equal(await run("typeof window.require"), "undefined");
    assert.equal(
      await run(
        "fetch('moolai://app/..%2f..%2fpackage.json').then(r => r.status)",
      ),
      404,
    );
    await request("POST", "/api/session", { action: "start" });
    await request("POST", "/api/input", {
      text: "I have an idea: build a better system for connecting thoughtful notes.",
    });
    await request("POST", "/api/input", {
      text: "Moo, help me organize my ideas. Use only my notes.",
    });
    await request("POST", "/api/input", {
      text: "Keep the first idea separate.",
    });
    await request("POST", "/api/input", {
      text: "And connect it to related notes.",
    });
    const state = await request("GET", "/api/state");
    const conversation = state.records.find(
      (record) => record.id === state.state.conversationId,
    );
    assert.equal(
      conversation.segments.filter((segment) => segment.speaker === "user")
        .length,
      3,
    );
    const dictation = state.records.find(
      (record) => record.kind === "dictation",
    );
    const liveDrafts=state.records.filter(record => record.kind === "dictation" && !record.sourceOnly && record.id !== "fixture-mixed-note");
    assert.equal(liveDrafts.length,1,"Speech is inspectable in one stable draft during an active session");
    assert.equal(liveDrafts[0].thoughtStatus,"draft");
    for(let n=0;n<30 && !await run("document.body.innerText.includes('Growing note')");n++)await delay(100);
    assert.ok(await run("document.body.innerText.includes('Growing note')"));
    let visible = "";
    for (let n = 0; n < 30; n++) {
      visible = await run("document.body.innerText");
      if (
        visible.includes("Fixture mode") &&
        visible.includes("Talking with Moo") &&
        visible.includes("Saved locally") &&
        visible.includes("And connect it to related notes.")
      )
        break;
      await delay(100);
    }
    assert.ok(
      visible.includes("Fixture mode") &&
        visible.includes("Talking with Moo") &&
        visible.includes("Saved locally") &&
        visible.includes("And connect it to related notes."),
    );
    // Poll real renderer snapshots with one changing utterance; it must replace, not append.
    const previewVisible=async (expected,busy)=>{
      for(let n=0;n<40;n++) {
        const result=await run(`Array.from(document.querySelectorAll('.utterance')).filter(e=>e.textContent.includes('Search the notes for')).map(e=>({text:e.textContent,busy:e.getAttribute('aria-busy')}))`);
        if(expected===null ? result.length===0 : result.length===1 && result[0].text.includes(expected) && result[0].busy===String(busy))return;
        await delay(100);
      }
      throw Error('Live transcript replacement/clearing did not render');
    };
    previewSegment={id:'fixture-live-preview',turnId:'fixture-live-turn',revision:1,final:false,speaker:'user',text:'Search the notes for Ian',createdAt:new Date().toISOString()};
    await previewVisible('Ian',true);
    previewSegment={...previewSegment,revision:2,text:'Search the notes for Ian, no, John'};
    await previewVisible('no, John',true);
    previewSegment={...previewSegment,revision:3,final:true};
    await previewVisible('no, John',false);
    previewSegment={...previewSegment,revision:4,text:''};
    await previewVisible(null,false);
    previewSegment=undefined;
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(
      path.join(evidenceDir, "desktop.png"),
      (await window.webContents.capturePage()).toPNG(),
    );
    await request("POST", "/api/input", { text: "That's all." });
    let afterEnd = await request("GET", "/api/state");
    for (let n = 0; n < 30 && afterEnd.state.conversationId; n++) {
      await delay(100);
      afterEnd = await request("GET", "/api/state");
    }
    assert.equal(afterEnd.state.conversationId, undefined, "Natural ending closes the conversation");
    await request("POST", "/api/input", { text: "What's even going on?" });
    const help = await request("GET", "/api/state");
    assert.equal(help.state.pendingOffer?.kind, "general_help");
    assert.equal(help.state.conversationId, undefined, "General help waits for the user's answer");
    for (let n = 0; n < 30; n++) {
      visible = await run("document.body.innerText");
      if (visible.includes("Moo will wait for your answer.")) break;
      await delay(100);
    }
    assert.ok(visible.includes("Moo will wait for your answer."));
    assert.ok(!visible.includes("Accepting captures"), "General help must not promise a screenshot");
    await request("POST", "/api/input", { text: "No, just save it." });
    const declined = await request("GET", "/api/state");
    assert.equal(declined.state.pendingOffer, undefined);
    assert.equal(declined.state.conversationId, undefined);
    assert.ok(declined.records.some(record => record.segments.some(segment => segment.text === "What's even going on?")));
    await request("POST", "/api/input", { text: "What's even going on?" });
    await request("POST", "/api/input", { text: "Yes, please." });
    const accepted = await request("GET", "/api/state");
    assert.ok(accepted.state.conversationId);
    assert.equal(accepted.state.pendingOffer, undefined);
    assert.ok(accepted.records.every(record => record.attachmentIds.length === 0));
    assert.equal(accepted.state.lastError, undefined);
    await request("POST", "/api/input", { text: "That's all." });
    await request("POST", "/api/session", { action: "stop" });
    for (let n = 0; n < 30; n++) {
      visible = await run("document.body.innerText");
      if (visible.includes("Start session") && visible.includes("Session off"))
        break;
      await delay(100);
    }
    assert.ok(
      visible.includes("Start session") && visible.includes("Session off"),
    );
    const consolidated = (await request('GET','/api/state')).records.filter(r=>r.kind==='dictation'&&!r.sourceOnly);
    assert.ok(consolidated.some(r=>r.summary && r.purpose),'Session stop finalizes attributed topic content');
    assert.ok(await run(`Boolean(document.querySelector('.graph-area .brain-graph canvas'))`),'Graph is visible without opening a note');
    await verifyGraphLabels();
    const clickNote = async title => {
      for(let n=0;n<40 && !await run(`Array.from(document.querySelectorAll('.notes button')).some(b=>b.textContent.includes(${JSON.stringify(title)}))`);n++)await delay(100);
      await run(`Array.from(document.querySelectorAll('.notes button')).find(b=>b.textContent.includes(${JSON.stringify(title)})).click()`);await delay(100);
    };
    const selectTab = async label => {await run(`Array.from(document.querySelectorAll('[role="tab"]')).find(b=>b.textContent===${JSON.stringify(label)}).click()`);await delay(60);};
    const buttons = await run(`Array.from(document.querySelectorAll('button')).map(b=>b.textContent.trim())`);
    for(const retired of ['New note','Add reply','Add correction','Archive','Restore note','Export Markdown','Export snapshot','Import snapshot','Mark resolved','Add relationship'])assert.ok(!buttons.includes(retired),retired);
    for(const [method,route] of [['POST','/api/notes'],['POST','/api/snapshot/export'],['POST','/api/snapshot/import'],['GET','/api/export/fixture-field-note'],['GET','/api/history/fixture-field-note']])await assert.rejects(request(method,route,{}));

    await clickNote('Field observation');
    assert.deepEqual(await run(`Array.from(document.querySelectorAll('[role="tab"]')).map(b=>b.textContent)`),['Summary','Recorded text','Connections']);
    assert.equal(await run(`document.querySelector('[role="tab"][aria-selected="true"]').textContent`),'Summary');
    assert.ok(!(await run('document.body.innerText')).includes('502'),'Stored diagnostics are not note prose');
    assert.ok((await run('document.body.innerText')).includes('Retry summary'));
    assert.equal(await run(`document.querySelector('.inspector-content .summary-review').textContent`),'Unchecked summary');
    assert.ok(await run(`!!(document.querySelector('.inspector-content .summary-review').compareDocumentPosition(document.querySelector('.inspector-content .markdown')) & Node.DOCUMENT_POSITION_FOLLOWING)`),'Quality appears before generated prose');
    assert.equal(await run(`Array.from(document.querySelectorAll('.note')).find(n=>n.querySelector('strong').textContent==='Field observation').querySelector('.summary-review').textContent`),'Unchecked summary');
    await clickNote('Flight observation');
    assert.equal(await run(`document.querySelector('.inspector-content .summary-review').textContent`),'Needs review');
    await clickNote('Field observation');
    simulateSettledOrganizationFailure=true;await delay(3300);
    assert.match(await run(`document.querySelector('.inspector-content').innerText`),/Organization stopped before the updated summary/);
    assert.ok(await run(`Array.from(document.querySelectorAll('.inspector-content button')).some(b=>b.textContent==='Retry organization')`),'Complete summaries retry their failed organization buffer');
    simulateSettledOrganizationFailure=false;
    simulateContinuation=true;await delay(3300);
    assert.match(await run(`document.querySelector('.inspector-content').innerText`),/This summary is saved\. More recorded text/);
    assert.ok(await run(`Array.from(document.querySelectorAll('.inspector-content button')).some(b=>b.textContent==='Continue organization')`));
    assert.match(await run(`document.querySelector('.inspector-content').innerText`),/Swifts catch insects/);
    simulateContinuation=false;await delay(3300);
    assert.ok((await run(`document.querySelector('.inspector-content').innerText`)).includes('Retry summary'));
    simulateProcessingOffline=true;await delay(3300);
    assert.match(await run(`document.querySelector('.connection-status').textContent`),/Processing unavailable/);
    assert.equal(await run(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Retry summary').disabled`),true);
    assert.ok(!(await run('document.body.innerText')).includes('Backend 502'));
    simulateProcessingOffline=false;await delay(3300);
    assert.equal(await run(`Boolean(document.querySelector('.connection-status'))`),false,'Backend recovery clears current availability banner');
    assert.ok((await request('GET','/api/state')).records.find(r=>r.id==='fixture-field-note').error,'Recovery does not erase failed note work');
    simulateTransportFailure=true;await delay(3300);
    assert.match(await run(`document.querySelector('.connection-status').textContent`),/Connecting to your local workspace/);
    simulateTransportFailure=false;await delay(3300);
    assert.equal(await run(`Boolean(document.querySelector('.connection-status'))`),false,'Successful poll clears fetch warning');
    await run(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Retry summary').click()`);
    let updated;
    for(let n=0;n<30;n++){updated=(await request('GET','/api/state')).records.find(r=>r.id==='fixture-field-note');if(!updated.error)break;await delay(100);}
    assert.equal(updated.error,undefined);assert.equal(updated.body,'Swifts catch insects while flying.');
    await selectTab('Recorded text');assert.match(await run(`document.querySelector('.inspector-content').innerText`),/Written note/);
    await clickNote('A bird at the window');
    assert.equal(await run(`document.querySelector('[role="tab"][aria-selected="true"]').textContent`),'Summary','Every selected note opens on Summary');
    await selectTab('Recorded text');
    const sourceText=await run(`document.querySelector('.inspector-content').innerText`);
    assert.match(sourceText,/Dictation/);assert.match(sourceText,/Moo conversation/);assert.match(sourceText,/Moo suggests/);
    await run(`document.querySelectorAll('.inspector-content details').forEach(e=>e.open=true)`);
    assert.match(await run(`document.querySelector('.inspector-content').innerText`),/What breed is this bird/,'Accepted help retains the original request');
    await clickNote('Field observation');await selectTab('Connections');
    assert.match(await run(`document.querySelector('.connections').innerText`),/Flight observation/);
    await run(`document.querySelector('button[aria-label="Remove connection to Flight observation"]').click()`);
    await delay(150);
    const related=(await request('GET','/api/state')).records.find(r=>r.id==='fixture-related-note');
    assert.equal(related.links[0].decision,'dismissed','Incoming automatic association is persistently dismissed');
    await selectTab('Summary');await run(`document.querySelector('.summary-actions button').click()`);
    await run(`(() => { const form=document.querySelector('.note-editor');
      const set=(element,value)=>{Object.getOwnPropertyDescriptor(element.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));};
      set(form.querySelector('input'),'My field observation');set(form.querySelector('textarea'),'My own summary of the swift observation.');
    })()`);await delay(40);
    await run(`document.querySelector('.note-editor').dispatchEvent(new KeyboardEvent('keydown',{key:'s',metaKey:true,bubbles:true}))`);
    for(let n=0;n<30;n++){updated=(await request('GET','/api/state')).records.find(r=>r.id==='fixture-field-note');if(updated.summary==='My own summary of the swift observation.')break;await delay(100);}
    assert.equal(updated.title,'My field observation');assert.ok(updated.manualFields.includes('summary'));assert.equal(updated.body,'Swifts catch insects while flying.');
    await run(`document.querySelector('.close-inspector').click()`);
    assert.equal(await run(`document.querySelector('.search-dropdown').open`),false);
    await run(`document.querySelector('.search-dropdown summary').click()`);
    assert.deepEqual(await run(`Array.from(document.querySelectorAll('.search-popover label')).map(e=>e.childNodes[0].textContent.trim())`),['Search','Topic','Category']);
    await run(`(() => {const e=document.querySelector('.search-dropdown input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'swifts');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await delay(80);
    assert.ok(await run(`Boolean(document.querySelector('.filter-count'))`));
    await run(`document.querySelector('.filter-footer button').click()`);await delay(60);
    await run(`document.querySelector('.search-dropdown summary').click()`);
    await clickNote('Field journal');
    assert.ok(await run(`document.querySelector('.inspector-content .markdown h1') && document.querySelector('.inspector-content .markdown strong') && document.querySelector('.inspector-content .markdown li ul') && document.querySelector('.inspector-content .markdown table')`),'Summary uses shared complete Markdown rendering');
    await selectTab('Recorded text');
    assert.ok(await run(`document.querySelector('.inspector-content .markdown table')`),'Written source uses the same Markdown renderer');
    await selectTab('Summary');
await delay(100);
    await run(`document.querySelector('#note-tab-summary').focus();document.querySelector('#note-tab-summary').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`);
    assert.equal(await run(`document.activeElement.id`),'note-tab-recorded','Arrow keys move focus and select the next reader tab');
    await run(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))`);
    assert.equal(await run(`document.querySelector('[role="tab"][aria-selected="true"]').textContent`),'Summary');
    await run(`document.querySelector('.inspector-content').scrollTop=200;document.querySelector('.notes').scrollLeft=100;document.querySelector('.transcript').scrollTop=80;`);await delay(350);
    const scrolling=await run(`(() => {
      const note=document.querySelector('.inspector-content'),list=document.querySelector('.notes'),chat=document.querySelector('.transcript');
      return {note:note.scrollTop,list:list.scrollLeft,chat:chat.scrollTop,page:document.scrollingElement.scrollTop,
        contained:[note,list,chat].every(e=>getComputedStyle(e).overscrollBehaviorY==='contain'),viewport:document.querySelector('.shell').getBoundingClientRect().bottom<=innerHeight+1};
    })()`);
    assert.ok(scrolling.note>0&&scrolling.list>0&&scrolling.chat>0,JSON.stringify(scrolling));assert.equal(scrolling.page,0);assert.equal(scrolling.contained,true);assert.equal(scrolling.viewport,true);
    await verifyChatInput();
    fs.writeFileSync(path.join(evidenceDir,'focused-inspector.png'),(await window.webContents.capturePage()).toPNG());
    await run(`document.querySelector('.close-inspector').click()`);await delay(80);
    const beforeZoom=await run(`document.querySelector('.brain-graph')._cyreg.cy.zoom()`);
    await run(`document.querySelector('button[aria-label="Zoom in"]').click()`);await delay(300);
    const zoom=await run(`document.querySelector('.brain-graph')._cyreg.cy.zoom()`);assert.ok(zoom>beforeZoom);
    const position=await run(`document.querySelector('.brain-graph')._cyreg.cy.pan()`);await delay(3200);
    assert.equal(await run(`document.querySelector('.brain-graph')._cyreg.cy.zoom()`),zoom);
    assert.deepEqual(await run(`document.querySelector('.brain-graph')._cyreg.cy.pan()`),position,'Polling preserves graph viewport');
    await verifyGraphLabels();
    await run(`document.querySelector('.brain-graph').focus();document.querySelector('.brain-graph').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`);await delay(300);
    assert.ok(await run(`document.querySelector('.brain-graph')._cyreg.cy.pan().x < ${position.x}`),'Focused graph can pan with the keyboard');
    fs.writeFileSync(path.join(evidenceDir,'focused-workspace.png'),(await window.webContents.capturePage()).toPNG());
    window.setMinimumSize(620,560);window.setSize(850,720);await delay(150);
    await clickNote('Field journal');await delay(200);
    assert.notEqual(await run(`getComputedStyle(document.querySelector('.conversation')).display`),'none');
    assert.notEqual(await run(`getComputedStyle(document.querySelector('.graph-area')).display`),'none');
    assert.equal(await run(`getComputedStyle(document.querySelector('.brain-document')).gridArea`),await run(`getComputedStyle(document.querySelector('.graph-area')).gridArea`),'Inspector overlays the graph area');
    assert.ok(await run(`document.querySelector('.brain-document').getBoundingClientRect().width>280`));
    assert.ok(await run(`document.querySelector('.transcript').getBoundingClientRect().height>100`));
    const chatHeight=await run(`document.querySelector('.transcript').clientHeight`);
    await run(`document.querySelector('.study-settings').open=true;document.querySelector('.folder-access').open=true`);
    assert.equal(await run(`document.querySelector('.transcript').clientHeight`),chatHeight,'Expanded settings and folder access cannot collapse chat');
    assert.ok(await run(`document.querySelector('.study-settings-panel').scrollHeight>document.querySelector('.study-settings-panel').clientHeight`),'Long settings scroll in their own panel');
    await run(`document.querySelector('.study-settings').open=false`);
    await verifyChatInput();
    fs.writeFileSync(path.join(evidenceDir,'focused-compact-inspector.png'),(await window.webContents.capturePage()).toPNG());
    await run(`document.querySelector('.close-inspector').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    assert.equal(await run(`Boolean(document.querySelector('.brain-document'))`),false);
    await delay(200);
    fs.writeFileSync(path.join(evidenceDir,'focused-compact.png'),(await window.webContents.capturePage()).toPNG());
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    assert.equal(await run(`getComputedStyle(document.querySelector('.transcript')).scrollBehavior`),'auto','Reduced motion removes smooth scrolling');
    await run(`document.querySelector('button[aria-label="Zoom in"]').click()`);
    assert.equal(await run(`document.querySelector('.brain-graph')._cyreg.cy.animated()`),false,'Reduced motion skips viewport animation');
    window.webContents.debugger.detach();
    const evidence = {
      checkedAt: new Date().toISOString(),
      passed: true,
      fixture: true,
      summarySourceConnectionsAndManualEdits: true,
      backendAndTransportRecovery: true,
      retiredFeaturesDenied: true,
      independentScrollAndCollapsedFilters: true,
      realWheelKeyboardAndPollingAtTwoWidths: true,
      simultaneousChatGraphAndInspector: true,
      graphLabelBoundsAndKeyboardNavigation: true,
      scenario:
        "production custom protocol, narrow preload/API, saved enriched dictation, three-turn Moo, natural close, general-help decline/accept, session start/stop",
      nodeCount: state.records.length,
      conversationUserTurns: 3,
      rejectedFileTraversal: true,
      rendererNodeDisabled: true,
      nativeCaptureDisabled: true,
      generalHelpWaitedForReply: true,
      generalHelpCapturedNoScreenshot: true,
      electron: process.versions.electron,
    };
    fs.writeFileSync(
      path.join(root, ".data/validation/desktop-smoke.json"),
      JSON.stringify(evidence, null, 2) + "\n",
    );
    console.log("PASS desktop smoke; screenshot .data/validation/desktop.png");
    await finish(0);
  } catch (error) {
    console.error(error);
    await finish(1);
  }
});
