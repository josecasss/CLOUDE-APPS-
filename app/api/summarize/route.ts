export const runtime = 'edge';

export async function POST(req: Request): Promise<Response> {
  const { transcript } = (await req.json()) as { transcript: string };

  if (!transcript?.trim()) {
    return Response.json({ error: 'Transcripción requerida' }, { status: 400 });
  }

  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    return Response.json({ error: 'GROQ_API_KEY no configurada' }, { status: 500 });
  }

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${groqKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content:
            'Eres un asistente que resume transcripciones de video. Responde SIEMPRE en el mismo idioma que el texto. Sé claro y conciso.',
        },
        {
          role: 'user',
          content: `Resume la siguiente transcripción en exactamente 5 puntos clave. Cada punto debe comenzar con un emoji relevante al contenido de ese punto específico (no uses siempre el mismo emoji). Usa este formato exacto, sin texto adicional:\n\n[emoji] [Punto 1]\n[emoji] [Punto 2]\n[emoji] [Punto 3]\n[emoji] [Punto 4]\n[emoji] [Punto 5]\n\nTranscripción:\n${transcript.slice(0, 12000)}`,
        },
      ],
      temperature: 0.4,
      max_tokens: 600,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    return Response.json({ error: `Groq error ${res.status}: ${err}` }, { status: 500 });
  }

  const data = await res.json() as { choices: Array<{ message: { content: string } }> };
  const summary = data.choices?.[0]?.message?.content?.trim() ?? '';

  return Response.json({ summary });
}
