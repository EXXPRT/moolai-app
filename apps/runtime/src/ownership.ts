import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function processAlive(pid:number): boolean {
  try {process.kill(pid,0);return true;} catch(error) {return (error as NodeJS.ErrnoException).code!=='ESRCH';}
}
/** Acquired before Brain construction/recovery. The guard serializes stale-owner reclamation. */
export function acquireRuntimeOwnership(directory:string, alive=processAlive) {
  const lock=join(directory,'runtime-owner.json'), guard=join(directory,'runtime-owner.guard');
  const owner={pid:process.pid,nonce:randomUUID()};
  function exclusive<T>(run:()=>T):T {
    let fd:number;
    try {fd=openSync(guard,'wx',0o600);} catch {
      throw Error('Another runtime is claiming this workspace. If startup was forcibly interrupted, inspect runtime-owner.guard before removing it.');
    }
    try {writeFileSync(fd,JSON.stringify(owner));return run();}
    finally {closeSync(fd);unlinkSync(guard);}
  }
  function read(file:string):{pid:number;nonce?:string}|undefined {
    if(!existsSync(file))return;
    const value=JSON.parse(readFileSync(file,'utf8'));
    if(!Number.isSafeInteger(value.pid)||value.pid<1)throw Error(`Invalid runtime ownership: ${file}`);
    return value;
  }
  exclusive(()=>{
    const previous=read(lock), legacy=read(join(directory,'runtime.json'));
    if((previous && alive(previous.pid)) || (legacy && legacy.pid!==process.pid && alive(legacy.pid)))
      throw Error('This workspace already has a running Agent runtime. Reconnect or stop it before restarting.');
    // The guard excludes competing recovery or release operations.
    if(previous)unlinkSync(lock);
    writeFileSync(lock,JSON.stringify(owner),{flag:'wx',mode:0o600});
  });
  return { release() {
    exclusive(()=>{
      const current=read(lock);
      if(current?.nonce===owner.nonce)unlinkSync(lock);
    });
  }};
}
