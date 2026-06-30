export const runtime = 'nodejs';
export const maxDuration = 300;

import { create } from 'youtube-dl-exec';
import { YoutubeTranscript } from 'youtube-transcript';
import { readdir, readFile, unlink, mkdir } from 'fs/promises';
import { join } from 'path';
import { randomBytes } from 'crypto';

// Ruta absoluta al binario — evita que Next.js lo resuelva como \ROOT\...
const binaryName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
const youtubeDl = create(join(process.cwd(), 'node_modules', 'youtube-dl-exec', 'bin', binaryName));

type ProgressEvent =
  | { status: 'fetching'; progress: number }
  | { status: 'downloading'; progress: number }
  | { status: 'transcribing'; progress: number }
  | { status: 'done'; progress: number; transcript: string; segments: Array<{ start: number; text: string }> }
  | { status: 'error'; message: string };

// Carpeta temporal: /tmp en Linux (Render), C:/ytdlp-tmp en Windows (dev)
const TMP_DIR = process.platform === 'win32' ? 'C:/ytdlp-tmp' : '/tmp';

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

// Limpia URLs con parámetros extra que rompen el shell (& como separador)
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
  } catch { /* URL inválida, la usamos tal cual */ }
  return raw;
}

// YouTube: extrae captions via HTTP, sin descargar audio (evita bot detection)
async function getYouTubeTranscript(url: string): Promise<{ text: string; segments: Array<{ start: number; text: string }> }> {
  const videoId = extractYouTubeId(url);
  if (!videoId) throw new Error('No se pudo extraer el ID del video de YouTube.');

  const segments = await YoutubeTranscript.fetchTranscript(videoId);
  if (!segments || segments.length === 0) {
    throw new Error('Este video de YouTube no tiene subtítulos/captions disponibles. Prueba subiendo el audio manualmente.');
  }

  const text = segments.map(s => s.text).join(' ').replace(/\s+/g, ' ').trim();
  return {
    text,
    segments: segments.map(s => ({ start: s.offset / 1000, text: s.text })),
  };
}

async function downloadAudio(url: string): Promise<{ buffer: Buffer; ext: string }> {
  await mkdir(TMP_DIR, { recursive: true });

  const id = randomBytes(8).toString('hex');
  const outputTemplate = join(TMP_DIR, `${id}.%(ext)s`).replace(/\\/g, '/');

  // bestaudio/best cubre Facebook Reels (mp4 combinado) y otros
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (youtubeDl as any)(url, {
    format: 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best[ext=mp4]/best',
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
    throw new Error(`Archivo demasiado grande (${sizeMB.toFixed(1)} MB). El video supera ~1 hora de duración.`);
  }

  const ext = generated.split('.').pop() ?? 'm4a';
  return { buffer, ext };
}

const MIME: Record<string, string> = {
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
};

interface TranscriptSegment { start: number; text: string; }
interface TranscriptResult { text: string; segments: TranscriptSegment[]; }

async function transcribeWithGroq(buffer: Buffer, ext: string, groqKey: string): Promise<TranscriptResult> {
  const mimeType = MIME[ext] ?? 'audio/mp4';
  const fileName = `audio.${ext}`;

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), fileName);
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
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch { /* stream cerrado */ }
      };

      try {
        send({ status: 'fetching', progress: 15 });

        const cleanedUrl = cleanUrl(url.trim());

        if (isYouTube(cleanedUrl)) {
          // YouTube: captions via HTTP, sin descargar audio
          send({ status: 'transcribing', progress: 50 });
          const result = await getYouTubeTranscript(cleanedUrl);
          send({ status: 'done', progress: 100, transcript: result.text, segments: result.segments });
        } else {
          // Facebook, Instagram, otros: descarga audio + Groq Whisper
          send({ status: 'downloading', progress: 30 });
          const { buffer, ext } = await downloadAudio(cleanedUrl);
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
