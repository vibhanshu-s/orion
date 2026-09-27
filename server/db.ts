import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
const dataDir=path.resolve(process.env.ORION_DATA_DIR??path.resolve(process.cwd(),'data')); fs.mkdirSync(dataDir,{recursive:true});
export const db=new DatabaseSync(path.join(dataDir,'orion.sqlite'));
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, goal TEXT NOT NULL, status TEXT NOT NULL, state_json TEXT NOT NULL, output_json TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, type TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(task_id) REFERENCES tasks(id));
CREATE INDEX IF NOT EXISTS events_task_id ON events(task_id,id);
CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, context TEXT NOT NULL, source TEXT NOT NULL, confidence_score REAL NOT NULL, embedding_json TEXT NOT NULL, embedding_model TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS answers(task_id TEXT PRIMARY KEY, answer TEXT NOT NULL);`);
const stamp=new Date().toISOString(); db.prepare("UPDATE tasks SET status='interrupted',updated_at=? WHERE status IN ('queued','analyzing','planning','running','evaluating')").run(stamp);
export const iso=()=>new Date().toISOString();
export function emit(taskId:string,type:string,data:unknown){const at=iso();db.prepare('INSERT INTO events(task_id,type,data_json,created_at) VALUES(?,?,?,?)').run(taskId,type,JSON.stringify(data),at); db.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run(at,taskId);}
export function updateTask(id:string,status:string,state?:unknown,output?:unknown,error?:string){db.prepare('UPDATE tasks SET status=?,state_json=COALESCE(?,state_json),output_json=COALESCE(?,output_json),error=?,updated_at=? WHERE id=?').run(status,state===undefined?null:JSON.stringify(state),output===undefined?null:JSON.stringify(output),error??null,iso(),id);}
export const getTask=(id:string)=>db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as any;
export const getState=(id:string)=>JSON.parse(getTask(id)?.state_json??'{}');
