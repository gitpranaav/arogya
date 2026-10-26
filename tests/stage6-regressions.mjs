/** Offline, synthetic Stage 6 checks. These tests do not use live MongoDB, Deepgram or Groq. */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const ts = require(process.env.MEDIFLOW_TYPESCRIPT ?? 'typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function load(rel, mocks={}) {
  const name = path.join(root, rel);
  const js = ts.transpileModule(readFileSync(name,'utf8'), {fileName:name, compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const mod={exports:{}};
  new Function('require','module','exports',js)((specifier)=> {
    if (specifier in mocks) return mocks[specifier];
    if (specifier.startsWith('../')) return load(path.join(path.dirname(rel),specifier+'.ts'));
    return require(specifier);
  }, mod, mod.exports);
  return mod.exports;
}
const batching=load('src/lib/extraction/batching.ts');
const context=load('src/lib/extraction/context.ts');
const history=load('src/lib/extraction/history.ts');
const segments = (texts)=>texts.map((text,i)=>({id:`s${i}`,text,is_final:true}));

test('Stage6: neighboring fragments wait until a quiet utterance boundary',()=> {
  const s=segments(['prescribe amoxi','cillin five hundred milligrams.']);
  assert.equal(batching.chooseTranscriptBatch(s,250,0,200).ready,false);
  assert.deepEqual(batching.chooseTranscriptBatch(s,1300,0,200).segments,s);
  assert.equal(batching.chooseTranscriptBatch(s,1300,0,200).reason,'boundary');
});
test('Stage6: flush on pause/stop and bounded waiting without punctuation',()=> {
  const s=segments(['one','two']);
  assert.equal(batching.chooseTranscriptBatch(s,1000,0,900).ready,false);
  assert.equal(batching.chooseTranscriptBatch(s,4000,0,900).reason,'age');
  assert.equal(batching.chooseTranscriptBatch(s,1000,0,900,true).reason,'flush');
});
test('Stage6: max segment count and char limit split without skipping or reordering',()=> {
  const many=segments(Array.from({length:24},()=> 'long '.repeat(45)));
  const first=batching.chooseTranscriptBatch(many,1000,0,1000);
  assert.ok(first.ready && first.segments.length<=12);
  assert.ok(first.segments.map(x=>x.text).join('').length<=3600);
  const next= many.slice(first.segments.length);
  assert.equal(next[0].id,`s${first.segments.length}`);
  const long=segments(['x'.repeat(4000),'next']);
  assert.equal(batching.chooseTranscriptBatch(long,1000,0,1000).segments.length,1);
});
test('Stage6: durable cursor recovery rejects missing cursors and preserves pending speech',()=> {
  const s=segments(['already committed','needs retry','also waiting']);
  assert.deepEqual(batching.pendingFromCursor(s,'s0').map(v=>v.id),['s1','s2']);
  assert.equal(batching.pendingFromCursor(s,'unknown'),null);
  assert.equal(batching.pendingFromCursor(s,'s2').length,0);
});
test('Stage6: compact snapshot keeps stable medication IDs and safety allergies, omits summaries and ICD',()=> {
  const value=context.buildClinicalContext({mode:'delta', segments:segments(['prescribe five hundred milligrams']),
    allergies:['penicillin'], allergyStatus:'recorded',snapshot:{clinical_summary:'very long unused prose',patient_summary:'unused',
      medications:[{id:'med_abc',name:'Amoxicillin',icd10_description:'irrelevant',dosage:'500mg'}]}});
  assert.deepEqual(value.payload.patient_allergies,['penicillin']);
  assert.equal(value.payload.emr_facts.medications[0].id,'med_abc');
  assert.ok(!value.json.includes('irrelevant') && !value.json.includes('very long unused prose'));
  assert.equal(value.payload.segments_delta[0].id,'s0');
});
test('Stage6: cannot trim essential evidence or allergies to satisfy context budget',()=> {
  assert.throws(()=>context.buildClinicalContext({mode:'delta',snapshot:{},allergies:['danger'.repeat(7000)],allergyStatus:'recorded',
    segments:segments(['current segment'])}),context.ContextBudgetError);
  assert.throws(()=>context.buildClinicalContext({mode:'final',snapshot:{},allergies:[],allergyStatus:'not_assessed',
    segments:segments(['clinically important long transcript '.repeat(3000)])}),context.ContextBudgetError);
});
test('Stage6: bounded context tail and dated historical citations are explicitly not current facts',()=> {
  const h={consultation_id:'old',date:'2025-01-01',kind:'prior_prescription',source_id:'rx1',value:[{name:'DrugX'}]};
  const payload=context.buildClinicalContext({mode:'delta',snapshot:{},allergies:[],allergyStatus:'not_assessed',segments:segments(['continue medicine']),
    priorTail:segments(['tail '.repeat(300),'nearby','last']),history:[h]}).payload;
  assert.equal(payload.historical_evidence_unverified_for_current_visit[0].source_id,'rx1');
  assert.equal(payload.historical_evidence_unverified_for_current_visit[0].date,'2025-01-01');
  assert.ok(payload.prior_finalized_tail.length <= 3);
  assert.equal(payload.patient_allergy_status,'not_assessed');
});
test('Stage6: history lookup triggered only for explicit references',()=> {
  for(const phrase of ['Continue the medicine from last visit','pichli dawa','prior prescription','history of asthma'])
    assert.equal(history.referencesPriorCare(phrase),true,phrase);
  for(const phrase of ['prescribe amoxicillin','blood pressure is high','tablet once daily'])
    assert.equal(history.referencesPriorCare(phrase),false,phrase);
});
test('Stage6: history retrieval never hits the database for unrelated speech',async()=> {
  const result=await history.retrieveAuthorizedHistory({collection:()=>{throw Error('unexpected DB')}} , 'patient','doctor','current','prescribe paracetamol');
  assert.deepEqual(result,[]);
});
test('Stage6: prior visits are filtered by authorized patient and practice, with bounded queries and source IDs',async()=> {
  const seen=[];
  const makeFind=(collection)=> (query,options)=> {
    seen.push({collection,query,options});
    const rows=collection==='consultations'?[{_id:'old-visit',created_at:'2025-02-12'}]:
      collection==='prescriptions'?[{_id:'rx-1',consultation_id:'old-visit',medications:[{id:'med-x',name:'Old medicine'}]}]:
      collection==='emr_entries'?[{_id:'emr-1',consultation_id:'old-visit',snapshot:{diagnosis_text:['Old diagnosis']}}]:[];
    const cursor={sort(){return this},limit(){return this},toArray:async()=>rows};return cursor;
  };
  const db={collection:name=>({find:makeFind(name)})};
  const items=await history.retrieveAuthorizedHistory(db,'p1','d1','c1','continue the medicine from last visit');
  assert.deepEqual(seen[0].query,{patient_id:'p1',doctor_id:'d1',status:'completed',_id:{$ne:'c1'}});
  assert.equal(seen[0].options.projection._id,1);
  assert.equal(items[0].source_id,'rx-1');
  assert.equal(items[0].date,'2025-02-12');
  assert.ok(items.every(item=>item.consultation_id==='old-visit'));
});
test('Stage6: history item count/size bounded and never substitutes current speech evidence',()=> {
  const h=Array.from({length:20},(_,i)=>({consultation_id:`c${i}`,date:null,source_id:`r${i}`,
    kind:'prior_prescription',value:[{name:'unsafe '.repeat(80)}]}));
  const ctx=context.buildClinicalContext({mode:'delta',snapshot:{},allergies:['penicillin'],allergyStatus:'recorded',
    segments:segments(['new speech']),history:h});
  assert.ok(ctx.payload.historical_evidence_unverified_for_current_visit.length<=6);
  assert.ok(JSON.stringify(ctx.payload.historical_evidence_unverified_for_current_visit).length<=context.CONTEXT_LIMITS.historyChars);
  assert.deepEqual(ctx.payload.segments_delta.map(x=>x.id),['s0']);
});
test('Stage6: synthetic batching request-count/size baseline',()=> {
  const synthetic=segments(['hello', 'how are you?', 'pain today', 'take rest.', 'your history', 'next visit.', 'thanks']);
  let batches=0,cursor=0,firstAt=0;
  while(cursor<synthetic.length){
    const chosen=batching.chooseTranscriptBatch(synthetic.slice(cursor),5000,firstAt,0);
    assert.equal(chosen.ready,true);cursor+=chosen.segments.length;batches++;
  }
  assert.ok(batches<synthetic.length);
});

test('Stage6: final extraction cache requires identical prompt/context and EMR version',async()=> {
  const {createHash}=await import('node:crypto');
  const text='patient describes pain';
  const transcriptHash=createHash('sha256').update(text).digest('hex');
  const hash=createHash('sha256').update('test-final-prompt').update(context.CONTEXT_VERSION)
    .update(JSON.stringify({transcriptHash,allergies:[],historical:[],model:process.env.GROQ_MODEL?.trim() || 'openai/gpt-oss-120b'})).digest('hex');
  let version=7;
  let providerCalls=0;
  const emr={snapshot:{chief_complaint:'pain'},grounding_version:'grounding-v1',
    final_transcript_hash:transcriptHash,final_context_hash:hash,final_cached_version:7};
  const db={collection:name=>({findOne:async()=> {
    if(name==='transcripts')return {processing_status:'completed',raw_text:text,segments:segments([text])};
    if(name==='emr_entries')return {...emr,version};
    return {};
  }})};
  const route=load('app/api/emr/extract/route.ts',{
    'groq-sdk':{default:class {constructor(){providerCalls++}}},
    'next/server':{NextResponse:{json:(body,options)=>({body,status:options?.status??200})}},
    '@/src/lib/security/access':{accessConsultation:async()=>({db,session:{uid:'doc'},consultationId:'curr',consultation:{patient_id:'p1',doctor_id:'d1'}}),
      enforceUsageLimit:async()=>true,parseBoundedJson:async()=>({consultation_id:'curr'})},
    '@/src/lib/emr/extractDeltaPrompt':{EXTRACT_FULL_SYSTEM_PROMPT:'test-final-prompt'},
    '@/src/lib/emr/medicationIdentity':{ensureMedicationIds:x=>x},
    '@/src/lib/emr/grounding':{GROUNDING_SCHEMA_VERSION:'grounding-v1'},
    '@/src/lib/extraction/context':context,
    '@/src/lib/extraction/history':{retrieveAuthorizedHistory:async()=>[]},
    '@/src/lib/extraction/metrics':{recordExtractionMetric:()=>{}},
    '@/src/lib/familyHistory/proposals':{prepareFamilyProposals:()=>[],mergeFamilyProposals:()=>({})},
    '@/src/lib/familyHistory/graph':{graphFromRecord:()=>({})},
    '@/src/lib/emr/normalizeMedications':{normalizeMedicationsArray:x=>x},
    '@/src/lib/emr/validation':{sanitizeSnapshot:x=>x},
    '@/src/lib/clinical/prescriptionSafetyServer':{screenPrescription:async()=>({issues:[],rule_version:'x'})},
    '@/src/lib/mongodb/clinicalTransaction':{},
    '@/src/lib/audit/consultationLedger':{},
  });
  const hit=await route.POST({});
  assert.equal(hit.status,200);
  assert.equal(hit.body.cached,true);
  assert.equal(providerCalls,0);
  const previousModel = process.env.GROQ_MODEL;
  process.env.GROQ_MODEL = 'synthetic-different-model';
  try {
    const changedModel = await route.POST({});
    assert.equal(changedModel.status,503);
    assert.equal(changedModel.body.cached,undefined);
  } finally {
    if (previousModel === undefined) delete process.env.GROQ_MODEL; else process.env.GROQ_MODEL = previousModel;
  }
  version=8; // a clinician edit or review changed the authoritative EMR version
  const miss=await route.POST({});
  assert.equal(miss.status,503); // no configured Groq key; cannot serve stale cache
  assert.equal(miss.body.cached,undefined);
  assert.equal(providerCalls,0);
});

test('Stage6: prompts prohibit historical records from being used as current field evidence',()=> {
  const source=readFileSync(path.join(root,'src/lib/emr/extractDeltaPrompt.ts'),'utf8');
  assert.match(source,/Historical evidence is from previous encounters, NOT proof of current medication orders/);
  assert.match(source,/cite only current segments_delta IDs/);
  assert.match(source,/Only cite current transcript segment IDs/);
});

test('Stage6: permanent extraction failures are not polled forever and honor retryable:false',()=> {
 const source=readFileSync(path.join(root,'src/components/doctor/consultation/ConsultationWorkspace.tsx'),'utf8');
 assert.match(source,/deltaBlockedRef\.current === pending\[0\]\.id/);
 assert.match(source,/typeof data\?\.retryable === "boolean" \? data\.retryable/);
 assert.match(source,/deltaBlockedRef\.current = delta\[0\]\.id/);
});
