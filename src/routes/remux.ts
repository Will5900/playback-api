//
// /remux — stream-through MKV → MP4 remux using ffmpeg.
// No re-encoding: just swaps the container via `-c copy`.
// Uses fragmented MP4 so playback starts immediately.
//

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { spawn } from 'child_process';
import { request } from 'undici';

export const remuxRoutes: FastifyPluginAsync = async (app) => {
  app.get('/remux', async (req, reply) => {
    const query = z.object({
      url: z.string().url(),
    }).parse(req.query);

    const upstream = await request(query.url, {
      method: 'GET',
      headers: { 'User-Agent': 'Playback/1.0' },
      maxRedirections: 5,
    });

    if (upstream.statusCode < 200 || upstream.statusCode >= 400) {
      reply.code(502);
      return { error: 'upstream returned ' + upstream.statusCode };
    }

    const contentLength = upstream.headers['content-length'];

    const ffmpeg = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-c', 'copy',
      '-movflags', 'frag_keyframe+empty_moov+faststart',
      '-f', 'mp4',
      'pipe:1',
    ]);

    upstream.body.pipe(ffmpeg.stdin);

    ffmpeg.stdin.on('error', () => {});
    ffmpeg.stderr.on('data', (chunk: Buffer) => {
      app.log.warn('[remux] ffmpeg: ' + chunk.toString().trim());
    });

    reply.raw.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-store',
    });

    ffmpeg.stdout.pipe(reply.raw);

    ffmpeg.on('close', (code) => {
      if (code !== 0) {
        app.log.warn(`[remux] ffmpeg exited with code ${code}`);
      }
      if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    });

    req.raw.on('close', () => {
      ffmpeg.kill('SIGTERM');
      upstream.body.destroy();
    });

    return reply;
  });
};
