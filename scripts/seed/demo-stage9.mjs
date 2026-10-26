/** Seed ONLY fictional doctor accounts into the disposable local MongoDB demo.
 * Never uses Atlas or non-loopback MongoDB, never logs credentials or resets data.
 * Run after `npm run seed:core` with MONGODB_URI on 127.0.0.1:27029.
 */
import { MongoClient, ObjectId } from 'mongodb';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', quiet: true });
const uri=process.env.MONGODB_URI;
if(!uri)throw new Error('Set MONGODB_URI to disposable local replica set');
const u=new URL(uri);
if(u.protocol!=='mongodb:'||u.hostname!=='127.0.0.1'||u.port!=='27029'||u.username||u.password||
   u.searchParams.get('directConnection')!=='true'||u.searchParams.get('replicaSet')!=='rs0')
  throw new Error('Demo seeding is restricted to mongodb://127.0.0.1:27029/?directConnection=true&replicaSet=rs0');
const doctorPassword=process.env.DEMO_DOCTOR_PASSWORD;
const receptionistPassword=process.env.DEMO_RECEPTIONIST_PASSWORD;
if(!doctorPassword||!receptionistPassword||doctorPassword.length<12||receptionistPassword.length<12||doctorPassword===receptionistPassword)
  throw new Error('Set distinct DEMO_DOCTOR_PASSWORD and DEMO_RECEPTIONIST_PASSWORD (12+ characters)');
const client=new MongoClient(uri,{serverSelectionTimeoutMS:4000});
try {
  await client.connect();
  const hello=await client.db('admin').command({hello:1});
  if(hello.setName!=='rs0')throw new Error('Local MongoDB must use replica set rs0');
  const db=client.db('cliniq');
  const doctorHash=await bcrypt.hash(doctorPassword,12);
  const receptionistHash=await bcrypt.hash(receptionistPassword,12);
  for(const email of ['demo-doctor-a@mediflow.invalid','demo-doctor-b@mediflow.invalid']){
    const existing=await db.collection('users').findOne({email});
    await db.collection('users').updateOne({email},{$set:{name:`SYNTHETIC ${email.includes('-a@')?'Doctor A':'Doctor B'}`,
      role:'doctor',email,specialization:'Demo only',specialty_code:'general',
      password_hash:doctorHash,receptionist_password_hash:receptionistHash,
      receptionist_actor_id:existing?.receptionist_actor_id??new ObjectId(),
      session_version:Number(existing?.session_version??0)+1,
      receptionist_session_version:Number(existing?.receptionist_session_version??0)+1,
      updated_at:new Date().toISOString()},$setOnInsert:{created_at:new Date().toISOString()}},{upsert:true});
  }
  console.log('PASS: two synthetic practices seeded in local disposable cliniq DB; passwords omitted');
}finally{await client.close();}
