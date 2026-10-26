/** Opt-in live provider smoke test: short synthetic audio and fictional clinical text only.
 * Requires local demo, test provider keys, macOS say/afconvert. Makes billable provider calls.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local', quiet: true });
const base = process.env.MEDIFLOW_DEMO_URL ?? 'http://127.0.0.1:3000';
const url = new URL(base), mongo = new URL(process.env.MONGODB_URI ?? '');
assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname));
assert.ok(mongo.protocol === 'mongodb:' && mongo.hostname === '127.0.0.1' && mongo.port === '27029');
assert.ok(process.env.DEMO_DOCTOR_PASSWORD && process.env.DEEPGRAM_API_KEY && process.env.GROQ_API_KEY, 'Configure test keys and demo credentials');
const run = promisify(execFile);
const report = { executed_at: new Date().toISOString(), scope: 'live Deepgram/Groq; synthetic audio/text, no clinical accuracy claim', checks: [] };
let cookie;
const request = async (path, body, raw = false) => {
  const response = await fetch(base + path, { method: 'POST', headers: {
    ...(cookie ? { Cookie: cookie } : {}), ...(raw ? {} : { 'Content-Type': 'application/json' }) },
    body: raw ? body : JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const data = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${data.error ?? 'request failed'}`);
  return { response, data };
};
const check = async (name, fn) => {
  try { const details = await fn(); report.checks.push({ name, status: 'passed', ...details }); console.log(`PASS: ${name}`); }
  catch (error) { report.checks.push({ name, status: 'failed', error: error.message }); console.log(`FAIL: ${name}: ${error.message}`); }
};
const directory = await mkdtemp(join(tmpdir(), 'mediflow-provider-'));
try {
  const login = await request('/api/auth/login', { email: 'demo-doctor-a@mediflow.invalid', password: process.env.DEMO_DOCTOR_PASSWORD });
  cookie = login.response.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
  const patient = (await request('/api/patients/create', { name: 'SYNTHETIC Live Provider Test', phone: '+1555' + String(Date.now()).slice(-7) })).data;
  const visit = (await request('/api/consultations/create', { patient_id: patient.id, type: 'General' })).data;
  const cid = visit.consultation_id;
  report.synthetic_consultation_id = cid;
  const spoken = 'Patient reports headache. Diagnosis is headache. The plan is rest.';
  const aiff = join(directory, 'speech.aiff'), wav = join(directory, 'speech.wav');
  await run('say', ['-r', '140', '-o', aiff, spoken], { timeout: 30000 });
  await run('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav], { timeout: 30000 });
  const audio = await readFile(wav);
  await check('live prerecorded medical transcription', async () => {
    const form = new FormData(); form.set('audio', new File([audio], 'synthetic.wav', { type: 'audio/wav' }));
    const { data } = await request(`/api/stt/transcribe?consultation_id=${cid}`, form, true);
    assert.ok(data.transcript?.trim(), 'Expected a nonempty live transcript');
    return { words: data.words?.length ?? 0, confidence: data.confidence, contains_headache: /headache/i.test(data.transcript) };
  });
  await check('temporary grant and live WebSocket transcription', async () => {
    const { data: grant, response } = await request('/api/stt/token', { consultation_id: cid });
    assert.equal(grant.mode, 'bearer'); assert.ok(grant.token && grant.expires_in > 0);
    assert.match(response.headers.get('cache-control'), /no-store/);
    // Match the application's Nova-3 Hindi streaming configuration. WAV is sent as raw PCM.
    let pcm;
    for (let offset = 12; offset + 8 <= audio.length;) {
      const length = audio.readUInt32LE(offset + 4);
      if (audio.toString('ascii', offset, offset + 4) === 'data') { pcm = audio.subarray(offset + 8, offset + 8 + length); break; }
      offset += 8 + length + length % 2;
    }
    assert.ok(pcm?.length);
    const result = await new Promise((resolve, reject) => {
      const socket = new WebSocket('wss://api.deepgram.com/v1/listen?model=nova-3&language=hi&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&endpointing=300', ['bearer', grant.token]);
      let finalWords = 0, interval;
      const timer = setTimeout(() => { socket.close(); reject(new Error('WebSocket transcription timeout')); }, 30000);
      socket.addEventListener('open', () => {
        let offset = 0;
        interval = setInterval(() => {
          if (socket.readyState !== WebSocket.OPEN) { clearInterval(interval); return; }
          if (offset < pcm.length) { socket.send(pcm.subarray(offset, offset + 3200)); offset += 3200; }
          else { clearInterval(interval); socket.send(JSON.stringify({ type: 'CloseStream' })); }
        }, 100);
      });
      socket.addEventListener('message', event => {
        try { const data = JSON.parse(String(event.data));
          if (data.type === 'Results' && data.is_final) finalWords += data.channel?.alternatives?.[0]?.words?.length ?? 0;
        } catch { /* Non-result messages are not transcription evidence. */ }
      });
      socket.addEventListener('error', () => { clearTimeout(timer); clearInterval(interval); reject(new Error('WebSocket connection failed')); });
      socket.addEventListener('close', event => {
        clearTimeout(timer); clearInterval(interval);
        if (event.code !== 1000 || !finalWords) reject(new Error(`WebSocket closed ${event.code}; finalized word count ${finalWords}`));
        else resolve({ finalized_words: finalWords, grant_ttl_seconds: grant.expires_in });
      });
    });
    return result;
  });
  // Use fixed text to isolate Groq/schema behavior from speech-recognition accuracy.
  const segment = { id: 'live-synthetic-1', text: spoken, is_final: true, sequence: 1 };
  await request('/api/transcripts/upsert', { consultation_id: cid, segments: [segment], processing_status: 'completed' });
  await check('live Groq incremental extraction', async () => {
    const { data } = await request('/api/emr/extract-delta', { consultation_id: cid, segments_delta: [segment] });
    assert.ok(data.snapshot && Number.isInteger(data.version));
    return { version: data.version, snapshot_fields: Object.keys(data.snapshot).length };
  });
  await check('live Groq final extraction', async () => {
    const { data } = await request('/api/emr/extract', { consultation_id: cid });
    assert.ok(data.snapshot && Number.isInteger(data.version));
    return { version: data.version, grounding_findings: data.grounding_findings?.length ?? 0 };
  });
} catch (error) { report.setup_failure = error.message; }
finally {
  report.status = !report.setup_failure && report.checks.length === 4 && report.checks.every(x => x.status === 'passed') ? 'passed' : 'failed';
  await mkdir('eval/results', { recursive: true });
  await writeFile('eval/results/provider-verification.json', JSON.stringify(report, null, 2) + '\n');
  await rm(directory, { recursive: true, force: true });
  console.log(`${report.status.toUpperCase()}: ${report.checks.filter(x => x.status === 'passed').length}/4 live provider checks`);
  if (report.setup_failure) console.error(report.setup_failure);
  if (report.status !== 'passed') process.exitCode = 1;
}
