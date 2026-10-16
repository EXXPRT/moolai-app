// Synthetic renderer fixtures. No real workspace, providers or microphone are opened.
const {contextBridge}=require('electron');
const make=(id,title)=>({id,kind:'dictation',revision:1,sourceRevision:1,title,
 summary:Array.from({length:18},(_,n)=>`Accepted summary paragraph ${n+1}. This accepted explanation stays visible while new speech is organized.`).join('\n\n'),
 summarySourceRevision:1,createdAt:'2026-10-10T00:00:00Z',updatedAt:'2026-10-10T00:00:00Z',segments:[{id:`${id}:source`,turnId:id,revision:1,speaker:'user',text:'Retained original speech',final:true,createdAt:'2026-10-10T00:00:00Z'}],links:[],attachmentIds:[],topics:[],quality:'ready',qualityReasons:[],doubt:false,manualFields:[],acceptedRevision:0,thoughtStatus:'growing'});
const records=[make('old','Historical growing note'),make('other','Another note')];
let sequence=0,liveThought={sessionId:'session',recordId:'old',revision:'history',segments:[{id:'old-live',speaker:'user',text:'Historical pending speech',final:true}]};
const events=new Set();const requests=[];
const emit=event=>{sequence++;for(const listener of events)listener({...event,sequence});};
const state=()=>({sequence,records:structuredClone(records),liveThought:structuredClone(liveThought),state:{sessionId:'session',listening:true,busy:false,webAllowed:true},processing:{status:'available'},mode:'fixture',native:{enabled:false},localFolders:[]});
contextBridge.exposeInMainWorld('moolai',{subscribe:listener=>{events.add(listener);return()=>events.delete(listener);},chooseFolder:async()=>null,openExternal:async()=>{},request:async(method,path,body)=>{
 if(path==='/api/state')return state();
 requests.push({method,path,body});
 if(path.startsWith('/api/record/')){const record=records.find(r=>r.id===path.split('/').at(-1));Object.assign(record,body.patch);record.revision++;emit({type:'record',record:structuredClone(record)});return record;}
 return {};
}});
contextBridge.exposeInMainWorld('fixture',{
 preview:(recordId,text,revision,final=false)=>{liveThought={sessionId:'session',recordId:recordId||undefined,revision,segments:[{id:'caption',speaker:'user',text,final}]};emit({type:'thought_preview',preview:structuredClone(liveThought)});},
 publish:(id,title)=>{let record=records.find(r=>r.id===id);if(!record){record=make(id,title);records.unshift(record);}emit({type:'record',record:structuredClone(record)});},
 suppress:id=>{const record=records.find(r=>r.id===id);record.suppressed={at:'2026-10-10T01:00:00Z',operationId:'suppress',sessionId:'session'};record.revision++;emit({type:'record',record:structuredClone(record)});liveThought=undefined;emit({type:'thought_preview'});},
 requests:()=>requests,
});
