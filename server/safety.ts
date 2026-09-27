import path from 'node:path';
import fs from 'node:fs/promises';
import { isIP } from 'node:net';

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split('.').map(Number);
    if (octets.length !== 4 || octets.some(n => n < 0 || n > 255)) return false;
    const [a, b, c] = octets;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) return false;
    if (a === 192 && b === 0 && c === 2) return false;
    if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    // Only accept globally routable unicast space; mapped, loopback, link-local,
    // unique-local, multicast, and documentation ranges are denied.
    return /^[23]/.test(normalized) && !normalized.startsWith('2001:db8:');
  }
  return false;
}

export function isPublicHttpsDestination(rawUrl: string, addresses: string[]): boolean {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return false; }
  return url.protocol === 'https:' && !url.username && !url.password && isIP(url.hostname) === 0 && addresses.length > 0 && addresses.every(isPublicAddress);
}

export function safeJoin(root: string, ...parts: string[]): string {
  const base = path.resolve(root);
  const target = path.resolve(base, ...parts);
  if (!target.startsWith(base + path.sep)) throw new Error('Path is outside the permitted workspace.');
  return target;
}

function isWithin(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export async function assertPathContained(root: string, target: string): Promise<string> {
  const base = path.resolve(root);
  const candidate = path.resolve(target);
  if (!isWithin(base, candidate) || candidate === base) throw new Error('Path is outside the permitted workspace.');

  const realBase = await fs.realpath(base);
  const realParent = await fs.realpath(path.dirname(candidate));
  if (!isWithin(realBase, realParent)) throw new Error('Path resolves through a symlink outside the permitted workspace.');

  try {
    const realCandidate = await fs.realpath(candidate);
    if (!isWithin(realBase, realCandidate)) throw new Error('Path resolves through a symlink outside the permitted workspace.');
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return candidate;
}

export function normalizeVector(values: number[]): number[] {
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!magnitude || values.some(value => !Number.isFinite(value))) throw new Error('Embedding vector is empty or invalid.');
  return values.map(value => value / magnitude);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  return a.reduce((sum, value, index) => sum + value * b[index], 0);
}
