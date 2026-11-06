// Drive mode: the examiner's voice (and optional coaching) while you practise with
// GPS, or while rehearsing at home with a simulated drive along the route.
import { buildCuePlan, CueRunner, simSpeedAt } from '../core/examiner.js';
import { bearingAt, cumulative, pointAt } from '../core/geo.js';
import { Speaker } from './speech.js';
import { esc, settings } from './util.js';

export const VOICE_DEFAULTS = { mode: 'mock', tips: 2, showMe: true, chime: true, rate: 1, voiceURI: '' };
export const voiceSettings = () => ({ ...VOICE_DEFAULTS, ...settings.get('voice', {}) });
export const saveVoiceSettings = (patch) => settings.set('voice', { ...voiceSettings(), ...patch });

export class DriveVoice {
  constructor({ caption }) {
    this.captionEl = caption;
    this.speaker = new Speaker({ onCaption: (it) => this.showCaption(it), onEnd: () => this.fadeCaption() });
    this.on = settings.get('voiceOn', false);
    this.route = null;
    this.plan = null;
    this.runner = null;
    this.lastAt = null;
    this.off = false;
    this.applySettings();
  }

  applySettings() {
    this.cfg = voiceSettings();
    Object.assign(this.speaker, { rate: +this.cfg.rate || 1, chime: !!this.cfg.chime, voiceURI: this.cfg.voiceURI || '' });
  }

  setRoute(route) {
    this.end();
    this.route = route;
  }

  get active() { return !!this.runner; }

  /** A fresh drive: new plan (and show-me question), nothing said yet. */
  begin() {
    this.applySettings();
    const c = this.cfg;
    this.plan = this.route ? buildCuePlan(this.route, { mode: c.mode, tipLevel: +c.tips || 2, showMe: !!c.showMe }) : null;
    this.runner = this.plan ? new CueRunner(this.plan) : null;
    this.lastAt = null;
    this.off = false;
    this.speaker.cancel();
    return this.plan;
  }

  /** Settings changed mid-drive: rebuild, without repeating what is behind us. */
  rebuild() {
    if (!this.runner) return this.applySettings();
    const at = this.lastAt;
    this.begin();
    if (at != null) { this.runner.skipTo(at); this.lastAt = at; }
  }

  end() {
    this.runner = null;
    this.plan = null;
    this.speaker.cancel();
    this.hideCaption();
  }

  setOn(on) {
    this.on = on;
    settings.set('voiceOn', on);
    if (on) this.speaker.unlock();
    else { this.speaker.cancel(); this.hideCaption(); }
  }

  /** Car position along the route. jump = moved abruptly (seek, GPS re-acquired). */
  progress({ at, v = 0, t = 0, jump = false }) {
    if (!this.runner) return [];
    if (this.lastAt == null ? at > 150 : jump || at - this.lastAt > 250) {
      this.runner.skipTo(at);
      if (this.lastAt != null) this.speaker.cancel(); // whatever was queued belongs to the old position
    }
    this.lastAt = at;
    this.off = false;
    const due = this.runner.update({ at, v, t });
    if (!this.on) return due;
    for (const c of due) {
      const until = c.kind === 'dir' ? c.at - 2 : c.until;
      this.speaker.say({ en: c.en, zh: c.zh, prio: c.prio, kind: c.kind, fresh: until == null ? null : () => (this.lastAt ?? 0) < until });
    }
    return due;
  }

  /** For the simulated drive: 2 = hold still (opening words), 1 = something is being said, 0 = quiet. */
  busy() {
    if (!this.on) return 0;
    const items = [this.speaker.current, ...this.speaker.queue].filter(Boolean);
    if (items.some((x) => x.kind === 'open')) return 2;
    return items.length ? 1 : 0;
  }

  offRoute() {
    if (this.off || !this.runner || this.lastAt == null) return; // only once we've been on the route
    this.off = true;
    if (this.on) this.speaker.say({ en: "You've left the route.", zh: '已偏离路线', prio: 1, kind: 'tip' });
  }

  /** Read one line now (instruction list preview, voice test). */
  sayNow(en, zh = '') {
    this.applySettings();
    this.speaker.unlock();
    this.speaker.cancel();
    this.speaker.say({ en, zh, prio: 0, kind: 'preview' });
  }

  showCaption(it) {
    const el = this.captionEl;
    if (!el) return;
    clearTimeout(this.capTimer);
    const who = it.kind === 'preview' ? '试听' : it.prio > 0 ? '提示' : '考官';
    el.className = `caption ${it.prio > 0 ? 'tip' : 'exam'}`;
    el.innerHTML = `<span class="who">${who}</span><b lang="en-GB">${esc(it.en)}</b>${it.zh ? `<small>${esc(it.zh)}</small>` : ''}`;
  }

  fadeCaption() {
    clearTimeout(this.capTimer);
    this.capTimer = setTimeout(() => this.hideCaption(), 6000);
  }

  hideCaption() {
    clearTimeout(this.capTimer);
    this.captionEl?.classList.add('hidden');
  }
}

/**
 * Moves a virtual car along the route at a plausible speed (× a time multiplier).
 * busy(): 2 = wait (the examiner's opening words), 1 = slow to real time while the
 * examiner speaks, so nothing is skipped at high multipliers.
 */
export class Simulator {
  constructor({ plan, geometry, onTick, onEnd, busy = () => 0 }) {
    this.busy = busy;
    this.plan = plan;
    this.geom = geometry;
    this.cum = cumulative(geometry);
    this.total = this.cum[this.cum.length - 1];
    this.at = 0;
    this.t = 0;
    this.v = 0;
    this.mult = settings.get('simMult', 2);
    this.playing = false;
    this.onTick = onTick;
    this.onEnd = onEnd;
  }

  play() {
    if (this.playing) return;
    if (this.at >= this.total - 1) this.seek(0);
    this.playing = true;
    this.last = performance.now();
    this.timer = setInterval(() => this.tick(), 200);
    this.emit();
  }

  pause() {
    this.playing = false;
    clearInterval(this.timer);
    this.emit();
  }

  setMult(m) {
    this.mult = m;
    settings.set('simMult', m);
  }

  seek(at) {
    this.at = Math.max(0, Math.min(this.total, at));
    this.emit(true);
  }

  tick() {
    const now = performance.now();
    const busy = this.busy();
    const dt = Math.min(1, (now - this.last) / 1000) * (busy === 1 ? Math.min(1, this.mult) : this.mult);
    this.last = now;
    if (busy === 2) { this.v = 0; this.emit(); return; } // waiting to "move off"
    this.v = simSpeedAt(this.plan, this.at);
    this.at = Math.min(this.total, this.at + this.v * dt);
    this.t += dt;
    if (this.at >= this.total) {
      this.playing = false;
      clearInterval(this.timer);
      this.emit();
      this.onEnd?.();
      return;
    }
    this.emit();
  }

  emit(jump = false) {
    this.onTick({
      at: this.at, t: this.t, jump, playing: this.playing,
      v: this.playing ? this.v : 0,
      p: pointAt(this.geom, this.cum, this.at),
      heading: bearingAt(this.geom, this.cum, this.at, 10),
    });
  }
}
