// =====================================================================
// Crime to Say Karaoke Booth
// One-page virtual karaoke booth: camera + mic capture, synced lyric/ball
// overlay, mixed audio recording, and MP4 export ready for sharing.
// =====================================================================

// This file now has its own 1-bar (4-beat, 80bpm) intro baked in with real
// instrumental sound, replacing the old silent gap we used to fill with our
// own synthesized count-in beeps. Everything else about the song (and the
// .lrc timings) is unchanged relative to where the "real" song content
// starts, i.e. exactly 1 bar into the file.
const AUDIO_FILE = './Crime2Say-wintro.mp3';
const LRC_FILE = './crime-2-say-oke-shortest.lrc';
const OUTPUT_PREFIX = 'Crime2Say-';

const BPM = 80;
const BEAT_SEC = 60 / BPM;
const INTRO_BEATS = 4; // 1 bar at 80bpm, baked into the start of AUDIO_FILE

// Audio mix levels. Two separate music gains are used: one for what the
// singer hears live (kept loud so they can perform to it), and a lower one
// that's actually recorded (so their voice cuts through in the final mix).
const MIC_GAIN = 3.0;
const MIC_MAKEUP_GAIN = 2.2; // applied after compression to lift quiet mics (see beginRecording)
const MUSIC_LIVE_GAIN = 0.85;
const MUSIC_REC_BASE_GAIN = 0.5;
const MUSIC_REC_DUCK_GAIN = 0.32;
const DUCK_THRESHOLD = 0.035;

// The mic's own capture pipeline (hardware buffer + OS + browser) adds real
// latency before samples reach us, while the backing track is scheduled on
// the audio clock with ~zero latency. Left uncompensated, the singer's
// voice lands measurably late relative to the music in the recording even
// though it sounded in-sync live. This delays only the *recorded* copy of
// the music (never live monitoring, never the mic) so it lines back up
// with when the voice actually arrives. Tune this if a device still drifts.
const MUSIC_REC_SYNC_DELAY_SEC = 0.13;

// Separately: the camera's own capture pipeline (sensor -> ISP -> browser)
// means the *video* frame drawn "now" actually shows a moment slightly in
// the past, while the audio graph above has ~zero latency by comparison.
// Mic and music are already correctly synced to each other (above); this
// delays that whole finished mix an extra step further so it lines up with
// what the lagging video is actually showing, rather than the true moment
// it was captured. Applied only to the recorded mix, never live monitoring.
const VIDEO_CAPTURE_LATENCY_SEC = 0.18;

const MAX_CANVAS_DIM = 1280;
const TITLE_LINES = ['THE CRIME TO SAY', 'KARAOKE', 'CHALLENGE!'];
const END_LINES = ['JOIN THE CRIME TO SAY', 'KARAOKE CHALLENGE:', 'CRIME2SAY.UK'];

const GREEN_BRIGHT = '#00ff7f';
const RED_BRIGHT = '#ff2b2b'; // vivid highlight red, used for the active lyric word
const WHITE = '#ffffff';
const RED_DROP_SHADOW = '#7a1414'; // dark red, flat drop shadow behind the title/end card text

// ---------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------
const PREVIEW = document.getElementById('preview');
const CANVAS = document.getElementById('stageCanvas');
const CTX = CANVAS.getContext('2d');
const FRAME = document.getElementById('frame');
const BOOTH = document.getElementById('booth');
const PERMISSION_GATE = document.getElementById('permissionGate');
const PERMISSION_TEXT = document.getElementById('permissionText');
const PERMISSION_RETRY = document.getElementById('permissionRetry');
const COUNTDOWN = document.getElementById('countdown');
const RECORD_BTN = document.getElementById('recordBtn');
const RECORD_LABEL = RECORD_BTN.querySelector('.rec-btn__label');
const HELPER_TEXT = document.getElementById('helperText');

const MODAL = document.getElementById('resultModal');
const MODAL_TITLE = document.getElementById('modalTitle');
const MODAL_SPINNER = document.getElementById('modalSpinner');
const RESULT_VIDEO = document.getElementById('resultVideo');
const MODAL_SHARE_TIP = document.getElementById('modalShareTip');
const SAVE_BTN = document.getElementById('saveBtn');
const RETRY_BTN = document.getElementById('retryBtn');

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------
let cameraStream = null;
let audioCtx = null;
let musicBuffer = null;
let musicBufferPromise = null;

let lyricLines = [];
let lyricFontSize = 40;

let appState = 'idle'; // idle | countingIn | recording | processing
let musicStartAudioTime = null; // audioCtx time reference for lyric/ball clock

let mediaRecorder = null;
let recordedChunks = [];
let recDestination = null;
let micSourceNode = null;
let micGainNode = null;
let musicLiveGainNode = null;
let musicRecGainNode = null;
let musicSourceNode = null;
let duckTimer = null;
let activeCaptureVideoTrack = null;

let ffmpegPromise = null;

let resultObjectUrl = null;
let drawLoopStarted = false;

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
  loadLyrics();
  preloadMusic();
  warmUpFFmpeg();
  initCamera();
});

PERMISSION_RETRY.addEventListener('click', initCamera);
RECORD_BTN.addEventListener('click', onRecordButton);
RETRY_BTN.addEventListener('click', resetForNewTake);
SAVE_BTN.addEventListener('click', onSaveClicked);

// Tapping the backdrop (not the panel itself) closes the result and resets
// for a new take — only once a finished video is actually showing, so this
// can't interrupt an in-progress conversion.
MODAL.addEventListener('click', (e) => {
  if (e.target === MODAL && pendingBlob) resetForNewTake();
});

// ---------------------------------------------------------------------
// Camera / mic setup
// ---------------------------------------------------------------------
async function initCamera() {
  PERMISSION_GATE.classList.remove('hidden');
  PERMISSION_RETRY.classList.add('hidden');
  PERMISSION_TEXT.textContent = 'Requesting camera & microphone access…';

  try {
    // getUserMedia is only available in a secure context (https, or
    // localhost). Outside of one, navigator.mediaDevices is undefined and
    // calling it would throw with a confusing generic error — catch it here
    // so the message actually points at the real problem (usually the page
    // being loaded over plain http, e.g. via a misconfigured custom domain).
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('INSECURE_CONTEXT');
    }

    // Deliberately no width/height constraints at all. Asking for a narrow
    // portrait-shaped ideal (e.g. 720x1280) previously caused some phones
    // to have the *camera itself* digitally crop/zoom its sensor to match
    // that exact ratio, rather than just scaling down its natural field of
    // view — stacked with our own cover-crop in drawMirroredCoverVideo(),
    // that compounded into a badly over-zoomed recording. Taking whatever
    // the camera gives us natively and doing all the aspect-fitting
    // ourselves in one place is more robust across devices.
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user' },
      // Deliberately no echoCancellation/noiseSuppression/autoGainControl:
      // that adaptive processing adds latency and, on several phones, was
      // intermittently gating/dropping the mic when it heard the loud
      // backing track as "echo" to cancel. We control levels ourselves.
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });

    PREVIEW.srcObject = cameraStream;
    await PREVIEW.play().catch(() => {});

    PERMISSION_GATE.classList.add('hidden');
    RECORD_BTN.disabled = false;

    PREVIEW.addEventListener('loadedmetadata', fitFrameToVideo);
    fitFrameToVideo();

    if (!drawLoopStarted) {
      drawLoopStarted = true;
      scheduleNextFrame();
    }
  } catch (err) {
    console.error('Camera/mic error', err);
    PERMISSION_TEXT.textContent =
      err && err.message === 'INSECURE_CONTEXT'
        ? 'This page needs to be loaded over a secure https:// link for camera access to work — check the URL you opened.'
        : 'Camera & microphone access is needed for the karaoke booth to work.';
    PERMISSION_RETRY.classList.remove('hidden');
    RECORD_BTN.disabled = true;
  }
}

// Sizes the on-screen preview frame (exact pixels, not CSS aspect-ratio) and
// the recording canvas buffer. The *target shape* always follows the actual
// viewport orientation, never the camera's own reported dimensions — some
// browsers don't honor portrait/landscape hints reliably, and trusting the
// camera's aspect ratio directly can produce a sideways/cropped recording.
// The camera frame is then cropped-to-fill that shape (like CSS
// object-fit: cover) when drawn, in drawMirroredCoverVideo().
function fitFrameToVideo() {
  const vw = PREVIEW.videoWidth;
  const vh = PREVIEW.videoHeight;
  if (!vw || !vh) return;
  if (appState === 'recording' || appState === 'countingIn') return; // don't resize mid-take

  lastKnownVW = vw;
  lastKnownVH = vh;

  const viewportAspect = window.innerWidth / window.innerHeight;
  let cw, ch;
  if (viewportAspect <= 1) {
    ch = MAX_CANVAS_DIM;
    cw = Math.max(2, Math.round(ch * viewportAspect));
  } else {
    cw = MAX_CANVAS_DIM;
    ch = Math.max(2, Math.round(cw / viewportAspect));
  }
  CANVAS.width = cw;
  CANVAS.height = ch;

  const isLandscape = window.matchMedia('(orientation: landscape)').matches;
  const heightCapPx = window.innerHeight * (isLandscape ? 0.58 : 0.64);
  const availW = BOOTH.clientWidth;

  let boxW = availW;
  let boxH = boxW * (ch / cw);
  if (boxH > heightCapPx) {
    boxH = heightCapPx;
    boxW = boxH * (cw / ch);
  }
  FRAME.style.width = `${Math.round(boxW)}px`;
  FRAME.style.height = `${Math.round(boxH)}px`;

  lyricFontSize = computeLyricFontSize();
}

window.addEventListener('resize', () => { if (appState === 'idle') fitFrameToVideo(); });
window.addEventListener('orientationchange', () => { if (appState === 'idle') fitFrameToVideo(); });

// Many mobile browsers don't reliably fire resize/orientationchange when the
// camera's own reported dimensions change on rotation, so poll for it too
// (cheap, and only while idle/pre-recording).
let lastKnownVW = 0;
let lastKnownVH = 0;
setInterval(() => {
  if (appState !== 'idle') return;
  if (PREVIEW.videoWidth && (PREVIEW.videoWidth !== lastKnownVW || PREVIEW.videoHeight !== lastKnownVH)) {
    fitFrameToVideo();
  }
}, 400);

// ---------------------------------------------------------------------
// LRC parsing (enhanced/word-level LRC)
// ---------------------------------------------------------------------
async function loadLyrics() {
  try {
    const text = await (await fetch(LRC_FILE)).text();
    lyricLines = parseEnhancedLRC(text);
    lyricFontSize = computeLyricFontSize();
  } catch (e) {
    console.warn('Could not load lyrics file', e);
    lyricLines = [];
  }
}

function timeToSeconds(mm, ss) {
  return parseInt(mm, 10) * 60 + parseFloat(ss);
}

function parseEnhancedLRC(text) {
  const rawLines = [];
  const lines = text.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith('[')) continue;

    const header = line.match(/^\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/);
    if (!header) continue;

    const lineStart = timeToSeconds(header[1], header[2]);
    const rest = header[3];

    const tagRe = /<(\d+):(\d+(?:\.\d+)?)>/g;
    const tags = [];
    let m;
    while ((m = tagRe.exec(rest)) !== null) {
      tags.push({ time: timeToSeconds(m[1], m[2]), index: m.index, end: tagRe.lastIndex });
    }

    const words = [];
    if (tags.length === 0) {
      const plain = rest.trim();
      if (plain) {
        plain.split(/\s+/).forEach((w, i) => {
          if (w) words.push({ text: w, start: lineStart + i * 0.3 });
        });
      }
    } else {
      const pre = rest.slice(0, tags[0].index).trim();
      if (pre) words.push({ text: pre, start: lineStart });

      for (let i = 0; i < tags.length; i++) {
        const segStart = tags[i].end;
        const segEnd = i + 1 < tags.length ? tags[i + 1].index : rest.length;
        const segText = rest.slice(segStart, segEnd).trim();
        if (segText) words.push({ text: segText, start: tags[i].time });
      }
    }

    if (words.length) rawLines.push({ start: lineStart, words });
  }

  for (let i = 0; i < rawLines.length; i++) {
    rawLines[i].end =
      i + 1 < rawLines.length
        ? rawLines[i + 1].start
        : rawLines[i].words[rawLines[i].words.length - 1].start + 1.6;
  }
  for (const ln of rawLines) {
    for (let i = 0; i < ln.words.length; i++) {
      ln.words[i].end = i + 1 < ln.words.length ? ln.words[i + 1].start : ln.end;
    }
  }
  return rawLines;
}

// ---------------------------------------------------------------------
// Backing track preload (decoded once, played sample-accurately later)
// ---------------------------------------------------------------------
function preloadMusic() {
  musicBufferPromise = (async () => {
    const ctx = getAudioCtx();
    const arrayBuffer = await (await fetch(AUDIO_FILE)).arrayBuffer();
    musicBuffer = await ctx.decodeAudioData(arrayBuffer);
    return musicBuffer;
  })();
  musicBufferPromise.catch((e) => console.warn('Music preload failed', e));
}

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

// ---------------------------------------------------------------------
// Lyric layout + bouncing ball
// ---------------------------------------------------------------------
function fitFontSizeToWidth(lines, marginRatio, fontSpec) {
  if (!CANVAS.width || !lines.length) return Math.round((CANVAS.width || 720) * 0.06);
  const maxWidth = CANVAS.width * marginRatio;
  const REF = 100;
  CTX.font = fontSpec(REF);
  let longest = 0;
  for (const text of lines) {
    const w = CTX.measureText(text).width;
    if (w > longest) longest = w;
  }
  if (longest === 0) return Math.round(CANVAS.width * 0.06);
  return Math.floor(REF * (maxWidth / longest));
}

function computeLyricFontSize() {
  if (!CANVAS.width || !lyricLines.length) return Math.round((CANVAS.width || 720) * 0.08);
  const isPortrait = CANVAS.height >= CANVAS.width;
  const marginRatio = isPortrait ? 0.88 : 0.8;
  const lines = lyricLines.map((l) => l.words.map((w) => w.text).join(' '));
  let fontSize = fitFontSizeToWidth(lines, marginRatio, (px) => `bold ${px}px Arial`);
  const capFraction = isPortrait ? 0.24 : 0.16;
  fontSize = Math.min(fontSize, Math.round(CANVAS.height * capFraction));
  fontSize = Math.max(fontSize, Math.round(CANVAS.width * 0.035));
  return fontSize;
}

function layoutLine(line, fontSize) {
  CTX.font = `bold ${fontSize}px Arial`;
  const space = CTX.measureText(' ').width;
  const words = line.words.map((w) => ({ ...w, width: CTX.measureText(w.text).width }));
  const totalWidth = words.reduce((s, w) => s + w.width, 0) + space * (words.length - 1);
  let x = Math.max(fontSize * 0.4, (CANVAS.width - totalWidth) / 2);
  for (const w of words) {
    w.x = x + w.width / 2;
    x += w.width + space;
  }
  return words;
}

function findActiveLineIndex(t) {
  for (let i = 0; i < lyricLines.length; i++) {
    if (t >= lyricLines[i].start && t < lyricLines[i].end) return i;
  }
  return -1;
}

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }

function lyricBaselineY() {
  return Math.round(CANVAS.height * 0.8);
}

function drawLyricsAndBall(t) {
  const lineIndex = findActiveLineIndex(t);
  if (lineIndex === -1) return;
  const line = lyricLines[lineIndex];

  const words = layoutLine(line, lyricFontSize);
  const baselineY = lyricBaselineY();

  let activeIndex = words.findIndex((w) => t >= w.start && t < w.end);

  CTX.textBaseline = 'alphabetic';
  CTX.textAlign = 'left';
  CTX.lineJoin = 'round';
  CTX.font = `bold ${lyricFontSize}px Arial`;
  CTX.lineWidth = Math.max(2, Math.round(lyricFontSize * 0.08));

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const isActive = i === activeIndex;
    CTX.fillStyle = isActive ? RED_BRIGHT : WHITE;
    CTX.strokeStyle = 'rgba(0,0,0,0.85)';
    const drawX = w.x - w.width / 2;
    CTX.strokeText(w.text, drawX, baselineY);
    CTX.fillText(w.text, drawX, baselineY);
  }

  drawBall(lineIndex, line, words, activeIndex, t, baselineY);
}

function drawBall(lineIndex, line, words, activeIndex, t, baselineY) {
  const restY = baselineY - lyricFontSize * 1.05;
  const amplitude = lyricFontSize * 1.5;
  const radius = Math.max(8, lyricFontSize * 0.22);
  const offLeft = -radius * 3;
  const offRight = CANVAS.width + radius * 3;

  let x = null, y = null;

  const firstWord = words[0];
  const lastWord = words[words.length - 1];

  if (t < firstWord.start) {
    // Base the entry's lead-in time on the actual gap since the *previous*
    // line's last word, not this line's own bracket timestamp — those often
    // coincide (many lines' first word has no lead-in tag and starts right
    // at the line marker), which left zero runway for the fly-in animation
    // and made the ball just snap onto the word out of nowhere.
    const prevLine = lyricLines[lineIndex - 1];
    const prevLastWordStart =
      prevLine && prevLine.words.length
        ? prevLine.words[prevLine.words.length - 1].start
        : firstWord.start - 0.4; // song's very first line: fixed lead-in
    const entryDuration = Math.min(0.5, Math.max(0.05, firstWord.start - prevLastWordStart));
    const entryStart = firstWord.start - entryDuration;
    if (t >= entryStart) {
      const p = easeInOut(clamp((t - entryStart) / entryDuration, 0, 1));
      x = lerp(offLeft, firstWord.x, p);
      y = restY - Math.sin(Math.PI * p) * amplitude;
    }
  } else if (activeIndex === words.length - 1) {
    const exitDuration = Math.min(0.5, line.end - lastWord.start);
    if (exitDuration > 0) {
      const p = clamp((t - lastWord.start) / exitDuration, 0, 1);
      const eased = easeInOut(p);
      x = lerp(lastWord.x, offRight, eased);
      y = restY - Math.sin(Math.PI * eased) * amplitude * 0.85;
    }
  } else if (activeIndex >= 0 && activeIndex < words.length - 1) {
    const a = words[activeIndex];
    const b = words[activeIndex + 1];
    const p = clamp((t - a.start) / (b.start - a.start), 0, 1);
    const eased = easeInOut(p);
    x = lerp(a.x, b.x, eased);
    y = restY - Math.sin(Math.PI * p) * amplitude;
  }

  if (x === null) return;

  CTX.beginPath();
  CTX.fillStyle = GREEN_BRIGHT;
  CTX.arc(x, y, radius, 0, Math.PI * 2);
  CTX.fill();
}

// Centered multi-line title/end card, used for the moment before the music
// kicks in and the moment after the last lyric — not shown during singing.
// `elapsed` is seconds since this particular card started being shown, and
// drives a quick pop-in scale animation (never starts invisible, so it's
// always clearly there from the very first frame it's shown on).
// `anchorLineIndex`: null anchors the bottom edge of the last line to the
// bottom-third line (used for the title); a number anchors the vertical
// center of that line index to it instead (used for the end card).
function drawCenteredCard(lines, color = GREEN_BRIGHT, elapsed = Infinity, anchorLineIndex = null) {
  const isPortrait = CANVAS.height >= CANVAS.width;
  const marginRatio = isPortrait ? 0.88 : 0.8;
  const fontSpec = (px) => `bold ${px}px Arial`;

  let size = fitFontSizeToWidth(lines, marginRatio, fontSpec);
  size = Math.min(size, Math.round(CANVAS.height * (isPortrait ? 0.1 : 0.13)));
  size = Math.max(size, Math.round(CANVAS.width * 0.045));

  const gap = size * 1.35;
  const bottomThirdY = CANVAS.height * (2 / 3);
  let firstY;
  if (anchorLineIndex !== null) {
    firstY = bottomThirdY - gap * anchorLineIndex;
  } else {
    // Bottom edge of the lowest line sits right on the bottom-third line.
    const lastY = bottomThirdY - gap / 2 - size * 0.5;
    firstY = lastY - gap * (lines.length - 1);
  }
  const lastY = firstY + gap * (lines.length - 1);
  const cx = CANVAS.width / 2;

  const REVEAL_DUR = 0.18;
  const revealEased = 0.5 + 0.5 * easeInOut(clamp(elapsed / REVEAL_DUR, 0, 1));
  const scale = 0.92 + 0.08 * revealEased;
  const centerY = (firstY + lastY) / 2;

  CTX.save();
  CTX.translate(cx, centerY);
  CTX.scale(scale, scale);
  CTX.translate(-cx, -centerY);

  CTX.font = fontSpec(size);
  CTX.textAlign = 'center';
  CTX.textBaseline = 'middle';
  CTX.lineJoin = 'round'; // avoids spiky miter joins ("devil horns") on bold glyph corners

  // Pronounced drop shadow, dark red, with real spread (blur) — drawn once,
  // offset behind the main text.
  const shadowOffset = Math.round(size * 0.13);
  CTX.save();
  CTX.shadowColor = RED_DROP_SHADOW;
  CTX.shadowBlur = size * 0.16;
  CTX.shadowOffsetX = shadowOffset;
  CTX.shadowOffsetY = shadowOffset;
  CTX.fillStyle = RED_DROP_SHADOW;
  lines.forEach((line, i) => {
    const y = firstY + gap * i;
    CTX.fillText(line, cx, y);
  });
  CTX.restore();

  CTX.lineWidth = Math.max(2, Math.round(size * 0.08));
  CTX.strokeStyle = 'rgba(0,0,0,0.85)';
  CTX.fillStyle = color;
  lines.forEach((line, i) => {
    const y = firstY + gap * i;
    CTX.strokeText(line, cx, y);
    CTX.fillText(line, cx, y);
  });

  CTX.restore();
  CTX.textAlign = 'left';
  CTX.textBaseline = 'alphabetic';
}

// ---------------------------------------------------------------------
// Main render loop — driven by requestVideoFrameCallback when available so
// draw cadence tracks real camera frame arrivals (falls back to rAF).
// ---------------------------------------------------------------------
function scheduleNextFrame() {
  if (typeof PREVIEW.requestVideoFrameCallback === 'function') {
    PREVIEW.requestVideoFrameCallback(renderLoop);
  } else {
    requestAnimationFrame(renderLoop);
  }
}

// Mirrors the camera feed (selfie view) and crops it to fill the canvas
// exactly, like CSS object-fit: cover — never stretches, regardless of
// whatever aspect ratio the camera itself happens to report.
function drawMirroredCoverVideo() {
  const vw = PREVIEW.videoWidth;
  const vh = PREVIEW.videoHeight;
  if (!vw || !vh) return;
  const cw = CANVAS.width;
  const ch = CANVAS.height;
  const videoAspect = vw / vh;
  const canvasAspect = cw / ch;

  let sx, sy, sw, sh;
  if (videoAspect > canvasAspect) {
    sh = vh;
    sw = vh * canvasAspect;
    sx = (vw - sw) / 2;
    sy = 0;
  } else {
    sw = vw;
    sh = vw / canvasAspect;
    sx = 0;
    sy = (vh - sh) / 2;
  }

  CTX.save();
  CTX.translate(cw, 0);
  CTX.scale(-1, 1);
  CTX.drawImage(PREVIEW, sx, sy, sw, sh, 0, 0, cw, ch);
  CTX.restore();
}

function renderLoop() {
  scheduleNextFrame();
  if (!CANVAS.width || !CANVAS.height || PREVIEW.readyState < 2) return;

  drawMirroredCoverVideo();

  if (appState === 'recording' && musicStartAudioTime !== null) {
    const t = audioCtx.currentTime - musicStartAudioTime;
    const lastLineEnd = lyricLines.length ? lyricLines[lyricLines.length - 1].end : Infinity;
    if (t < 0) {
      // Visible from the very first frame of the recording; t starts at
      // -(INTRO_BEATS * BEAT_SEC) when the file (and recording) begins.
      drawCenteredCard(TITLE_LINES, GREEN_BRIGHT, t + INTRO_BEATS * BEAT_SEC);
    } else if (t >= lastLineEnd) {
      // Anchor line index 1 ("KARAOKE CHALLENGE:", the middle line) so its
      // vertical center sits on the bottom-third line.
      drawCenteredCard(END_LINES, GREEN_BRIGHT, t - lastLineEnd, 1);
    } else {
      drawLyricsAndBall(t);
    }
  }

  if (activeCaptureVideoTrack) activeCaptureVideoTrack.requestFrame();
}

// ---------------------------------------------------------------------
// Record button / state machine
// ---------------------------------------------------------------------
async function onRecordButton() {
  if (appState === 'idle') {
    await startSequence();
  } else if (appState === 'recording') {
    await stopSequence();
  }
}

async function startSequence() {
  appState = 'countingIn';
  RECORD_BTN.classList.add('is-active');
  RECORD_LABEL.textContent = 'STOP';
  RECORD_BTN.setAttribute('aria-pressed', 'true');
  HELPER_TEXT.textContent = 'Get ready…';

  const ctx = getAudioCtx();
  await ctx.resume();

  if (!musicBuffer) {
    HELPER_TEXT.textContent = 'Loading backing track…';
    try { await musicBufferPromise; } catch (e) { /* handled below */ }
  }
  if (!musicBuffer) {
    HELPER_TEXT.textContent = 'Could not load the backing track. Please try again.';
    resetForNewTake();
    return;
  }

  // Start capturing camera+mic immediately (well before the music begins)
  // so the encoder is fully warmed up and there is zero risk of a startup
  // delay throwing off the sync between video and the backing track.
  beginRecording(ctx);
  await runCountIn(ctx);
}

function runCountIn(ctx) {
  return new Promise((resolve) => {
    const now = ctx.currentTime;
    // The music file now supplies its own audible 1-bar intro, so it starts
    // almost immediately rather than after a separate silent count-in — a
    // tiny buffer here just gives the scheduling a clean moment to land on.
    const fileStart = now + 0.05;
    startMusic(ctx, fileStart); // sets musicStartAudioTime = fileStart + 1 bar

    const labels = ['3', '2', '1', 'GO!'];
    COUNTDOWN.classList.remove('hidden');

    labels.forEach((label, i) => {
      const when = fileStart + i * BEAT_SEC;
      setTimeout(() => { COUNTDOWN.textContent = label; }, Math.max(0, (when - now) * 1000));
    });

    setTimeout(() => {
      COUNTDOWN.classList.add('hidden');
      resolve();
    }, Math.max(0, (musicStartAudioTime - now) * 1000));
  });
}

function beginRecording(ctx) {
  appState = 'recording';
  HELPER_TEXT.textContent = 'Recording…';

  // ---- Audio graph ----
  recDestination = ctx.createMediaStreamDestination();

  // Gentle limiter on the final recorded mix: keeps the boosted mic from
  // clipping and helps glue voice + music together.
  const recCompressor = ctx.createDynamicsCompressor();
  recCompressor.threshold.value = -12;
  recCompressor.knee.value = 18;
  recCompressor.ratio.value = 3;
  recCompressor.attack.value = 0.01;
  recCompressor.release.value = 0.2;

  // Shifts the whole finished mix later to match the camera's own capture
  // latency (see VIDEO_CAPTURE_LATENCY_SEC above) — applied after mic and
  // music are already correctly synced to each other, so their relative
  // timing is untouched, only their timing relative to video changes.
  const videoSyncDelay = ctx.createDelay(1.0);
  videoSyncDelay.delayTime.value = VIDEO_CAPTURE_LATENCY_SEC;
  recCompressor.connect(videoSyncDelay);
  videoSyncDelay.connect(recDestination);

  // Mic and music are synced to each other here; it's the block above that
  // additionally shifts the combined result to match the video.
  // A weak/quiet mic (seen on some older devices) needs more than just a
  // gain multiplier to become audible: compressing first tames any loud
  // peaks, then a makeup-gain stage lifts the now-controlled signal further
  // — compression alone doesn't add loudness, only the makeup gain after it
  // does. This is the whole "boost a quiet recording" trick, no heavier
  // processing than that.
  micSourceNode = ctx.createMediaStreamSource(cameraStream);
  micGainNode = ctx.createGain();
  micGainNode.gain.value = MIC_GAIN;
  micSourceNode.connect(micGainNode);

  const micCompressor = ctx.createDynamicsCompressor();
  micCompressor.threshold.value = -24;
  micCompressor.knee.value = 12;
  micCompressor.ratio.value = 4;
  micCompressor.attack.value = 0.01;
  micCompressor.release.value = 0.25;
  micGainNode.connect(micCompressor);

  const micMakeupGainNode = ctx.createGain();
  micMakeupGainNode.gain.value = MIC_MAKEUP_GAIN;
  micCompressor.connect(micMakeupGainNode);
  micMakeupGainNode.connect(recCompressor);

  const micAnalyser = ctx.createAnalyser();
  micAnalyser.fftSize = 512;
  micGainNode.connect(micAnalyser);

  musicSourceNode = ctx.createBufferSource();
  musicSourceNode.buffer = musicBuffer;

  musicLiveGainNode = ctx.createGain();
  musicLiveGainNode.gain.value = MUSIC_LIVE_GAIN;
  musicSourceNode.connect(musicLiveGainNode);
  musicLiveGainNode.connect(ctx.destination); // audible during recording, never ducked, never delayed

  // The recorded copy of the music is nudged later to match the mic's
  // capture latency (see MUSIC_REC_SYNC_DELAY_SEC above).
  const musicRecDelay = ctx.createDelay(1.0);
  musicRecDelay.delayTime.value = MUSIC_REC_SYNC_DELAY_SEC;
  musicRecDelay.connect(recCompressor);

  musicRecGainNode = ctx.createGain();
  musicRecGainNode.gain.value = MUSIC_REC_BASE_GAIN;
  musicSourceNode.connect(musicRecGainNode);
  musicRecGainNode.connect(musicRecDelay);

  runDuckingLoop(ctx, micAnalyser);

  // ---- Video graph (composited canvas, manual frame-accurate capture) ----
  const { stream: canvasStream, manualTrack } = createCanvasCaptureStream();
  activeCaptureVideoTrack = manualTrack;

  const finalStream = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...recDestination.stream.getAudioTracks()
  ]);

  recordedChunks = [];
  const mimeType = pickRecorderMimeType();
  mediaRecorder = new MediaRecorder(finalStream, {
    mimeType,
    videoBitsPerSecond: 6_000_000,
    audioBitsPerSecond: 192_000
  });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recordedChunks.push(e.data);
  };

  mediaRecorder.start(200);
}

function startMusic(ctx, fileStartTime) {
  musicSourceNode.start(fileStartTime);
  // Lyrics/ball/title-card timing (t=0) is anchored 1 bar into the file,
  // where the file's baked-in intro ends and the actual song content
  // (matching the .lrc's own timestamps) begins.
  musicStartAudioTime = fileStartTime + INTRO_BEATS * BEAT_SEC;
  musicSourceNode.onended = () => {
    if (appState === 'recording') stopSequence();
  };
}

function createCanvasCaptureStream() {
  try {
    const s = CANVAS.captureStream(0);
    const track = s.getVideoTracks()[0];
    if (track && typeof track.requestFrame === 'function') {
      return { stream: s, manualTrack: track };
    }
  } catch (e) { /* fall through */ }
  return { stream: CANVAS.captureStream(30), manualTrack: null };
}

function runDuckingLoop(ctx, analyser) {
  const data = new Uint8Array(analyser.fftSize);

  duckTimer = setInterval(() => {
    if (appState !== 'recording') return;
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);
    const singing = rms > DUCK_THRESHOLD;
    const target = singing ? MUSIC_REC_DUCK_GAIN : MUSIC_REC_BASE_GAIN;
    musicRecGainNode.gain.setTargetAtTime(target, ctx.currentTime, singing ? 0.07 : 0.4);
  }, 60);
}

function pickRecorderMimeType() {
  const candidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || 'video/webm';
}

function warmUpFFmpeg() {
  // Every recording gets remuxed through ffmpeg before saving (see
  // processAndOfferSave), so this is always worth having ready ahead of time.
  getFFmpeg().catch((e) => console.warn('ffmpeg preload failed', e));
}

async function stopSequence() {
  if (appState !== 'recording') return;
  appState = 'processing';
  RECORD_BTN.classList.remove('is-active');
  RECORD_LABEL.textContent = 'START';
  RECORD_BTN.setAttribute('aria-pressed', 'false');
  RECORD_BTN.disabled = true;
  HELPER_TEXT.textContent = '';

  if (duckTimer) clearInterval(duckTimer);
  duckTimer = null;
  activeCaptureVideoTrack = null;

  try { if (musicSourceNode) musicSourceNode.onended = null; musicSourceNode?.stop(); } catch (e) {}
  musicStartAudioTime = null;

  const finalizePromise = new Promise((resolve) => {
    mediaRecorder.onstop = () => resolve();
  });
  if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  await finalizePromise;

  try {
    micSourceNode?.disconnect();
    micGainNode?.disconnect();
    musicLiveGainNode?.disconnect();
    musicRecGainNode?.disconnect();
  } catch (e) {}

  const rawMime = mediaRecorder.mimeType || 'video/webm';
  const rawBlob = new Blob(recordedChunks, { type: rawMime });

  showModal();
  await processAndOfferSave(rawBlob, rawMime);
}

// ---------------------------------------------------------------------
// Post-processing / export
// ---------------------------------------------------------------------

// MediaRecorder output — mp4 or webm — very often lacks a properly
// finalized duration/moov atom, since the browser writes it incrementally
// without knowing the final length up front. In-browser blob playback (and
// thumbnail generation) is lenient about this and plays it anyway, which is
// exactly why a "does it play in a hidden <video>" check isn't trustworthy —
// it can pass while a strict native player (like iOS Photos) refuses the
// same file. So every recording is unconditionally remuxed through ffmpeg
// before it's offered for saving, which forces a clean, finalized
// container. mp4 sources use a fast stream-copy remux (no quality loss, no
// re-encode); webm sources need a full re-encode since MP4 can't contain
// VP8/Opus directly.
async function processAndOfferSave(rawBlob, rawMime) {
  let finalBlob = rawBlob;
  let ext = 'mp4';

  MODAL_TITLE.textContent = 'Finishing up…';
  try {
    finalBlob = await transcodeToMp4(rawBlob);
  } catch (e) {
    console.warn('MP4 remux/conversion failed, offering original file', e);
    MODAL_TITLE.textContent = rawMime.includes('mp4') ? 'Ready!' : 'Ready! (WebM format)';
    ext = rawMime.includes('mp4') ? 'mp4' : rawMime.includes('webm') ? 'webm' : 'mp4';
    finalBlob = rawBlob;
  }

  const filename = `${OUTPUT_PREFIX}${Date.now()}.${ext}`;
  presentResult(finalBlob, filename, ext);
}

async function getFFmpeg() {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const { FFmpeg } = await import('https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js');
      const { toBlobURL } = await import('https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js');
      const ffmpeg = new FFmpeg();
      const base = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm';
      await ffmpeg.load({
        coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm')
      });
      return ffmpeg;
    })();
  }
  return ffmpegPromise;
}

const REENCODE_ARGS = [
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '192k',
  '-movflags', '+faststart',
  'output.mp4'
];

async function transcodeToMp4(blob) {
  const ffmpeg = await getFFmpeg();
  const isMp4Source = blob.type.includes('mp4');
  const inputName = 'input' + (isMp4Source ? '.mp4' : blob.type.includes('webm') ? '.webm' : '.mov');
  const buf = new Uint8Array(await blob.arrayBuffer());
  await ffmpeg.writeFile(inputName, buf);

  ffmpeg.on('progress', ({ progress }) => {
    const pct = Math.round(Math.min(1, Math.max(0, progress)) * 100);
    MODAL_TITLE.textContent = `Finishing up… ${pct}%`;
  });

  if (isMp4Source) {
    // Fast path: just remux (no re-encode) to force a clean, finalized
    // container — this is what actually fixes native-player compatibility.
    // ffmpeg.wasm reports failure via a non-zero exit code rather than a
    // thrown exception, so check both.
    let code;
    try {
      code = await ffmpeg.exec(['-i', inputName, '-c', 'copy', '-movflags', '+faststart', 'output.mp4']);
    } catch (e) {
      console.warn('Stream-copy remux threw, falling back to re-encode', e);
    }
    if (code !== 0) {
      console.warn(`Stream-copy remux exited ${code}, falling back to re-encode`);
      await ffmpeg.exec(['-i', inputName, ...REENCODE_ARGS]);
    }
  } else {
    await ffmpeg.exec(['-i', inputName, ...REENCODE_ARGS]);
  }

  const data = await ffmpeg.readFile('output.mp4');
  try { await ffmpeg.deleteFile(inputName); await ffmpeg.deleteFile('output.mp4'); } catch (e) {}
  return new Blob([data.buffer], { type: 'video/mp4' });
}

// ---------------------------------------------------------------------
// Result modal / save
// ---------------------------------------------------------------------
let pendingBlob = null;
let pendingFilename = null;
let pendingExt = null;

function showModal() {
  MODAL.classList.remove('hidden');
  MODAL_TITLE.textContent = 'Processing…';
  MODAL_SPINNER.classList.remove('hidden');
  RESULT_VIDEO.classList.add('hidden');
  MODAL_SHARE_TIP.classList.add('hidden');
  SAVE_BTN.classList.add('hidden');
  RETRY_BTN.classList.add('hidden');
}

function presentResult(blob, filename, ext) {
  pendingBlob = blob;
  pendingFilename = filename;
  pendingExt = ext;

  if (resultObjectUrl) URL.revokeObjectURL(resultObjectUrl);
  resultObjectUrl = URL.createObjectURL(blob);

  MODAL_TITLE.textContent = '';
  MODAL_SPINNER.classList.add('hidden');
  RESULT_VIDEO.src = resultObjectUrl;
  RESULT_VIDEO.classList.remove('hidden');
  MODAL_SHARE_TIP.classList.remove('hidden');
  SAVE_BTN.classList.remove('hidden');
  RETRY_BTN.classList.remove('hidden');
}

async function onSaveClicked() {
  if (!pendingBlob) return;
  const mime = pendingExt === 'mp4' ? 'video/mp4' : (pendingBlob.type || 'video/webm');
  const file = new File([pendingBlob], pendingFilename, { type: mime });

  try {
    if (navigator.canShare && navigator.share && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: pendingFilename });
      return;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    console.warn('Share failed, falling back to download', e);
  }

  const url = URL.createObjectURL(pendingBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = pendingFilename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function resetForNewTake() {
  MODAL.classList.add('hidden');
  if (resultObjectUrl) { URL.revokeObjectURL(resultObjectUrl); resultObjectUrl = null; }
  RESULT_VIDEO.removeAttribute('src');
  pendingBlob = null;
  pendingFilename = null;
  pendingExt = null;

  appState = 'idle';
  RECORD_BTN.disabled = false;
  RECORD_BTN.classList.remove('is-active');
  RECORD_LABEL.textContent = 'START';
  RECORD_BTN.setAttribute('aria-pressed', 'false');
  HELPER_TEXT.textContent = '';

  fitFrameToVideo();
}
