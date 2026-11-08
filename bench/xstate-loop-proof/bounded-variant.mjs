import fs from 'node:fs'
import path from 'node:path'
import {spawn} from 'node:child_process'
const directory=path.dirname(new URL(import.meta.url).pathname)
const variant=process.argv[2]
const log=fs.openSync(path.join(directory,variant+'.log'),'w')
const started=performance.now()
const child=spawn(process.execPath,[path.join(directory,'run-variant.mjs'),variant],{stdio:['ignore',log,log],detached:true})
let bounded=false
const timer=setTimeout(()=>{bounded=true;try{process.kill(-child.pid,'SIGKILL')}catch{}},180000)
const result=await new Promise(resolve=>{child.once('error',error=>resolve({error:String(error)}));child.once('close',(code,signal)=>resolve({code,signal}))})
clearTimeout(timer);fs.closeSync(log)
const row={variant,...result,bounded,boundMs:180000,ms:performance.now()-started}
fs.writeFileSync(path.join(directory,variant+'-exit.json'),JSON.stringify(row,null,2));console.log(JSON.stringify(row))
process.exit(result.code??1)
