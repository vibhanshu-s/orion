import { Document } from '@langchain/core/documents';
import { Embeddings } from '@langchain/core/embeddings';
import { MemoryVectorStore } from '@langchain/classic/vectorstores/memory';
import { GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';
import { TaskType } from '@google/generative-ai';
import { db } from './db.js';
import { env, embed } from './gemini.js';
import { scheduleProvider } from './providerQueue.js';

class GeminiRetrievalEmbeddings extends Embeddings {
  private readonly documents: GoogleGenerativeAIEmbeddings;
  private readonly queries: GoogleGenerativeAIEmbeddings;

  constructor() {
    super({ maxConcurrency: 3 });
    if (!env.GEMINI_API_KEY) throw new Error('Gemini is not configured. Add GEMINI_API_KEY to .env to create or search vector memories.');
    this.documents = new GoogleGenerativeAIEmbeddings({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_EMBEDDING_MODEL, taskType: TaskType.RETRIEVAL_DOCUMENT, outputDimensionality: 768, maxRetries: 0, maxConcurrency: 1 });
    this.queries = new GoogleGenerativeAIEmbeddings({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_EMBEDDING_MODEL, taskType: TaskType.RETRIEVAL_QUERY, outputDimensionality: 768, maxRetries: 0, maxConcurrency: 1 });
  }

  async embedDocuments(texts: string[]) {
    const vectors = [];
    for (const text of texts) vectors.push(...await scheduleProvider(() => this.documents.embedDocuments([`task: document | content: ${text}`])));
    return vectors.map(normalize);
  }

  async embedQuery(text: string) {
    return normalize(await scheduleProvider(() => this.queries.embedQuery(`task: search | query: ${text}`)));
  }
}

function normalize(vector: number[]) {
  const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!length) throw new Error('The embedding provider returned an empty vector.');
  return vector.map(value => value / length);
}

let vectorStore: MemoryVectorStore | null = null;
let indexedSignature = '';
const embeddings = () => new GeminiRetrievalEmbeddings();

function readRows() {
  return db.prepare('SELECT id,context,source,embedding_json,embedding_model,created_at FROM memories ORDER BY id').all() as any[];
}

async function hydrate(force = false) {
  const rows = readRows();
  const signature = rows.map(row => `${row.id}:${row.embedding_model}`).join('|');
  if (!vectorStore || force || signature !== indexedSignature) {
    const next = new MemoryVectorStore(embeddings());
    const currentModelRows = rows.filter(row => row.embedding_model === env.GEMINI_EMBEDDING_MODEL);
    if (currentModelRows.length) {
      await next.addVectors(
        currentModelRows.map(row => normalize(JSON.parse(row.embedding_json))),
        currentModelRows.map(row => new Document({ pageContent: row.context, metadata: { id: row.id, source: row.source, created_at: row.created_at } }))
      );
    }
    vectorStore = next;
    indexedSignature = signature;
  }
  return vectorStore;
}

export async function addVectorMemory(context: string, source: string) {
  const vector = normalize(await embed(`task: document | content: ${context}`));
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare('INSERT INTO memories(id,context,source,confidence_score,embedding_json,embedding_model,created_at) VALUES(?,?,?,?,?,?,?)').run(id, context, source, 0, JSON.stringify(vector), env.GEMINI_EMBEDDING_MODEL, createdAt);
  await hydrate(true);
  return id;
}

export async function searchVectorMemory(query: string, limit = 5) {
  const store = await hydrate();
  if (!store.memoryVectors.length) return [];
  const matches = await store.similaritySearchWithScore(query, limit);
  return matches.map(([document, score]) => ({ id: String(document.metadata.id), context: document.pageContent, source: String(document.metadata.source), confidence_score: score }));
}
