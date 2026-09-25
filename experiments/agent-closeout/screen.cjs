// Cover the primary display with a synthetic page before using the real companion.
// Never opens the microphone. No network or renderer Node access.
const {app,BrowserWindow,screen}=require('electron');
const {spawn}=require('node:child_process');
const {createInterface}=require('node:readline');
const fs=require('node:fs');const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const image=path.resolve(process.argv[2]);const output=path.resolve(process.argv[3]);
if(!image.startsWith(path.join(__dirname,'images')+path.sep)||!output.startsWith(path.join(root,'.data')+path.sep))throw Error('Only synthetic fixture capture paths allowed');
let child;const timeout=setTimeout(()=>finish(1,{error:'Capture deadline reached'}),30000);
function finish(code,result){clearTimeout(timeout);child?.kill();console.log(JSON.stringify(result));app.exit(code);}
app.whenReady().then(async()=>{
  try {
    const display=screen.getPrimaryDisplay();
    const win=new BrowserWindow({...display.bounds,frame:false,show:false,alwaysOnTop:true,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
    win.setAlwaysOnTop(true,'screen-saver');win.setSimpleFullScreen(true);
    const data=fs.readFileSync(image).toString('base64');
    await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(`<style>html,body{margin:0;width:100%;height:100%;background:#fafbfd}img{width:100%;height:100%;object-fit:contain}</style><img src="data:image/png;base64,${data}">`));
    win.show();win.focus();
    await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    await new Promise(r=>setTimeout(r,500));
    child=spawn(path.join(root,'native/build/Moolai Native.app/Contents/MacOS/MoolaiNative'),[],{stdio:['pipe','pipe','pipe']});
    let next=0;const pending=new Map();
    createInterface({input:child.stdout}).on('line',line=>{try{const v=JSON.parse(line);const p=pending.get(v.id);if(p){pending.delete(v.id);v.error?p.reject(Error(String(v.error))):p.resolve(v.result);}}catch{}});
    child.on('error',()=>finish(1,{error:'Native companion unavailable'}));
    child.on('exit',code=>{if(pending.size)finish(1,{error:'Native companion exited',code});});
    function request(method){return new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,method,params:{}})+'\n');});}
    const health=await request('health');
    if(!health.screenPermission)throw Error('Screen permission not granted; no capture requested');
    const capture=await request('capture');
    fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,Buffer.from(capture.dataBase64,'base64'),{flag:'wx',mode:0o600});
    finish(0,{health,path:output,mimeType:capture.mimeType,syntheticImage:image,display:display.bounds,window:win.getBounds(),nativeCapture:true});
  }catch(e){finish(1,{error:String(e)});}
});
