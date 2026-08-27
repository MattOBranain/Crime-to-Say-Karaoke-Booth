// =====================================================
// Crime to Say Karaoke – Camera fixed + previous improvements
// =====================================================

const PREVIEW = document.getElementById('preview');
const CANVAS = document.getElementById('overlay-canvas');
const CTX = CANVAS.getContext('2d');
const RECORD_BTN = document.getElementById('record-btn');
const COUNT_DISPLAY = document.getElementById('count-in-display');
const WRAPPER = document.getElementById('preview-wrapper');
const MODAL = document.getElementById('save-modal');
const MODAL_STATUS = document.getElementById('modal-status');
const SAVE_BTN = document.getElementById('save-btn');

let stream = null;
let audioCtx = null;
let mediaRecorder = null;
let recordedChunks = [];
let isRecording = false;
let lyrics = [];
let audioElement = null;
let destinationNode = null;
let micSource = null;
let musicSource = null;
let musicGain = null;
let finalBlob = null;
let finalMime = '';

const BPM = 80;
const BEAT_DURATION = 60 / BPM;
const B3_FREQ = 246.94;

// ---------- CAMERA FIRST (most important) ----------
async function initCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    PREVIEW.srcObject = stream;
    PREVIEW.muted = true;
    PREVIEW.playsInline = true;

    // Wait until video is actually ready
    await PREVIEW.play().catch(() => {});

    PREVIEW.onloadedmetadata = () => {
      updateAspectRatio();
      resizeCanvas();
    };

    // Force a resize after a short delay (helps some mobile browsers)
    setTimeout(() => {
      updateAspectRatio();
      resizeCanvas();
      startDrawLoop();
    }, 300);

  } catch (err) {
    console.error('Camera error:', err);
    alert('Could not access camera/microphone. Please allow permission and reload.');
  }
}

function updateAspectRatio() {
  if (PREVIEW.videoWidth && PREVIEW.videoHeight) {
    WRAPPER.style.aspectRatio = PREVIEW.videoWidth / PREVIEW.videoHeight;
  }
}

function resizeCanvas() {
  if (PREVIEW.videoWidth && PREVIEW.videoHeight) {
    CANVAS.width = PREVIEW.videoWidth;
    CANVAS.height = PREVIEW.videoHeight;
  }
}

// ---------- LRC (safe) ----------
async function loadLyrics() {
  try {
    const res = await fetch('crime-2-say-oke-shortest.lrc');
    const text = await res.text();
    lyrics = parseEnhancedLRC(text);
  } catch (e) {
    console.warn('Lyrics could not be loaded', e);
    lyrics = [];
  }
}

function parseEnhancedLRC(text) {
  const result = [];
  const lines = text.split(/\r?\n/);

  for (let raw of lines) {
    raw = raw.trim();
    if (!raw.startsWith('[')) continue;

    const m = raw.match(/^\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/);
    if (!m) continue;

    const start = parseInt(m[1]) * 60 + parseFloat(m[2]);
    let content = m[3].trim();

    const words = [];
    const re = /<(\d+):(\d+(?:\.\d+)?)>([^<]*)/g;
    let match;
    let found = false;

    while ((match = re.exec(content)) !== null) {
      found = true;
      const wStart = parseInt(match[1]) * 60 + parseFloat(match[2]);
      const word = match[3].trim();
      if (word) words.push({ text: word, start: wStart });
    }

    // Fallback – never lose the first words
    if (!found || words.length === 0) {
      const plain = content.replace(/<[^>]+>/g, '').trim();
      if (plain) {
        plain.split(/\s+/).forEach((w, i) => {
          if (w) words.push({ text: w, start: start + i * 0.25 });
        });
      }
    }

    if (words.length) result.push({ start, words });
  }
  return result;
}

// ---------- Count-in ----------
function playTone(when) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.frequency.value = B3_FREQ;
  osc.type = 'sine';
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.exponentialRampToValueAtTime(0.35, when + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.14);
  osc.start(when);
  osc.stop(when + 0.16);
}

function startCountIn() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const now = audioCtx.currentTime;
  const labels = ['3', '2', '1', 'GO'];

  labels.forEach((label, i) => {
    playTone(now + i * BEAT_DURATION);
    setTimeout(() => {
      COUNT_DISPLAY.textContent = label;
      COUNT_DISPLAY.classList.remove('hidden');
    }, i * BEAT_DURATION * 1000);
  });

  setTimeout(() => {
    COUNT_DISPLAY.classList.add('hidden');
    beginRecording();
  }, 3 * BEAT_DURATION * 1000);
}

// ---------- Recording ----------
async function beginRecording() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  destinationNode = audioCtx.createMediaStreamDestination();

  micSource = audioCtx.createMediaStreamSource(stream);
  micSource.connect(destinationNode);

  audioElement = new Audio('crime-2-say-oke-shortest.mp3');
  audioElement.crossOrigin = 'anonymous';
  await audioElement.play();

  musicSource = audioCtx.createMediaElementSource(audioElement);
  musicGain = audioCtx.createGain();
  musicGain.gain.value = 0.40;
  musicSource.connect(musicGain);
  musicGain.connect(destinationNode);
  musicGain.connect(audioCtx.destination);

  const canvasStream = CANVAS.captureStream(30);
  const finalStream = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...destinationNode.stream.getAudioTracks()
  ]);

  recordedChunks = [];
  const candidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm'
  ];
  const chosen = candidates.find(t => MediaRecorder.isTypeSupported(t)) || 'video/webm';

  mediaRecorder = new MediaRecorder(finalStream, {
    mimeType: chosen,
    videoBitsPerSecond: 5500000,
    audioBitsPerSecond: 256000
  });

  mediaRecorder.ondataavailable = e => {
    if (e.data && e.data.size > 0) recordedChunks.push(e.data);
  };

  mediaRecorder.onstop = () => {
    finalMime = mediaRecorder.mimeType || 'video/webm';
    finalBlob = new Blob(recordedChunks, { type: finalMime });
    showSaveModal();
    cleanupAfterStop();
  };

  mediaRecorder.start(100);
  isRecording = true;
  RECORD_BTN.classList.add('recording');
  RECORD_BTN.querySelector('.btn-text').textContent = 'STOP';
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

function cleanupAfterStop() {
  isRecording = false;
  RECORD_BTN.classList.remove('recording');
  RECORD_BTN.querySelector('.btn-text').textContent = 'REC';
  if (audioElement) {
    audioElement.pause();
    audioElement = null;
  }
  try { micSource?.disconnect(); } catch(e){}
  try { musicSource?.disconnect(); } catch(e){}
  try { musicGain?.disconnect(); } catch(e){}
  if (stream) stream.getAudioTracks().forEach(t => t.enabled = false);
}

// ---------- Save ----------
function showSaveModal() {
  MODAL_STATUS.textContent = 'CONVERTING…';
  SAVE_BTN.classList.add('hidden');
  MODAL.classList.remove('hidden');
  setTimeout(() => {
    MODAL_STATUS.textContent = 'Ready to save';
    SAVE_BTN.classList.remove('hidden');
  }, 700);
}

SAVE_BTN.addEventListener('click', async () => {
  if (!finalBlob) return;
  const ext = finalMime.includes('mp4') ? 'mp4' : 'webm';
  const filename = `Crime2Say-${Date.now()}.${ext}`;
  const file = new File([finalBlob], filename, { type: finalMime });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Crime to Say Karaoke' });
      MODAL.classList.add('hidden');
      if (stream) stream.getAudioTracks().forEach(t => t.enabled = true);
      return;
    } catch (err) {}
  }

  const url = URL.createObjectURL(finalBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    MODAL.classList.add('hidden');
  }, 300);
  if (stream) stream.getAudioTracks().forEach(t => t.enabled = true);
});

// ---------- Draw loop ----------
function startDrawLoop() {
  function loop() {
    requestAnimationFrame(loop);
    if (!PREVIEW.videoWidth) return;

    CTX.drawImage(PREVIEW, 0, 0, CANVAS.width, CANVAS.height);

    if (audioElement && !audioElement.paused) {
      drawLyricsAndBall(audioElement.currentTime);
    }
  }
  loop();
}

function drawLyricsAndBall(time) {
  // (same improved drawing code as previous version)
  let current = null;
  for (let
