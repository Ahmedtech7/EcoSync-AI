import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import Groq from 'groq-sdk';
import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
const app=express();app.disable('x-powered-by');app.use(express.json({limit:'16kb'}));
const origins=(process.env.FRONTEND_ORIGIN||'http://localhost:5173').split(',').map(x=>x.trim());app.use(cors({origin:origins}));
const DATA=path.join(path.dirname(fileURLToPath(import.meta.url)),'..','data.json');
const day=new Date();day.setHours(9,0,0,0);const stamp=h=>new Date(day.getTime()+h*3600000).toISOString();
const seed={rooms:[
{id:1,name:'A-101',building:'College Hall',capacity:46,load_kw:9.5,floor:'Level 1'},
{id:2,name:'B-204',building:'Engineering Center',capacity:68,load_kw:13,floor:'Level 2'},
{id:3,name:'C-310',building:'Fine Arts Library',capacity:35,load_kw:7.5,floor:'Level 3'},
{id:4,name:'D-115',building:'Quadrangle',capacity:52,load_kw:11,floor:'Level 1'}],
lectures:[{id:1,title:'Applied Mathematics',room_id:1,start_at:stamp(0),end_at:stamp(2),status:'scheduled'},
{id:2,title:'Computer Science',room_id:2,start_at:stamp(2),end_at:stamp(4),status:'scheduled'},
{id:3,title:'Physics Laboratory',room_id:3,start_at:stamp(1),end_at:stamp(3),status:'scheduled'},
{id:4,title:'Data Structures',room_id:4,start_at:stamp(4),end_at:stamp(6),status:'scheduled'}],events:[{id:1,message:'Campus workspace initialized',created_at:new Date().toISOString()}]};
const pool=process.env.DATABASE_URL
 ? new pg.Pool({
     connectionString:process.env.DATABASE_URL,
     max:3,
     ssl:process.env.DATABASE_URL.includes('localhost')?false:{rejectUnauthorized:false}
   })
 : null;

const sessionStore = new AsyncLocalStorage();

app.use((req,res,next)=>{
  let sid;
  const match=(req.headers.cookie||'').match(/(?:^|;\\s*)ecosync_sid=([a-f0-9-]{36})(?:;|$)/i);
  if(match && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(match[1])){
    sid=match[1];
  } else {
    sid=randomUUID();
    res.cookie('ecosync_sid',sid,{
      httpOnly:true,
      secure:process.env.VERCEL==='1'||process.env.NODE_ENV==='production',
      sameSite:'lax',
      maxAge:7*24*60*60*1000,
      path:'/'
    });
  }
  sessionStore.run(sid,next);
});

let local=fs.existsSync(DATA)?JSON.parse(fs.readFileSync(DATA,'utf8')):structuredClone(seed);

function sessionId(){
  const id=sessionStore.getStore();
  if(!id)throw Error('Missing visitor session');
  return id;
}

async function ensureSession(client){
  await client.query('CREATE TABLE IF NOT EXISTS ecosync_sessions (id TEXT PRIMARY KEY, payload JSONB NOT NULL)');
  await client.query(
    'INSERT INTO ecosync_sessions(id,payload) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING',
    [sessionId(),JSON.stringify(seed)]
  );
}

async function getState(){
  if(!pool){
    if(process.env.VERCEL)throw Error('DATABASE_URL required on Vercel');
    return local;
  }
  await ensureSession(pool);
  const {rows}=await pool.query(
    'SELECT payload FROM ecosync_sessions WHERE id=$1',
    [sessionId()]
  );
  return rows[0].payload;
}

async function mutate(fn){
  if(!pool){
    if(process.env.VERCEL)throw Error('DATABASE_URL required on Vercel');
    const value=fn(local);
    fs.writeFileSync(DATA,JSON.stringify(local,null,2));
    return value;
  }
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await ensureSession(client);
    const {rows}=await client.query(
      'SELECT payload FROM ecosync_sessions WHERE id=$1 FOR UPDATE',
      [sessionId()]
    );
    const state=rows[0].payload;
    const result=fn(state);
    await client.query(
      'UPDATE ecosync_sessions SET payload=$2::jsonb WHERE id=$1',
      [sessionId(),JSON.stringify(state)]
    );
    await client.query('COMMIT');
    return result;
  }catch(e){
    await client.query('ROLLBACK');
    throw e;
  }finally{
    client.release();
  }
}
const safe=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
function metric(s){const energy=l=>{const room=s.rooms.find(r=>r.id===l.room_id);return room?room.load_kw*Math.max(0,(Date.parse(l.end_at)-Date.parse(l.start_at))/3600000):0;};const baseline=s.lectures.reduce((t,l)=>t+energy(l),0),projected=s.lectures.filter(l=>l.status==='scheduled').reduce((t,l)=>t+energy(l),0);return {rooms:s.rooms.length,scheduled_lectures:s.lectures.filter(l=>l.status==='scheduled').length,cancelled_lectures:s.lectures.filter(l=>l.status==='cancelled').length,baseline_kwh:+baseline.toFixed(1),projected_kwh:+projected.toFixed(1),saved_kwh:+(baseline-projected).toFixed(1),co2_avoided_kg:+((baseline-projected)*0.5).toFixed(1)};}
function log(s,message){s.events.unshift({id:Date.now(),message,created_at:new Date().toISOString()});s.events=s.events.slice(0,100);}
app.get('/api/health',(_q,r)=>r.json({status:'ok',product:'EcoSync'}));
for(const [route,key] of [['rooms','rooms'],['lectures','lectures'],['activity','events']])app.get('/api/'+route,safe(async(_q,r)=>r.json((await getState())[key])));
app.get('/api/dashboard',safe(async(_q,r)=>r.json(metric(await getState()))));
app.get('/api/analytics',safe(async(_q,r)=>{const s=await getState();r.json(s.rooms.map(room=>{const ls=s.lectures.filter(l=>l.room_id===room.id);const kwh=l=>room.load_kw*(Date.parse(l.end_at)-Date.parse(l.start_at))/3600000;return {room:room.name,building:room.building,baseline:+ls.reduce((a,l)=>a+kwh(l),0).toFixed(2),projected:+ls.filter(l=>l.status==='scheduled').reduce((a,l)=>a+kwh(l),0).toFixed(2)};}));}));
const lectureSchema=z.object({title:z.string().trim().min(2).max(100),room_id:z.number().int().positive(),start_at:z.string().datetime(),end_at:z.string().datetime()});
app.post('/api/lectures',safe(async(q,r)=>{const parsed=lectureSchema.safeParse(q.body);if(!parsed.success)return r.status(422).json({error:'Invalid lecture details'});const d=parsed.data;if(Date.parse(d.end_at)<=Date.parse(d.start_at))return r.status(422).json({error:'End time must follow start time'});const result=await mutate(s=>{if(!s.rooms.some(x=>x.id===d.room_id))return {error:'Room not found',code:404};if(s.lectures.some(l=>l.room_id===d.room_id&&l.status==='scheduled'&&Date.parse(l.start_at)<Date.parse(d.end_at)&&Date.parse(l.end_at)>Date.parse(d.start_at)))return {error:'Room already booked at this time',code:409};const l={...d,id:Math.max(0,...s.lectures.map(x=>x.id))+1,status:'scheduled'};s.lectures.push(l);log(s,`Scheduled ${l.title}`);return {lecture:l};});if(result.error)return r.status(result.code).json({error:result.error});r.status(201).json(result.lecture);}));
app.post('/api/lectures/:id/cancel',safe(async(q,r)=>{const result=await mutate(s=>{const l=s.lectures.find(x=>x.id===Number(q.params.id));if(!l)return {error:'Lecture not found',code:404};if(l.status!=='scheduled')return {error:'Lecture already cancelled',code:409};l.status='cancelled';log(s,`Cancelled ${l.title} · energy demand recalculated`);return {lecture:l,metrics:metric(s)};});if(result.error)return r.status(result.code).json({error:result.error});r.json(result);}));
// Free deterministic assistant: always available, even without a paid API key.
// It suggests actions; only explicit user confirmation can mutate a lecture.
function freeAssistant(message,s){
  const m=message.toLocaleLowerCase().normalize('NFKC').replace(/[\u064b-\u065f]/g,'').replace(/ـ/g,'').replace(/[أإآٱ]/g,'ا').replace(/ى/g,'ي');
  const wantsCancel=/(الغ|الغي|الغاء|احذف|شيل|كنسل|cancel|remove|delete)/i.test(m);
  const wantsEnergy=/(طاق|كهرب|توفير|استهلاك|انبعاث|energy|saving|consumption|carbon|co2)/i.test(m);
  const wantsFind=/(وين|ابحث|جدول|محاضر|محاضرة|lecture|find|search|schedule)/i.test(m);
  const arabic=/[\u0600-\u06ff]/.test(m);
  const aliases={1:['رياضيات','الرياضيات','math','mathematics','applied mathematics'],2:['حاسب','الحاسب','computer','علوم الحاسب','computer science'],3:['فيزياء','الفيزياء','physics','physics laboratory'],4:['بيانات','هياكل','data structures']};
  const matched=s.lectures.filter(l=>{
    const names=[l.title.toLowerCase(),...(aliases[l.id]||[])];
    return names.some(n=>m.includes(n.toLowerCase()));
  });
  if(wantsCancel){
    if(matched.length!==1)return {intent:'other',lecture_id:null,reply:arabic?'حدد اسم المحاضرة بدقة. المحاضرات المتاحة: '+s.lectures.filter(l=>l.status==='scheduled').map(l=>l.title).join('، '):'Which lecture should I cancel? Available: '+s.lectures.filter(l=>l.status==='scheduled').map(l=>l.title).join(', ')};
    const lecture=matched[0];
    if(lecture.status!=='scheduled')return {intent:'other',lecture_id:null,reply:arabic?'هذه المحاضرة ملغاة مسبقًا.':'That lecture is already cancelled.'};
    const room=s.rooms.find(r=>r.id===lecture.room_id);
    const hours=(Date.parse(lecture.end_at)-Date.parse(lecture.start_at))/3600000;
    const estimate=(room?.load_kw||0)*hours;
    return {intent:'cancel',lecture_id:lecture.id,reply:arabic?`لقيت محاضرة ${lecture.title} في القاعة ${room?.name}. الإلغاء قد يقلل الطلب المحسوب بمقدار ${estimate.toFixed(1)} kWh. هل تؤكد الإلغاء؟`:`Found ${lecture.title} in ${room?.name}. Cancelling could reduce calculated demand by ${estimate.toFixed(1)} kWh. Review and confirm to proceed.`};
  }
  if(wantsEnergy){const t=metric(s);return {intent:'summary',lecture_id:null,reply:arabic?`الطلب الحالي المحسوب ${t.projected_kwh} kWh، والتوفير التقديري ${t.saved_kwh} kWh، والانبعاثات المتجنبة تقديريًا ${t.co2_avoided_kg} kg. هذه حسابات مبنية على الجدول وليست قراءات عدادات.`:`Current calculated demand is ${t.projected_kwh} kWh; estimated savings ${t.saved_kwh} kWh, and estimated avoided emissions ${t.co2_avoided_kg} kg. These are schedule estimates, not meter measurements.`};}
  if(wantsFind){const found=matched.length?matched:s.lectures.filter(l=>l.status==='scheduled');return {intent:'search',lecture_id:null,reply:found.map(l=>`${l.title} · ${s.rooms.find(r=>r.id===l.room_id)?.name||'Unknown room'} · ${new Date(l.start_at).toLocaleString(arabic?'ar-SA':'en-US')}${l.status==='cancelled'?' (cancelled)':''}`).join('\n')};}
  return {intent:'other',lecture_id:null,reply:arabic?'أقدر أبحث عن محاضرة، ألغيها بعد تأكيدك، أو أعرض ملخص الطاقة. جرّب: ألغِ محاضرة الرياضيات.':'I can find lectures, prepare a cancellation for your confirmation, or summarize energy use. Try: Cancel the mathematics lecture.'};
}
const groq=process.env.GROQ_API_KEY?new Groq({apiKey:process.env.GROQ_API_KEY.trim()}):null;
const aiSchema=z.object({message:z.string().trim().min(2).max(400)});
const aiHits=new Map();

async function aiQuota(){
  if(!pool)return true;
  const day=new Date().toISOString().slice(0,10);
  const sid=sessionId();
  await pool.query(`CREATE TABLE IF NOT EXISTS ecosync_ai_quota (
    id TEXT PRIMARY KEY,
    used INTEGER NOT NULL DEFAULT 0
  )`);
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    for(const [id,limit] of [
      ['global:'+day,60],
      ['visitor:'+day+':'+sid,10]
    ]){
      const result=await client.query(
        `INSERT INTO ecosync_ai_quota(id,used) VALUES($1,1)
         ON CONFLICT(id) DO UPDATE SET used=ecosync_ai_quota.used+1
         WHERE ecosync_ai_quota.used<$2 RETURNING used`,
        [id,limit]
      );
      if(!result.rowCount){
        await client.query('ROLLBACK');
        return false;
      }
    }
    await client.query('COMMIT');
    return true;
  } catch(e){
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

app.post('/api/ai',safe(async(q,r)=>{
 const parsed=aiSchema.safeParse(q.body);
 if(!parsed.success)return r.status(422).json({error:'Enter a message (2–400 characters)'});
 const ip=q.ip||'unknown',now=Date.now(),hits=(aiHits.get(ip)||[]).filter(t=>now-t<60000);
 if(hits.length>=15)return r.status(429).json({error:'Please wait a minute before sending more commands'});
 hits.push(now);aiHits.set(ip,hits);
 if(!await aiQuota())return r.status(429).json({error:'AI demo daily limit reached. Please try again tomorrow.'});
 const s=await getState();
 const deterministic=freeAssistant(parsed.data.message,s);
 const fallback=()=>r.json({...deterministic,mode:'local'});
 // Scheduling actions must be grounded in real database records, not in an
 // LLM's optional JSON formatting. A unique match wins before calling Groq.
 // Let Groq interpret all requests when configured.
 if(!groq)return fallback();
 try{
  const response=await groq.chat.completions.create({model:process.env.GROQ_MODEL||'llama-3.3-70b-versatile',temperature:0,messages:[{role:'system',content:`You are EcoSync campus operations copilot. Reply in the user's language. Never execute actions; propose only. Output strictly JSON {"reply":"string","intent":"cancel"|"summary"|"search"|"other","lecture_id":integer|null}. If intent is cancel, only match an unambiguous scheduled lecture ID. UTC now: ${new Date().toISOString()}. Lectures: ${JSON.stringify(s.lectures)} Rooms: ${JSON.stringify(s.rooms)} Energy: ${JSON.stringify(metric(s))}`},{role:'user',content:parsed.data.message}]});
  const raw=response.choices[0]?.message?.content||'';
  const data=JSON.parse(raw.replace(/^```json\s*|\s*```$/g,''));
  const intent=['cancel','summary','search','other'].includes(data.intent)?data.intent:'other';
  const id=Number.isInteger(data.lecture_id)&&s.lectures.some(l=>l.id===data.lecture_id&&l.status==='scheduled')?data.lecture_id:null;
  return r.json({reply:String(data.reply||'').slice(0,1000),intent,lecture_id:intent==='cancel'?id:null,mode:'groq'});
 }catch(err){
  // Invalid or exhausted keys must never break the public portfolio experience.
  console.warn('Groq unavailable; local interpreter used:',err.status||err.code||err.message);
  return fallback();
 }
}));
app.use((err,_req,res,_next)=>{console.error(err);res.status(err.status||500).json({error:err.status?err.message:'Request failed. Check backend logs.'});});
export default app;
if (!process.env.VERCEL) {
  const port = Number(process.env.PORT) || 8000;
  app.listen(port, '0.0.0.0', () => console.log('EcoSync API ready on ' + port));
}
