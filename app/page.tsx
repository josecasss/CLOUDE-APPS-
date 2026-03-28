'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Copy, RotateCcw, Sparkles, Bookmark, BookmarkCheck,
  ChevronDown, ChevronUp, Tag, X, Filter, Loader2, Pencil, Upload, FileVideo,
  Clock, FileText, FileDown,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

type Status = 'idle' | 'fetching' | 'downloading' | 'transcribing' | 'done' | 'error';

interface VideoPreview {
  platform: 'youtube' | 'facebook' | 'instagram' | 'tiktok' | 'other';
  title?: string;
  thumbnail?: string;
  channel?: string;
  embedUrl?: string;
}

interface TranscriptSegment { start: number; text: string; }

interface BackendEvent {
  status: Status;
  progress?: number;
  transcript?: string;
  segments?: TranscriptSegment[];
  message?: string;
}

interface SavedItem {
  id: string;
  title: string;
  topic: string;
  transcript: string;
  url: string;
  savedAt: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STEP_LABELS: Record<Status, string> = {
  idle: '',
  fetching: 'Obteniendo audio del video...',
  downloading: 'Descargando audio...',
  transcribing: 'Transcribiendo con IA...',
  done: '¡Transcripción lista!',
  error: '',
};

const STEP_COLORS: Record<Status, string> = {
  idle: '#8b5cf6',
  fetching: '#8b5cf6',
  downloading: '#a78bfa',
  transcribing: '#c4b5fd',
  done: '#22d3ee',
  error: '#ef4444',
};

const LS_SESSION = 'papa-session';
const LS_LIBRARY = 'papa-library';

const SUGGESTED_TOPICS = ['Ciencia', 'Historia', 'Política', 'Religión', 'Salud', 'Tecnología', 'Naturaleza', 'Otro'];

// ─── Component ────────────────────────────────────────────────────────────────

export default function Home() {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [progress, setProgress] = useState(0);
  const [transcript, setTranscript] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  // Preview de link
  const [preview, setPreview] = useState<VideoPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Resumen
  const [summary, setSummary] = useState('');
  const [summaryLoading, setSummaryLoading] = useState(false);

  // Biblioteca
  const [library, setLibrary] = useState<SavedItem[]>([]);
  const [libOpen, setLibOpen] = useState(false);
  const [filterTopic, setFilterTopic] = useState('');
  const [saveModal, setSaveModal] = useState(false);
  const [saveTitle, setSaveTitle] = useState('');
  const [saveTopic, setSaveTopic] = useState('');
  const [editModal, setEditModal] = useState(false);
  const [editItem, setEditItem] = useState<SavedItem | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editTopic, setEditTopic] = useState('');

  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [showTimestamps, setShowTimestamps] = useState(true);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const transcriptRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const isLoading = status === 'fetching' || status === 'downloading' || status === 'transcribing';

  // ── Persistencia de sesión ──────────────────────────────────────────────────
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_SESSION) ?? '{}');
      if (saved.url) setUrl(saved.url);
      if (saved.transcript) { setTranscript(saved.transcript); setStatus('done'); }
    } catch { /* nada */ }

    try {
      const lib = JSON.parse(localStorage.getItem(LS_LIBRARY) ?? '[]');
      setLibrary(lib);
    } catch { /* nada */ }
  }, []);

  useEffect(() => {
    localStorage.setItem(LS_SESSION, JSON.stringify({ url, transcript }));
  }, [url, transcript]);

  // ── Preview dinámico del link ───────────────────────────────────────────────
  useEffect(() => {
    if (!url.trim()) { setPreview(null); return; }

    const u = url.toLowerCase();
    const isYT = u.includes('youtube.com') || u.includes('youtu.be');
    const isFB = u.includes('facebook.com') || u.includes('fb.watch');
    const isIG = u.includes('instagram.com');
    const isTT = u.includes('tiktok.com');

    if (!isYT && !isFB && !isIG && !isTT) { setPreview({ platform: 'other' }); return; }

    // TikTok: oEmbed público sin auth
    if (isTT) {
      setPreview({ platform: 'tiktok' });
      setPreviewLoading(true);
      const timer = setTimeout(() => {
        fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`)
          .then(r => r.ok ? r.json() : null)
          .then((data: { title?: string; author_name?: string; thumbnail_url?: string } | null) => {
            if (data) setPreview({ platform: 'tiktok', title: data.title, channel: data.author_name, thumbnail: data.thumbnail_url });
          })
          .catch(() => {})
          .finally(() => setPreviewLoading(false));
      }, 600);
      return () => clearTimeout(timer);
    }

    // Facebook/Instagram: OG tags via servidor + embed URL
    if (isFB || isIG) {
      const platform = isFB ? 'facebook' : 'instagram';

      // Calcular embedUrl
      let embedUrl: string | undefined;
      if (isFB) {
        embedUrl = `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(url)}&show_text=false`;
      } else {
        const igMatch = url.match(/instagram\.com\/(p|reel|tv)\/([A-Za-z0-9_-]+)/i);
        if (igMatch) embedUrl = `https://www.instagram.com/${igMatch[1]}/${igMatch[2]}/embed/`;
      }

      setPreview({ platform, embedUrl });
      setPreviewLoading(true);
      const timer = setTimeout(() => {
        fetch(`/api/og-preview?url=${encodeURIComponent(url)}`)
          .then(r => r.ok ? r.json() : null)
          .then((data: { title?: string; image?: string } | null) => {
            if (data?.title || data?.image) {
              setPreview({ platform, title: data.title ?? undefined, thumbnail: data.image ?? undefined, embedUrl });
            }
          })
          .catch(() => {})
          .finally(() => setPreviewLoading(false));
      }, 600);
      return () => clearTimeout(timer);
    }

    // YouTube: thumbnail inmediato + título vía oEmbed + embed URL
    let videoId = '';
    try {
      const parsed = new URL(url);
      if (parsed.hostname.includes('youtu.be')) {
        videoId = parsed.pathname.slice(1);
      } else {
        videoId = parsed.searchParams.get('v') ?? parsed.pathname.split('/').pop() ?? '';
      }
    } catch { /* nada */ }

    if (!videoId) { setPreview({ platform: 'youtube' }); return; }

    const thumbnail = `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
    const embedUrl = `https://www.youtube.com/embed/${videoId}`;
    setPreview({ platform: 'youtube', thumbnail, embedUrl });
    setPreviewLoading(true);

    const timer = setTimeout(() => {
      fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`)
        .then(r => r.ok ? r.json() : null)
        .then((data: { title?: string; author_name?: string } | null) => {
          if (data) setPreview({ platform: 'youtube', thumbnail, title: data.title, channel: data.author_name, embedUrl });
        })
        .catch(() => {})
        .finally(() => setPreviewLoading(false));
    }, 600);

    return () => clearTimeout(timer);
  }, [url]);

  // ── Transcripción ──────────────────────────────────────────────────────────
  const handleTranscribe = useCallback(async () => {
    if ((!url.trim() && !uploadFile) || isLoading) return;
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    setStatus('fetching');
    setProgress(10);
    setTranscript('');
    setErrorMsg('');
    setSummary('');

    try {
      let res: Response;
      if (uploadFile) {
        const form = new FormData();
        form.append('file', uploadFile);
        res = await fetch('/api/upload-transcribe', {
          method: 'POST',
          body: form,
          signal: abortRef.current.signal,
        });
      } else {
        res = await fetch('/api/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: url.trim() }),
          signal: abortRef.current.signal,
        });
      }

      if (!res.body) throw new Error('Sin respuesta del servidor');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6)) as BackendEvent;
            if (event.status) setStatus(event.status);
            if (typeof event.progress === 'number') setProgress(event.progress);
            if (event.transcript) {
              setTranscript(event.transcript);
              if (event.segments) setSegments(event.segments);
              setTimeout(() => transcriptRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
            }
            if (event.message) setErrorMsg(event.message);
          } catch { /* chunk parcial */ }
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setStatus('error');
        setErrorMsg(e instanceof Error ? e.message : 'Error de conexión');
      }
    }
  }, [url, isLoading]);

  // ── Resumen con Groq Llama ─────────────────────────────────────────────────
  const handleSummarize = useCallback(async () => {
    if (!transcript || summaryLoading) return;
    setSummaryLoading(true);
    setSummary('');
    try {
      const res = await fetch('/api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript }),
      });
      const data = await res.json() as { summary?: string; error?: string };
      if (data.error) throw new Error(data.error);
      setSummary(data.summary ?? '');
    } catch (e) {
      setSummary(`Error: ${e instanceof Error ? e.message : 'Error desconocido'}`);
    } finally {
      setSummaryLoading(false);
    }
  }, [transcript, summaryLoading]);

  // ── Biblioteca ─────────────────────────────────────────────────────────────
  const handleSave = () => {
    if (!transcript) return;
    setSaveTitle('');
    setSaveTopic('');
    setSaveModal(true);
  };

  const confirmSave = () => {
    if (!saveTitle.trim()) return;
    const item: SavedItem = {
      id: Date.now().toString(),
      title: saveTitle.trim(),
      topic: saveTopic.trim() || 'Sin categoría',
      transcript,
      url,
      savedAt: Date.now(),
    };
    const next = [item, ...library];
    setLibrary(next);
    localStorage.setItem(LS_LIBRARY, JSON.stringify(next));
    setSaveModal(false);
  };

  const handleDelete = (id: string) => {
    const next = library.filter(i => i.id !== id);
    setLibrary(next);
    localStorage.setItem(LS_LIBRARY, JSON.stringify(next));
  };

  const handleEditItem = (item: SavedItem) => {
    setEditItem(item);
    setEditTitle(item.title);
    setEditTopic(item.topic);
    setEditModal(true);
  };

  const confirmEdit = () => {
    if (!editItem || !editTitle.trim()) return;
    const next = library.map(i =>
      i.id === editItem.id ? { ...i, title: editTitle.trim(), topic: editTopic.trim() || 'Sin categoría' } : i
    );
    setLibrary(next);
    localStorage.setItem(LS_LIBRARY, JSON.stringify(next));
    setEditModal(false);
    setEditItem(null);
  };

  const handleLoadItem = (item: SavedItem) => {
    setUrl(item.url);
    setTranscript(item.transcript);
    setStatus('done');
    setSummary('');
    setLibOpen(false);
    setTimeout(() => transcriptRef.current?.scrollIntoView({ behavior: 'smooth' }), 200);
  };

  const topics = [...new Set(library.map(i => i.topic))];
  const filteredLib = filterTopic ? library.filter(i => i.topic === filterTopic) : library;

  // ── Helpers ────────────────────────────────────────────────────────────────
  const handleCopy = () => { if (transcript) navigator.clipboard.writeText(transcript); };

  const handleReset = () => {
    abortRef.current?.abort();
    setStatus('idle');
    setProgress(0);
    setTranscript('');
    setErrorMsg('');
    setUrl('');
    setUploadFile(null);
    setSegments([]);
    setSummary('');
  };

  const barColor = STEP_COLORS[status];
  const alreadySaved = library.some(i => i.url === url && i.transcript === transcript);

  const formatTime = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    if (h > 0) return `${h}:${m.toString().padStart(2,'0')}:${sec.toString().padStart(2,'0')}`;
    return `${m.toString().padStart(2,'0')}:${sec.toString().padStart(2,'0')}`;
  };

  const handleExportPDF = async () => {
    const { jsPDF } = await import('jspdf');
    const doc = new jsPDF();
    const pageW = doc.internal.pageSize.getWidth();
    const margin = 18;
    const maxW = pageW - margin * 2;
    let y = 22;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.text('Transcripción', margin, y); y += 9;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(120);
    if (url) { const urlLines = doc.splitTextToSize(`URL: ${url}`, maxW); doc.text(urlLines, margin, y); y += urlLines.length * 5; }
    doc.text(`Fecha: ${new Date().toLocaleDateString('es-ES')}`, margin, y); y += 5;
    doc.text(`Palabras: ${transcript.split(/\s+/).filter(Boolean).length.toLocaleString()}`, margin, y); y += 9;

    doc.setDrawColor(220);
    doc.line(margin, y, pageW - margin, y); y += 7;

    doc.setTextColor(30);
    doc.setFontSize(11);

    const lines = showTimestamps && segments.length > 0
      ? segments.map(seg => `[${formatTime(seg.start)}]  ${seg.text}`)
      : transcript.split('\n').filter(Boolean);

    for (const line of lines) {
      const wrapped = doc.splitTextToSize(line, maxW);
      if (y + wrapped.length * 6 > doc.internal.pageSize.getHeight() - margin) { doc.addPage(); y = margin; }
      doc.text(wrapped, margin, y);
      y += wrapped.length * 6 + (showTimestamps && segments.length > 0 ? 2 : 1);
    }

    doc.save('transcripcion.pdf');
  };

  const handleExportWord = () => {
    const rows = showTimestamps && segments.length > 0
      ? segments.map(seg => `<p style="margin:0 0 8px"><span style="color:#7c3aed;font-weight:600;margin-right:10px">[${formatTime(seg.start)}]</span>${seg.text}</p>`).join('')
      : `<p style="white-space:pre-wrap">${transcript.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</p>`;

    const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><style>body{font-family:Calibri,sans-serif;font-size:11pt;margin:2cm}</style></head><body><h1 style="font-size:18pt">Transcripción</h1>${url ? `<p style="color:#666;font-size:9pt">URL: ${url}</p>` : ''}<p style="color:#666;font-size:9pt">Fecha: ${new Date().toLocaleDateString('es-ES')} · Palabras: ${transcript.split(/\s+/).filter(Boolean).length.toLocaleString()}</p><hr style="border:1px solid #ddd;margin:12px 0">${rows}</body></html>`;

    const blob = new Blob([html], { type: 'application/msword' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'transcripcion.doc';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <main className="min-h-screen bg-[#080810] flex flex-col items-center justify-start py-16 px-4">

      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: 'easeOut' }}
        className="text-center mb-12"
      >
        <p className="text-[#8b5cf6] text-base font-semibold tracking-widest uppercase mb-3">Para Papá</p>
        <h1 className="text-5xl sm:text-6xl font-bold text-white leading-tight">
          Transcriptor de{' '}
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-violet-400 to-violet-600">Videos</span>
        </h1>
        <p className="text-[#9ca3af] mt-4 text-xl sm:text-2xl">
          Pega el link · Presiona el botón · Lee la transcripción
        </p>
      </motion.div>

      {/* Card principal */}
      <motion.div
        initial={{ opacity: 0, y: 32 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.15, ease: 'easeOut' }}
        className="w-full max-w-2xl"
      >
        <div className="bg-[#0f0f1a] border border-[#1e1e30] rounded-2xl p-6 sm:p-8 shadow-2xl">

          {/* Input */}
          <div className="relative mb-5">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleTranscribe()}
              placeholder="https://youtube.com/watch?v=...  ·  facebook.com/...  ·  instagram.com/reel/..."
              disabled={isLoading}
              className="w-full text-xl sm:text-2xl text-white placeholder-[#374151] bg-[#080810] border-2 border-[#1e1e30] rounded-2xl px-6 py-5 pr-14 outline-none transition-all duration-200 focus:border-[#8b5cf6] focus:shadow-[0_0_0_4px_rgba(139,92,246,0.15)] disabled:opacity-50 disabled:cursor-not-allowed"
            />
            {url && !isLoading && (
              <button onClick={() => setUrl('')} className="absolute right-4 top-1/2 -translate-y-1/2 text-[#4b5563] hover:text-white transition-colors">
                <X size={18} />
              </button>
            )}
          </div>

          {/* Subir desde PC */}
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*,audio/*,.mp3,.mp4,.m4a,.wav,.webm,.ogg,.flac,.mov,.avi,.mkv"
            className="hidden"
            onChange={e => {
              const f = e.target.files?.[0] ?? null;
              setUploadFile(f);
              if (f) setUrl('');
              e.target.value = '';
            }}
          />
          <AnimatePresence>
            {uploadFile ? (
              <motion.div
                key="file-preview"
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.2 }}
                className="flex items-center gap-3 p-4 rounded-2xl border border-violet-800/40 mb-5"
                style={{ background: 'rgba(139,92,246,0.07)' }}
              >
                <FileVideo size={24} className="text-violet-400 shrink-0" />
                <p className="flex-1 text-base text-white truncate font-medium">{uploadFile.name}</p>
                <span className="text-sm text-[#6b7280] shrink-0">{(uploadFile.size / (1024 * 1024)).toFixed(1)} MB</span>
                {!isLoading && (
                  <button onClick={() => setUploadFile(null)} className="text-[#4b5563] hover:text-white transition-colors shrink-0">
                    <X size={15} />
                  </button>
                )}
              </motion.div>
            ) : (
              <motion.button
                key="upload-btn"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => fileInputRef.current?.click()}
                disabled={isLoading}
                className="w-full mb-5 flex items-center justify-center gap-3 py-4 rounded-2xl border-2 border-dashed border-[#2a2a45] hover:border-violet-600 hover:bg-violet-950/20 text-[#6b7280] hover:text-violet-300 text-lg font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Upload size={20} />
                Subir archivo desde PC
              </motion.button>
            )}
          </AnimatePresence>

          {/* Reproductor embebido */}
          <AnimatePresence>
            {preview?.embedUrl && !isLoading && (
              <motion.div
                key="embed-player"
                initial={{ opacity: 0, scale: 0.97 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.97 }}
                transition={{ duration: 0.35, ease: 'easeOut' }}
                style={{ marginBottom: 20 }}
              >
                <iframe
                  src={preview.embedUrl}
                  style={{
                    width: '100%',
                    aspectRatio: '16 / 9',
                    border: 'none',
                    borderRadius: 12,
                    display: 'block',
                    background: '#0a0a14',
                  }}
                  allowFullScreen
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  loading="lazy"
                />
              </motion.div>
            )}
          </AnimatePresence>

          {/* Botón Transcribir */}
          <motion.button
            onClick={handleTranscribe}
            disabled={(!url.trim() && !uploadFile) || isLoading}
            animate={!isLoading && (url.trim() || uploadFile) ? { boxShadow: ['0 0 16px rgba(139,92,246,0.35)', '0 0 36px rgba(139,92,246,0.7)', '0 0 16px rgba(139,92,246,0.35)'] } : { boxShadow: '0 0 0px rgba(139,92,246,0)' }}
            transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.97 }}
            className="w-full py-5 rounded-2xl text-2xl font-bold text-white bg-gradient-to-r from-violet-600 to-violet-500 disabled:from-[#1e1e30] disabled:to-[#1e1e30] disabled:text-[#374151] disabled:cursor-not-allowed disabled:shadow-none transition-colors duration-200 select-none"
          >
            {isLoading ? (
              <span className="flex items-center justify-center gap-3">
                <motion.span animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: 'linear' }} className="block w-5 h-5 border-2 border-white/30 border-t-white rounded-full" />
                {STEP_LABELS[status]}
              </span>
            ) : 'Transcribir'}
          </motion.button>

          {/* Barra de progreso */}
          <AnimatePresence>
            {status !== 'idle' && (
              <motion.div initial={{ opacity: 0, height: 0, marginTop: 0 }} animate={{ opacity: 1, height: 'auto', marginTop: 20 }} exit={{ opacity: 0, height: 0, marginTop: 0 }} transition={{ duration: 0.3 }}>
                <div className="flex justify-between items-center mb-3">
                  <span className="text-base text-[#9ca3af] font-medium">{status === 'error' ? 'Error' : STEP_LABELS[status]}</span>
                  <span className="text-base font-bold" style={{ color: barColor }}>{status === 'error' ? '' : `${progress}%`}</span>
                </div>
                <div className="h-3 w-full bg-[#1e1e30] rounded-full overflow-hidden">
                  <motion.div className="h-full rounded-full" style={{ backgroundColor: barColor }} initial={{ width: '0%' }} animate={{ width: status === 'error' ? '100%' : `${progress}%` }} transition={{ type: 'spring', stiffness: 60, damping: 20 }} />
                </div>
                {status !== 'error' && (
                  <div className="flex justify-between mt-3 px-1">
                    {(['fetching', 'downloading', 'transcribing', 'done'] as const).map((step, i) => {
                      const steps: Status[] = ['fetching', 'downloading', 'transcribing', 'done'];
                      const currentIdx = steps.indexOf(status);
                      return (
                        <div key={step} className="flex items-center gap-1.5">
                          <motion.div className="w-2 h-2 rounded-full" animate={{ backgroundColor: i < currentIdx ? '#8b5cf6' : i === currentIdx ? barColor : '#1e1e30', scale: i === currentIdx ? 1.4 : 1 }} transition={{ duration: 0.4 }} />
                          <span className="text-sm hidden sm:block font-medium" style={{ color: i <= currentIdx ? '#9ca3af' : '#374151' }}>
                            {['Obteniendo', 'Descargando', 'Transcribiendo', 'Listo'][i]}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Error */}
          <AnimatePresence>
            {status === 'error' && errorMsg && (
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-4 p-5 rounded-2xl bg-red-950/40 border border-red-900/50 text-red-400 text-base leading-relaxed">
                <strong className="block mb-2 text-lg">Algo salió mal</strong>
                {errorMsg}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>

      {/* Resultado */}
      <AnimatePresence>
        {transcript && (
          <motion.div ref={transcriptRef} initial={{ opacity: 0, y: 40 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }} transition={{ duration: 0.5, ease: 'easeOut' }} className="w-full max-w-2xl mt-6">
            <div className="bg-[#0f0f1a] border border-[#1e1e30] rounded-2xl p-6 sm:p-8 shadow-2xl">

              {/* Header resultado */}
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <motion.div className="w-3.5 h-3.5 rounded-full bg-[#22d3ee]" animate={{ opacity: [1, 0.4, 1] }} transition={{ duration: 2, repeat: Infinity }} />
                  <span className="text-lg font-semibold text-[#9ca3af]">Transcripción</span>
                </div>
                <div className="flex gap-2 flex-wrap justify-end">
                  {segments.length > 0 && (
                    <motion.button onClick={() => setShowTimestamps(v => !v)} whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all border ${showTimestamps ? 'bg-violet-900/50 text-violet-200 border-violet-600' : 'bg-[#1e1e30] text-[#9ca3af] border-[#2a2a45] hover:text-white'}`}>
                      <Clock size={16} /> {showTimestamps ? 'Con timestamps' : 'Sin timestamps'}
                    </motion.button>
                  )}
                  <motion.button onClick={handleCopy} whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-cyan-950/60 border border-cyan-700/50 text-cyan-300 hover:bg-cyan-900/60 text-sm font-semibold transition-all">
                    <Copy size={16} /> Copiar
                  </motion.button>
                  <motion.button onClick={handleSave} whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all border ${alreadySaved ? 'bg-green-950/60 text-green-300 border-green-700/50' : 'bg-[#1e1e30] border-[#2a2a45] text-[#9ca3af] hover:text-white hover:border-[#3a3a55]'}`}>
                    {alreadySaved ? <BookmarkCheck size={16} /> : <Bookmark size={16} />}
                    {alreadySaved ? 'Guardado' : 'Guardar'}
                  </motion.button>
                  <motion.button onClick={handleReset} whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-amber-950/60 border border-amber-700/50 text-amber-300 hover:bg-amber-900/60 text-sm font-semibold transition-all">
                    <RotateCcw size={16} /> Nuevo
                  </motion.button>
                </div>
              </div>

              {/* Texto transcrito */}
              <div className="max-h-[60vh] overflow-y-auto">
                {showTimestamps && segments.length > 0 ? (
                  <div className="space-y-2">
                    {segments.map((seg, i) => (
                      <div key={i} className="flex gap-3 items-start">
                        <span className="shrink-0 text-sm font-mono font-bold text-violet-400 mt-1 pt-0.5 select-none bg-violet-950/40 px-2 py-0.5 rounded-md">{formatTime(seg.start)}</span>
                        <p className="text-[#e5e7eb] text-xl leading-relaxed">{seg.text}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-[#e5e7eb] text-xl leading-loose whitespace-pre-wrap">{transcript}</p>
                )}
              </div>

              {/* Stats + acciones */}
              <div className="mt-4 pt-4 border-t border-[#1e1e30] flex items-center justify-between flex-wrap gap-3">
                <div className="flex gap-6">
                  <div>
                    <span className="text-sm text-[#6b7280]">Palabras</span>
                    <p className="text-lg font-bold text-[#8b5cf6]">{transcript.split(/\s+/).filter(Boolean).length.toLocaleString()}</p>
                  </div>
                  <div>
                    <span className="text-sm text-[#6b7280]">Caracteres</span>
                    <p className="text-lg font-bold text-[#8b5cf6]">{transcript.length.toLocaleString()}</p>
                  </div>
                  {segments.length > 0 && (
                    <div>
                      <span className="text-sm text-[#6b7280]">Segmentos</span>
                      <p className="text-lg font-bold text-[#8b5cf6]">{segments.length}</p>
                    </div>
                  )}
                </div>
                <div className="flex gap-2 flex-wrap">
                  <motion.button onClick={handleExportPDF} whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }} className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-rose-950/60 border border-rose-700/50 text-rose-300 hover:bg-rose-900/60 text-sm font-semibold transition-all">
                    <FileDown size={16} /> PDF
                  </motion.button>
                  <motion.button onClick={handleExportWord} whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }} className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-950/60 border border-blue-700/50 text-blue-300 hover:bg-blue-900/60 text-sm font-semibold transition-all">
                    <FileText size={16} /> Word
                  </motion.button>
                  <motion.button
                    onClick={handleSummarize}
                    disabled={summaryLoading}
                    whileHover={{ scale: 1.03 }}
                    whileTap={{ scale: 0.97 }}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-violet-700 to-fuchsia-700 hover:from-violet-600 hover:to-fuchsia-600 text-white text-base font-bold transition-all shadow-lg shadow-violet-900/30 disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {summaryLoading ? <Loader2 size={17} className="animate-spin" /> : <Sparkles size={17} />}
                    Resumir en 5 Puntos
                  </motion.button>
                </div>
              </div>
            </div>

            {/* Botón Empezar de Nuevo */}
          <motion.button
            onClick={handleReset}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.97 }}
            className="mt-4 w-full flex items-center justify-center gap-2 py-3 rounded-xl border border-[#1e1e30] hover:border-violet-800/60 bg-[#0f0f1a] hover:bg-[#13131f] text-[#9ca3af] hover:text-white text-sm font-medium transition-all"
          >
            <RotateCcw size={15} />
            Empezar de Nuevo
          </motion.button>

          {/* Tarjeta Resumen Glassmorphism */}
            <AnimatePresence>
              {(summary || summaryLoading) && (
                <motion.div
                  initial={{ opacity: 0, y: 20, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 10 }}
                  transition={{ duration: 0.4, ease: 'easeOut' }}
                  className="mt-4 rounded-2xl p-6 border border-violet-500/20 shadow-xl shadow-violet-900/20"
                  style={{ background: 'rgba(139,92,246,0.07)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)' }}
                >
                  <div className="flex items-center gap-3 mb-5">
                    <Sparkles size={20} className="text-violet-400" />
                    <span className="text-lg font-bold text-violet-300">Resumen en 5 Puntos</span>
                  </div>
                  {summaryLoading ? (
                    <div className="flex items-center gap-3 text-[#9ca3af] text-lg">
                      <Loader2 size={20} className="animate-spin text-violet-400" />
                      Generando resumen con IA...
                    </div>
                  ) : (
                    <div className="flex flex-col gap-4">
                      {summary.split('\n').filter(l => l.trim()).map((line, i) => (
                        <div key={i} className="flex items-start gap-4 p-4 rounded-2xl" style={{ background: 'rgba(139,92,246,0.09)', border: '1px solid rgba(139,92,246,0.2)' }}>
                          <span style={{ fontSize: 28, lineHeight: 1.3, flexShrink: 0 }}>{line.match(/^\p{Emoji}/u)?.[0] ?? '•'}</span>
                          <p className="text-[#e5e7eb] text-lg leading-relaxed" style={{ marginTop: 2 }}>
                            {line.replace(/^\p{Emoji}\s*/u, '')}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Biblioteca de Favoritos */}
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.4 }} className="w-full max-w-2xl mt-6">
        <button
          onClick={() => setLibOpen(o => !o)}
          className="w-full flex items-center justify-between px-6 py-4 rounded-2xl bg-[#0f0f1a] border border-[#1e1e30] text-[#9ca3af] hover:text-white hover:border-violet-800/50 transition-all"
        >
          <div className="flex items-center gap-3">
            <Bookmark size={20} className={library.length > 0 ? 'text-violet-400' : ''} />
            <span className="text-lg font-semibold">Mis Guardados</span>
            {library.length > 0 && (
              <span className="px-2.5 py-1 rounded-full bg-violet-900/50 text-violet-300 text-sm font-bold">{library.length}</span>
            )}
          </div>
          {libOpen ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
        </button>

        <AnimatePresence>
          {libOpen && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.3 }}
              className="overflow-hidden"
            >
              <div className="bg-[#0f0f1a] border border-t-0 border-[#1e1e30] rounded-b-2xl p-5">
                {library.length === 0 ? (
                  <p className="text-center text-[#4b5563] text-sm py-6">Todavía no hay nada guardado.<br />Transcribe un video y presiona <strong className="text-violet-500">Guardar</strong>.</p>
                ) : (
                  <>
                    {/* Filtro por categoría */}
                    <div className="flex gap-2 flex-wrap mb-5">
                      <button onClick={() => setFilterTopic('')} className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold transition-colors ${!filterTopic ? 'bg-violet-700 text-white' : 'bg-[#1e1e30] text-[#9ca3af] hover:text-white'}`}>
                        <Filter size={13} /> Todos
                      </button>
                      {topics.map(t => (
                        <button key={t} onClick={() => setFilterTopic(t === filterTopic ? '' : t)} className={`px-4 py-2 rounded-full text-sm font-semibold transition-colors ${filterTopic === t ? 'bg-violet-700 text-white' : 'bg-[#1e1e30] text-[#9ca3af] hover:text-white'}`}>
                          {t}
                        </button>
                      ))}
                    </div>

                    {/* Lista */}
                    <div className="space-y-3 max-h-96 overflow-y-auto">
                      {filteredLib.map(item => (
                        <motion.div key={item.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} className="flex items-start justify-between gap-3 p-4 rounded-2xl bg-[#080810] border border-[#1e1e30] hover:border-violet-900/50 transition-colors group">
                          <button onClick={() => handleLoadItem(item)} className="flex-1 text-left min-w-0">
                            <p className="text-base font-semibold text-white truncate">{item.title}</p>
                            <div className="flex items-center gap-2 mt-1.5">
                              <Tag size={13} className="text-violet-500 shrink-0" />
                              <span className="text-sm text-violet-400 font-medium">{item.topic}</span>
                              <span className="text-sm text-[#4b5563]">· {item.transcript.split(/\s+/).length} palabras</span>
                            </div>
                          </button>
                          <div className="flex items-center gap-2 shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button onClick={() => handleEditItem(item)} className="text-[#374151] hover:text-violet-400 transition-colors p-1">
                              <Pencil size={16} />
                            </button>
                            <button onClick={() => handleDelete(item.id)} className="text-[#374151] hover:text-red-400 transition-colors p-1">
                              <X size={17} />
                            </button>
                          </div>
                        </motion.div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {/* Footer */}
      <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.8 }} className="mt-12 text-sm text-[#374151] text-center">
        YouTube · Facebook · Instagram Reels · TikTok
      </motion.p>

      {/* Modal Guardar */}
      <AnimatePresence>
        {saveModal && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/70 backdrop-blur-sm z-40" onClick={() => setSaveModal(false)} />
            <motion.div
              initial={{ opacity: 0, scale: 0.92, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.92 }}
              transition={{ duration: 0.25, ease: 'easeOut' }}
              className="fixed inset-0 flex items-center justify-center z-50 px-4"
            >
              <div className="w-full max-w-md bg-[#0f0f1a] border border-[#1e1e30] rounded-2xl p-6 shadow-2xl">
                <div className="flex items-center justify-between mb-5">
                  <h2 className="text-white font-semibold text-lg">Guardar transcripción</h2>
                  <button onClick={() => setSaveModal(false)} className="text-[#4b5563] hover:text-white transition-colors"><X size={18} /></button>
                </div>

                <div className="space-y-4">
                  <div>
                    <label className="text-xs text-[#9ca3af] mb-1.5 block">Título *</label>
                    <input
                      autoFocus
                      value={saveTitle}
                      onChange={e => setSaveTitle(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && confirmSave()}
                      placeholder="Ej: Video sobre física cuántica"
                      className="w-full bg-[#080810] border border-[#1e1e30] rounded-xl px-4 py-3 text-white text-sm outline-none focus:border-violet-500 focus:shadow-[0_0_0_3px_rgba(139,92,246,0.15)] transition-all"
                    />
                  </div>

                  <div>
                    <label className="text-xs text-[#9ca3af] mb-1.5 block">Tema / Categoría</label>
                    <input
                      value={saveTopic}
                      onChange={e => setSaveTopic(e.target.value)}
                      placeholder="Escribe o elige abajo..."
                      className="w-full bg-[#080810] border border-[#1e1e30] rounded-xl px-4 py-3 text-white text-sm outline-none focus:border-violet-500 focus:shadow-[0_0_0_3px_rgba(139,92,246,0.15)] transition-all mb-2"
                    />
                    {topics.length > 0 && (
                      <div className="mb-2">
                        <p className="text-xs text-[#6b7280] mb-1.5">Mis categorías</p>
                        <div className="flex gap-2 flex-wrap">
                          {topics.map(t => (
                            <button key={t} onClick={() => setSaveTopic(t)} className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${saveTopic === t ? 'bg-violet-700 text-white' : 'bg-violet-900/30 text-violet-300 hover:bg-violet-800/50'}`}>
                              {t}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    <p className="text-xs text-[#6b7280] mb-1.5">Sugerencias</p>
                    <div className="flex gap-2 flex-wrap">
                      {SUGGESTED_TOPICS.filter(t => !topics.includes(t)).map(t => (
                        <button key={t} onClick={() => setSaveTopic(t)} className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${saveTopic === t ? 'bg-violet-700 text-white' : 'bg-[#1e1e30] text-[#9ca3af] hover:text-white'}`}>
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="flex gap-3 mt-6">
                  <button onClick={() => setSaveModal(false)} className="flex-1 py-2.5 rounded-xl border border-[#1e1e30] text-[#9ca3af] hover:text-white text-sm transition-colors">
                    Cancelar
                  </button>
                  <motion.button
                    onClick={confirmSave}
                    disabled={!saveTitle.trim()}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.97 }}
                    className="flex-1 py-2.5 rounded-xl bg-gradient-to-r from-violet-600 to-violet-500 text-white text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                  >
                    Guardar
                  </motion.button>
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Modal Editar */}
      <AnimatePresence>
        {editModal && editItem && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/70 backdrop-blur-sm z-40" onClick={() => setEditModal(false)} />
            <motion.div
              initial={{ opacity: 0, scale: 0.92, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.92 }}
              transition={{ duration: 0.25, ease: 'easeOut' }}
              className="fixed inset-0 flex items-center justify-center z-50 px-4"
            >
              <div className="w-full max-w-md bg-[#0f0f1a] border border-[#1e1e30] rounded-2xl p-6 shadow-2xl">
                <div className="flex items-center justify-between mb-5">
                  <h2 className="text-white font-semibold text-lg">Editar guardado</h2>
                  <button onClick={() => setEditModal(false)} className="text-[#4b5563] hover:text-white transition-colors"><X size={18} /></button>
                </div>

                <div className="space-y-4">
                  <div>
                    <label className="text-xs text-[#9ca3af] mb-1.5 block">Título *</label>
                    <input
                      autoFocus
                      value={editTitle}
                      onChange={e => setEditTitle(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && confirmEdit()}
                      className="w-full bg-[#080810] border border-[#1e1e30] rounded-xl px-4 py-3 text-white text-sm outline-none focus:border-violet-500 focus:shadow-[0_0_0_3px_rgba(139,92,246,0.15)] transition-all"
                    />
                  </div>

                  <div>
                    <label className="text-xs text-[#9ca3af] mb-1.5 block">Tema / Categoría</label>
                    <input
                      value={editTopic}
                      onChange={e => setEditTopic(e.target.value)}
                      placeholder="Escribe o elige abajo..."
                      className="w-full bg-[#080810] border border-[#1e1e30] rounded-xl px-4 py-3 text-white text-sm outline-none focus:border-violet-500 focus:shadow-[0_0_0_3px_rgba(139,92,246,0.15)] transition-all mb-2"
                    />
                    {topics.length > 0 && (
                      <div className="mb-2">
                        <p className="text-xs text-[#6b7280] mb-1.5">Mis categorías</p>
                        <div className="flex gap-2 flex-wrap">
                          {topics.map(t => (
                            <button key={t} onClick={() => setEditTopic(t)} className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${editTopic === t ? 'bg-violet-700 text-white' : 'bg-violet-900/30 text-violet-300 hover:bg-violet-800/50'}`}>
                              {t}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    <p className="text-xs text-[#6b7280] mb-1.5">Sugerencias</p>
                    <div className="flex gap-2 flex-wrap">
                      {SUGGESTED_TOPICS.filter(t => !topics.includes(t)).map(t => (
                        <button key={t} onClick={() => setEditTopic(t)} className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${editTopic === t ? 'bg-violet-700 text-white' : 'bg-[#1e1e30] text-[#9ca3af] hover:text-white'}`}>
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="flex gap-3 mt-6">
                  <button onClick={() => setEditModal(false)} className="flex-1 py-2.5 rounded-xl border border-[#1e1e30] text-[#9ca3af] hover:text-white text-sm transition-colors">
                    Cancelar
                  </button>
                  <motion.button
                    onClick={confirmEdit}
                    disabled={!editTitle.trim()}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.97 }}
                    className="flex-1 py-2.5 rounded-xl bg-gradient-to-r from-violet-600 to-violet-500 text-white text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                  >
                    Guardar cambios
                  </motion.button>
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </main>
  );
}
