/** Synthetic Stage 9 evaluation using historic baseline fixture labels.
 * No network or real patient data. Runs only local deterministic algorithms.
 * Baseline 2026-10-07 metrics from eval/BASELINE.md are historical measurements,
 * not rerun here; comparison uses exactly the historical 16-case fixture.
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
const ts=require(process.env.MEDIFLOW_TYPESCRIPT??'typescript');
function load(rel,cache=new Map()){
  const abs=path.resolve(root,rel);if(cache.has(abs))return cache.get(abs).exports;
  if(abs.endsWith('.json'))return JSON.parse(readFileSync(abs,'utf8'));
  const code=ts.transpileModule(readFileSync(abs,'utf8'),{fileName:abs,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true,resolveJsonModule:true}}).outputText;
  const m={exports:{}};cache.set(abs,m);
  new Function('require','module','exports',code)((id)=>id.startsWith('@/')?load(id.slice(2),cache):id.startsWith('.')?load(path.relative(root,path.resolve(path.dirname(abs),id+(path.extname(id)?'':'.ts'))),cache):require(id),m,m.exports);
  return m.exports;
}
const {detectLiveAllergySignals,evaluatePrescriptionSafety}=load('src/lib/clinical/allergySafety.ts');
const {prepareFamilyProposals}=load('src/lib/familyHistory/proposals.ts');
const {evaluateClaim}=load('src/lib/emr/grounding.ts');
const {chooseTranscriptBatch}=load('src/lib/extraction/batching.ts');
const {buildClinicalContext}=load('src/lib/extraction/context.ts');
const fixtureText=readFileSync(path.join(root,'eval/fixtures/baseline.json'),'utf8');
const fixtures=JSON.parse(fixtureText);
function counts(rows){const tp=rows.filter(x=>x.expected&&x.actual).length,fp=rows.filter(x=>!x.expected&&x.actual).length,fn=rows.filter(x=>x.expected&&!x.actual).length,tn=rows.filter(x=>!x.expected&&!x.actual).length;return {total:rows.length,tp,fp,fn,tn,precision:tp+fp?tp/(tp+fp):null,recall:tp+fn?tp/(tp+fn):null};}
function percentile(items,p){if(!items.length)return null;const a=[...items].sort((x,y)=>x-y);return Number(a[Math.max(0,Math.ceil(a.length*p)-1)].toFixed(3));}
const transcriptChecks=[],medChecks=[],detectorTime=[],failures=[];
for(const c of fixtures.cases){
  const finalized=[];let interim='';
  for(const event of c.events){
    if(event.final){finalized.push(event.text);interim='';}else interim=event.text;
    const start=performance.now();
    const signals=detectLiveAllergySignals(c.allergies,finalized.join(' '),interim);
    detectorTime.push(performance.now()-start);
    const actual=signals.some(s=>s.intent==='prescribing');
    transcriptChecks.push({id:c.id,expected:event.expected_alert,actual});
    if(actual!==event.expected_alert)failures.push({path:'transcript',case:c.id,expected:event.expected_alert,actual});
  }
  const begin=performance.now();
  const issues=evaluatePrescriptionSafety(c.allergies,c.medications);
  detectorTime.push(performance.now()-begin);
  const actual=issues.some(i=>i.kind==='ingredient_conflict'||i.kind==='explicit_rule');
  medChecks.push({id:c.id,expected:c.expected_medication_alert,actual});
  if(actual!==c.expected_medication_alert)failures.push({path:'medication',case:c.id,expected:c.expected_medication_alert,actual});
}
// These assertions are purpose-built synthetic examples; NOT clinical gold-standard samples.
const groundingCases=[
  {statement:'fever',text:'Patient reports fever and chills',expected:'lexical_support'},
  {statement:'asthma',text:'Patient denies asthma',expected:'contradicted'},
  {statement:'diabetes',text:'Patient has hypertension',expected:'unverified'},
  {statement:'500 mg',text:'Take paracetamol 250 mg',expected:'unverified'},
];
const groundingChecks=groundingCases.map((c,i)=>({id:`ground-${i}`,expected:c.expected,actual:evaluateClaim(c.statement,[{id:'s1',text:c.text,is_final:true}])}));
const familyCases=[
  {text:'My mother has diabetes',relation:'mother',condition:'diabetes',expected:true},
  {text:'My father does not have asthma',relation:'father',condition:'asthma',expected:false},
  {text:'My maternal grandmother has asthma',relation:'grandmother',lineage:'maternal',condition:'asthma',expected:true},
  {text:'My grandmother has asthma',relation:'grandmother',lineage:'maternal',condition:'asthma',expected:false},
];
const familyChecks=familyCases.map((c,i)=>({id:`family-${i}`,expected:c.expected,actual:prepareFamilyProposals([{relation:c.relation,lineage:c.lineage,condition:c.condition,evidence_segment_ids:['s1']}],[{id:'s1',text:c.text,is_final:true}]).length>0}));
const segments=Array.from({length:24},(_,i)=>({id:`seg-${i}`,text:i%3===2?'twice daily for three days.':i%3===1?'paracetamol five hundred milligrams':'we are prescribing',is_final:true}));
let pending=[],first=0,last=0,calls=0,at=0;
for(let i=0;i<segments.length;i++){at=Math.floor(i/3)*2500+(i%3)*150; pending.push(segments[i]); if(pending.length===1)first=at;last=at;
  const nextArrival=i+1<segments.length?Math.floor((i+1)/3)*2500+((i+1)%3)*150:at+1500;
  let decision=chooseTranscriptBatch(pending,Math.min(nextArrival-1,at+1100),first,last);
  if(decision.ready){calls++;pending=pending.slice(decision.segments.length);if(pending.length)first=at;}
}
while(pending.length){const d=chooseTranscriptBatch(pending,at+4000,first,last,true);calls++;pending=pending.slice(d.segments.length);}
const snapshot={chief_complaint:'pain',medications:[{id:'med_111',name:'Paracetamol',dosage:'500 mg',frequency:'once daily',duration:'3 days'}],clinical_summary:'derived '.repeat(600),patient_summary:'derived '.repeat(600)};
const baselineChars=JSON.stringify({segments_delta:segments.slice(0,3),emr_snapshot:snapshot,patient_allergies:['penicillin']}).length;
const context=buildClinicalContext({mode:'delta',snapshot,allergies:['penicillin'],allergyStatus:'recorded',segments:segments.slice(0,3)});
const report={schema_version:1,kind:'offline_synthetic_only',fixture_sha256:createHash('sha256').update(fixtureText).digest('hex'),baseline_historical:{date:'2026-10-07',transcript:{precision:0.75,recall:0.60},medications:{precision:1,recall:5/7},description:'Recorded in original baseline branch; not re-run against its old implementation'},
  current:{transcript:counts(transcriptChecks),medications:counts(medChecks),detector_local_p50_ms:percentile(detectorTime,.5),detector_local_p95_ms:percentile(detectorTime,.95),grounding:{cases:groundingChecks.length,passed:groundingChecks.filter(x=>x.expected===x.actual).length},family:{...counts(familyChecks)},failures},
  batching:{synthetic_finalized_segments:24,unbatched_logical_calls:24,stage6_scheduled_calls:calls,request_reduction_pct:Number((100*(1-calls/24)).toFixed(1)),baseline_example_request_chars:baselineChars,compact_example_request_chars:context.chars,prompt_char_reduction_pct:Number((100*(1-context.chars/baselineChars)).toFixed(1))},
  provider:{transcription_wer:null,groq_calls:null,input_tokens:null,output_tokens:null,estimated_cost_usd:null,provider_p50_ms:null,provider_p95_ms:null,audio_to_alert_p95_ms:null,recovery_time_ms:null},
  notes:['Development fixture labels, not clinician-reviewed held-out data.','Transcript positive means prescribing-intent warning; generic mentions do not count.','Local processing timings use Node, not audio/WebSocket/browser time.','Character/4 token estimates are not provider tokens.','No live provider, browser, MongoDB or end-to-end workflow executed.']};
const output=path.join(root,'eval/results/stage9-offline.json');mkdirSync(path.dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({file:'eval/results/stage9-offline.json',current:report.current,batchedCalls:calls,promptChars:context.chars},null,2));
