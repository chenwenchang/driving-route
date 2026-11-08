// What is said in a YouTube route video, with timestamps (the source for a route's voice lines):
//   node scripts/video/text.mjs <YouTube id or URL> [...more]
//   npm run video-text -- <id>
//
// Uses the video's English captions when YouTube has them. Otherwise it downloads the audio and
// transcribes it with Whisper, through ffmpeg's whisper filter. Never fall back to generated
// directions: the point is to hear what the sat-nav and the examiner really said.
//
// Writes .cache/transcripts/<id>.txt ("m:ss text" per line) next to the raw .json3 / .srt file,
// and prints it. Tools are not in git; put them here once (or set YTDLP / WHISPER_MODEL / WHISPER_VAD):
//   .tools/yt-dlp/yt-dlp(.exe)             https://github.com/yt-dlp/yt-dlp/releases/latest
//   .tools/whisper/ggml-small.en.bin       https://huggingface.co/ggerganov/whisper.cpp (resolve/main/ggml-small.en.bin)
//   .tools/whisper/ggml-silero-v5.1.2.bin  https://huggingface.co/ggml-org/whisper-vad (resolve/main/ggml-silero-v5.1.2.bin)
//   ffmpeg 8 or newer built with whisper   (Windows: winget install Gyan.FFmpeg)
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYouTubeId } from '../../app/js/core/model.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const win = process.platform === 'win32';
const local = (p) => join(root, p);
const YTDLP = process.env.YTDLP || (existsSync(local(`.tools/yt-dlp/yt-dlp${win ? '.exe' : ''}`)) ? local(`.tools/yt-dlp/yt-dlp${win ? '.exe' : ''}`) : 'yt-dlp');
const MODEL = process.env.WHISPER_MODEL || local('.tools/whisper/ggml-small.en.bin');
const VAD = process.env.WHISPER_VAD || local('.tools/whisper/ggml-silero-v5.1.2.bin');
const OUT = local('.cache/transcripts');
const AUDIO = local('.cache/audio');

const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20, ...opts }).toString();
const ytdlp = (args) => run(YTDLP, ['--js-runtimes', 'node', '--no-warnings', '--no-progress', ...args]);

/** YouTube json3 captions → lines: a new line after a pause of 2.5 s or a full stop. */
export function captionLines(j) {
  const words = [];
  for (const e of j.events || []) {
    if (!e.segs || e.aAppend) continue;
    for (const s of e.segs) {
      const w = s.utf8.replace(/\n/g, ' ').trim();
      if (w) words.push([(e.tStartMs + (s.tOffsetMs || 0)) / 1000, w]);
    }
  }
  const lines = [];
  let cur = null;
  for (const [t, w] of words) {
    if (!cur || t - cur.last > 2.5 || /[.?!]$/.test(cur.text)) { cur = { t, text: w, last: t }; lines.push(cur); }
    else { cur.text += ` ${w}`; cur.last = t; }
  }
  return lines.map(({ t, text }) => ({ t, text }));
}

/** SubRip text → lines. */
export function srtLines(srt) {
  const out = [];
  for (const block of srt.replace(/\r/g, '').split(/\n\n+/)) {
    const m = block.match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->[^\n]*\n([\s\S]*)/);
    if (!m) continue;
    const text = m[5].replace(/\s+/g, ' ').trim();
    if (text) out.push({ t: +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000, text });
  }
  return out;
}

function captions(id) {
  ytdlp(['--skip-download', '--write-subs', '--write-auto-subs', '--sub-langs', 'en,en-GB,en-orig', '--sub-format', 'json3',
    '-o', join(OUT, '%(id)s.%(ext)s'), `https://www.youtube.com/watch?v=${id}`]);
  for (const lang of ['en-GB', 'en', 'en-orig']) {
    const f = join(OUT, `${id}.${lang}.json3`);
    if (existsSync(f)) return { how: `YouTube captions (${lang})`, lines: captionLines(JSON.parse(readFileSync(f, 'utf8'))) };
  }
  return null;
}

const CHUNK = 240, OVERLAP = 10; // s

/** Run ffmpeg without blocking (several pieces of audio are transcribed at once). */
const ffmpeg = (args) => new Promise((resolve, reject) => {
  const p = spawn('ffmpeg', args, { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
  p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err}`))));
});

async function transcribe(id) {
  for (const [f, what] of [[MODEL, 'Whisper model'], [VAD, 'Whisper VAD model']]) {
    if (!existsSync(f)) throw new Error(`${what} missing: ${f} (see the top of this file)`);
  }
  mkdirSync(AUDIO, { recursive: true });
  let audio = ['m4a', 'webm', 'opus', 'mp3'].map((x) => join(AUDIO, `${id}.${x}`)).find(existsSync);
  if (!audio) {
    ytdlp(['-f', 'bestaudio[ext=m4a]/bestaudio', '-o', join(AUDIO, '%(id)s.%(ext)s'), `https://www.youtube.com/watch?v=${id}`]);
    audio = ['m4a', 'webm', 'opus', 'mp3'].map((x) => join(AUDIO, `${id}.${x}`)).find(existsSync);
    if (!audio) throw new Error('audio download failed');
  }
  const dur = +run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', audio]).trim();
  // ffmpeg's whisper filter uses about one CPU core: cut the audio into overlapping pieces and
  // transcribe them in parallel. Filter options are ':'-separated, so paths stay relative (no drive letters).
  const rel = (p) => relative(root, p).replace(/\\/g, '/');
  const starts = [];
  for (let s = 0; s < dur; s += CHUNK) starts.push(s);
  const part = (k) => join(OUT, `${id}.part${k}.srt`);
  const jobs = starts.map((s, k) => () => ffmpeg(['-hide_banner', '-nostats', '-loglevel', 'error', '-y', '-ss', String(s), '-t', String(CHUNK + OVERLAP),
    '-i', rel(audio), '-vn', '-af', `whisper=model=${rel(MODEL)}:language=en:queue=20:vad_model=${rel(VAD)}:destination=${rel(part(k))}:format=srt`, '-f', 'null', '-']));
  await pool(jobs, Math.max(2, Math.floor(cpus().length * 0.75)));
  // stitch: each piece keeps its lines up to the middle of the overlap with the next
  const lines = [];
  starts.forEach((s, k) => {
    const lo = k ? s + OVERLAP / 2 : 0, hi = k < starts.length - 1 ? starts[k + 1] + OVERLAP / 2 : Infinity;
    for (const l of srtLines(readFileSync(part(k), 'utf8'))) if (s + l.t >= lo && s + l.t < hi) lines.push({ t: s + l.t, text: l.text });
  });
  return { how: `Whisper transcription of the audio (${starts.length} pieces)`, lines };
}

/** Run async jobs with at most n at a time. */
async function pool(jobs, n) {
  let next = 0;
  const worker = async () => { while (next < jobs.length) await jobs[next++](); };
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, worker));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ids = process.argv.slice(2).map(parseYouTubeId).filter(Boolean);
  if (!ids.length) { console.error('usage: node scripts/video/text.mjs <YouTube id or URL> [...]'); process.exit(1); }
  mkdirSync(OUT, { recursive: true });
  for (const id of ids) {
    const res = captions(id) || await transcribe(id);
    const text = res.lines.map((l) => `${fmt(l.t)} ${l.text}`).join('\n');
    writeFileSync(join(OUT, `${id}.txt`), `${text}\n`);
    console.log(`== ${id}: ${res.how}, ${res.lines.length} lines → ${relative(root, join(OUT, `${id}.txt`))}\n${text}\n`);
  }
}
