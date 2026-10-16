/** A short first pass, then the normal background cadence. Timing never determines a topic boundary. */
export class ThoughtSchedule {
  private initial?: ReturnType<typeof setTimeout>;
  private periodic: ReturnType<typeof setInterval>;
  private running=false;
  private closed=false;
  private dirty=false;
  private attempted=false;
  constructor(private p:{run:()=>Promise<void>;enabled:()=>boolean;periodicEnabled?:()=>boolean;onError:(error:unknown)=>void;initialMs?:number;intervalMs?:number}) {
    this.periodic=setInterval(()=>void this.run(true),p.intervalMs ?? 60000);this.periodic.unref?.();
  }
  draftAvailable() {
    if(this.closed || !this.p.enabled())return;
    this.dirty=true;
    if(this.initial || this.running)return;
    const delay=this.attempted ? this.p.intervalMs ?? 60000 : this.p.initialMs ?? 6000;
    this.initial=setTimeout(()=>{this.initial=undefined;void this.run();},delay);
    this.initial.unref?.();
  }
  private async run(periodic=false) {
    if(this.closed || this.running || !this.p.enabled() || (periodic && this.p.periodicEnabled && !this.p.periodicEnabled()))return;
    // Keep the pending source pass's deadline; a periodic tick must not shorten its coalescing window.
    if(periodic && this.initial)return;
    if(this.initial){clearTimeout(this.initial);this.initial=undefined;}
    // Empty periodic checks do not consume the first-source quick pass.
    this.attempted ||= this.dirty;
    this.dirty=false;
    this.running=true;
    try {await this.p.run();} catch(error){this.p.onError(error);} finally {
      this.running=false;
      // New source may arrive after the running pass took its snapshot. Preserve one follow-up,
      // including typed work while periodic processing is disabled.
      if(this.dirty)this.draftAvailable();
    }
  }
  close() {this.closed=true;this.dirty=false;clearInterval(this.periodic);if(this.initial)clearTimeout(this.initial);this.initial=undefined;}
}
