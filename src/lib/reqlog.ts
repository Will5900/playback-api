//
// In-memory ring buffer of recent HTTP requests. Used by /v1/_debug/recent
// to surface what the iOS app is actually hitting (method, path, status,
// response time). Bounded so memory can't grow unboundedly.
//

export interface ReqEntry {
  ts: string;             // ISO timestamp
  deviceId?: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
}

const MAX = 200;
const buf: ReqEntry[] = [];

export function pushReq(entry: ReqEntry): void {
  buf.push(entry);
  if (buf.length > MAX) buf.splice(0, buf.length - MAX);
}

export function recentReqs(filter?: { deviceId?: string; status?: number; pathContains?: string; limit?: number }): ReqEntry[] {
  let out = buf.slice();
  if (filter?.deviceId)     out = out.filter(e => e.deviceId === filter.deviceId);
  if (filter?.status != null) out = out.filter(e => e.status === filter.status);
  if (filter?.pathContains) out = out.filter(e => e.path.includes(filter.pathContains!));
  out.reverse(); // newest first
  return out.slice(0, filter?.limit ?? 100);
}
