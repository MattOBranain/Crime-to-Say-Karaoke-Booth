// =====================================================
// Crime to Say Karaoke – Fixed version
// =====================================================

const PREVIEW = document.getElementById('preview');
const CANVAS = document.getElementById('overlay-canvas');
const CTX = CANVAS.getContext('2d');
const RECORD_BTN = document.getElementById('record-btn');
const COUNT_DISPLAY = document.getElementById('count-in-display');
const WRAPPER = document.getElementById('preview-wrapper');

let stream = null;
let audioCtx = null;
let mediaRecorder = null;
let recordedChunks = [];
let isRecording = false;
let animationId = null;
let lyrics = [];
let audioElement = null;          // backing track
let destinationNode = null;       // for mixing
let micSource = null;
let musicSource = null;

const BPM = 80;
const BEAT_DURATION = 60 / BPM;   // seconds
const B3_FREQ = 246.94;

// -------------------------------------------------
// 1. Camera + Microphone
// -------------------------------------------------
async function initCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width:  { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    PREVIEW.srcObject = stream;
    PREVIEW.onloadedmetadata = () => {
      updateAspectRatio();
      resizeCanvas();
      startDrawLoop();
    };
  } catch (err) {
    alert('Camera and microphone permission are required.');
    console.error(err);
  }
}

function updateAspectRatio() {
  if (!PREVIEW.videoWidth) return;
  const ratio = PREVIEW.videoWidth / PREVIEW.videoHeight;
  WRAPPER.style.aspectRatio = ratio;
}

// -------------------------------------------------
// 2. Load & parse Enhanced LRC
// -------------------------------------------------
async function loadLyrics() {
  try {
    const res = await fetch('crime-2-say-oke-shortest.lrc');
    const text = await res.text();
    lyrics = parseEnhancedLRC(text);
  } catch (e) {
    console.error('Could not load LRC', e);
  }
}

function parseEnhancedLRC(text) {
  const result = [];
  const lineRe = /\[(\d+):(\d+(?:\.\d+)?)\](.*)/g;
  let m;

  while ((m = lineRe.exec(text)) !== null) {
    const start = parseInt(m[1]) * 60 + parseFloat(m[2]);
    const raw = m[3].trim();
    const words = [];

    const wordRe = /<(\d+):(\d+(?:\.\d+)?)>([^<]*)/g;
    let wm;
    while ((wm = wordRe.exec(raw)) !== null) {
      const wStart = parseInt(wm[1]) * 60 + parseFloat(wm[2]);
      const word = wm[3].trim();
      if (word) words.push({ text: word, start: wStart });
    }

    if (words.length === 0 && raw) {
      words.push({ text: raw, start });
    }

    result.push({ start, words });
  }
  return result;
}

// -------------------------------------------------
// 3. Count-in
// -------------------------------------------------
function playTone(when) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);

  osc.frequency.value = B3_FREQ;
  osc.type = 'sine';

  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.exponentialRampToValueAtTime(0.45, when + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.16);

  osc.start(when);
  osc.stop(when + 0.18);
}

function startCountIn() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  const now = audioCtx.currentTime;
  const labels = ['3', '2', '1', 'GO'];

  labels.forEach((label, i) => {
    const t = now + i * BEAT_DURATION;
    playTone(t);

    setTimeout(() => {
      COUNT_DISPLAY.textContent = label;
      COUNT_DISPLAY.classList.remove('hidden');
    }, i * BEAT_DURATION * 1000);
  });

  // Start recording + music on the 4th beat (GO)
  setTimeout(() => {
    COUNT_DISPLAY.classList.add('hidden');
    beginRecording();
  }, 3 * BEAT_DURATION * 1000);
}

// -------------------------------------------------
// 4. Start recording with proper audio mix
// -------------------------------------------------
async function beginRecording() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // Create destination for mixed audio
  destinationNode = audioCtx.createMediaStreamDestination();

  // Mic
  micSource = audioCtx.createMediaStreamSource(stream);
  micSource.connect(destinationNode);

  // Backing track
  audioElement = new Audio('crime-2-say-oke-shortest.mp3');
  audioElement.crossOrigin = 'anonymous';
  await audioElement.play();

  musicSource = audioCtx.createMediaElementSource(audioElement);
  musicSource.connect(destinationNode);
  // Also play locally so user hears it
  musicSource.connect(audioCtx.destination);

  // Canvas stream
  const canvasStream = CANVAS.captureStream(30);

  // Final stream = video from canvas + mixed audio
  const finalStream = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...destinationNode.stream.getAudioTracks()
  ]);

  recordedChunks = [];

  // Prefer mp4 if the browser supports it
  let options = { mimeType: 'video/mp4;codecs=avc1,mp4a.40.2' };
  if (!MediaRecorder.isTypeSupported(options.mimeType)) {
    options = { mimeType: 'video/webm;codecs=vp9,opus' };
  }
  if (!MediaRecorder.isTypeSupported(options.mimeType)) {
    options = { mimeType: 'video/webm' };
  }

  mediaRecorder = new MediaRecorder(finalStream, {
    ...options,
    videoBitsPerSecond: 4500000,
    audioBitsPerSecond: 192000
  });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recordedChunks.push(e.data);
  };

  mediaRecorder.onstop = () => {
    const isMp4 = mediaRecorder.mimeType.includes('mp4');
    const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType });
    downloadRecording(blob, isMp4);
    cleanupAfterStop();
  };

  mediaRecorder.start(200);
  isRecording = true;

  RECORD_BTN.classList.add('recording');
  RECORD_BTN.querySelector('.btn-text').textContent = 'STOP';
}

// -------------------------------------------------
// 5. Stop
// -------------------------------------------------
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
  if (micSource) micSource.disconnect();
  if (musicSource) musicSource.disconnect();

  // Mute mic monitoring
  if (stream) {
    stream.getAudioTracks().forEach(track => track.enabled = false);
  }
}

// -------------------------------------------------
// 6. Download (iOS friendly)
// -------------------------------------------------
function downloadRecording(blob, isMp4) {
  const ext = isMp4 ? 'mp4' : 'webm';
  const filename = `Crime2Say-${Date.now()}.${ext}`;
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.style.display = 'none';
  a.href = url;
  a.download = filename;

  // iOS / iPadOS sometimes needs this pattern
  document.body.appendChild(a);
  a.click();

  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 150);

  // Re-enable mic for next take
  if (stream) {
    stream.getAudioTracks().forEach(track => track.enabled = true);
  }
}

// -------------------------------------------------
// 7. Drawing (lyrics + ball) with better padding
// -------------------------------------------------
function resizeCanvas() {
  if (!PREVIEW.videoWidth) return;
  CANVAS.width = PREVIEW.videoWidth;
  CANVAS.height = PREVIEW.videoHeight;
}

function startDrawLoop() {
  function loop() {
    animationId = requestAnimationFrame(loop);
    if (!PREVIEW.videoWidth) return;

    CTX.drawImage(PREVIEW, 0, 0, CANVAS.width, CANVAS.height);

    if (audioElement && !audioElement.paused) {
      drawLyricsAndBall(audioElement.currentTime);
    }
  }
  loop();
}

function drawLyricsAndBall(time) {
  let current = null;
  for (let i = 0; i < lyrics.length; i++) {
    if (time >= lyrics[i].start) current = lyrics[i];
    else break;
  }
  if (!current || !current.words.length) return;

  const isPortrait = CANVAS.height >= CANVAS.width;
  const baseSize = isPortrait ? CANVAS.width / 15.5 : CANVAS.height / 17;
  const fontSize = Math.max(22, Math.floor(baseSize));
  const paddingX = isPortrait ? CANVAS.width * 0.08 : CANVAS.width * 0.06; // healthy margin

  CTX.font = `bold ${fontSize}px Arial`;
  CTX.textAlign = 'left';
  CTX.textBaseline = 'middle';
  CTX.lineWidth = Math.max(2.5, fontSize / 11);
  CTX.strokeStyle = '#000';

  const y = CANVAS.height * 0.79;

  // Calculate total width of line
  const texts = current.words.map(w => w.text);
  const full = texts.join(' ');
  const totalWidth = CTX.measureText(full).width;

  // Centered start X with padding protection
  let x = (CANVAS.width - totalWidth) / 2;
  x = Math.max(paddingX, Math.min(x, CANVAS.width - totalWidth - paddingX));

  // Draw words
  let activeIdx = -1;
  current.words.forEach((word, idx) => {
    const next = current.words[idx + 1];
    if (time >= word.start && (!next || time < next.start)) {
      activeIdx = idx;
    }

    const w = CTX.measureText(word.text).width;
    CTX.fillStyle = (idx === activeIdx) ? '#00FF7F' : '#ffffff';

    CTX.strokeText(word.text, x, y);
    CTX.fillText(word.text, x, y);

    x += w + CTX.measureText(' ').width;
  });

  // Bouncing ball
  if (activeIdx >= 0) {
    const word = current.words[activeIdx];
    const progress = Math.min(1, (time - word.start) / 0.35);
    const bounce = Math.sin(progress * Math.PI) * (fontSize * 1.55);

    // Re-calculate x of active word
    let ballX = (CANVAS.width - totalWidth) / 2;
    ballX = Math.max(paddingX, Math.min(ballX, CANVAS.width - totalWidth - paddingX));
    for (let i = 0; i < activeIdx; i++) {
      ballX += CTX.measureText(current.words[i].text + ' ').width;
    }
    ballX += CTX.measureText(word.text).width / 2;

    CTX.beginPath();
    CTX.arc(ballX, y - fontSize * 0.75 - bounce, fontSize * 0.27, 0, Math.PI * 2);
    CTX.fillStyle = '#00FF7F';
    CTX.fill();
    CTX.lineWidth = 2;
    CTX.strokeStyle = '#000';
    CTX.stroke();
  }

  // Extra overlays
  const small = Math.floor(fontSize * 0.52);
  CTX.font = `${small}px Courier`;
  CTX.fillStyle = '#ffffff';
  CTX.textAlign = 'center';
  CTX.fillText('"Crime to Say" Karaoke Challenge', CANVAS.width / 2, y + fontSize * 1.55);
  CTX.fillText('CRIME2SAY.UK', CANVAS.width / 2, y + fontSize * 2.25);
}

// -------------------------------------------------
// 8. Button handler
// -------------------------------------------------
RECORD_BTN.addEventListener('click', () => {
  if (!isRecording) {
    startCountIn();
  } else {
    stopRecording();
  }
});

// -------------------------------------------------
// Init
// -------------------------------------------------
window.addEventListener('resize', () => {
  updateAspectRatio();
  resizeCanvas();
});

initCamera();
loadLyrics();
