export const runtime = 'nodejs';
export const maxDuration = 300;

type ProgressEvent =
  | { status: 'transcribing'; progress: number }
  | { status: 'done'; progress: number; transcript: string; segments: Array<{ start: number; text: string }> }
  | { status: 'error'; message: string };

const MIME: Record<string, string> = {
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
};

export async function POST(req: Request): Promise<Response> {
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
        const formData = await req.formData();
        const file = formData.get('file') as File | null;

        if (!file) { send({ status: 'error', message: 'No se recibió ningún archivo.' }); return; }

        const sizeMB = file.size / (1024 * 1024);
        if (sizeMB > 24.9) {
          send({ status: 'error', message: `Archivo demasiado grande (${sizeMB.toFixed(1)} MB). Groq acepta hasta 25 MB. Para videos largos, extrae solo el audio primero.` });
          return;
        }

        const ext = file.name.split('.').pop()?.toLowerCase() ?? 'mp4';
        if (!MIME[ext]) {
          send({ status: 'error', message: `Formato .${ext} no soportado. Usa: mp3, mp4, m4a, wav, webm, ogg, flac, mov, avi, mkv.` });
          return;
        }

        send({ status: 'transcribing', progress: 30 });

        const buffer = Buffer.from(await file.arrayBuffer());
        const mimeType = MIME[ext];
        const form = new FormData();
        form.append('file', new Blob([buffer], { type: mimeType }), file.name);
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
        send({ status: 'done', progress: 100, transcript: data.text.trim(), segments: (data.segments ?? []).map(s => ({ start: s.start, text: s.text.trim() })) });
      } catch (e) {
        send({ status: 'error', message: e instanceof Error ? e.message : 'Error inesperado.' });
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
