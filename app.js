// =====================================================
// Crime to Say Karaoke – Final polish version
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

// ---------- Camera ----------
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

// ---------- Much more robust LRC parser ----------
async function loadLyrics() {
  try {
    const res = await fetch('crime-2-say-oke-shortest.lrc');
    const text = await res.text();
    lyrics = parseEnhancedLRC(text);
    console.log('Parsed lyrics:', lyrics); // helpful for debugging
  } catch (e) {
    console.error('LRC load failed', e);
  }
}

function parseEnhancedLRC(text) {
  const result = [];
  const lines = text.split(/\r?\n/);

  for (let raw of lines) {
    raw = raw.trim();
    if (!raw.startsWith('[')) continue;

    const match = raw.match(/^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/);
    if (!match) continue;

    const start = parseInt(match[1]) * 60 + parseFloat(match[2]);
    let content = match[3].trim();

    const words = [];

    // Primary: enhanced tags <mm:ss.xx>word
    const wordRe = /<(\d+):(\d+(?:\.\d+)?)>([^<]*)/g;
    let wm;
    let foundEnhanced = false;

    while ((wm = wordRe.exec(content)) !== null) {
      foundEnhanced = true;
      const wStart = parseInt(wm[1]) * 60 + parseFloat(wm[2]);
      let word = wm[3].trim();
      // Remove any trailing punctuation that sometimes sticks
      if (word) words.push({ text: word, start: wStart });
    }

    // Fallback – treat whole line as one word or split on spaces
    if (!foundEnhanced && content) {
      // Keep the original first characters
      words.push({ text: content, start });
    }

    if (words.length > 0) {
      result.push({ start, words });
    }
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

  // Mic – full level, clean
  micSource = audioCtx.createMediaStreamSource(stream);
  micSource.connect(destinationNode);

  // Music – reduced
  audioElement = new Audio('crime-2-say-oke-shortest.mp3');
  audioElement.crossOrigin = 'anonymous';
  await audioElement.play();

  musicSource = audioCtx.createMediaElementSource(audioElement);
  musicGain = audioCtx.createGain();
  musicGain.gain.value = 0.52;
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
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];
  let chosen = candidates.find(t => MediaRecorder.isTypeSupported(t)) || '';

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

  if (stream) {
    stream.getAudioTracks().forEach(t => t.enabled = false);
  }
}

// ---------- Save modal + best possible “Save to Photos” ----------
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

  // Best path: Web Share API (gives “Save Video” on many phones)
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: 'Crime to Say Karaoke'
      });
      MODAL.classList.add('hidden');
      if (stream) stream.getAudioTracks().forEach(t => t.enabled = true);
      return;
    } catch (err) {
      // User cancelled or share failed → fall through to download
      console.log('Share cancelled or failed', err);
    }
  }

  // Fallback: classic download
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

// ---------- Drawing + improved bouncing ball ----------
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
  const fontSize = Math.max(22, Math.floor(isPortrait ? CANVAS.width / 15.5 : CANVAS.height / 17));
  const paddingX = isPortrait ? CANVAS.width * 0.085 : CANVAS.width * 0.065;
  const maxWidth = CANVAS.width - paddingX * 2;

  CTX.font = `bold ${fontSize}px Arial`;
  CTX.textAlign = 'left';
  CTX.textBaseline = 'middle';
  CTX.lineWidth = Math.max(2.5, fontSize / 11);
  CTX.strokeStyle = '#000';

  // Simple single-line for now (most karaoke lines fit)
  const words = current.words;
  let totalWidth = 0;
  words.forEach(w => totalWidth += CTX.measureText(w.text + ' ').width);

  let startX = (CANVAS.width - totalWidth) / 2;
  startX = Math.max(paddingX, Math.min(startX, CANVAS.width - totalWidth - paddingX));

  const y = CANVAS.height * 0.78;

  // Draw words + collect positions for the ball
  const wordPositions = [];
  let x = startX;

  words.forEach((word, idx) => {
    const wWidth = CTX.measureText(word.text).width;
    const isActive = time >= word.start && (idx === words.length - 1 || time < words[idx + 1].start);

    CTX.fillStyle = isActive ? '#00FF7F' : '#ffffff';
    CTX.strokeText(word.text, x, y);
    CTX.fillText(word.text, x, y);

    wordPositions.push({
      centre: x + wWidth / 2,
      start: word.start,
      end: (idx < words.length - 1) ? words[idx + 1].start : word.start + 0.8
    });

    x += wWidth + CTX.measureText(' ').width;
  });

  // ===== Traditional karaoke bouncing ball =====
  if (wordPositions.length > 0) {
    let ballX = wordPositions[0].centre;
    let ballY = y - fontSize * 0.75;
    let found = false;

    for (let i = 0; i < wordPositions.length; i++) {
      const curr = wordPositions[i];
      const next = wordPositions[i + 1];

      if (time >= curr.start && (!next || time < next.start)) {
        // Sitting on this word
        ballX = curr.centre;
        ballY = y - fontSize * 0.75;
        found = true;
        break;
      }

      if (next && time >= curr.start && time < next.start) {
        // Travelling between curr and next
        const progress = (time - curr.start) / (next.start - curr.start);
        const eased = progress; // linear is fine, or use ease

        // Horizontal
        ballX = curr.centre + (next.centre - curr.centre) * eased;

        // Parabolic arc (high bounce)
        const arcHeight = fontSize * 1.8;
        ballY = (y - fontSize * 0.75) - Math.sin(progress * Math.PI) * arcHeight;
        found = true;
        break;
      }
    }

    if (found) {
      CTX.beginPath();
      CTX.arc(ballX, ballY, fontSize * 0.28, 0, Math.PI * 2);
      CTX.fillStyle = '#00FF7F';
      CTX.fill();
      CTX.lineWidth = 2.5;
      CTX.strokeStyle = '#000';
      CTX.stroke();
    }
  }

  // Extra text – larger, same margins, no red outline
  const small = Math.floor(fontSize * 0.62);
  CTX.font = `bold ${small}px Courier`;
  CTX.textAlign = 'center';
  CTX.lineWidth = 3;
  CTX.strokeStyle = '#000';
  CTX.fillStyle = '#ffffff';

  const extraY1 = y + fontSize * 1.7;
  const extraY2 = extraY1 + small * 1.35;

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
