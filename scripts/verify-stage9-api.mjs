/** Browser-independent HTTP smoke tests: synthetic only, writes to disposable LOCAL instance.
 * Requires npm run demo:seed and `npm run dev` with local MONGODB_URI.
 * No provider calls, no final clinical sign-off; never points to production hosts.
 */
import { randomInt } from 'node:crypto';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', quiet: true });
const base=process.env.MEDIFLOW_DEMO_URL??'http://127.0.0.1:3000';
const u=new URL(base);
if(!['localhost','127.0.0.1'].includes(u.hostname)||u.protocol!=='http:')throw Error('Refusing non-local URL');
const pw=process.env.DEMO_DOCTOR_PASSWORD,rpw=process.env.DEMO_RECEPTIONIST_PASSWORD;
if(!pw||!rpw)throw Error('Set DEMO_DOCTOR_PASSWORD and DEMO_RECEPTIONIST_PASSWORD');
let passed=0;
async function call(method,route,body,cookie){
  const res=await fetch(new URL(route,base),{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(8000)});
  const json=await res.json().catch(()=>null);
  return {status:res.status,data:json,cookie:res.headers.get('set-cookie')?.split(';')[0]};
}
async function check(label,res,expected){assert.ok(expected.includes(res.status),`${label}: unexpected ${res.status}`);passed++;console.log(`PASS ${passed}: ${label} [${res.status}]`);return res;}
const phone='+1555'+String(randomInt(1000000,9999999));
const intake={name:'SYNTHETIC Stage9 QA Patient',phone,gender:'Other',allergies:['Penicillin']};
const unauth=await call('POST','/api/patients/create',intake);
await check('unauthenticated intake rejected',unauth,[401]);
const docA=await check('doctor A login',await call('POST','/api/auth/login',{email:'demo-doctor-a@mediflow.invalid',password:pw}),[200]);
const docB=await check('doctor B login',await call('POST','/api/auth/login',{email:'demo-doctor-b@mediflow.invalid',password:pw}),[200]);
const reception=await check('receptionist login',await call('POST','/api/auth/receptionist/login',{doctor_email:'demo-doctor-a@mediflow.invalid',password:rpw}),[200]);
assert.ok(docA.cookie&&docB.cookie&&reception.cookie,'Expected signed cookies');
const created=await check('synthetic patient intake',await call('POST','/api/patients/create',intake,reception.cookie),[200]);
assert.match(created.data?.id??'',/^[0-9a-f]{24}$/);
await check('cross-practice same-phone registration denied',await call('POST','/api/patients/create',intake,docB.cookie),[409]);
const consultation=await check('receptionist starts consultation',await call('POST','/api/consultations/create',{patient_id:created.data.id,type:'General',chief_complaint:'SYNTHETIC fever'},reception.cookie),[200]);
const id=consultation.data?.consultation_id;assert.match(id??'',/^[0-9a-f]{24}$/);
await check('other practice cannot read consultation',await call('GET',`/api/consultations/context/${id}`,undefined,docB.cookie),[403,404]);
await check('receptionist cannot sign off',await call('POST',`/api/emr/review/${id}`,{expected_version:0},reception.cookie),[403]);
await check('doctor cannot complete unfinished consultation',await call('PATCH',`/api/consultations/${id}`,{status:'completed',reviewed_version:0},docA.cookie),[409]);
const seg={id:'synthetic-segment-1',text:'SYNTHETIC patient reports fever, recorded penicillin allergy',is_final:true,sequence:1};
await check('transcript append',await call('POST','/api/transcripts/upsert',{consultation_id:id,segments:[seg],processing_status:'in_progress'},docA.cookie),[200]);
await check('transcript idempotent retry',await call('POST','/api/transcripts/upsert',{consultation_id:id,segments:[seg],processing_status:'in_progress'},docA.cookie),[200]);
await check('altered evidence ID rejected',await call('POST','/api/transcripts/upsert',{consultation_id:id,segments:[{...seg,text:'SYNTHETIC contradictory text'}],processing_status:'in_progress'},docA.cookie),[409]);
const review=await check('doctor sees review blockers',await call('GET',`/api/emr/review/${id}`,undefined,docA.cookie),[200]);
assert.ok(Array.isArray(review.data?.blockers)&&review.data.blockers.length>0,'Doctor review must be blocked while final extraction is incomplete');
console.log(`PASS: ${passed} local API smoke assertions. Live STT/Groq and completed prescription intentionally not exercised.`);
