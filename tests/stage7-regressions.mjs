/** Offline synthetic Stage 7 tests; no MongoDB, Groq or patient data. */
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
  const full = path.join(root,rel);
  const result = ts.transpileModule(readFileSync(full,'utf8'), {fileName:full,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},reportDiagnostics:true});
  assert.equal(result.diagnostics.filter(d=>d.category===ts.DiagnosticCategory.Error).length,0);
  const mod={exports:{}};
  new Function('require','module','exports',result.outputText)((name)=>{
    if(name in mocks)return mocks[name];
    if(name.startsWith('./'))return load(path.join(path.dirname(rel),name+'.ts'));
    return require(name);
  },mod,mod.exports);
  return mod.exports;
}
const graph=load('src/lib/familyHistory/graph.ts');
const proposal=load('src/lib/familyHistory/proposals.ts',{'./graph':graph});
const start=()=>graph.blankGraph();
const add=(g,r='mother',l='unknown',name='')=>graph.applyFamilyAction(g,{action:'add_relative',relative_to:'patient',relation:r,lineage:l,label:name});
const speech=(text,id='s1')=>[{id,text,is_final:true}];

test('Stage7: create relative with stable ID and edit without reallocating',()=>{
  const one=add(start());const id=one.relatives[0].id;
  const two=graph.applyFamilyAction(one,{action:'edit_relative',id,label:'Mother A'});
  assert.equal(id,two.relatives[0].id);assert.equal(two.relatives[0].label,'Mother A');assert.equal(two.version,2);
  assert.equal(two.relatives[0].origin,'clinician_correction');
});
test('Stage7: duplicate mother / named sibling rejected, multiple distinct siblings allowed',()=>{
  const a=add(start());assert.throws(()=>add(a),/Duplicate/);
  const b=add(a,'sibling','unknown','Sibling A');const c=add(b,'sibling','unknown','Sibling B');
  assert.equal(c.relatives.length,3);
  assert.throws(()=>add(c,'sibling','unknown','Sibling A'),/Duplicate/);
  assert.throws(()=>add(c,'sibling'),/label/);
});
test('Stage7: maternal/paternal grandparents and ancestry chain',()=>{
  const a=add(start(),'mother');const m=a.relatives[0].id;
  const b=graph.applyFamilyAction(a,{action:'add_relative',relative_to:m,relation:'mother',lineage:'maternal',label:'Maternal grandmother'});
  const c=add(b,'grandfather','paternal');assert.equal(c.relatives.length,3);
  assert.throws(()=>add(c,'grandmother'),/lineage/);
  assert.equal(graph.traverseFamily(c,'patient',2).relatives.length,3);
});
test('Stage7: relationship self-links, invalid target and cycles rejected',()=>{
  const a=add(start());const b=graph.applyFamilyAction(a,{action:'add_relative',relative_to:a.relatives[0].id,relation:'mother'});
  const m=a.relatives[0].id, g=b.relatives[1].id;
  assert.throws(()=>graph.applyFamilyAction(b,{action:'edit_relative',id:m,relative_to:g}),/cycle/);
  assert.throws(()=>graph.applyFamilyAction(b,{action:'edit_relative',id:m,relative_to:'rel_invalid'}),/Invalid family relationship/);
  assert.throws(()=>graph.applyFamilyAction(b,{action:'edit_relative',id:m,relative_to:m}),/Invalid family relationship/);
});
test('Stage7: capped BFS traversal excludes deeper descendants and rejected nodes',()=>{
  let a=add(start());a=graph.applyFamilyAction(a,{action:'add_relative',relative_to:a.relatives[0].id,relation:'mother'});
  a=graph.applyFamilyAction(a,{action:'add_relative',relative_to:a.relatives[1].id,relation:'mother'});
  assert.equal(graph.traverseFamily(a,'patient',1).relatives.length,1);
  assert.equal(graph.traverseFamily(a,'patient',2).relatives.length,2);
  assert.equal(graph.traverseFamily(a,'patient',3).relatives.length,3);
  assert.throws(()=>graph.traverseFamily(a,'patient',7),/depth/);
});
test('Stage7: condition edits, duplicate prevention, remove cascading, safe child removal',()=>{
  let a=add(start());const id=a.relatives[0].id;
  a=graph.applyFamilyAction(a,{action:'add_condition',relative_id:id,condition:'Diabetes',evidence_source:'patient_reported'});
  assert.equal(a.assertions[0].origin,'patient_reported');const cid=a.assertions[0].id;
  assert.throws(()=>graph.applyFamilyAction(a,{action:'add_condition',relative_id:id,condition:'diabetes'}),/Duplicate/);
  a=graph.applyFamilyAction(a,{action:'edit_condition',id:cid,condition:'Type 2 diabetes'});
  assert.equal(a.assertions[0].id,cid);assert.equal(a.assertions[0].origin,'clinician_correction');
  a=graph.applyFamilyAction(a,{action:'add_relative',relative_to:id,relation:'father'});
  assert.throws(()=>graph.applyFamilyAction(a,{action:'remove_relative',id}),/dependent/);
  a=graph.applyFamilyAction(a,{action:'remove_relative',id:a.relatives[1].id});
  a=graph.applyFamilyAction(a,{action:'remove_relative',id});assert.equal(a.assertions.length,0);
});
test('Stage7: transcript grounding accepts positive explicit family fact',()=>{
  const p=proposal.prepareFamilyProposals([{relation:'mother',condition:'diabetes',evidence_segment_ids:['s1'],confidence:'high'}],speech('My mother has diabetes'));
  assert.equal(p.length,1);const merged=proposal.mergeFamilyProposals(null,p,'consult-1');
  assert.equal(merged.relatives[0].status,'proposed');assert.equal(merged.assertions[0].status,'proposed');
  assert.deepEqual(merged.assertions[0].evidence_segment_ids,['s1']);
  assert.equal(merged.assertions[0].consultation_id,'consult-1');
});
test('Stage7: invalid evidence IDs, unsupported condition and unrelated speech rejected',()=>{
  const base={relation:'father',condition:'asthma',evidence_segment_ids:['s1']};
  for (const changes of [{evidence_segment_ids:['fabricated']},{condition:'hypertension'},{relation:'mother'}])
    assert.deepEqual(proposal.prepareFamilyProposals([{...base,...changes}],speech('My father has asthma')),[]);
});
test('Stage7: negation, uncertainty and contradiction are not promoted to a family proposal',()=>{
  const p={relation:'mother',condition:'diabetes',evidence_segment_ids:['s1']};
  for (const text of ['My mother does not have diabetes','Maybe my mother has diabetes',
    'My mother has diabetes, but no, mother does not have diabetes'])
    assert.deepEqual(proposal.prepareFamilyProposals([p],speech(text)),[],text);
});
test('Stage7: no invented grandparent lineage; explicit maternal lineage accepted',()=>{
  const p={relation:'grandmother',lineage:'maternal',condition:'asthma',evidence_segment_ids:['s1']};
  assert.equal(proposal.prepareFamilyProposals([p],speech('My grandmother has asthma')).length,0);
  assert.equal(proposal.prepareFamilyProposals([p],speech('My maternal grandmother has asthma')).length,1);
});
test('Stage7: duplicate AI proposals do not overwrite clinician-confirmed information',()=>{
  const p=proposal.prepareFamilyProposals([{relation:'mother',condition:'diabetes',evidence_segment_ids:['s1']}],speech('My mother has diabetes'));
  let a=proposal.mergeFamilyProposals(null,p,'c1');const id=a.relatives[0].id, conditionId=a.assertions[0].id;
  a=graph.applyFamilyAction(a,{action:'review_relative',id,decision:'confirmed'});
  a=graph.applyFamilyAction(a,{action:'review_condition',id:conditionId,decision:'confirmed'});
  const before=a.version;
  a=proposal.mergeFamilyProposals(a,p,'c1');assert.equal(a.version,before);
  assert.equal(a.relatives[0].status,'confirmed');assert.equal(a.assertions[0].status,'confirmed');
});
test('Stage7: rejected AI proposal cannot be silently restored',()=>{
  const p=proposal.prepareFamilyProposals([{relation:'father',condition:'asthma',evidence_segment_ids:['s1']}],speech('My father has asthma'));
  let a=proposal.mergeFamilyProposals(null,p,'c1');
  a=graph.applyFamilyAction(a,{action:'review_relative',id:a.relatives[0].id,decision:'rejected'});
  const before=a.version;
  a=proposal.mergeFamilyProposals(a,p,'c1');assert.equal(a.version,before);assert.equal(a.relatives.length,1);
});
test('Stage7: cannot confirm an AI condition on an unconfirmed relative',()=>{
  const p=proposal.prepareFamilyProposals([{relation:'mother',condition:'diabetes',evidence_segment_ids:['s1']}],speech('My mother has diabetes'));
  let a=proposal.mergeFamilyProposals(null,p,'c1');
  assert.throws(()=>graph.applyFamilyAction(a,{action:'review_condition',id:a.assertions[0].id,decision:'confirmed'}),/Confirm relative/);
  a=graph.applyFamilyAction(a,{action:'review_relative',id:a.relatives[0].id,decision:'confirmed'});
  a=graph.applyFamilyAction(a,{action:'review_condition',id:a.assertions[0].id,decision:'confirmed'});
  assert.equal(a.assertions[0].status,'confirmed');
});
test('Stage7: versioned graph does not mutate input and legacy free-text is untouched',()=>{
  const previous={core:{family_history:'Grandfather: hypertension'}};
  const a=graph.graphFromRecord(null);const b=add(a);
  assert.equal(a.version,0);assert.deepEqual(a.relatives,[]);
  assert.equal(previous.core.family_history,'Grandfather: hypertension');
  assert.equal(b.version,1);
});
test('Stage7: routes enforce doctor-only scoped reads and clinical-version CAS for writes',()=>{
  const source=readFileSync(path.join(root,'app/api/patients/[id]/family-graph/route.ts'),'utf8');
  for(const fragment of ['session.role !== "doctor"','patient_doctors','doctor_id: doctorId','expected_version','clinicalTransaction(',
    'activeConsultationId: consultationId','logConsultationAudit(','version: before.version','patient_id: patientId','createIndex({ patient_id: 1 }, { unique: true })'])
    assert.ok(source.includes(fragment),fragment);
});
test('Stage7: Groq delta adds proposals within the existing clinical transaction and audit',()=>{
  const source=readFileSync(path.join(root,'app/api/emr/extract-delta/route.ts'),'utf8');
  assert.ok(source.includes('prepareFamilyProposals(parsed.family_history_proposals'));
  assert.ok(source.includes('eventType: "family_history_proposal"'));
  assert.ok(source.includes('session: mongoSession'));
  assert.ok(source.includes('version: beforeFamily.version'));
});

test('Stage7: separate sibling utterances never collapse into a guessed single relative',()=>{
  const items=[{relation:'sibling',condition:'asthma',evidence_segment_ids:['s1']},
    {relation:'sibling',condition:'diabetes',evidence_segment_ids:['s2']}];
  const spoken=[{id:'s1',text:'My brother has asthma',is_final:true},{id:'s2',text:'My sister has diabetes',is_final:true}];
  const proposed=proposal.prepareFamilyProposals(items,spoken);
  const result=proposal.mergeFamilyProposals(null,proposed,'c1');
  assert.equal(result.relatives.length,2);assert.equal(result.assertions.length,2);
  assert.notEqual(result.assertions[0].relative_id,result.assertions[1].relative_id);
});
test('Stage7: final extraction proposals share the same transactional controls',()=>{
  const source=readFileSync(path.join(root,'app/api/emr/extract/route.ts'),'utf8');
  for(const snippet of ['prepareFamilyProposals(data.family_history_proposals','eventType: "family_history_proposal"',
    'session: mongoSession','version: beforeFamily.version'])assert.ok(source.includes(snippet),snippet);
});

test('Stage7: mocked API enforces practice isolation, active visits, CAS and audit rollback',async()=>{
  const patientId='aaaaaaaaaaaaaaaaaaaaaaaa', doctorId='bbbbbbbbbbbbbbbbbbbbbbbb', consultId='cccccccccccccccccccccccc';
  class Oid {constructor(v){this.v=v}toString(){return this.v}static isValid(x){return /^[0-9a-f]{24}$/i.test(x)}}
  let role='doctor', authorized=true, active=true, auditFailure=false, snapshot=null;
  const same=(a,b)=>String(a)===String(b);
  const collection=name=>({
    findOne:async query=>{
      if(name==='patient_doctors')return authorized&&same(query.patient_id,patientId)&&same(query.doctor_id,doctorId)?{_id:'linked'}:null;
      if(name==='consultations')return active&&same(query._id,consultId)&&same(query.patient_id,patientId)&&same(query.doctor_id,doctorId)?{status:'active'}:null;
      if(name==='patient_family_graphs')return snapshot;
      return null;
    },
    createIndex:async()=>{},
    updateOne:async(filter,update,opts)=>{
      if(name!=='patient_family_graphs')throw Error('Unexpected update collection');
      if(snapshot && filter.version!==snapshot.version)return {matchedCount:0,upsertedCount:0};
      snapshot={_id:'graph',patient_id:patientId,...snapshot,...update.$set};
      return {matchedCount:1,upsertedCount:opts?.upsert?1:0};
    }
  });
  const db={collection};
  const route=load('app/api/patients/[id]/family-graph/route.ts',{
    'mongodb':{ObjectId:Oid},
    'next/server':{NextResponse:{json:(body,option)=>({status:option?.status??200,body})}},
    '@/src/lib/auth/session':{getServerSession:async()=>role==='none'?null:{role,uid:doctorId,actor_id:'actor'}},
    '@/src/lib/mongodb/client':{getDb:async()=>db},
    '@/src/lib/security/access':{validId:x=>Oid.isValid(x),parseBoundedJson:async req=>req.payload},
    '@/src/lib/mongodb/clinicalTransaction':{clinicalTransaction:async(_db,fn)=>{
      const backup=structuredClone(snapshot);
      try{return await fn({id:'synthetic-session'});}catch(e){snapshot=backup;throw e;}
    },isClinicalConflict:e=>e.message==='version_conflict'},
    '@/src/lib/audit/consultationLedger':{logConsultationAudit:async()=>{if(auditFailure)throw Error('synthetic audit failure')}},
    '@/src/lib/familyHistory/graph':graph,
  });
  const params={params:Promise.resolve({id:patientId})};
  const get=()=>route.GET(new Request('http://localhost/api/family'),params);
  const send=(version)=>route.PATCH({payload:{consultation_id:consultId,expected_version:version,
    change:{action:'add_relative',relative_to:'patient',relation:'mother',lineage:'unknown'}}},params);
  role='none';assert.equal((await get()).status,401);
  role='receptionist';assert.equal((await get()).status,403);
  role='doctor';authorized=false;assert.equal((await get()).status,404);
  authorized=true;active=false;assert.equal((await send(0)).status,403);
  active=true;let res=await send(0);assert.equal(res.status,200);assert.equal(res.body.graph.version,1);
  assert.equal((await send(0)).status,409);assert.equal(snapshot.version,1);
  auditFailure=true;res=await route.PATCH({payload:{consultation_id:consultId,expected_version:1,
    change:{action:'add_relative',relative_to:'patient',relation:'father'}}},params);
  assert.equal(res.status,503);assert.equal(snapshot.version,1);assert.equal(snapshot.relatives.length,1);
});

test('Stage7: malicious review status/confidence/origin are not persisted',()=>{
  const a=add(start());const id=a.relatives[0].id;
  for(const payload of [
    {action:'add_condition',relative_id:id,condition:'asthma',confidence:'certainly'},
    {action:'add_condition',relative_id:id,condition:'asthma',evidence_source:'system_override'},
    {action:'review_relative',id,decision:'approved_automatically'}])
    assert.throws(()=>graph.applyFamilyAction(a,payload),/Invalid|Only proposals/);
});
