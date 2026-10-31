/** The watchdog outlives a crashed Backend. It owns only the child it spawned,
 * and removes image inputs only after that child has exited. No PID-file kill. */
export const analysisProviderRunner = String.raw`
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const [binary,encoded,directory,deadlineText]=process.argv.slice(1);
const args=JSON.parse(encoded),deadline=Number(deadlineText);
const child=spawn(binary,args,{cwd:directory,stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32'});
let stopped=false,force,timer,monitor,bytes=0;
function signalChild(signal){if(!child.pid||child.exitCode!==null)return;try{process.kill(-child.pid,signal);}catch{child.kill(signal);}}
function stop(){
 if(stopped)return;stopped=true;
 signalChild('SIGTERM');force=setTimeout(()=>signalChild('SIGKILL'),3000);
}
process.on('disconnect',stop);process.on('SIGTERM',stop);process.on('SIGINT',stop);
process.stdin.pipe(child.stdin);child.stdin.on('error',()=>{});
for(const [stream,target]of [[child.stdout,process.stdout],[child.stderr,process.stderr]])stream.on('data',b=>{bytes+=b.length;if(bytes>1048576)stop();else target.write(b);});
timer=setTimeout(stop,Math.max(1,Math.min(120000,deadline-Date.now())));
monitor=setInterval(()=>{try{if(fs.statSync(path.join(directory,'result.json')).size>1048576)stop();}catch{}},100);
const cleanup=code=>{process.stdin.unpipe(child.stdin);process.stdin.destroy();clearTimeout(timer);clearTimeout(force);clearInterval(monitor);try{for(const name of fs.readdirSync(directory))if(/^\d+\.jpg$/.test(name))fs.unlinkSync(path.join(directory,name));}catch{};process.exitCode=code;if(process.connected)process.disconnect();};
child.once('error',()=>cleanup(1));child.once('close',code=>cleanup(stopped?124:code??1));
`;
