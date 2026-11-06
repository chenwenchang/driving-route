// Video sources for the editor: YouTube embed (IFrame API) or a local video file,
// plus "tab capture" so YouTube frames can be screenshotted with one click.
import { toJpeg } from './ui/util.js';

let ytReady;
function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  ytReady ??= new Promise((res, rej) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); res(window.YT); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => rej(new Error('无法加载 YouTube 播放器（网络问题？）'));
    document.head.append(s);
  });
  return ytReady;
}

/** Common interface: kind, time, duration, playing, seek(t), play(), pause(), toggle(), setRate(r), destroy() */
export class YouTubeSource {
  constructor(host, { onError, onState } = {}) {
    this.kind = 'youtube';
    this.host = host;
    this.onError = onError;
    this.onState = onState;
    this.player = null;
    this.ready = false;
  }

  async load(videoId, start = 0) {
    const YT = await loadYouTubeApi();
    this.host.innerHTML = '<div id="yt-slot"></div>';
    await new Promise((res) => {
      this.player = new YT.Player('yt-slot', {
        videoId,
        width: '100%', height: '100%',
        playerVars: { start: Math.floor(start || 0), rel: 0, modestbranding: 1, playsinline: 1, origin: location.origin },
        events: {
          onReady: () => { this.ready = true; res(); },
          onStateChange: (e) => this.onState?.(e.data),
          onError: (e) => {
            const msg = { 2: '视频 ID 无效', 5: '播放出错', 100: '视频不存在或已设为私有', 101: '作者不允许嵌入播放', 150: '作者不允许嵌入播放' }[e.data] || `播放错误 ${e.data}`;
            this.onError?.(`${msg}。可以在 YouTube 上看，在这里手动输入时间。`);
            res();
          },
        },
      });
    });
  }

  get time() { try { return this.ready ? this.player.getCurrentTime() : 0; } catch { return 0; } }
  get duration() { try { return this.player.getDuration(); } catch { return 0; } }
  get playing() { try { return this.player.getPlayerState() === 1; } catch { return false; } }
  seek(t) { try { this.player.seekTo(Math.max(0, t), true); } catch { /* not ready */ } }
  play() { try { this.player.playVideo(); } catch { /* */ } }
  pause() { try { this.player.pauseVideo(); } catch { /* */ } }
  toggle() { this.playing ? this.pause() : this.play(); }
  setRate(r) { try { this.player.setPlaybackRate(r); } catch { /* */ } }
  destroy() { try { this.player?.destroy(); } catch { /* */ } this.host.innerHTML = ''; }
  /** element whose pixels a tab capture should crop to */
  get frameEl() { return this.host; }
}

export class FileSource {
  constructor(host, { onState } = {}) {
    this.kind = 'file';
    this.host = host;
    this.onState = onState;
  }

  async load(file) {
    this.url = URL.createObjectURL(file);
    this.host.innerHTML = '';
    this.video = Object.assign(document.createElement('video'), { src: this.url, controls: true, playsInline: true });
    this.video.addEventListener('play', () => this.onState?.(1));
    this.video.addEventListener('pause', () => this.onState?.(2));
    this.host.append(this.video);
    await new Promise((res) => this.video.addEventListener('loadedmetadata', res, { once: true }));
  }

  get time() { return this.video?.currentTime || 0; }
  get duration() { return this.video?.duration || 0; }
  get playing() { return !!this.video && !this.video.paused; }
  seek(t) { if (this.video) this.video.currentTime = Math.max(0, t); }
  play() { this.video?.play(); }
  pause() { this.video?.pause(); }
  toggle() { this.playing ? this.pause() : this.play(); }
  setRate(r) { if (this.video) this.video.playbackRate = r; }
  destroy() { this.video?.pause(); if (this.url) URL.revokeObjectURL(this.url); this.host.innerHTML = ''; }
  get frameEl() { return this.video; }

  /** Grab the current frame as JPEG. */
  async capture() {
    if (!this.video?.videoWidth) throw new Error('视频还没加载好');
    return toJpeg(this.video);
  }
}

/**
 * One-click screenshots of an embedded YouTube player: the browser shares this
 * tab once, then each capture crops the player's rectangle out of the stream.
 */
export class TabCapture {
  constructor() { this.stream = null; this.video = null; this.cropped = false; }
  get active() { return !!this.stream && this.stream.getVideoTracks()[0]?.readyState === 'live'; }
  static supported() { return !!navigator.mediaDevices?.getDisplayMedia; }

  async start() {
    this.stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser', frameRate: 10 },
      audio: false,
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
    });
    const track = this.stream.getVideoTracks()[0];
    track.addEventListener('ended', () => this.stop());
    this.video = Object.assign(document.createElement('video'), { muted: true, playsInline: true });
    this.video.srcObject = this.stream;
    await this.video.play();
    this.cropped = false;
  }

  async capture(el) {
    if (!this.active) throw new Error('请先开启一键截图');
    const v = this.video;
    await new Promise((r) => requestAnimationFrame(() => r()));
    const vw = v.videoWidth, vh = v.videoHeight;
    const rect = el.getBoundingClientRect();
    // the stream is the tab's viewport; check the user really shared this tab
    const ratioStream = vw / vh, ratioView = innerWidth / innerHeight;
    if (Math.abs(ratioStream - ratioView) / ratioView > 0.06) throw new Error('共享的似乎不是当前标签页，请停止后重新开启，并选择"此标签页"');
    const sx = vw / innerWidth, sy = vh / innerHeight;
    const c = document.createElement('canvas');
    c.width = Math.round(rect.width * sx);
    c.height = Math.round(rect.height * sy);
    c.getContext('2d').drawImage(v, rect.left * sx, rect.top * sy, rect.width * sx, rect.height * sy, 0, 0, c.width, c.height);
    return toJpeg(c);
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video = null;
  }
}
