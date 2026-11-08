// Speech output for drive mode: a British English voice (Web Speech API), a small
// priority queue (examiner directions interrupt coaching tips), an optional chime
// before tips, and a caption callback so every line is also shown on screen.

const estimateMs = (text, rate = 1) => (600 + String(text).split(/\s+/).length * 420) / rate;

// Road numbers the way British sat-navs read them: A1309 → "A 13 oh 9", B1049 → "B 10 49".
const pair = (s) => (s[0] === '0' ? `oh ${s[1]}` : s);
const roadNumber = (d) => (d.length <= 2 ? d : d.length === 3 ? `${d[0]} ${pair(d.slice(1))}` : `${d.slice(0, 2)} ${pair(d.slice(2))}`);
export const speakable = (text) => String(text)
  .replace(/\b([ABM])(\d{2,4})\b/g, (m, l, d) => `${l} ${roadNumber(d)}`)
  .replace(/\byd\b/gi, 'yards');

// Natural-sounding voices first: neural/online voices beat the old offline ones by a mile.
const NATURAL = /natural|neural|premium|enhanced|wavenet|studio/i;
const ONLINE = /online|google|siri/i;
const FEMALE = /female|sonia|libby|hazel|susan|kate|serena|martha|stephanie|emily|amy|jenny|mia|maisie|bella|catherine|fiona|moira|tessa/i;
const MALE = /\bmale\b|ryan|george|daniel|arthur|thomas|oliver|rhys|alfie|ethan|elliot|noah|harry|james/i;
const isFemale = (v) => FEMALE.test(v.name), isMale = (v) => !isFemale(v) && MALE.test(v.name);

export class Speaker {
  constructor({ onCaption = () => {}, onEnd = () => {} } = {}) {
    this.synth = typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;
    this.queue = [];
    this.current = null;
    this.voiceURI = '';
    this.satnavVoiceURI = '';
    this.rate = 1;
    this.chime = true;
    this.onCaption = onCaption;
    this.onEnd = onEnd;
    this.audio = null;
    this.timer = null;
    this.spokenLog = []; // last lines, for debugging / tests
    if (this.synth) {
      this.synth.getVoices(); // Chrome loads voices lazily
      this.synth.addEventListener?.('voiceschanged', () => this.onVoices?.());
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.synth.resume(); });
    }
  }

  get supported() { return !!this.synth; }

  /** English voices: British first, then natural-sounding (neural / online) ones. */
  voices() {
    if (!this.synth) return [];
    const score = (v) => (/^en[-_]gb/i.test(v.lang) ? 100 : 0) + (NATURAL.test(v.name) ? 40 : 0) + (ONLINE.test(v.name) ? 15 : 0)
      + (/united kingdom|\buk\b|british/i.test(v.name) ? 5 : 0) + (v.localService ? 2 : 0);
    return (this.synth.getVoices() || []).filter((v) => /^en([-_]|$)/i.test(v.lang)).sort((a, b) => score(b) - score(a));
  }

  /**
   * Voice for a speaker. The examiner and the sat-nav get different voices when the
   * phone has more than one British voice (a male examiner, a female sat-nav if possible).
   */
  voice(who = 'examiner') {
    const vs = this.voices();
    if (!vs.length) return null;
    const pick = (uri) => (uri ? vs.find((v) => v.voiceURI === uri) : null);
    const gb = vs.filter((v) => /^en[-_]gb/i.test(v.lang));
    const pool = gb.length ? gb : vs;
    const examiner = pick(this.voiceURI) || pool.find(isMale) || pool[0];
    if (who !== 'satnav') return examiner;
    return pick(this.satnavVoiceURI) || pool.find((v) => v !== examiner && isFemale(v)) || pool.find((v) => v !== examiner) || examiner;
  }

  /** Must run inside a tap/click: browsers only allow speech and audio after a user gesture. */
  unlock() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!this.audio && AC) this.audio = new AC();
      this.audio?.resume?.();
    } catch { /* no Web Audio */ }
    if (!this.synth || this.unlocked) return;
    this.unlocked = true; // one silent utterance inside a tap is enough for the whole page
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      this.synth.speak(u);
    } catch { /* ignore */ }
  }

  /**
   * Queue a line. item: {en, zh, prio (0 examiner · 1 tip), fresh?: () => boolean}
   * A higher-priority line cuts off a tip that is being spoken.
   */
  say(item) {
    if (this.current && item.prio < this.current.prio) this.stopCurrent();
    const i = this.queue.findIndex((q) => q.prio > item.prio);
    if (i < 0) this.queue.push(item); else this.queue.splice(i, 0, item);
    if (!this.current) {
      clearTimeout(this.timer);
      // Chrome drops a speak() issued right after cancel(): give it a moment
      const wait = Math.max(0, 150 - (performance.now() - (this.cancelledAt || 0)));
      this.timer = setTimeout(() => this.next(), wait);
    }
  }

  cancel() {
    this.queue = [];
    this.stopCurrent();
  }

  stopCurrent() {
    clearTimeout(this.timer);
    this.current = null;
    this.cancelledAt = performance.now();
    try { this.synth?.cancel(); } catch { /* ignore */ }
  }

  async next() {
    if (this.current) return;
    let item;
    while ((item = this.queue.shift())) if (!item.fresh || item.fresh()) break;
    if (!item) return;
    this.current = item;
    this.spokenLog.push(item.en);
    if (this.spokenLog.length > 50) this.spokenLog.shift();
    this.onCaption(item);
    if (item.prio > 0 && this.chime) await this.playChime();
    if (this.current !== item) return; // interrupted during the chime
    if (!this.synth) { // no speech engine: captions only
      this.timer = setTimeout(() => this.finish(item), estimateMs(item.en, this.rate));
      return;
    }
    const u = new SpeechSynthesisUtterance(speakable(item.en));
    // no English voice listed (some Android builds list none until later): let the engine pick for en-GB
    const v = this.voice(item.who);
    if (v) u.voice = v;
    u.lang = v?.lang || 'en-GB';
    // one voice for both speakers: tell them apart by pitch (sat-nav a little higher and brisker)
    const same = item.who === 'satnav' && v && v === this.voice('examiner');
    u.rate = this.rate * (item.who === 'satnav' ? 1.02 : 0.96);
    u.pitch = same ? 1.15 : item.who === 'satnav' ? 1.03 : 0.95;
    u.onend = u.onerror = () => this.finish(item);
    // Android sometimes never fires onend: don't let the queue stall
    this.timer = setTimeout(() => this.finish(item), estimateMs(item.en, this.rate) + 4000);
    try { this.synth.speak(u); } catch { this.finish(item); }
  }

  finish(item) {
    if (this.current !== item) return;
    clearTimeout(this.timer);
    this.current = null;
    this.onEnd(item);
    this.timer = setTimeout(() => this.next(), 300); // short pause between lines
  }

  /** Two soft notes, so a coaching tip never sounds like an examiner direction. */
  playChime() {
    const ac = this.audio;
    if (!ac || ac.state !== 'running') return Promise.resolve();
    const t = ac.currentTime + 0.02;
    [[880, 0], [1320, 0.13]].forEach(([f, dt]) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + dt);
      g.gain.exponentialRampToValueAtTime(0.2, t + dt + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.2);
      o.connect(g).connect(ac.destination);
      o.start(t + dt);
      o.stop(t + dt + 0.22);
    });
    return new Promise((res) => setTimeout(res, 420));
  }
}
