export const runtime = 'nodejs';
export const maxDuration = 300;

import { create } from 'youtube-dl-exec';
import { YoutubeTranscript } from 'youtube-transcript';
import { readdir, readFile, unlink, mkdir } from 'fs/promises';
import { join } from 'path';
import { randomBytes } from 'crypto';

const binaryName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
const youtubeDl = create(join(process.cwd(), 'node_modules', 'youtube-dl-exec', 'bin', binaryName));

type ProgressEvent =
  | { status: 'fetching'; progress: number }
  | { status: 'downloading'; progress: number; detail?: string }
  | { status: 'transcribing'; progress: number; detail?: string }
  | { status: 'done'; progress: number; transcript: string; segments: Array<{ start: number; text: string }> }
  | { status: 'error'; message: string };

const TMP_DIR = process.platform === 'win32' ? 'C:/ytdlp-tmp' : '/tmp';
const CHUNK_SEC = 1200; // 20 min por chunk
const AUDIO_FORMAT = 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best[ext=mp4]/best';

function isYouTube(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname.includes('youtube.com') || u.hostname.includes('youtu.be');
  } catch { return false; }
}

function extractYouTubeId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1).split('?')[0];
    return u.searchParams.get('v');
  } catch { return null; }
}

function cleanUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.hostname.includes('youtube.com')) {
      const v = u.searchParams.get('v');
      return v ? `https://www.youtube.com/watch?v=${v}` : raw;
    }
    if (u.hostname.includes('facebook.com') || u.hostname.includes('fb.watch')) {
      const v = u.searchParams.get('v');
      return v ? `https://www.facebook.com/watch/?v=${v}` : raw;
    }
    if (u.hostname.includes('instagram.com')) {
      return u.origin + u.pathname;
    }
  } catch { /* URL inválida */ }
  return raw;
}

async function getYouTubeTranscript(url: string): Promise<{ text: string; segments: Array<{ start: number; text: string }> }> {
  const videoId = extractYouTubeId(url);
  if (!videoId) throw new Error('No se pudo extraer el ID del video de YouTube.');

  const segments = await YoutubeTranscript.fetchTranscript(videoId);
  if (!segments || segments.length === 0) {
    throw new Error('Este video de YouTube no tiene subtítulos disponibles. Súbelo manualmente en la pestaña "Subir archivo".');
  }

  const text = segments.map(s => s.text).join(' ').replace(/\s+/g, ' ').trim();
  return { text, segments: segments.map(s => ({ start: s.offset / 1000, text: s.text })) };
}

async function getVideoDuration(url: string): Promise<number> {
  try {
    const result = await (youtubeDl as any)(url, {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificates: true,
    });
    const info = typeof result === 'string' ? JSON.parse(result) : result;
    return typeof info?.duration === 'number' ? info.duration : 0;
  } catch {
    return 0;
  }
}

async function downloadSection(
  url: string,
  startSec: number,
  endSec: number,
): Promise<{ buffer: Buffer; ext: string } | null> {
  await mkdir(TMP_DIR, { recursive: true });
  const id = randomBytes(8).toString('hex');
  const outputTemplate = join(TMP_DIR, `${id}.%(ext)s`).replace(/\\/g, '/');

  await (youtubeDl as any)(url, {
    format: AUDIO_FORMAT,
    output: outputTemplate,
    downloadSections: `*${startSec}-${endSec}`,
    noCheckCertificates: true,
    noWarnings: true,
  });

  const files = await readdir(TMP_DIR);
  const generated = files.find(f => f.startsWith(id));
  if (!generated) return null;

  const filePath = join(TMP_DIR, generated);
  const buffer = await readFile(filePath);
  await unlink(filePath).catch(() => {});
  const ext = generated.split('.').pop() ?? 'm4a';
  return { buffer, ext };
}

async function downloadFull(url: string): Promise<{ buffer: Buffer; ext: string }> {
  await mkdir(TMP_DIR, { recursive: true });
  const id = randomBytes(8).toString('hex');
  const outputTemplate = join(TMP_DIR, `${id}.%(ext)s`).replace(/\\/g, '/');

  await (youtubeDl as any)(url, {
    format: AUDIO_FORMAT,
    output: outputTemplate,
    noCheckCertificates: true,
    noWarnings: true,
  });

  const files = await readdir(TMP_DIR);
  const generated = files.find(f => f.startsWith(id));
  if (!generated) throw new Error('No se pudo descargar el audio. Verifica que el link sea público.');

  const filePath = join(TMP_DIR, generated);
  const buffer = await readFile(filePath);
  await unlink(filePath).catch(() => {});

  const sizeMB = buffer.byteLength / (1024 * 1024);
  if (sizeMB > 24.9) {
    throw new Error(`Archivo de ${sizeMB.toFixed(0)} MB — usa el modo chunked para videos largos.`);
  }

  const ext = generated.split('.').pop() ?? 'm4a';
  return { buffer, ext };
}

const MIME: Record<string, string> = {
  m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'audio/webm',
  ogg: 'audio/ogg', mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac',
};

interface TranscriptSegment { start: number; text: string; }
interface TranscriptResult { text: string; segments: TranscriptSegment[]; }

async function transcribeWithGroq(buffer: Buffer, ext: string, groqKey: string): Promise<TranscriptResult> {
  const mimeType = MIME[ext] ?? 'audio/mp4';
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), `audio.${ext}`);
  form.append('model', 'whisper-large-v3');
  form.append('response_format', 'verbose_json');

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${groqKey}` },
    body: form,
    signal: AbortSignal.timeout(280_000),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Groq error ${res.status}: ${err}`);
  }

  const data = await res.json() as { text: string; segments: Array<{ start: number; text: string }> };
  return {
    text: data.text.trim(),
    segments: (data.segments ?? []).map(s => ({ start: s.start, text: s.text.trim() })),
  };
}

async function transcribeChunked(
  url: string,
  duration: number,
  groqKey: string,
  send: (e: ProgressEvent) => void,
): Promise<TranscriptResult> {
  const numChunks = Math.ceil(duration / CHUNK_SEC);
  const allSegments: TranscriptSegment[] = [];
  const allText: string[] = [];

  for (let i = 0; i < numChunks; i++) {
    const startSec = i * CHUNK_SEC;
    const endSec = Math.min((i + 1) * CHUNK_SEC, duration);
    const pct = Math.round(20 + (i / numChunks) * 70);

    send({ status: 'downloading', progress: pct, detail: `Parte ${i + 1} de ${numChunks} — descargando...` });
    const chunk = await downloadSection(url, startSec, endSec);
    if (!chunk) continue;

    send({ status: 'transcribing', progress: pct + 5, detail: `Parte ${i + 1} de ${numChunks} — transcribiendo...` });
    const result = await transcribeWithGroq(chunk.buffer, chunk.ext, groqKey);

    allText.push(result.text);
    for (const seg of result.segments) {
      allSegments.push({ start: seg.start + startSec, text: seg.text });
    }
  }

  return { text: allText.join(' '), segments: allSegments };
}

export async function POST(req: Request): Promise<Response> {
  const { url } = (await req.json()) as { url: string };

  if (!url?.trim()) {
    return new Response(JSON.stringify({ error: 'URL requerida' }), { status: 400 });
  }

  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    return new Response(JSON.stringify({ error: 'GROQ_API_KEY no configurada' }), { status: 500 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: ProgressEvent) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); }
        catch { /* stream cerrado */ }
      };

      try {
        send({ status: 'fetching', progress: 10 });
        const cleanedUrl = cleanUrl(url.trim());

        if (isYouTube(cleanedUrl)) {
          send({ status: 'transcribing', progress: 50 });
          let result;
          try {
            result = await getYouTubeTranscript(cleanedUrl);
          } catch {
            throw new Error('YouTube bloquea solicitudes desde servidores. Para videos de YouTube: descarga el video y súbelo en la pestaña "Subir archivo".');
          }
          send({ status: 'done', progress: 100, transcript: result.text, segments: result.segments });
          return;
        }

        // FB / Instagram / otros — detectar duración primero
        send({ status: 'fetching', progress: 15, detail: 'Analizando video...' } as any);
        const duration = await getVideoDuration(cleanedUrl);

        if (duration > CHUNK_SEC) {
          // Video largo → fragmentar
          const mins = Math.round(duration / 60);
          send({ status: 'downloading', progress: 20, detail: `Video de ~${mins} min — procesando en partes...` });
          const result = await transcribeChunked(cleanedUrl, duration, groqKey, send);
          send({ status: 'done', progress: 100, transcript: result.text, segments: result.segments });
        } else {
          // Video corto → descarga normal
          send({ status: 'downloading', progress: 30 });
          const { buffer, ext } = await downloadFull(cleanedUrl);
          send({ status: 'transcribing', progress: 65 });
          const result = await transcribeWithGroq(buffer, ext, groqKey);
          send({ status: 'done', progress: 100, transcript: result.text, segments: result.segments });
        }
      } catch (e) {
        console.error('[transcribe] ERROR:', JSON.stringify(e, Object.getOwnPropertyNames(e as object)));
        const err = e as Record<string, unknown>;
        const msg = String(
          (err.stderr as string) ||
          (err.stdout as string) ||
          (e instanceof Error && e.message) ||
          'Error inesperado al procesar el video.'
        ).slice(0, 400);
        send({ status: 'error', message: msg });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}
