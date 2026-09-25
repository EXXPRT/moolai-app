/** Replay saved model decisions against the controller; never dispatch providers. */
import {readFile,readdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {MemoryBrain,SQLiteBrain} from '../../packages/brain/src/index.js';
import {prepare} from './scenario.js';
const source=resolve(process.argv[2]??'.data/j1-closing-20260926');const results=[];
for(const file of (await readdir(source)).filter(f=>/^c\d+r?-(current|contextual)\.json$/.test(f))) {
  const saved=JSON.parse(await readFile(join(source,file),'utf8'));
  for(const storage of ['memory','sqlite']) {
    const dir=await mkdtemp(join(tmpdir(),'moolai-replay-'));
    const brain=storage==='memory'?new MemoryBrain():new SQLiteBrain(dir);
    try {
      const {f,release}=await prepare(brain,saved.item,saved.profile);let index=0;
      const generationCount=f.observed.generations.length;
      f.hooks.decisions.route=async()=>{
        const result=saved.outputs[index++];if(!result)throw new Error('No saved result; replay cannot dispatch');return result;
      };
      if(saved.item.text!==null)await f.agent.submitText(saved.item.text);
      release();await f.agent.drain();
      assert.equal(!f.agent.getState().conversationId,saved.closed,file);
      assert.equal(f.observed.generations.length-generationCount,saved.generated,file);
      assert.equal(index,saved.modelCalls,file);
      const session=(await brain.getRecord(f.agent.getState().sessionId!))!;
      assert.ok(saved.item.text===null||session.segments.some(s=>s.speaker==='user'&&s.text===saved.item.text));
      results.push({file,storage,pass:true,closed:saved.closed});
    }finally{if(brain instanceof SQLiteBrain)brain.close();await rm(dir,{recursive:true,force:true});}
  }
}
await writeFile(join(source,'controller-replay.json'),JSON.stringify({providerCalls:0,results},null,2));
console.log(`${results.length}/${results.length} replay checks passed; zero provider calls.`);
