// ============================================
// CRIME TO SAY... KARAOKE BOOTH - Main App
// Updated: use single AudioContext-driven live mix for sync and visible overlay
// ============================================

// Globals
let stream = null;
let canvas = null;
let ctx = null;
let mediaRecorder = null;
let recordedChunks = [];
let audioContext = null;
let backingTrackAudio = null;
let ffmpegReady = false;
let recordingStartAudioTime = 0; // audioContext.currentTime when recording started
let recordingStartPreviewTS = 0; // Date.now fallback
let recordingDuration = 0;

// Karaoke animation state
let lyrics = [];
let currentLyricIndex = 0;
let lastActiveWordIndex = -1;

// DOM
const preview = document.getElementById('preview');
const previewContainer = document.getElementById('preview-container');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusDiv = document.getElementById('status');
const processingCanvas = document.getElementById('processing-canvas');

// Output resolution (portrait)
const OUTPUT_W = 1080;
const OUTPUT_H = 1920;
let DPR = Math.max(1, Math.floor(window.devicePixelRatio) || 1);

// Utility: easing
function easeInOutQuad(t){ return t<0.5 ? 2*t*t : -1 + (4-2*t)*t; }

// ============================================
// FFmpeg init (optional)
// ============================================
async function initFFmpeg(){
  try{
    if (typeof FFmpeg === 'undefined') return;
    const { createFFmpeg, fetchFile } = FFmpeg;
    const ffmpeg = createFFmpeg({ log: false });
    statusDiv.innerText = 'Loading FFmpeg...';
    if (!ffmpeg.isLoaded()) await ffmpeg.load();
    ffmpegReady = true;
    window.ffmpegInstance = ffmpeg;
    window.ffmpegFetchFile = fetchFile;
    statusDiv.innerText = 'Ready (FFmpeg loaded)';
  }catch(e){ console.warn('FFmpeg init failed', e); ffmpegReady = false; statusDiv.innerText = 'Ready (FFmpeg unavailable)'; }
}

// ============================================
// Init
// ============================================
async function init(){
  try{
    statusDiv.innerText = 'Requesting camera...';
    // Request flexible resolution; avoid strict ideal to reduce odd cropping on iOS
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: true });

    preview.srcObject = stream;
    preview.play().catch(()=>{});

    canvas = processingCanvas;
    ctx = canvas.getContext('2d');

    setCanvasSize();

    previewContainer.style.position = 'relative';

    // Ensure preview & canvas layering
    preview.style.position = 'absolute'; preview.style.top = '0'; preview.style.left = '0'; preview.style.width = '100%'; preview.style.height = '100%'; preview.style.objectFit = 'contain';
    canvas.style.position = 'absolute'; canvas.style.top = '0'; canvas.style.left = '0'; canvas.style.width = '100%'; canvas.style.height = '100%'; canvas.style.zIndex = '2'; canvas.style.pointerEvents = 'none';

    await loadLyrics();

    requestAnimationFrame(drawLoop);

    initFFmpeg();

    statusDiv.innerText = 'Ready';
    startBtn.disabled = false;
  }catch(err){
    console.error('Init failed', err);
    statusDiv.innerText = 'Camera or mic unavailable';
    startBtn.disabled = true;
  }
}

function setCanvasSize(){
  DPR = Math.max(1, Math.floor(window.devicePixelRatio) || 1);
  canvas.width = OUTPUT_W * DPR;
  canvas.height = OUTPUT_H * DPR;
  canvas.style.width = OUTPUT_W + 'px';
  canvas.style.height = OUTPUT_H + 'px';
  ctx.setTransform(DPR,0,0,DPR,0,0);
}

// ============================================
// Draw loop
// ============================================
function drawLoop(now = performance.now()){
  requestAnimationFrame(drawLoop);
  if (!canvas || !preview) return;

  const newDPR = Math.max(1, Math.floor(window.devicePixelRatio) || 1);
  if (newDPR !== DPR) setCanvasSize();

  const cw = OUTPUT_W; const ch = OUTPUT_H;
  ctx.clearRect(0,0,cw,ch);

  if (preview.readyState >= 2){
    const videoAspect = (preview.videoWidth || 9) / (preview.videoHeight || 16);
    const canvasAspect = cw / ch;
    let drawW, drawH, dx, dy;
    if (videoAspect > canvasAspect){ drawW = cw; drawH = cw / videoAspect; dx = 0; dy = (ch - drawH)/2; }
    else { drawH = ch; drawW = ch * videoAspect; dx = (cw - drawW)/2; dy = 0; }

    ctx.save();
    ctx.translate(cw,0); ctx.scale(-1,1); // mirror
    ctx.drawImage(preview, cw - dx - drawW, dy, drawW, drawH);
    ctx.restore();

    // Draw overlay
    drawKaraokeOverlay();
    drawBottomCaption();
  }
}

// ============================================
// Karaoke overlay: driven by audioContext.currentTime when recording, backingTrackAudio.currentTime for preview
// ============================================
function drawKaraokeOverlay(){
  if (!lyrics || lyrics.length === 0) return;

  // determine playback time in seconds
  let nowSec = 0;
  if (audioContext && recordingStartAudioTime) {
    nowSec = audioContext.currentTime - recordingStartAudioTime;
  } else if (backingTrackAudio && !backingTrackAudio.paused) {
    nowSec = backingTrackAudio.currentTime;
  } else if (recordingStartPreviewTS) {
    nowSec = (Date.now() - recordingStartPreviewTS) / 1000;
  } else {
    return; // nothing playing
  }

  // find active line
  let activeLine = null;
  for (let i=0;i<lyrics.length;i++){
    if (nowSec >= lyrics[i].start && nowSec <= lyrics[i].end){ activeLine = lyrics[i]; currentLyricIndex = i; break; }
  }
  if (!activeLine) return;

  const cw = OUTPUT_W;
  const bottomY = OUTPUT_H - 220;

  const lineText = (activeLine.text || '').replace(/\s+/g,' ').trim();
  let fontSize = Math.round(cw * 0.07);
  ctx.font = `bold ${fontSize}px Arial`;
  const padding = 100;
  let measured = ctx.measureText(lineText).width;
  while (measured > (cw - padding) && fontSize > 18){ fontSize -= 2; ctx.font = `bold ${fontSize}px Arial`; measured = ctx.measureText(lineText).width; }

  const words = (activeLine.words && activeLine.words.length) ? activeLine.words.slice() : lineText.split(' ').map((w,i,arr)=>({ text:w, start: activeLine.start + (i/arr.length)*(activeLine.end-activeLine.start), end: activeLine.start + ((i+1)/arr.length)*(activeLine.end-activeLine.start) }));

  const spaceWidth = ctx.measureText(' ').width;
  let totalW = 0;
  const measuredWords = words.map(w=>{ const wWidth = ctx.measureText(w.text).width; totalW += wWidth + spaceWidth; return {...w, width:wWidth}; });

  let startX = Math.round((cw - totalW)/2);
  if (startX < 30) startX = 30;

  // draw inactive words dim
  ctx.textBaseline = 'middle';
  let x = startX;
  for (let i=0;i<measuredWords.length;i++){
    const w = measuredWords[i]; ctx.fillStyle = '#ffffff'; ctx.globalAlpha = 0.35; ctx.fillText(w.text, x + w.width/2 - w.width/2, bottomY); x += w.width + spaceWidth; }
  ctx.globalAlpha = 1.0;

  // find active word index
  let activeWordIndex = -1;
  for (let i=0;i<measuredWords.length;i++){
    if (nowSec >= measuredWords[i].start && nowSec <= measuredWords[i].end){ activeWordIndex = i; break; }
  }
  if (activeWordIndex === -1 && nowSec > activeLine.end) activeWordIndex = measuredWords.length -1;

  // compute centers and draw words, and ball
  x = startX;
  let prevCenter = x + (measuredWords[0]?.width||0)/2;
  let ballCenterX = prevCenter;
  for (let i=0;i<measuredWords.length;i++){
    const w = measuredWords[i]; const centerX = x + w.width/2;
    if (i < activeWordIndex){ ctx.fillStyle = '#fff'; ctx.fillText(w.text, x, bottomY); }
    else if (i === activeWordIndex){
      const t = Math.max(0, Math.min(1, (nowSec - w.start) / Math.max(0.0001, (w.end - w.start))));
      const ease = easeInOutQuad(t);
      ballCenterX = prevCenter + (centerX - prevCenter) * ease;
      ctx.fillStyle = '#fff'; ctx.fillText(w.text, x, bottomY);

      const maxArc = 60;
      const arc = Math.sin(Math.PI * ease) * maxArc;
      const ballY = bottomY - (fontSize * 1.8) - arc;
      const ballRadius = Math.max(12, Math.round(fontSize * 0.28));
      ctx.beginPath(); ctx.fillStyle = '#fff'; ctx.arc(ballCenterX, ballY, ballRadius, 0, Math.PI * 2); ctx.fill(); ctx.closePath();
    } else {
      ctx.fillStyle = '#fff'; ctx.globalAlpha = 0.6; ctx.fillText(w.text, x, bottomY); ctx.globalAlpha = 1.0;
    }
    prevCenter = centerX;
    x += w.width + spaceWidth;
  }
}

// Bottom caption
function drawBottomCaption(){
  const cw = OUTPUT_W; const text = '#CRIMETOSAY KARAOKE CHALLENGE!';
  let fontSize = Math.round(cw * 0.045);
  ctx.font = `bold ${fontSize}px Arial`;
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.fillText(text, cw/2, OUTPUT_H - 40);
}

// ============================================
// Start recording: create single backing track and AudioContext live mix
// ============================================
async function ensureBackingTrack(){
  if (!backingTrackAudio){
    backingTrackAudio = new Audio('./crime-to-say-oke-challenge.mp3');
    backingTrackAudio.crossOrigin = 'anonymous';
    backingTrackAudio.preload = 'auto';
    backingTrackAudio.loop = false;
  }
}

async function startRecording(){
  try{
    startBtn.disabled = true; stopBtn.disabled = false; recordedChunks = [];

    await ensureBackingTrack();

    // Create or resume AudioContext on user gesture
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === 'suspended') await audioContext.resume();

    // Create mixing destination
    const mixDest = audioContext.createMediaStreamDestination();

    // backing track source
    const backSrc = audioContext.createMediaElementSource(backingTrackAudio);
    const backGain = audioContext.createGain(); backGain.gain.value = 0.8; backSrc.connect(backGain).connect(mixDest);

    // mic source
    const micSrc = audioContext.createMediaStreamSource(stream);
    const micGain = audioContext.createGain(); micGain.gain.value = 1.0; micSrc.connect(micGain).connect(mixDest);

    // Do NOT connect mixDest to audioContext.destination to avoid live monitoring/echo

    // Prepare canvas stream and attach mixed audio
    const canvasStream = canvas.captureStream(30);
    mixDest.stream.getAudioTracks().forEach(t => canvasStream.addTrack(t));

    // Fallback: ensure at least mic track available
    if (mixDest.stream.getAudioTracks().length === 0){ if (stream && stream.getAudioTracks().length) canvasStream.addTrack(stream.getAudioTracks()[0]); }

    // Prepare MediaRecorder
    let mime = '';
    if (MediaRecorder.isTypeSupported('video/mp4')) mime='video/mp4';
    else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')) mime='video/webm;codecs=vp9,opus';
    else mime='video/webm';

    mediaRecorder = new MediaRecorder(canvasStream, { mimeType: mime });
    mediaRecorder.ondataavailable = e => { if (e.data && e.data.size) recordedChunks.push(e.data); };
    mediaRecorder.onerror = e => { console.error('recorder error', e); statusDiv.innerText = 'Recording error'; startBtn.disabled = false; stopBtn.disabled = true; };

    mediaRecorder.onstop = async () => {
      recordingDuration = (Date.now() - recordingStartPreviewTS)/1000;
      const blob = new Blob(recordedChunks, { type: mime });
      if (audioContext && ffmpegReady && window.ffmpegInstance && mime.includes('webm')){
        try{ await transcodeToMp4(blob); return; } catch(e){ console.warn('transcode failed', e); }
      }
      await saveToGallery(blob, `crime-to-say-${Date.now()}.${mime.includes('mp4') ? 'mp4' : 'webm'}`);
      statusDiv.innerText = 'Done';
    };

    // Start playback and recording in sync
    try{ await backingTrackAudio.play(); } catch(e){ console.warn('playback blocked', e); }
    // align audio clock
    recordingStartAudioTime = audioContext.currentTime;
    recordingStartPreviewTS = Date.now();

    mediaRecorder.start();
    statusDiv.innerText = 'Recording';
  }catch(err){ console.error('startRecording failed', err); statusDiv.innerText = 'Start failed'; startBtn.disabled = false; stopBtn.disabled = true; }
}

// Stop recording
function stopRecording(){
  try{ if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop(); } catch(e){ console.warn(e); }
  if (backingTrackAudio){ backingTrackAudio.pause(); backingTrackAudio.currentTime = 0; }
  if (audioContext){ try{ audioContext.close(); } catch(e){} audioContext = null; }
  startBtn.disabled = false; stopBtn.disabled = true; statusDiv.innerText = 'Processing...';
}

// Transcode to MP4 using ffmpeg.wasm if available
async function transcodeToMp4(inputBlob){
  if (!ffmpegReady || !window.ffmpegInstance || !window.ffmpegFetchFile) throw new Error('ffmpeg unavailable');
  const ffmpeg = window.ffmpegInstance; const fetchFile = window.ffmpegFetchFile;
  statusDiv.innerText = 'Transcoding to MP4...';
  const data = await fetchFile(inputBlob);
  ffmpeg.FS('writeFile','input.webm', data);
  await ffmpeg.run('-i','input.webm','-c:v','libx264','-preset','fast','-c:a','aac','-ac','2','output.mp4');
  const out = ffmpeg.FS('readFile','output.mp4');
  const mp4 = new Blob([out.buffer], { type: 'video/mp4' });
  try{ ffmpeg.FS('unlink','input.webm'); }catch(e){}
  try{ ffmpeg.FS('unlink','output.mp4'); }catch(e){}
  await saveToGallery(mp4, `crime-to-say-${Date.now()}.mp4`);
  statusDiv.innerText = 'Done!';
}

// Save blob to filesystem / download
async function saveToGallery(blob, filename){
  try{
    if (window.showSaveFilePicker){
      const handle = await window.showSaveFilePicker({ suggestedName: filename, types: [{ description: 'Video', accept: { 'video/mp4': ['.mp4'], 'video/webm': ['.webm'] } }] });
      const writable = await handle.createWritable(); await writable.write(blob); await writable.close();
    } else {
      const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url), 60000);
    }
  }catch(e){ console.warn('save failed', e); }
}

// Load lyrics (try JSON file first then fallback to SRT)
async function loadLyrics(){
  try{ const res = await fetch('./lyrics.JSON'); if (res.ok){ const data = await res.json(); // expected structure: timed.line with begin/end/content
      if (data && data.timed && data.timed.line){ lyrics = data.timed.line.map(l=>({ start: Number(l.begin), end: Number(l.end), text: l.content })); console.log('Loaded lyrics.JSON'); return; } }
  }catch(e){}
  try{ const res2 = await fetch('./lyrics.json'); if (res2.ok){ const data = await res2.json(); if (data && data.timed && data.timed.line){ lyrics = data.timed.line.map(l=>({ start: Number(l.begin), end: Number(l.end), text: l.content })); console.log('Loaded lyrics.json'); return; } } }catch(e){}
  // Fallback: try SRT
  try{ const res3 = await fetch('./lyrics.srt'); if (res3.ok){ const srt = await res3.text(); lyrics = parseSRT(srt); console.log('Loaded lyrics.srt'); return; } }catch(e){}
  console.warn('No lyrics loaded');
}

function parseSRT(srt){
  const parts = srt.split(/\n\s*\n/); const out = [];
  for (const p of parts){ const lines = p.split('\n').map(l=>l.trim()).filter(Boolean); if (lines.length >= 2){ const time = lines[1]; const m = time.match(/(\d{2}:\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,\.]\d{3})/); if (m){ const start = parseTimecode(m[1]); const end = parseTimecode(m[2]); const text = lines.slice(2).join(' '); out.push({ start, end, text }); } } }
  return out;
}
function parseTimecode(tc){ const parts = tc.split(/[:,\.]/).map(x=>parseInt(x,10)); if (parts.length>=4) return parts[0]*3600+parts[1]*60+parts[2]+(parts[3]/1000); return 0; }

// Events
startBtn.addEventListener('click', startRecording);
stopBtn.addEventListener('click', stopRecording);
window.addEventListener('load', init);

