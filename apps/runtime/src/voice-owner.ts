import { processAlive } from './ownership.js';

/** A detached runtime may outlive its UI, but its microphone may not. */
export class VoiceOwner {
  private pid?:number;
  private generation=0;
  get token(){return this.generation;}
  private timer?:ReturnType<typeof setInterval>;
  constructor(private lost:()=>Promise<unknown>, private alive=processAlive) {}
  claim(pid:unknown) {
    if(!Number.isSafeInteger(pid) || Number(pid)<1 || !this.alive(Number(pid))) throw Error('Voice owner is unavailable');
    if(this.pid!==undefined && this.pid!==pid && this.alive(this.pid)) throw Error('Another app window owns voice capture');
    this.pid=Number(pid);
    this.generation++;
    this.timer ??= setInterval(()=>void this.check(),1000);
    this.timer.unref();
    return this.generation;
  }
  async check() {
    const pid=this.pid;
    if(pid===undefined || this.alive(pid))return;
    this.clear();
    await this.lost();
  }
  clear(token=this.generation) {if(token!==this.generation)return;this.pid=undefined;if(this.timer)clearInterval(this.timer);this.timer=undefined;}
}
