import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { written } from './literal-helper.ts'
const scriptDirectory=path.dirname(fileURLToPath(import.meta.url))
const evidence=path.resolve(process.argv[3] ?? scriptDirectory)
fs.mkdirSync(evidence,{recursive:true})
const root=fs.realpathSync(process.argv[2])
fs.writeFileSync(path.join(evidence,'literal-runner.config.mjs'), `import base from ${JSON.stringify(pathToFileURL(path.join(root,'vitest.config.js')).href)}\nexport default { ...base, test: { ...base.test, runner: ${JSON.stringify(path.join(scriptDirectory,'literal-runner.mjs'))} } }\n`)
const require=createRequire(root+'/package.json')
const bin=path.join(path.dirname(require.resolve('vitest/package.json')),'vitest.mjs')
const file=path.join(root,'src/parse/lexer.ts')
const source=fs.readFileSync(file,'utf8')
const hash=text=>crypto.createHash('sha256').update(text).digest('hex')
if(hash(source)!=='6e49bf24e73235192b8ef3a1bdcc86c17ce2bea0ab37bcbdb9480c4b6e2813a5')throw Error('source hash differs')
const entry={file:'src/parse/lexer.ts',start:[151,6],end:[151,29],mutator:'AssignmentOperator',replacement:'this.pos -= line.length'}
const changed=written(file,source,entry)
fs.writeFileSync(path.join(evidence,'lexer.literal-exact.ts'),changed)
const rows=[]
async function test(name,bail){
 const events=path.join(evidence,name+'.events.jsonl');fs.writeFileSync(events,'')
 const log=fs.openSync(path.join(evidence,name+'.log'),'w')
 const args=[bin,'run','tests/doc/comments.ts','--config='+path.join(evidence,'literal-runner.config.mjs'),'--reporter=json','--outputFile='+path.join(evidence,name+'.json'),'--maxWorkers=1',...(bail?['--bail=1']:[])]
 const began=performance.now();const child=spawn(process.execPath,args,{cwd:root,env:{...process.env,YAML119_ROOT:root,YAML119_EVENTS:events},stdio:['ignore',log,log],detached:true})
 let bounded=false
 const timer=setTimeout(()=>{bounded=true;try{process.kill(-child.pid,'SIGKILL')}catch{}},30000)
 const result=await new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})))
 clearTimeout(timer);fs.closeSync(log)
 const row={name,bail,boundMs:30000,bounded,...result,ms:performance.now()-began};rows.push(row);fs.writeFileSync(path.join(evidence,'literal-check-results.json'),JSON.stringify(rows,null,2));console.log(JSON.stringify(row))
}
try{
 await test('literal-original',false)
 fs.writeFileSync(file,changed)
 await test('literal-bail-captured',true)
 await test('literal-full-captured',false)
}finally{fs.writeFileSync(file,source);console.log(JSON.stringify({restored:hash(fs.readFileSync(file,'utf8'))===hash(source)}))}
