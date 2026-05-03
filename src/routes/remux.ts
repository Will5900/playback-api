//
// /remux — stream-through MKV → MP4 remux using ffmpeg.
// No re-encoding: just swaps the container via `-c copy`.
// Uses fragmented MP4 so playback starts immediately.
//

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { spawn } from 'child_process';

export const remuxRoutes: FastifyPluginAsync = async (app) => {
  app.get('/remux', async (req, reply) => {
    const query = z.object({
      url: z.string().url(),
    }).parse(req.query);

    const ffmpeg = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'warning',
      '-user_agent', 'Playback/1.0',
      '-i', query.url,
      '-map', '0:v:0',
      '-map', '0:a:0',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-f', 'mpegts',
      'pipe:1',
    ]);

    ffmpeg.stderr.on('data', (chunk: Buffer) => {
      app.log.warn('[remux] ffmpeg: ' + chunk.toString().trim());
    });

    reply.raw.writeHead(200, {
      'Content-Type': 'video/mp2t',
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
    });

    return reply;
  });
};
