import { z } from 'zod';
import { scheduleProvider } from './providerQueue.js';
const envSchema=z.object({GEMINI_API_KEY:z.string().optional(),GEMINI_MODEL:z.string().default('gemini-3.5-flash-lite'),GEMINI_EMBEDDING_MODEL:z.string().default('gemini-embedding-001'),PORT:z.coerce.number().default(4317)});
export const env=envSchema.parse(process.env);
const base='https://generativelanguage.googleapis.com/v1beta/models/';
export async function gemini(contents:unknown,opts:{schema?:unknown;tool?:'google_search'|'code_execution';system?:string}={}){
 return scheduleProvider(() => generate(contents, opts));
}
async function generate(contents:unknown,opts:{schema?:unknown;tool?:'google_search'|'code_execution';system?:string}={}){
 if(!env.GEMINI_API_KEY)throw new Error('Gemini is not configured. Add GEMINI_API_KEY to orion/.env and restart ORION.');
 const body:any={contents:Array.isArray(contents)?contents:[{role:'user',parts:[{text:String(contents)}]}]};if(opts.system)body.system_instruction={parts:[{text:opts.system}]};if(opts.schema)body.generationConfig={responseMimeType:'application/json'};if(opts.tool)body.tools=[opts.tool==='google_search'?{google_search:{}}:{code_execution:{}}];
 const response=await fetch(`${base}${encodeURIComponent(env.GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(90_000)});const payload:any=await response.json().catch(()=>({}));if(!response.ok)throw new Error(`Gemini API ${response.status}: ${payload?.error?.message??'request failed'}`);return payload;
}
export function textFrom(payload:any){return (payload.candidates?.[0]?.content?.parts??[]).filter((p:any)=>p.text).map((p:any)=>p.text).join('\n');}
export async function embed(input:string,query=false){return scheduleProvider(() => embedNow(input,query));}
async function embedNow(input:string,query=false){if(!env.GEMINI_API_KEY)throw new Error('Gemini is not configured. Add GEMINI_API_KEY to orion/.env and restart ORION.');const r=await fetch(`${base}${env.GEMINI_EMBEDDING_MODEL}:embedContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:`models/${env.GEMINI_EMBEDDING_MODEL}`,content:{parts:[{text:input}]},taskType:query?'RETRIEVAL_QUERY':'RETRIEVAL_DOCUMENT',outputDimensionality:768}),signal:AbortSignal.timeout(45000)});const j:any=await r.json();if(!r.ok)throw new Error(`Gemini embedding ${r.status}: ${j?.error?.message??'request failed'}`);const v:number[]=j.embedding?.values??[];const n=Math.sqrt(v.reduce((s,x)=>s+x*x,0));if(!n)throw new Error('Gemini returned an empty embedding.');return v.map(x=>x/n);}
