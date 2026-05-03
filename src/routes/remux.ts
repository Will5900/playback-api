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
      '-hls_playlist_type', 'event',
      '-hls_segment_type', 'fmp4',
      '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_segment_filename', join(dir, 'seg%04d.m4s'),
      join(dir, 'stream.m3u8'),
    ]);

    sessions.set(id, { done: false });

    ffmpeg.stderr.on('data', (chunk: Buffer) => {
      app.log.warn('[remux] ' + chunk.toString().trim());
    });

    // Wait for ffmpeg to fully complete so the playlist has #EXT-X-ENDLIST.
    const completion = new Promise<number | null>((resolve) => {
      ffmpeg.on('close', (code) => {
        if (code !== 0) app.log.warn(`[remux] ffmpeg exited ${code}`);
        const session = sessions.get(id);
        if (session) session.done = true;
        resolve(code);
      });
    });

    const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 180_000));
    const result = await Promise.race([completion, timeout]);

    const playlist = join(dir, 'stream.m3u8');
    if (result === 'timeout') {
      app.log.warn(`[remux] ${id} still running after 180s, returning anyway`);
    }

    if (!existsSync(playlist)) {
      ffmpeg.kill('SIGTERM');
      reply.code(502);
      return { error: 'ffmpeg failed to produce output' };
    }

    // Schedule cleanup.
    setTimeout(() => {
      rm(dir, { recursive: true, force: true }).catch(() => {});
      sessions.delete(id);
    }, SESSION_TTL_MS);

    const base = `${req.protocol}://${req.hostname}`;
    return { playlistURL: `${base}/v1/remux/${id}/stream.m3u8` };
  });

  // Serve HLS playlist.
  app.get('/remux/:id/stream.m3u8', async (req, reply) => {
    const { id } = req.params as { id: string };
    const file = join(REMUX_DIR, id, 'stream.m3u8');
    if (!existsSync(file)) { reply.code(404); return { error: 'not found' }; }
    let content = await readFile(file, 'utf-8');
    const session = sessions.get(id);
    if (session?.done && !content.includes('#EXT-X-ENDLIST')) {
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
