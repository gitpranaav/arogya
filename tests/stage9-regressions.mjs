/** Stage 9 synthetic-only evaluation and defect regression checks. */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url),ts=require(process.env.MEDIFLOW_TYPESCRIPT??'typescript');
function load(rel,cache=new Map()){
 const file=path.resolve(root,rel);if(cache.has(file))return cache.get(file).exports;
 if(file.endsWith('.json'))return JSON.parse(readFileSync(file,'utf8'));
 const js=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 const m={exports:{}};cache.set(file,m);
 new Function('require','module','exports',js)((id)=>id.startsWith('@/')?load(id.slice(2),cache):id.startsWith('.')?load(path.relative(root,path.resolve(path.dirname(file),id+(path.extname(id)?'':'.ts'))),cache):require(id),m,m.exports);return m.exports;
}
const safety=load('src/lib/clinical/allergySafety.ts');
test('Stage9: present progressive prescribing triggers a provisional direct-ingredient warning',()=>{
 const signals=safety.detectLiveAllergySignals(['Penicillin'],'I am starting amoxicillin 500 mg.');
 assert.ok(signals.some(s=>s.intent==='prescribing'&&s.medication==='Amoxicillin'));
});
test('Stage9: explicit negation and historical medication do not count as prescriptions',()=>{
 for(const text of ['Do not start amoxicillin', 'Last year I was taking amoxicillin', 'Avoid prescribing amoxicillin']){
  assert.equal(safety.detectLiveAllergySignals(['Penicillin'],text).some(s=>s.intent==='prescribing'),false,text);
 }
});
test('Stage9: synthetic evaluation produces explicit confusion counts and null live metrics',()=>{
 execFileSync(process.execPath,['scripts/eval-stage9.mjs'],{cwd:root,stdio:'pipe',env:process.env});
 const result=JSON.parse(readFileSync(path.join(root,'eval/results/stage9-offline.json'),'utf8'));
 assert.equal(result.current.transcript.total,20);
 assert.equal(result.current.medications.total,16);
 assert.equal(result.current.family.total,4);
 assert.equal(result.current.grounding.cases,4);
 assert.equal(result.provider.groq_calls,null);
 assert.equal(result.provider.transcription_wer,null);
 assert.ok(result.current.transcript.fn>=1,'Known coverage gaps must not be hidden');
});
test('Stage9: demo/test scripts reject nonlocal integration by design',()=>{
 const seed=readFileSync(path.join(root,'scripts/seed/demo-stage9.mjs'),'utf8');
 const api=readFileSync(path.join(root,'scripts/verify-stage9-api.mjs'),'utf8');
 assert.ok(seed.includes("u.hostname!=='127.0.0.1'"));
 assert.ok(seed.includes("u.port!=='27029'"));
 assert.ok(api.includes("!['localhost','127.0.0.1'].includes(u.hostname)"));
 assert.ok(seed.includes('DEMO_RECEPTIONIST_PASSWORD'));
});
