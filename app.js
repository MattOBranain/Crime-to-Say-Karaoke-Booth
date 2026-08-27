// =====================================================================
// Crime to Say Karaoke Booth
// One-page virtual karaoke booth: camera + mic capture, synced lyric/ball
// overlay, optional UK-flag mouth-gag AR effect, mixed audio recording,
// and MP4 export ready for sharing.
// =====================================================================

import { FaceLandmarker, FilesetResolver } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';

// ---------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------
const AUDIO_FILE = './crime-2-say-oke-shortest.mp3';
const LRC_FILE = './crime-2-say-oke-shortest.lrc';
const OUTPUT_PREFIX = 'Crime2Say-';

const BPM = 80;
const BEAT_SEC = 60 / BPM;
const B3_FREQ = 246.94;

const BASE_MUSIC_GAIN = 0.85;
const DUCK_GAIN = 0.6;
const MIC_GAIN = 1.0;

const MAX_CANVAS_DIM = 1280;
const FOOTER_LINE_1 = "'CRIME TO SAY' KARAOKE CHALLENGE";
const FOOTER_LINE_2 = 'CRIME2SAY.UK';

const FACE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

// ---------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------
const PREVIEW = document.getElementById('preview');
const CANVAS = document.getElementById('stageCanvas');
const CTX = CANVAS.getContext('2d');
const FRAME = document.getElementById('frame');
const PERMISSION_GATE = document.getElementById('permissionGate');
const PERMISSION_TEXT = document.getElementById('permissionText');
const PERMISSION_RETRY = document.getElementById('permissionRetry');
const COUNTDOWN = document.getElementById('countdown');
const RECORD_BTN = document.getElementById('recordBtn');
const RECORD_LABEL = RECORD_BTN.querySelector('.rec-btn__label');
const HELPER_TEXT = document.getElementById('helperText');
const GAG_TOGGLE = document.getElementById('gagToggle');
const GAG_LABEL = document.getElementById('gagLabel');

const MODAL = document.getElementById('resultModal');
const MODAL_TITLE = document.getElementById('modalTitle');
const MODAL_SPINNER = document.getElementById('modalSpinner');
const RESULT_VIDEO = document.getElementById('resultVideo');
const MODAL_HINT = document.getElementById('modalHint');
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
let recordingStartWallTime = null;

let mediaRecorder = null;
let recordedChunks = [];
let recDestination = null;
let micSourceNode = null;
let micGainNode = null;
let musicGainNode = null;
let musicSourceNode = null;
let duckRAF = null;

let nativeMp4Supported = false;
let ffmpegPromise = null;

let faceLandmarker = null;
let faceLandmarkerReady = false;
let faceFrameCounter = 0;
let smoothedMouth = null;
let lastFaceSeenAt = 0;
const flagSprite = buildFlagSprite();

let resultObjectUrl = null;
let drawLoopStarted = false;

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
  loadLyrics();
  preloadMusic();
  detectNativeMp4Support();
  initCamera();
  initFaceLandmarker();
});

PERMISSION_RETRY.addEventListener('click', initCamera);
RECORD_BTN.addEventListener('click', onRecordButton);
RETRY_BTN.addEventListener('click', resetForNewTake);
SAVE_BTN.addEventListener('click', onSaveClicked);
GAG_TOGGLE.addEventListener('change', () => {
  if (!GAG_TOGGLE.checked) smoothedMouth = null;
});

// ---------------------------------------------------------------------
// Camera / mic setup
// ---------------------------------------------------------------------
async function initCamera() {
  PERMISSION_GATE.classList.remove('hidden');
  PERMISSION_RETRY.classList.add('hidden');
  PERMISSION_TEXT.textContent = 'Requesting camera & microphone access…';

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 1280 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });

    PREVIEW.srcObject = cameraStream;
    await PREVIEW.play().catch(() => {});

    PERMISSION_GATE.classList.add('hidden');
    RECORD_BTN.disabled = false;

    PREVIEW.addEventListener('loadedmetadata', fitCanvasToVideo);
    fitCanvasToVideo();

    if (!drawLoopStarted) {
      drawLoopStarted = true;
      requestAnimationFrame(renderLoop);
    }
  } catch (err) {
    console.error('Camera/mic error', err);
    PERMISSION_TEXT.textContent =
      'Camera & microphone access is needed for the karaoke booth to work.';
    PERMISSION_RETRY.classList.remove('hidden');
    RECORD_BTN.disabled = true;
  }
}

function fitCanvasToVideo() {
  const vw = PREVIEW.videoWidth;
  const vh = PREVIEW.videoHeight;
  if (!vw || !vh) return;
  if (appState === 'recording' || appState === 'countingIn') return; // don't resize mid-take

  let cw = vw;
  let ch = vh;
  if (Math.max(cw, ch) > MAX_CANVAS_DIM) {
    const scale = MAX_CANVAS_DIM / Math.max(cw, ch);
    cw = Math.round(cw * scale);
    ch = Math.round(ch * scale);
  }
  CANVAS.width = cw;
  CANVAS.height = ch;
  FRAME.style.aspectRatio = `${vw} / ${vh}`;
  lyricFontSize = computeLyricFontSize();
}

window.addEventListener('resize', () => {
  if (appState === 'idle') fitCanvasToVideo();
});

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
// Face landmark tracking (for the UK flag mouth-gag effect)
// ---------------------------------------------------------------------
async function initFaceLandmarker() {
  try {
    const vision = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
    );
    faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: FACE_MODEL_URL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numFaces: 1
    });
    faceLandmarkerReady = true;
  } catch (e) {
    console.warn('Face tracking unavailable', e);
    faceLandmarkerReady = false;
    GAG_TOGGLE.checked = false;
    GAG_TOGGLE.disabled = true;
    GAG_LABEL.title = 'Face tracking unavailable on this device or connection';
  }
}

function updateFaceTracking() {
  if (!GAG_TOGGLE.checked || !faceLandmarkerReady || PREVIEW.readyState < 2) return;
  faceFrameCounter++;
  if (faceFrameCounter % 2 !== 0) return; // throttle to ~every other frame

  let result;
  try {
    result = faceLandmarker.detectForVideo(PREVIEW, performance.now());
  } catch (e) {
    return;
  }
  if (!result || !result.faceLandmarks || !result.faceLandmarks.length) return;

  const lm = result.faceLandmarks[0];
  const p1 = lm[61];
  const p2 = lm[291];
  if (!p1 || !p2) return;

  // Landmarks are normalized [0,1] against the source video frame; mirror X
  // to match the mirrored canvas we draw the preview onto.
  const mx1 = CANVAS.width * (1 - p1.x);
  const my1 = CANVAS.height * p1.y;
  const mx2 = CANVAS.width * (1 - p2.x);
  const my2 = CANVAS.height * p2.y;

  const rawCx = (mx1 + mx2) / 2;
  const rawCy = (my1 + my2) / 2;
  const rawWidth = Math.hypot(mx2 - mx1, my2 - my1);
  const rawAngle = Math.atan2(my2 - my1, mx2 - mx1);

  if (!smoothedMouth) {
    smoothedMouth = { cx: rawCx, cy: rawCy, angle: rawAngle, width: rawWidth };
  } else {
    const a = 0.35;
    smoothedMouth.cx += (rawCx - smoothedMouth.cx) * a;
    smoothedMouth.cy += (rawCy - smoothedMouth.cy) * a;
    smoothedMouth.width += (rawWidth - smoothedMouth.width) * a;
    let da = rawAngle - smoothedMouth.angle;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    smoothedMouth.angle += da * a;
  }
  lastFaceSeenAt = performance.now();
}

function buildFlagSprite() {
  const w = 300, h = 180;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');

  g.fillStyle = '#00247d';
  g.fillRect(0, 0, w, h);

  g.strokeStyle = '#ffffff';
  g.lineWidth = h * 0.34;
  g.beginPath(); g.moveTo(0, 0); g.lineTo(w, h); g.moveTo(w, 0); g.lineTo(0, h); g.stroke();

  g.strokeStyle = '#cf142b';
  g.lineWidth = h * 0.14;
  g.beginPath(); g.moveTo(0, 0); g.lineTo(w, h); g.stroke();
  g.beginPath(); g.moveTo(w, 0); g.lineTo(0, h); g.stroke();

  g.strokeStyle = '#ffffff';
  g.lineWidth = h * 0.4;
  g.beginPath(); g.moveTo(w / 2, 0); g.lineTo(w / 2, h); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();

  g.strokeStyle = '#cf142b';
  g.lineWidth = h * 0.18;
  g.beginPath(); g.moveTo(w / 2, 0); g.lineTo(w / 2, h); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();

  g.strokeStyle = 'rgba(0,0,0,0.55)';
  g.lineWidth = 4;
  g.strokeRect(2, 2, w - 4, h - 4);

  return c;
}

function drawMouthGag() {
  if (!GAG_TOGGLE.checked || !smoothedMouth) return;
  if (performance.now() - lastFaceSeenAt > 450) return;

  const { cx, cy, angle, width } = smoothedMouth;
  const flagW = width * 2.1;
  const flagH = flagW * (flagSprite.height / flagSprite.width);

  CTX.save();
  CTX.translate(cx, cy);
  CTX.rotate(angle);

  CTX.strokeStyle = 'rgba(15,15,15,0.85)';
  CTX.lineWidth = Math.max(4, width * 0.07);
  CTX.lineCap = 'round';
  CTX.beginPath();
  CTX.moveTo(-flagW * 0.48, 0);
  CTX.lineTo(-flagW * 0.95, -flagH * 0.2);
  CTX.moveTo(flagW * 0.48, 0);
  CTX.lineTo(flagW * 0.95, -flagH * 0.2);
  CTX.stroke();

  CTX.drawImage(flagSprite, -flagW / 2, -flagH / 2, flagW, flagH);
  CTX.restore();
}

// ---------------------------------------------------------------------
// Lyric layout + bouncing ball
// ---------------------------------------------------------------------
function computeLyricFontSize() {
  if (!CANVAS.width || !lyricLines.length) return Math.round((CANVAS.width || 720) * 0.08);

  const cw = CANVAS.width;
  const isPortrait = CANVAS.height >= CANVAS.width;
  const marginRatio = isPortrait ? 0.88 : 0.8;
  const maxWidth = cw * marginRatio;

  const REF = 100;
  CTX.font = `bold ${REF}px Arial`;
  let longest = 0;
  for (const line of lyricLines) {
    const full = line.words.map((w) => w.text).join(' ');
    const w = CTX.measureText(full).width;
    if (w > longest) longest = w;
  }
  if (longest === 0) return Math.round(cw * 0.08);

  let fontSize = Math.floor(REF * (maxWidth / longest));
  const capFraction = isPortrait ? 0.34 : 0.22;
  fontSize = Math.min(fontSize, Math.round(CANVAS.height * capFraction));
  fontSize = Math.max(fontSize, Math.round(cw * 0.035));
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

function findActiveLine(t) {
  for (const line of lyricLines) {
    if (t >= line.start && t < line.end) return line;
  }
  return null;
}

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

function drawLyricsAndBall(t) {
  const line = findActiveLine(t);
  if (!line) return;

  const words = layoutLine(line, lyricFontSize);
  const baselineY = Math.round(CANVAS.height * 0.76);

  let activeIndex = words.findIndex((w) => t >= w.start && t < w.end);

  CTX.textBaseline = 'alphabetic';
  CTX.textAlign = 'left';
  CTX.lineJoin = 'round';
  CTX.font = `bold ${lyricFontSize}px Arial`;
  CTX.lineWidth = Math.max(2, Math.round(lyricFontSize * 0.08));

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const isActive = i === activeIndex;
    CTX.fillStyle = isActive ? '#00ff7f' : '#ffffff';
    CTX.strokeStyle = 'rgba(0,0,0,0.9)';
    const drawX = w.x - w.width / 2;
    CTX.strokeText(w.text, drawX, baselineY);
    CTX.fillText(w.text, drawX, baselineY);
  }

  drawBall(line, words, activeIndex, t, baselineY);
}

function drawBall(line, words, activeIndex, t, baselineY) {
  const restY = baselineY - lyricFontSize * 1.05;
  const amplitude = lyricFontSize * 1.5;
  const radius = Math.max(8, lyricFontSize * 0.22);
  const offLeft = -radius * 3;
  const offRight = CANVAS.width + radius * 3;

  let x = null, y = null;

  const firstWord = words[0];
  const lastWord = words[words.length - 1];

  if (t < firstWord.start) {
    // Entry: fly in from off-screen-left onto the first word.
    const entryDuration = Math.min(0.5, firstWord.start - line.start);
    const entryStart = firstWord.start - entryDuration;
    if (t >= entryStart) {
      const p = easeInOut(clamp((t - entryStart) / entryDuration, 0, 1));
      x = lerp(offLeft, firstWord.x, p);
      y = restY - Math.sin(Math.PI * p) * amplitude;
    }
  } else if (t >= lastWord.start && activeIndex === words.length - 1) {
    // Exit: bounce off the last word and fly off-screen-right.
    const exitDuration = Math.min(0.5, line.end - lastWord.start);
    const p = clamp((t - lastWord.start) / exitDuration, 0, 1);
    if (p <= 1) {
      const eased = easeInOut(p);
      x = lerp(lastWord.x, offRight, eased);
      y = restY - Math.sin(Math.PI * eased) * amplitude * 0.85;
    }
  } else if (activeIndex >= 0 && activeIndex < words.length - 1) {
    // Interior hop from current word to the next.
    const a = words[activeIndex];
    const b = words[activeIndex + 1];
    const p = clamp((t - a.start) / (b.start - a.start), 0, 1);
    const eased = easeInOut(p);
    x = lerp(a.x, b.x, eased);
    y = restY - Math.sin(Math.PI * p) * amplitude;
  }

  if (x === null) return;

  CTX.beginPath();
  CTX.fillStyle = '#00ff7f';
  CTX.shadowColor = 'rgba(0,255,127,0.65)';
  CTX.shadowBlur = 12;
  CTX.arc(x, y, radius, 0, Math.PI * 2);
  CTX.fill();
  CTX.shadowBlur = 0;
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }

function drawFooterText() {
  const y1 = Math.round(CANVAS.height * 0.9);
  const y2 = y1 + Math.round(CANVAS.height * 0.032);
  const size = Math.max(12, Math.round(CANVAS.width * 0.028));

  CTX.font = `${size}px "Courier New", Courier, monospace`;
  CTX.textAlign = 'center';
  CTX.fillStyle = '#ffffff';
  CTX.fillText(FOOTER_LINE_1, CANVAS.width / 2, Math.min(y1, CANVAS.height - size * 2.6));
  CTX.fillText(FOOTER_LINE_2, CANVAS.width / 2, Math.min(y2, CANVAS.height - size * 1.1));
  CTX.textAlign = 'left';
}

// ---------------------------------------------------------------------
// Main render loop
// ---------------------------------------------------------------------
function renderLoop() {
  requestAnimationFrame(renderLoop);
  if (!CANVAS.width || !CANVAS.height || PREVIEW.readyState < 2) return;

  CTX.save();
  CTX.translate(CANVAS.width, 0);
  CTX.scale(-1, 1);
  CTX.drawImage(PREVIEW, 0, 0, CANVAS.width, CANVAS.height);
  CTX.restore();

  updateFaceTracking();
  drawMouthGag();

  if (appState === 'recording' && musicStartAudioTime !== null) {
    const t = audioCtx.currentTime - musicStartAudioTime;
    if (t >= 0) drawLyricsAndBall(t);
    drawFooterText();
  }
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

  await runCountIn(ctx);
}

function runCountIn(ctx) {
  return new Promise((resolve) => {
    const now = ctx.currentTime;
    const labels = ['3', '2', '1', 'GO!'];

    COUNTDOWN.classList.remove('hidden');

    labels.forEach((label, i) => {
      const when = now + i * BEAT_SEC;
      playCountTone(ctx, when);
      setTimeout(() => { COUNTDOWN.textContent = label; }, Math.max(0, (when - now) * 1000));
    });

    const recordAt = now + 3 * BEAT_SEC; // 4th note (GO)
    const musicAt = now + 4 * BEAT_SEC; // following downbeat

    setTimeout(() => {
      beginRecording(ctx, musicAt);
    }, Math.max(0, (recordAt - now) * 1000));

    setTimeout(() => {
      COUNTDOWN.classList.add('hidden');
      resolve();
    }, Math.max(0, (musicAt - now) * 1000));
  });
}

function playCountTone(ctx, when) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = B3_FREQ;
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.exponentialRampToValueAtTime(0.32, when + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.15);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(when);
  osc.stop(when + 0.18);
}

function beginRecording(ctx, musicStartTime) {
  appState = 'recording';
  HELPER_TEXT.textContent = 'Recording… press STOP when you’re done.';

  // ---- Audio graph ----
  recDestination = ctx.createMediaStreamDestination();

  micSourceNode = ctx.createMediaStreamSource(cameraStream);
  micGainNode = ctx.createGain();
  micGainNode.gain.value = MIC_GAIN;
  micSourceNode.connect(micGainNode);
  micGainNode.connect(recDestination);

  const micAnalyser = ctx.createAnalyser();
  micAnalyser.fftSize = 512;
  micGainNode.connect(micAnalyser);

  musicSourceNode = ctx.createBufferSource();
  musicSourceNode.buffer = musicBuffer;
  musicGainNode = ctx.createGain();
  musicGainNode.gain.value = BASE_MUSIC_GAIN;
  musicSourceNode.connect(musicGainNode);
  musicGainNode.connect(recDestination);
  musicGainNode.connect(ctx.destination); // audible during recording

  musicSourceNode.start(musicStartTime);
  musicStartAudioTime = musicStartTime;
  musicSourceNode.onended = () => {
    if (appState === 'recording') stopSequence();
  };

  runDuckingLoop(ctx, micAnalyser);

  // ---- Video graph (composited canvas) ----
  const canvasStream = CANVAS.captureStream(30);
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

function runDuckingLoop(ctx, analyser) {
  const data = new Uint8Array(analyser.fftSize);
  const threshold = 0.045;

  function tick() {
    if (appState !== 'recording') return;
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);
    const target = (rms > threshold ? DUCK_GAIN : 1) * BASE_MUSIC_GAIN;
    musicGainNode.gain.setTargetAtTime(target, ctx.currentTime, rms > threshold ? 0.09 : 0.45);
    duckRAF = requestAnimationFrame(tick);
  }
  duckRAF = requestAnimationFrame(tick);
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

function detectNativeMp4Support() {
  nativeMp4Supported =
    MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.42E01E,mp4a.40.2') ||
    MediaRecorder.isTypeSupported('video/mp4');
  if (!nativeMp4Supported) {
    // Warm up ffmpeg.wasm in the background so conversion is fast later.
    getFFmpeg().catch((e) => console.warn('ffmpeg preload failed', e));
  }
}

async function stopSequence() {
  if (appState !== 'recording') return;
  appState = 'processing';
  RECORD_BTN.classList.remove('is-active');
  RECORD_LABEL.textContent = 'START';
  RECORD_BTN.setAttribute('aria-pressed', 'false');
  RECORD_BTN.disabled = true;
  HELPER_TEXT.textContent = 'When you press START a timer will count you in.';

  if (duckRAF) cancelAnimationFrame(duckRAF);
  duckRAF = null;

  try { if (musicSourceNode) musicSourceNode.onended = null; musicSourceNode?.stop(); } catch (e) {}
  musicStartAudioTime = null;

  const finalizePromise = new Promise((resolve) => {
    mediaRecorder.onstop = () => resolve();
  });
  if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  await finalizePromise;

  try { micSourceNode?.disconnect(); micGainNode?.disconnect(); musicGainNode?.disconnect(); } catch (e) {}

  const rawMime = mediaRecorder.mimeType || 'video/webm';
  const rawBlob = new Blob(recordedChunks, { type: rawMime });

  showModal();
  await processAndOfferSave(rawBlob, rawMime);
}

// ---------------------------------------------------------------------
// Post-processing / export
// ---------------------------------------------------------------------
async function processAndOfferSave(rawBlob, rawMime) {
  let finalBlob = rawBlob;
  let ext = 'webm';

  if (rawMime.includes('mp4')) {
    ext = 'mp4';
  } else {
    MODAL_TITLE.textContent = 'Converting to MP4…';
    try {
      finalBlob = await transcodeToMp4(rawBlob);
      ext = 'mp4';
    } catch (e) {
      console.warn('MP4 conversion failed, offering original file', e);
      MODAL_TITLE.textContent = 'Ready! (WebM format)';
      ext = rawMime.includes('webm') ? 'webm' : 'mp4';
      finalBlob = rawBlob;
    }
  }

  const filename = `${OUTPUT_PREFIX}${Date.now()}.${ext}`;
  presentResult(finalBlob, filename);
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

async function transcodeToMp4(blob) {
  const ffmpeg = await getFFmpeg();
  const inputName = 'input' + (blob.type.includes('webm') ? '.webm' : '.mov');
  const buf = new Uint8Array(await blob.arrayBuffer());
  await ffmpeg.writeFile(inputName, buf);

  ffmpeg.on('progress', ({ progress }) => {
    const pct = Math.round(Math.min(1, Math.max(0, progress)) * 100);
    MODAL_TITLE.textContent = `Converting to MP4… ${pct}%`;
  });

  await ffmpeg.exec([
    '-i', inputName,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    'output.mp4'
  ]);

  const data = await ffmpeg.readFile('output.mp4');
  try { await ffmpeg.deleteFile(inputName); await ffmpeg.deleteFile('output.mp4'); } catch (e) {}
  return new Blob([data.buffer], { type: 'video/mp4' });
}

// ---------------------------------------------------------------------
// Result modal / save
// ---------------------------------------------------------------------
let pendingBlob = null;
let pendingFilename = null;

function showModal() {
  MODAL.classList.remove('hidden');
  MODAL_TITLE.textContent = 'Processing…';
  MODAL_SPINNER.classList.remove('hidden');
  RESULT_VIDEO.classList.add('hidden');
  MODAL_HINT.classList.add('hidden');
  SAVE_BTN.classList.add('hidden');
  RETRY_BTN.classList.add('hidden');
}

function presentResult(blob, filename) {
  pendingBlob = blob;
  pendingFilename = filename;

  if (resultObjectUrl) URL.revokeObjectURL(resultObjectUrl);
  resultObjectUrl = URL.createObjectURL(blob);

  MODAL_TITLE.textContent = 'Your video is ready!';
  MODAL_SPINNER.classList.add('hidden');
  RESULT_VIDEO.src = resultObjectUrl;
  RESULT_VIDEO.classList.remove('hidden');
  MODAL_HINT.classList.remove('hidden');
  SAVE_BTN.classList.remove('hidden');
  RETRY_BTN.classList.remove('hidden');
}

async function onSaveClicked() {
  if (!pendingBlob) return;
  const file = new File([pendingBlob], pendingFilename, { type: pendingBlob.type });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: pendingFilename });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      console.warn('Share failed, falling back to download', e);
    }
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

  appState = 'idle';
  RECORD_BTN.disabled = false;
  RECORD_BTN.classList.remove('is-active');
  RECORD_LABEL.textContent = 'START';
  RECORD_BTN.setAttribute('aria-pressed', 'false');
  HELPER_TEXT.textContent = 'When you press START a timer will count you in.';

  fitCanvasToVideo();
}
