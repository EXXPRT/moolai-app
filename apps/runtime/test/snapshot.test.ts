import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileSnapshot,type Snapshot} from '../../desktop/src/snapshot.js';
import {newRecord} from '../../../packages/contracts/src/records.js';

test('newer pushed record, capture and Agent state survive an older poll',()=>{
 const old=newRecord({id:'n',kind:'note',createdAt:'now'});const current={...old,revision:2,title:'Newer title'};
 const snapshot:Snapshot={sequence:10,state:{listening:false,busy:false,webAllowed:true},records:[old],mode:'fixture',localFolders:[]};
 const result=reconcileSnapshot(snapshot,[{type:'record',record:current,sequence:11},{type:'voice',voice:{listening:true},sequence:12},{type:'state',state:{listening:true,busy:true,webAllowed:false},sequence:13}]);
 assert.equal(result.records[0]!.title,'Newer title');assert.equal(result.native!.listening,true);assert.equal(result.state.busy,true);assert.equal(result.state.webAllowed,false);
});
test('events older than a snapshot do not regress its state and newer record revisions win',()=>{
 const record={...newRecord({id:'n',kind:'note',createdAt:'now'}),revision:3,title:'Latest'};
 const snapshot:Snapshot={sequence:20,state:{listening:true,busy:false,webAllowed:true},records:[record],mode:'fixture',localFolders:[]};
 assert.deepEqual(reconcileSnapshot(snapshot,[{type:'state',state:{listening:false,busy:false,webAllowed:true},sequence:19}]),snapshot);
 assert.equal(reconcileSnapshot(snapshot,[{type:'record',record:{...record,revision:2,title:'Old'},sequence:21}]).records[0]!.title,'Latest');
});

test('live preview corrections and suppression clearing survive an older snapshot',()=>{
 const preview={sessionId:'session',recordId:'growing',revision:'1',segments:[{id:'speech',speaker:'user' as const,text:'Ask Ian',final:false}]};
 const snapshot:Snapshot={sequence:10,state:{listening:true,busy:false,webAllowed:true},records:[],mode:'fixture',localFolders:[],liveThought:preview};
 const corrected={...preview,revision:'2',segments:[{...preview.segments[0]!,text:'Ask John'}]};
 const result=reconcileSnapshot(snapshot,[{type:'thought_preview',preview:corrected,sequence:11}]);
 assert.equal(result.liveThought?.segments[0]?.text,'Ask John');
 assert.equal(reconcileSnapshot(result,[{type:'thought_preview',sequence:12}]).liveThought,undefined);
 assert.equal(reconcileSnapshot(result,[{type:'thought_preview',preview,sequence:9}]).liveThought?.revision,'2');
});
