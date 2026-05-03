//
// /remux — MKV → HLS remux using ffmpeg.
// Converts unsupported containers into Apple-native HLS playlists
// that AVPlayer streams without issues.
//

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdir, readFile, readdir, stat, rm } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

const REMUX_DIR = '/tmp/remux';
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const sessions = new Map<string, { done: boolean }>();

function probeDuration(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const probe = spawn('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-user_agent', 'Playback/1.0',
      url,
    ]);
    let output = '';
    probe.stdout.on('data', (chunk: Buffer) => { output += chunk; });
    probe.on('close', () => {
      try {
        const info = JSON.parse(output);
        const dur = parseFloat(info.format?.duration);
        resolve(isFinite(dur) ? dur : null);
      } catch {
        resolve(null);
      }
    });
    setTimeout(() => { probe.kill(); resolve(null); }, 10_000);
  });
}

export const remuxRoutes: FastifyPluginAsync = async (app) => {

  // Start a remux session — returns the HLS playlist URL.
  app.post('/remux', async (req, reply) => {
    const body = z.object({
      url: z.string().url(),
    }).parse(req.body);

    const id = randomUUID().slice(0, 12);
    const dir = join(REMUX_DIR, id);
    await mkdir(dir, { recursive: true });

    const ffmpeg = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'warning',
      '-user_agent', 'Playback/1.0',
      '-i', body.url,
      '-map', '0:v:0',
      '-map', '0:a:0',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-f', 'hls',
      '-hls_time', '4',
      '-hls_list_size', '0',
      '-hls_segment_type', 'fmp4',
      '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_segment_filename', join(dir, 'seg%04d.m4s'),
      join(dir, 'stream.m3u8'),
    ]);

    sessions.set(id, { done: false });

    ffmpeg.stderr.on('data', (chunk: Buffer) => {
      app.log.warn('[remux] ' + chunk.toString().trim());
    });

    ffmpeg.on('close', (code) => {
      if (code !== 0) app.log.warn(`[remux] ffmpeg exited ${code}`);
      const session = sessions.get(id);
      if (session) session.done = true;
    });

    // Probe total duration and wait for first segments in parallel.
    const durationPromise = probeDuration(body.url);

    const playlist = join(dir, 'stream.m3u8');
    const initSeg = join(dir, 'init.mp4');
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (existsSync(playlist) && existsSync(initSeg)) {
        const content = await readFile(playlist, 'utf-8');
        const segCount = (content.match(/\.m4s/g) || []).length;
        if (segCount >= 2) break;
      }
      await new Promise(r => setTimeout(r, 500));
    }

    if (!existsSync(playlist)) {
      ffmpeg.kill('SIGTERM');
      reply.code(502);
      return { error: 'ffmpeg failed to produce output' };
    }

    const durationSeconds = await durationPromise;

    // Schedule cleanup.
    setTimeout(() => {
      rm(dir, { recursive: true, force: true }).catch(() => {});
      sessions.delete(id);
    }, SESSION_TTL_MS);

    const base = `${req.protocol}://${req.hostname}`;
    return { playlistURL: `${base}/v1/remux/${id}/stream.m3u8`, durationSeconds };
  });

  // Serve HLS playlist — always as VOD so AVPlayer shows no LIVE badge.
  app.get('/remux/:id/stream.m3u8', async (req, reply) => {
    const { id } = req.params as { id: string };
    const file = join(REMUX_DIR, id, 'stream.m3u8');
    if (!existsSync(file)) { reply.code(404); return { error: 'not found' }; }
    let content = await readFile(file, 'utf-8');
    if (!content.includes('#EXT-X-PLAYLIST-TYPE')) {
      content = content.replace('#EXTM3U', '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD');
    }
    if (!content.includes('#EXT-X-ENDLIST')) {
      content = content.trimEnd() + '\n#EXT-X-ENDLIST\n';
    }
    reply.header('Content-Type', 'application/vnd.apple.mpegurl');
    reply.header('Cache-Control', 'no-cache');
    return content;
  });

  // Serve fMP4 segments (.m4s) and init segment (init.mp4).
  app.get('/remux/:id/:segment', async (req, reply) => {
    const { id, segment } = req.params as { id: string; segment: string };
    if (!segment.endsWith('.m4s') && segment !== 'init.mp4') {
      reply.code(400); return { error: 'bad segment' };
    }
    const file = join(REMUX_DIR, id, segment);
    if (!existsSync(file)) { reply.code(404); return { error: 'not found' }; }
    const data = await readFile(file);
    reply.header('Content-Type', 'video/mp4');
    reply.header('Cache-Control', 'public, max-age=3600');
    return reply.send(data);
  });
};
