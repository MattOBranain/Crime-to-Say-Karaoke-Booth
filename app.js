// =====================================================
// Crime to Say Karaoke – Updated
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
let finalIsMp4 = false;

const BPM = 80;
const BEAT_DURATION = 60 / BPM;
const B3_FREQ = 246.94;

// ---------- Camera ----------
async function initCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
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
  WRAPPER.style.aspectRatio = PREVIEW.videoWidth / PREVIEW.videoHeight;
}

// ---------- LRC Parser (more robust) ----------
async function loadLyrics() {
  try {
    const res = await fetch('crime-2-say-oke-shortest.lrc');
    const text = await res.text();
    lyrics = parseEnhancedLRC(text);
  } catch (e) {
    console.error('LRC load failed', e);
  }
}

function parseEnhancedLRC(text) {
  const result = [];
  const lines = text.split(/\r?\n/);

  for (const rawLine of lines) {
    const match = rawLine.match(/\[(\d+):(\d+(?:\.\d+)?)\](.*)/);
    if (!match) continue;

    const start = parseInt(match[1]) * 60 + parseFloat(match[2]);
    let content = match[3].trim();

    const words = [];
    // Match <mm:ss.xx>word  (handles missing spaces better)
    const wordRe = /<(\d+):(\d+(?:\.\d+)?)>\s*([^<]*)/g;
    let wm;
    while ((wm = wordRe.exec(content)) !== null) {
      const wStart = parseInt(wm[1]) * 60 + parseFloat(wm[2]);
      const word = wm[3].trim();
      if (word) words.push({ text: word, start: wStart });
    }

    // Fallback if no enhanced tags
    if (words.length === 0 && content) {
      words.push({ text: content, start });
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
  gain.gain.exponentialRampToValueAtTime(0.4, when + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.15);
  osc.start(when);
  osc.stop(when + 0.17);
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

// ---------- Recording with balanced mix ----------
async function beginRecording() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  destinationNode = audioCtx.createMediaStreamDestination();

  // Mic (full level)
  micSource = audioCtx.createMediaStreamSource(stream);
  micSource.connect(destinationNode);

  // Music – lowered ~3 dB
  audioElement = new Audio('crime-2-say-oke-shortest.mp3');
  audioElement.crossOrigin = 'anonymous';
  await audioElement.play();

  musicSource = audioCtx.createMediaElementSource(audioElement);
  musicGain = audioCtx.createGain();
  musicGain.gain.value = 0.55; // ~ -5 dB → more even with voice
  musicSource.connect(musicGain);
  musicGain.connect(destinationNode);
  musicGain.connect(audioCtx.destination); // hear it live

  const canvasStream = CANVAS.captureStream(30);
  const finalStream = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...destinationNode.stream.getAudioTracks()
  ]);

  recordedChunks = [];
  let options = { mimeType: 'video/mp4;codecs=avc1,mp4a.40.2' };
  if (!MediaRecorder.isTypeSupported(options.mimeType)) {
    options = { mimeType: 'video/webm;codecs=vp9,opus' };
  }
  if (!MediaRecorder.isTypeSupported(options.mimeType)) {
    options = { mimeType: 'video/webm' };
  }

  mediaRecorder = new MediaRecorder(finalStream, {
    ...options,
    videoBitsPerSecond: 5000000,
    audioBitsPerSecond: 192000
  });

  mediaRecorder.ondataavailable = e => {
    if (e.data?.size > 0) recordedChunks.push(e.data);
  };

  mediaRecorder.onstop = () => {
    finalIsMp4 = mediaRecorder.mimeType.includes('mp4');
    finalBlob = new Blob(recordedChunks, { type: mediaRecorder.mimeType });
    showSaveModal();
    cleanupAfterStop();
  };

  mediaRecorder.start(200);
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
  if (micSource) micSource.disconnect();
  if (musicSource) musicSource.disconnect();
  if (musicGain) musicGain.disconnect();

  if (stream) {
    stream.getAudioTracks().forEach(t => t.enabled = false);
  }
}

// ---------- Save modal ----------
function showSaveModal() {
  MODAL_STATUS.textContent = 'CONVERTING…';
  SAVE_BTN.classList.add('hidden');
  MODAL.classList.remove('hidden');

  // Short delay to simulate / allow processing
  setTimeout(() => {
    MODAL_STATUS.textContent = 'Ready!';
    SAVE_BTN.classList.remove('hidden');
  }, 600);
}

SAVE_BTN.addEventListener('click', () => {
  if (!finalBlob) return;
  const ext = finalIsMp4 ? 'mp4' : 'webm';
  const filename = `Crime2Say-${Date.now()}.${ext}`;
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
  }, 200);

  // Re-enable mic
  if (stream) {
    stream.getAudioTracks().forEach(t => t.enabled = true);
  }
});

// ---------- Drawing ----------
function resizeCanvas() {
  if (!PREVIEW.videoWidth) return;
  CANVAS.width = PREVIEW.videoWidth;
  CANVAS.height = PREVIEW.videoHeight;
}

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
  let current = null;
  for (let i = 0; i < lyrics.length; i++) {
    if (time >= lyrics[i].start) current = lyrics[i];
    else break;
  }
  if (!current || !current.words.length) return;

  const isPortrait = CANVAS.height >= CANVAS.width;
  const fontSize = Math.max(20, Math.floor(isPortrait ? CANVAS.width / 16 : CANVAS.height / 18));
  const paddingX = isPortrait ? CANVAS.width * 0.09 : CANVAS.width * 0.07;
  const maxWidth = CANVAS.width - paddingX * 2;

  CTX.font = `bold ${fontSize}px Arial`;
  CTX.textAlign = 'left';
  CTX.textBaseline = 'middle';
  CTX.lineWidth = Math.max(2.2, fontSize / 12);
  CTX.strokeStyle = '#000';

  // Build lines with wrapping
  const linesToDraw = [];
  let currentLineWords = [];
  let currentLineWidth = 0;

  current.words.forEach(word => {
    const w = CTX.measureText(word.text + ' ').width;
    if (currentLineWidth + w > maxWidth && currentLineWords.length > 0) {
      linesToDraw.push([...currentLineWords]);
      currentLineWords = [];
      currentLineWidth = 0;
    }
    currentLineWords.push(word);
    currentLineWidth += w;
  });
  if (currentLineWords.length) linesToDraw.push(currentLineWords);

  const baseY = CANVAS.height * 0.76;
  const lineHeight = fontSize * 1.35;

  linesToDraw.forEach((lineWords, lineIdx) => {
    const y = baseY + lineIdx * lineHeight;
    let totalW = 0;
    lineWords.forEach(w => totalW += CTX.measureText(w.text + ' ').width);
    let x = (CANVAS.width - totalW) / 2;
    x = Math.max(paddingX, Math.min(x, CANVAS.width - totalW - paddingX));

    lineWords.forEach((word, idx) => {
      const next = lineWords[idx + 1];
      const isActive = time >= word.start && (!next || time < next.start);

      CTX.fillStyle = isActive ? '#00FF7F' : '#ffffff';
      CTX.strokeText(word.text, x, y);
      CTX.fillText(word.text, x, y);

      // Ball only on active
      if (isActive) {
        const progress = Math.min(1, (time - word.start) / 0.35);
        const bounce = Math.sin(progress * Math.PI) * (fontSize * 1.5);
        const ballX = x + CTX.measureText(word.text).width / 2;

        CTX.beginPath();
        CTX.arc(ballX, y - fontSize * 0.7 - bounce, fontSize * 0.26, 0, Math.PI * 2);
        CTX.fillStyle = '#00FF7F';
        CTX.fill();
        CTX.lineWidth = 2;
        CTX.strokeStyle = '#000';
        CTX.stroke();
      }

      x += CTX.measureText(word.text + ' ').width;
    });
  });

  // Extra text – same width / grid as lyrics + red outline
  const small = Math.floor(fontSize * 0.52);
  CTX.font = `${small}px Courier`;
  CTX.textAlign = 'center';
  CTX.lineWidth = 2.5;
  CTX.strokeStyle = '#cc0000';          // small red outline
  CTX.fillStyle = '#ffffff';

  const extraY1 = baseY + linesToDraw.length * lineHeight + fontSize * 0.9;
  const extraY2 = extraY1 + small * 1.4;

  CTX.strokeText('"Crime to Say" Karaoke Challenge', CANVAS.width / 2, extraY1);
  CTX.fillText('"Crime to Say" Karaoke Challenge', CANVAS.width / 2, extraY1);
  CTX.strokeText('CRIME2SAY.UK', CANVAS.width / 2, extraY2);
  CTX.fillText('CRIME2SAY.UK', CANVAS.width / 2, extraY2);
}

// ---------- Button ----------
RECORD_BTN.addEventListener('click', () => {
  if (!isRecording) startCountIn();
  else stopRecording();
});

// ---------- Init ----------
window.addEventListener('resize', () => {
  updateAspectRatio();
  resizeCanvas();
});

initCamera();
loadLyrics();
