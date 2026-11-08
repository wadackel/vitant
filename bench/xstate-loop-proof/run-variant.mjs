import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const directory=path.dirname(new URL(import.meta.url).pathname)
const variant=process.argv[2]
if(!['start','corrected'].includes(variant))throw Error('variant required')
const root=fs.realpathSync(path.join(directory,'xstate/packages/core'))
process.chdir(root)
const require=createRequire(path.join(root,'package.json'))
const file=path.join(root,'src/stateUtils.ts')
const source=fs.readFileSync(file,'utf8')
const offset=(line,column)=>source.split('\n').slice(0,line-1).reduce((n,s)=>n+s.length+1,0)+column
process.env.XSTATE_DIAGNOSTIC_RANGE=[offset(823,61),offset(825,3)].join(':')
const {generate,defaultExclude}=await import(pathToFileURL(path.join(directory,'tool-'+variant+'/src/mutate/generate.ts')))
const options={root,include:['src/stateUtils.ts'],exclude:defaultExclude,lines:new Map([[file,new Set([823,824,825])]])}
const generated=generate(options).mutants
if(generated.length!==1 || generated[0].mutator!=='BlockStatement' || generated[0].replacement!=='{}' || generated[0].loc.start.line!==823 || generated[0].loc.start.column!==61 || generated[0].loc.end.line!==825 || generated[0].loc.end.column!==3)throw Error('Generated identity mismatch')
fs.writeFileSync(path.join(directory,variant+'-generated.json'),JSON.stringify({node:process.version,vitest:require('vitest/package.json').version,cwd:process.cwd(),mutants:generated},null,2))
if(process.argv[3]==='--prepare')process.exit(0)
const {run}=await import(pathToFileURL(path.join(directory,'tool-'+variant+'/src/run.ts')))
const result=await run({...options,filters:['test/history.test.ts'],projects:[],related:true,timeoutFactor:4,timeoutMs:3000,recycleHeapMb:2048,loopFactor:50,loopSlack:1000000,budgetMs:30000,cheapMs:20,maxRounds:200,incremental:false,clone:false,static:false,led:false,strict:false,confirm:Infinity,maxWorkers:1,log:message=>console.log(message)})
fs.writeFileSync(path.join(directory,variant+'.json'),JSON.stringify(result,null,2))
console.log(JSON.stringify({counts:result.counts,mutants:result.mutants,failedBaselines:result.failedBaselines,suiteErrors:result.suiteErrors,abandoned:result.abandonedFiles}))
process.exit(result.abandonedFiles.length?1:0)
