import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { NativeBridge } from "./native.js";

/** The host owns synthesis. Swift owns playback, echo reference and capture intent. */
export class LocalSpeech {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private epoch=0;
  private lifecycle=0;
  private next=0;
  private active?: {id:number; reject:(e:Error)=>void};
  private config?: {provider:"kokoro"|"apple";python:string};
  private root=process.env.MOOLAI_PROJECT_ROOT ?? process.cwd();
  constructor(private native: Pick<NativeBridge,"request">,private notice:(text:string)=>void, private paths?:{config:string;worker:string}) {}
  warm(): Promise<void> {
    if(this.ready)return this.ready;
    const pending=this.load(this.lifecycle);
    this.ready=pending;
    void pending.catch(()=>{if(this.ready===pending)this.ready=undefined;});
    return pending;
  }
  private async load(lifecycle:number) {
    this.config=JSON.parse(await readFile(this.paths?.config ?? path.join(this.root,"tts-config.json"),"utf8"));
    if(lifecycle!==this.lifecycle)throw Error("Speech session closed during loading");
    if(this.config!.provider==="apple")return;
    if(this.config!.provider!=="kokoro")throw Error("Unsupported configured speech provider");
    this.notice("Loading local Heart voice…");
    await new Promise<void>((resolve,reject)=>{
      const configRoot=this.paths ? path.dirname(this.paths.config) : this.root;
      const child=spawn(path.resolve(configRoot,this.config!.python),[this.paths?.worker ?? path.join(this.root,"native/tts/worker.py"),this.paths?.config ?? path.join(this.root,"tts-config.json")],{stdio:["pipe","pipe","pipe"]});
      this.child=child;
      const timer=setTimeout(()=>{child.kill();reject(Error("Local voice loading timed out"));},90000);
      const fail=(message:string)=>{
        clearTimeout(timer);reject(Error(message));
        if(this.child===child){this.active?.reject(Error(message));this.active=undefined;this.child=undefined;this.ready=undefined;child.kill();}
      };
      child.once("error",e=>fail(`Kokoro unavailable: ${e.message}. Run npm run setup:tts.`));
      child.once("exit",()=>fail("Local speech worker closed; full text remains on screen."));
      child.stdin.on("error",e=>fail(e.message));
      child.stderr.on("data",()=>{}); // library diagnostics may contain spoken text; never forward them
      createInterface({input:child.stdout}).on("line",line=>{
        try {
          const value=JSON.parse(line);
          if(value.event==="ready"){clearTimeout(timer);this.notice("Local Heart voice ready.");resolve();}
          else if(value.event==="failed")fail(`Kokoro unavailable: ${value.error}`);
          else child.emit("speech",value);
        } catch {fail("Invalid local speech output");}
      });
    });
  }
  async speak(text:string) {
    if (!text.trim()) throw Error("Speech text is empty; playback was not started.");
    this.active?.reject(Error("Speech superseded"));
    const epoch=++this.epoch;
    await this.warm();
    if(epoch!==this.epoch)return;
    if(this.config?.provider==="apple"){await this.native.request("speak",{text});return;}
    const child=this.child!;const id=++this.next;
    const token=`kokoro-${id}`;
    await this.native.request("beginSpeechAudio",{utteranceId:token});
    if(epoch!==this.epoch)return;
    await new Promise<void>((resolve,reject)=>{
      let chain=Promise.resolve();let bytes=0;let settled=false;
      const timer=setTimeout(()=>finish(Error("Local speech exceeded its time limit")),180000);
      const finish=(error?:Error)=>{
        if(settled)return;settled=true;
        clearTimeout(timer);child.removeListener("speech",receive);if(this.active?.id===id)this.active=undefined;
        if(error){child.stdin.write(JSON.stringify({id,method:"cancel"})+"\n");if(epoch===this.epoch)void this.native.request("stopSpeaking").catch(()=>{});reject(error);}else resolve();
      };
      const receive=(value:any)=>{
        if(value.id!==id || epoch!==this.epoch)return;
        chain=chain.then(async()=>{
          if(epoch!==this.epoch || settled)return;
          if(value.error)throw Error(value.error);
          if(typeof value.pcm==="string"){
            bytes+=Buffer.byteLength(value.pcm,"base64");
            if(bytes>24000*4*240)throw Error("Local speech exceeded audio bound");
            await this.native.request("speechAudio",{utteranceId:token,pcm:value.pcm});
          }
          if(value.done){await this.native.request("endSpeechAudio",{utteranceId:token});finish();}
        }).catch(e=>finish(e instanceof Error?e:Error(String(e))));
      };
      this.active={id,reject:e=>finish(e)};
      child.on("speech",receive);
      child.stdin.write(JSON.stringify({id,text})+"\n");
    });
  }
  async stop() {
    this.epoch++;
    if(this.active){const pending=this.active;this.active=undefined;pending.reject(Error("Speech interrupted"));}
    await this.native.request("stopSpeaking");
  }
  close(){this.active?.reject(Error("Speech session closed"));this.lifecycle++;this.epoch++;this.active=undefined;this.child?.kill();this.child=undefined;this.ready=undefined;}
}
