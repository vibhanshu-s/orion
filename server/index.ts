import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { db, emit, getTask, iso, updateTask } from './db.js';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { env } from './gemini.js';
import { addMemory, answerClarification, cancel, queueRun, searchMemory } from './engine.js';
import { decisionHealth } from './decision.js';
import { assertPathContained } from './safety.js';
const app=Fastify({logger:true,bodyLimit:12*1024*1024});
const host = process.env.HOST ?? '127.0.0.1';
if (host === '0.0.0.0' && !process.env.DEMO_PASSWORD) throw new Error('Set DEMO_PASSWORD in Replit Secrets before exposing the demo.');
app.addHook('onRequest', async (req, reply) => {
 if (!process.env.DEMO_PASSWORD || req.url === '/api/health') return;
 const expected = Buffer.from(`${process.env.DEMO_USER ?? 'demo'}:${process.env.DEMO_PASSWORD}`).toString('base64');
 if (req.headers.authorization !== `Basic ${expected}`) return reply.header('www-authenticate','Basic realm="ORION demo"').code(401).send({error:'Demo sign-in required.'});
});
await app.register(cors,{origin:false});
await app.register(multipart,{limits:{fileSize:10*1024*1024,files:1}});
const idSchema=/^[0-9a-f-]{36}$/i;
const taskView=(row:any)=>({...row,state:JSON.parse(row.state_json??'{}'),output:row.output_json?JSON.parse(row.output_json):null,state_json:undefined,output_json:undefined});
app.get('/api/health',async()=>({ok:true,model:env.GEMINI_MODEL,configured:Boolean(env.GEMINI_API_KEY),decision:await decisionHealth(),activeTasks:(db.prepare("SELECT COUNT(*) n FROM tasks WHERE status IN ('queued','analyzing','planning','running','evaluating')").get() as any).n}));
app.get('/api/tasks',async()=>({tasks:(db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 100').all() as any[]).map(taskView)}));
app.post('/api/tasks',async(req:any,reply)=>{const body=req.body as any;if(typeof body?.goal!=='string'||body.goal.trim().length<3||body.goal.length>6000)return reply.code(400).send({error:'Enter a goal between 3 and 6000 characters.'});const active=(db.prepare("SELECT COUNT(*) n FROM tasks WHERE status IN ('queued','analyzing','planning','running','evaluating')").get() as any).n;if(active>=1)return reply.code(409).send({error:'One task is already running. Wait for it to finish or cancel it first.'});const id=randomUUID(),at=iso(),state={completed_steps:[],remaining_steps:[],knowledge:[],errors:[],tool_actions:0};db.prepare('INSERT INTO tasks(id,goal,status,state_json,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,body.goal.trim(),'queued',JSON.stringify(state),at,at);emit(id,'status',{status:'queued'});queueRun(id);return reply.code(201).send(taskView(getTask(id)));});
app.get('/api/tasks/:id',async(req:any,reply)=>{if(!idSchema.test(req.params.id))return reply.code(400).send({error:'Invalid task id.'});const task=getTask(req.params.id);return task?taskView(task):reply.code(404).send({error:'Task not found.'});});
app.get('/api/tasks/:id/events',async(req:any,reply)=>{
 const id=req.params.id;if(!idSchema.test(id)||!getTask(id))return reply.code(404).send({error:'Task not found.'});reply.hijack();const res=reply.raw;
 res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache, no-transform','connection':'keep-alive','x-accel-buffering':'no'});res.write('retry: 2000\n');
 let cursor=Math.max(0,Number(req.headers['last-event-id']??req.query?.after??0)||0);let closed=false;
 const pump=()=>{if(closed)return;const rows=db.prepare('SELECT id,type,data_json,created_at FROM events WHERE task_id=? AND id>? ORDER BY id LIMIT 100').all(id,cursor) as any[];for(const row of rows){cursor=row.id;res.write(`id: ${row.id}\nevent: ${row.type}\ndata: ${JSON.stringify({...(JSON.parse(row.data_json)??{}),at:row.created_at})}\n\n`);}};
 pump();const timer=setInterval(()=>{pump();if(!closed)res.write(': keepalive\n\n');},1000);res.on('close',()=>{closed=true;clearInterval(timer);});
});
app.post('/api/tasks/:id/answer',async(req:any,reply)=>{const id=req.params.id,answer=(req.body as any)?.answer;if(!idSchema.test(id)||typeof answer!=='string'||answer.trim().length<1||answer.length>4000)return reply.code(400).send({error:'Provide a clarification answer up to 4000 characters.'});if(!answerClarification(id,answer.trim()))return reply.code(409).send({error:'This task is not waiting for clarification or is already resuming.'});return {ok:true};});
app.post('/api/tasks/:id/cancel',async(req:any,reply)=>{const id=req.params.id;if(!idSchema.test(id)||!getTask(id))return reply.code(404).send({error:'Task not found.'});if(!['queued','analyzing','planning','running','evaluating','waiting_for_clarification'].includes(getTask(id).status))return reply.code(409).send({error:'Task is already finished.'});cancel(id);return {ok:true};});
app.post('/api/tasks/:id/retry',async(req:any,reply)=>{const id=req.params.id,row=getTask(id);if(!idSchema.test(id)||!row)return reply.code(404).send({error:'Task not found.'});if(!['failed','interrupted','partial'].includes(row.status))return reply.code(409).send({error:'Only failed, interrupted, or partial tasks can be retried.'});const active=(db.prepare("SELECT COUNT(*) n FROM tasks WHERE status IN ('queued','analyzing','planning','running','evaluating')").get() as any).n;if(active)return reply.code(409).send({error:'Wait for the active task to finish.'});const state={completed_steps:[],remaining_steps:[],knowledge:[],errors:[],tool_actions:0};updateTask(id,'queued',state,null);emit(id,'retry',{message:'Task restarted explicitly. Prior actions may run again.'});emit(id,'status',{status:'queued'});queueRun(id);return {ok:true};});
app.get('/api/memory',async()=>({memories:(db.prepare('SELECT id,context,source,confidence_score,created_at FROM memories ORDER BY created_at DESC LIMIT 200').all() as any[]).map(r=>({...r,confidence_score:null}))}));
app.post('/api/memory/search',async(req:any,reply)=>{const query=(req.body as any)?.query;if(typeof query!=='string'||!query.trim())return reply.code(400).send({error:'Enter a search query.'});try{return {results:await searchMemory(query.trim(),10),scoreMeaning:'Retrieval relevance, not factual certainty.'};}catch(e:any){return reply.code(503).send({error:e.message});}});
app.delete('/api/memory/:id',async(req:any,reply)=>{const result=db.prepare('DELETE FROM memories WHERE id=?').run(String(req.params.id));return result.changes?{ok:true}:reply.code(404).send({error:'Memory not found.'});});
app.post('/api/memory/import',async(req:any,reply)=>{
 const file=await req.file();
 if(!file)return reply.code(400).send({error:'Choose a TXT, Markdown, CSV, or text PDF file.'});
 const name=path.basename(file.filename).replace(/[^\w. -]/g,'_');
 const ext=path.extname(name).toLowerCase();
 if(!['.txt','.md','.markdown','.csv','.pdf'].includes(ext))return reply.code(415).send({error:'Supported imports: TXT, Markdown, CSV, and text based PDF.'});
 const buffer=await file.toBuffer();let content='';
 if(ext==='.pdf'){
  try{const pdf:any=await import('pdf-parse');if(pdf.PDFParse){const parser=new pdf.PDFParse({data:buffer});const parsed=await parser.getText();content=parsed.text??'';await parser.destroy?.();}else if(pdf.default)content=await pdf.default(buffer);}
  catch{return reply.code(422).send({error:'Could not extract PDF text. Scanned PDFs are not supported.'});}
 }else content=buffer.toString('utf8');
 content=content.replace(/\0/g,'').trim();
 if(content.length<30)return reply.code(422).send({error:'The file contains too little readable text. Scanned PDFs are not supported.'});
 const importDir=path.resolve(process.cwd(),'data','imports');await fs.mkdir(importDir,{recursive:true});
 const documentId=randomUUID();const sourcePath=path.resolve(importDir,`${documentId}${ext}`);
 if(!sourcePath.startsWith(importDir+path.sep))return reply.code(400).send({error:'Import path rejected.'});
 const safeSource=await assertPathContained(path.resolve(process.cwd(),'data'),sourcePath);
 await fs.writeFile(safeSource,buffer);db.prepare('INSERT INTO documents(id,name,path,created_at) VALUES(?,?,?,?)').run(documentId,name,safeSource,iso());
 const safeContent=content.slice(0,100000);
 const splitter=new RecursiveCharacterTextSplitter({chunkSize:850,chunkOverlap:120,separators:['\n\n','\n',' ','']});
 const pieces=await splitter.splitText(safeContent);let saved=0;
 for(let i=0;i<pieces.length;i++){await addMemory(pieces[i],`${name} · ${i+1}/${pieces.length}`);saved++;}
 return {ok:true,name,chunks:saved,characters:safeContent.length};
});
app.get('/api/tasks/:id/artifacts',async(req:any,reply)=>{const id=req.params.id;if(!idSchema.test(id))return reply.code(400).send({error:'Invalid task id.'});return {artifacts:db.prepare('SELECT id,name,created_at FROM artifacts WHERE task_id=? ORDER BY created_at DESC').all(id)};});
app.get('/api/artifacts/:id',async(req:any,reply)=>{const row=db.prepare('SELECT a.*,t.id task_exists FROM artifacts a JOIN tasks t ON t.id=a.task_id WHERE a.id=?').get(req.params.id) as any;if(!row)return reply.code(404).send({error:'Artifact not found.'});const dataRoot=path.resolve(process.cwd(),'data','tasks');const taskRoot=path.resolve(dataRoot,row.task_id);const dest=path.resolve(row.path);if(!dest.startsWith(taskRoot+path.sep))return reply.code(403).send({error:'Artifact path rejected.'});let safePath:string;try{safePath=await assertPathContained(dataRoot,dest);}catch{return reply.code(403).send({error:'Artifact path rejected.'});}return reply.header('content-disposition',`attachment; filename="${path.basename(row.name)}"`).type('text/markdown; charset=utf-8').send(await fs.readFile(safePath));});
if(process.env.NODE_ENV==='production'){await app.register(staticPlugin,{root:path.resolve(process.cwd(),'dist')});}
try{const server=await app.listen({port:env.PORT,host});app.log.info(`ORION server listening at ${server}`);}catch(error:any){if(error?.code==='EADDRINUSE'){app.log.error(`ORION backend port ${env.PORT} is already in use. Another ORION server is probably running; keep that instance open or stop it before starting a second copy.`);process.exitCode=1;await app.close();}else throw error;}
