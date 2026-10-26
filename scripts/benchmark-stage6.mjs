/** Reproducible synthetic sizing and scheduling comparison, not a Groq benchmark. */
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),ts=require(process.env.MEDIFLOW_TYPESCRIPT??'typescript');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function load(file){const m={exports:{}};const js=ts.transpileModule(readFileSync(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
new Function('module','exports',js)(m,m.exports);return m.exports;}
const {chooseTranscriptBatch}=load('src/lib/extraction/batching.ts');
const {buildClinicalContext}=load('src/lib/extraction/context.ts');
const utteranceFragments=['we are prescribing','paracetamol five hundred milligrams','twice daily for three days.'];
const events=Array.from({length:8},(_,i)=>utteranceFragments.map((text,j)=>({at:i*2500+j*150,segment:{id:`s${i*3+j}`,text,is_final:true}}))).flat();
let pending=[],firstAt=0,lastAt=0,readyAt=0,pointer=0,newCalls=0,batchSizes=[];
for(let now=0;now<=events.at(-1).at+2000;now+=100){
 while(pointer<events.length && events[pointer].at<=now){const ev=events[pointer++];if(!pending.length)firstAt=now;pending.push(ev.segment);lastAt=now;}
 if(!pending.length)continue;
 const d=chooseTranscriptBatch(pending,now,firstAt,lastAt);
 if(d.ready){newCalls++;batchSizes.push(d.segments.length);pending=pending.slice(d.segments.length);firstAt=now;lastAt=now;readyAt=now;}
}
if(pending.length){newCalls++;batchSizes.push(pending.length);}
const snapshot={chief_complaint:'pain',medications:[{id:'med_abc',name:'paracetamol',dosage:'500mg',icd10_description:'unneeded',icd10_code:'ABCD'}],
clinical_summary:'A long, repeated, derived clinical summary. '.repeat(100),patient_summary:'A long, repeated, derived patient summary. '.repeat(100),
needs_confirmation:['patient summary']};
const sample=events.slice(0,3).map(e=>e.segment);
const baseline=JSON.stringify({segments_delta:sample,emr_snapshot:snapshot,patient_allergies:['penicillin']});
const compact=buildClinicalContext({mode:'delta',snapshot,allergies:['penicillin'],allergyStatus:'recorded',segments:sample});
const result={kind:'synthetic_only',segments:events.length,baselineCalls:events.length,batchedCalls:newCalls,batchSizes,
requestReductionPct:Number((100*(1-newCalls/events.length)).toFixed(1)),baselineUserPromptChars:baseline.length,stage6UserPromptChars:compact.chars,
userPromptReductionPct:Number((100*(1-compact.chars/baseline.length)).toFixed(1)),
modelTokens:'not_measured',providerLatency:'not_measured',providerCost:'not_measured'};
console.log(JSON.stringify(result,null,2));
