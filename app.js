// ======================
// Crime to Say Karaoke
// ======================

const PREVIEW = document.getElementById('preview');
const CANVAS = document.getElementById('overlay-canvas');
const CTX = CANVAS.getContext('2d');
const RECORD_BTN = document.getElementById('record-btn');
const COUNT_DISPLAY = document.getElementById('count-in-display');

let stream = null;
let audioCtx = null;
let mediaRecorder = null;
let recordedChunks = [];
let isRecording = false;
let animationId = null;

let lyrics = [];          // parsed Enhanced LRC
let currentLineIndex = -1;
let audio = null;         // backing track
let startTime = 0;        // performance time when music + recording began

const BPM = 80;
const BEAT_MS = 60000 / BPM;
const B3 = 246.94;

// ---------- 1. Load camera + mic ----------
async function initCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true
    });
    PREVIEW.srcObject = stream;
    PREVIEW.onloadedmetadata = () => {
      resizeCanvas();
      drawLoop();
    };
  } catch (err) {
    alert('Camera / microphone access is required for this karaoke booth.');
    console.error(err);
  }
}

// ---------- 2. Parse Enhanced LRC ----------
async function loadLyrics() {
  const res = await fetch('crime-2-say-oke-shortest.lrc');
  const text = await res.text();
  lyrics = parseEnhancedLRC(text);
}

function parseEnhancedLRC(text) {
  const lines = [];
  const regex = /\[(\d+):(\d+\.\d+)\](.*)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const min = parseInt(match[1]);
    const sec = parseFloat(match[2]);
    const start = min * 60 + sec;
    const content = match[3].trim();

    // Extract words with optional <timestamps>
    const words = [];
    const wordRegex = /<(\d+):(\d+\.\d+)>([^<]*)/g;
    let wMatch;
    let lastIndex = 0;
    let plain = content.replace(wordRegex, '').trim();

    // If enhanced
    wordRegex.lastIndex = 0;
    while ((wMatch = wordRegex.exec(content)) !== null) {
      const wMin = parseInt(wMatch[1]);
      const wSec = parseFloat(wMatch[2]);
      const wStart = wMin * 60 + wSec;
      const word = wMatch[3].trim();
      if (word) words.push({ text: word, start: wStart });
    }

    if (words.length === 0 && plain) {
      // fallback: treat whole line as one word
      words.push({ text: plain, start });
    }

    lines.push({ start, words, plain: plain || content });
  }
  return lines;
}

// ---------- 3. Count-in (Web Audio) ----------
function playBeep(time) {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.frequency.value = B3;
  osc.type = 'sine';
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(0.4, time + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.18);
  osc.start(time);
  osc.stop(time + 0.2);
}

function startCountIn() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const now = audioCtx.currentTime;

  const labels = ['3', '2', '1', 'GO'];
  labels.forEach((label, i) => {
    const t = now + (i * BEAT_MS) / 1000;
    playBeep(t);

    setTimeout(() => {
      COUNT_DISPLAY.textContent = label;
      COUNT_DISPLAY.classList.remove('hidden');
    }, i * BEAT_MS);
  });

  // On 4th beat (GO) → start everything
  setTimeout(() => {
    COUNT_DISPLAY.classList.add('hidden');
    beginRecordingAndMusic();
  }, 3 * BEAT_MS);
}

// ---------- 4. Recording + Music ----------
function beginRecordingAndMusic() {
  // Start backing track
  audio = new Audio('crime-2-say-oke-shortest.mp3');
  audio.play().catch(console.error);

  startTime = performance.now();

  // Prepare MediaRecorder from canvas + audio
  const canvasStream = CANVAS.captureStream(30);
  const audioTracks = stream.getAudioTracks();
  const mixedStream = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...audioTracks
  ]);

  recordedChunks = [];
  mediaRecorder = new MediaRecorder(mixedStream, {
    mimeType: 'video/webm;codecs=vp9,opus'
  });

  mediaRecorder.ondataavailable = e => {
    if (e.data.size > 0) recordedChunks.push(e.data);
  };

  mediaRecorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: 'video/webm' });
    downloadVideo(blob);
    resetUI();
  };

  mediaRecorder.start(100);
  isRecording = true;
  RECORD_BTN.classList.add('recording');
  RECORD_BTN.querySelector('.btn-text').textContent = 'STOP';
}

// ---------- 5. Draw loop (lyrics + ball) ----------
function resizeCanvas() {
  const rect = PREVIEW.getBoundingClientRect();
  CANVAS.width = PREVIEW.videoWidth || 720;
  CANVAS.height = PREVIEW.videoHeight || 1280;
}

function drawLoop() {
  animationId = requestAnimationFrame(drawLoop);
  if (!PREVIEW.videoWidth) return;

  // Draw camera frame
  CTX.drawImage(PREVIEW, 0, 0, CANVAS.width, CANVAS.height);

  if (!isRecording && !audio) return; // only draw lyrics during/after count-in when music is active

  const elapsed = audio ? audio.currentTime : 0;
  drawLyricsAndBall(elapsed);
}

function drawLyricsAndBall(time) {
  // Find current line
  let line = null;
  for (let i = 0; i < lyrics.length; i++) {
    if (time >= lyrics[i].start) line = lyrics[i];
    else break;
  }
  if (!line || !line.words.length) return;

  const isPortrait = CANVAS.height > CANVAS.width;
  const fontSize = isPortrait ? Math.floor(CANVAS.width / 14) : Math.floor(CANVAS.height / 16);
  CTX.font = `bold ${fontSize}px Arial`;
  CTX.textAlign = 'center';
  CTX.textBaseline = 'middle';
  CTX.lineWidth = Math.max(2, fontSize / 12);
  CTX.strokeStyle = '#000';

  const y = CANVAS.height * 0.78;
  const centerX = CANVAS.width / 2;

  // Measure total line width for centering
  const fullText = line.words.map(w => w.text).join(' ');
  const metrics = CTX.measureText(fullText);
  let x = centerX - metrics.width / 2;

  // Draw each word
  let activeWordIndex = -1;
  line.words.forEach((word, idx) => {
    const nextStart = line.words[idx + 1] ? line.words[idx + 1].start : line.start + 5;
    if (time >= word.start && time < nextStart) activeWordIndex = idx;

    CTX.fillStyle = (idx === activeWordIndex) ? '#00FF7F' : '#ffffff';
    CTX.strokeText(word.text, x + CTX.measureText(word.text).width / 2, y);
    CTX.fillText(word.text, x + CTX.measureText(word.text).width / 2, y);
    x += CTX.measureText(word.text + ' ').width;
  });

  // Simple bouncing ball
  if (activeWordIndex >= 0) {
    const word = line.words[activeWordIndex];
    const progress = Math.min(1, (time - word.start) / 0.4);
    const bounce = Math.sin(progress * Math.PI) * (fontSize * 1.6);

    // Approximate x position of active word
    let ballX = centerX - metrics.width / 2;
    for (let i = 0; i < activeWordIndex; i++) {
      ballX += CTX.measureText(line.words[i].text + ' ').width;
    }
    ballX += CTX.measureText(word.text).width / 2;

    CTX.beginPath();
    CTX.arc(ballX, y - fontSize * 0.7 - bounce, fontSize * 0.28, 0, Math.PI * 2);
    CTX.fillStyle = '#00FF7F';
    CTX.fill();
    CTX.strokeStyle = '#000';
    CTX.lineWidth = 2;
    CTX.stroke();
  }

  // Extra text overlays (always shown in recording)
  CTX.font = `${Math.floor(fontSize * 0.55)}px Courier`;
  CTX.fillStyle = '#ffffff';
  CTX.textAlign = 'center';
  CTX.fillText('"Crime to Say" Karaoke Challenge', centerX, y + fontSize * 1.5);
  CTX.fillText('CRIME2SAY.UK', centerX, y + fontSize * 2.2);
}

// ---------- 6. UI & Download ----------
RECORD_BTN.addEventListener('click', () => {
  if (!isRecording) {
    startCountIn();
  } else {
    stopRecording();
  }
});

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  if (audio) {
    audio.pause();
    audio = null;
  }
  // Stop mic monitoring
  if (stream) {
    stream.getAudioTracks().forEach(t => t.enabled = false);
  }
  isRecording = false;
}

function downloadVideo(blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Crime2Say-${Date.now()}.webm`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function resetUI() {
  RECORD_BTN.classList.remove('recording');
  RECORD_BTN.querySelector('.btn-text').textContent = 'REC';
  // Re-enable mic for next take
  if (stream) {
    stream.getAudioTracks().forEach(t => t.enabled = true);
  }
}

// ---------- Init ----------
window.addEventListener('resize', resizeCanvas);
initCamera();
loadLyrics();
