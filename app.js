// ============================================
// CRIME TO SAY... KARAOKE BOOTH - Main App (DPR & smooth ball fixes)
// ============================================

// Global Variables
let stream = null;
let canvas = null;
let ctx = null;
let mediaRecorder = null;
let recordedChunks = [];
let audioContext = null;
let backingTrackAudio = null;
let ffmpegReady = false;
let recordingStartTime = 0;
let recordingDuration = 0;

// Karaoke animation state
let lyrics = null;
let currentLyricIndex = 0;
let ballX = 0;
let ballStartX = 0;
let ballTargetX = 0;
let ballAnimStart = 0;
let ballAnimDuration = 220; // ms transition between words
let lastActiveWordIndex = -1;

// DOM Elements
const preview = document.getElementById('preview');
const previewContainer = document.getElementById('preview-container');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusDiv = document.getElementById('status');
const processingCanvas = document.getElementById('processing-canvas');

// Device pixel ratio for crisp canvas and correct measurements
const OUTPUT_W = 1080;
const OUTPUT_H = 1920;
let DPR = Math.max(1, Math.floor(window.devicePixelRatio) || 1);

// ============================================
// 0. FFmpeg initialization (optional)
// ============================================
async function initFFmpeg() {
  try {
    const { createFFmpeg, fetchFile } = FFmpeg;
    const ffmpeg = createFFmpeg({ log: true });
    statusDiv.innerText = 'Loading FFmpeg...';
    if (!ffmpeg.isLoaded()) await ffmpeg.load();
    ffmpegReady = true;
    window.ffmpegInstance = ffmpeg;
    window.ffmpegFetchFile = fetchFile;
    statusDiv.innerText = 'Ready (FFmpeg loaded)';
  } catch (e) {
    console.warn('FFmpeg init failed', e);
    ffmpegReady = false;
    statusDiv.innerText = 'Ready (FFmpeg unavailable)';
  }
}

// ============================================
// 1. Init
// ============================================
async function init() {
  try {
    statusDiv.innerText = 'Requesting camera...';
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: OUTPUT_W }, height: { ideal: OUTPUT_H } }, audio: true });

    preview.srcObject = stream;
    preview.play().catch(()=>{});

    canvas = processingCanvas;
    ctx = canvas.getContext('2d');

    // Set canvas physical size (DPR aware)
    setCanvasSize();

    // Ensure container & layering
    previewContainer.style.position = 'relative';

    preview.style.position = 'absolute'; preview.style.top = '0'; preview.style.left = '0'; preview.style.width = '100%'; preview.style.height = '100%'; preview.style.objectFit = 'contain'; preview.style.zIndex = '1';
    canvas.style.position = 'absolute'; canvas.style.top = '0'; canvas.style.left = '0'; canvas.style.width = '100%'; canvas.style.height = '100%'; canvas.style.zIndex = '2'; canvas.style.pointerEvents = 'none';

    // Load lyrics
    await loadLyrics();

    // Start draw loop
    requestAnimationFrame(drawLoop);

    // Init ffmpeg (optional)
    initFFmpeg();

    statusDiv.innerText = 'Ready';
    startBtn.disabled = false;
  } catch (err) {
    console.error('Init failed', err);
    statusDiv.innerText = 'Camera or mic unavailable';
    startBtn.disabled = true;
  }
}

function setCanvasSize() {
  DPR = Math.max(1, Math.floor(window.devicePixelRatio) || 1);
  canvas.width = OUTPUT_W * DPR;
  canvas.height = OUTPUT_H * DPR;
  canvas.style.width = OUTPUT_W + 'px';
  canvas.style.height = OUTPUT_H + 'px';
  // Set transform so all drawing measurements are in CSS pixels
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}

// ============================================
// Draw loop with DPR-corrected measurements and time-based ball animation
// ============================================
let lastFrameTime = performance.now();
function drawLoop(now = performance.now()) {
  requestAnimationFrame(drawLoop);
  if (!canvas || !preview) return;

  // Recompute canvas size if DPR changed (e.g., device rotation)
  const newDPR = Math.max(1, Math.floor(window.devicePixelRatio) || 1);
  if (newDPR !== DPR) setCanvasSize();

  const cw = OUTPUT_W; // working in CSS pixels now
  const ch = OUTPUT_H;

  // Clear transparent (video underneath)
  ctx.clearRect(0, 0, cw, ch);

  if (preview.readyState >= 2) {
    // contain fit
    const videoAspect = (preview.videoWidth || 9) / (preview.videoHeight || 16);
    const canvasAspect = cw / ch;
    let drawW, drawH, dx, dy;
    if (videoAspect > canvasAspect) {
      drawW = cw; drawH = cw / videoAspect; dx = 0; dy = (ch - drawH)/2;
    } else {
      drawH = ch; drawW = ch * videoAspect; dx = (cw - drawW)/2; dy = 0;
    }

    ctx.save();
    // mirror horizontally
    ctx.translate(cw, 0); ctx.scale(-1, 1);
    ctx.drawImage(preview, cw - dx - drawW, dy, drawW, drawH);
    ctx.restore();

    // Draw karaoke overlay
    drawKaraokeOverlay(now);
    // Bottom caption
    drawBottomCaption();
  }

  lastFrameTime = now;
}

// ============================================
// Karaoke overlay with tidy spacing and smooth ball
// ============================================
function easeInOutQuad(t){ return t<0.5 ? 2*t*t : -1 + (4-2*t)*t; }

function drawKaraokeOverlay(nowMillis) {
  if (!lyrics || lyrics.length === 0) return;

  const now = (Date.now() - recordingStartTime)/1000;
  let activeLine = null;
  for (let i=0;i<lyrics.length;i++){ if (now >= lyrics[i].start && now <= lyrics[i].end){ activeLine = lyrics[i]; currentLyricIndex = i; break; }}
  if (!activeLine) return;

  const cw = OUTPUT_W;
  const bottomY = OUTPUT_H - 260;

  const lineText = (activeLine.text || '').replace(/\s+/g,' ').trim();
  let fontSize = Math.round(cw * 0.06);
  ctx.font = `bold ${fontSize}px Arial`;
  const padding = 120;
  let measured = ctx.measureText(lineText).width;
  while (measured > (cw - padding) && fontSize > 18){ fontSize -= 2; ctx.font = `bold ${fontSize}px Arial`; measured = ctx.measureText(lineText).width; }

  const words = (activeLine.words && activeLine.words.length) ? activeLine.words.slice() : lineText.split(' ').map((w,i,arr)=>({ text:w, start: activeLine.start + (i/arr.length)*(activeLine.end-activeLine.start), end: activeLine.start + ((i+1)/arr.length)*(activeLine.end-activeLine.start) }));

  // Compute total width properly by measuring each word + single space
  let totalW = 0;
  const wordWidths = words.map((w, idx)=>{ const s = w.text + (idx < words.length -1 ? ' ' : ''); const m = ctx.measureText(s).width; totalW += m; return m; });
  let x = (cw - totalW) / 2;

  // active word idx
  let activeWordIndex = 0;
  for (let w=0; w<words.length; w++){ if (now >= words[w].start && now <= words[w].end){ activeWordIndex = w; break; } if (now > words[w].end) activeWordIndex = w; }

  // When active word changes, start an animation from current ballX to computed center
  if (activeWordIndex !== lastActiveWordIndex) {
    // compute center x for that word
    let acc = 0;
    for (let i=0;i<activeWordIndex;i++) acc += wordWidths[i];
    const wText = words[activeWordIndex].text;
    const wNoSpaceWidth = ctx.measureText(wText).width;
    const centerX = x + acc + wNoSpaceWidth/2;
    ballStartX = isFinite(ballX) && ballX>0 ? ballX : centerX;
    ballTargetX = centerX;
    ballAnimStart = performance.now();
    lastActiveWordIndex = activeWordIndex;
  }

  // compute interpolation t from time
  const nowMs = performance.now();
  let t = Math.min(1, Math.max(0, (nowMs - ballAnimStart) / ballAnimDuration));
  const eased = easeInOutQuad(t);
  ballX = ballStartX + (ballTargetX - ballStartX) * eased;

  // Draw words with left alignment and consistent spacing
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left'; ctx.lineWidth = Math.max(3, Math.round(fontSize*0.12));
  let cursor = x;
  for (let i=0;i<words.length;i++){
    const w = words[i]; const wordNoSpace = w.text; const withSpace = wordNoSpace + (i < words.length -1 ? ' ' : '');
    // stroke
    ctx.strokeStyle = '#000'; ctx.strokeText(wordNoSpace, cursor, bottomY);
    if (i === activeWordIndex) { ctx.fillStyle = '#66BB6A'; ctx.fillText(wordNoSpace, cursor, bottomY); } else { ctx.fillStyle = '#FFF'; ctx.fillText(wordNoSpace, cursor, bottomY); }
    // advance by measured width of withSpace
    const adv = ctx.measureText(withSpace).width;
    cursor += adv;
  }

  // draw bouncing ball using progress of current word for arc height
  if (isFinite(ballX) && ballX>0) {
    const aw = words[activeWordIndex];
    const prog = Math.max(0, Math.min(1, (now - aw.start) / Math.max(0.001, (aw.end - aw.start))));
    const arcH = Math.max(18, fontSize * 0.8);
    const yOff = Math.sin(prog * Math.PI) * arcH;
    const r = Math.max(6, fontSize * 0.12);
    ctx.beginPath(); ctx.fillStyle = '#FFD700'; ctx.arc(ballX, bottomY - fontSize - 12 - yOff, r, 0, Math.PI*2); ctx.fill();
  }
}

// ============================================
// Bottom caption
// ============================================
function drawBottomCaption(){ const cw=OUTPUT_W, ch=OUTPUT_H; const text = '#CRIMETOSAY KARAOKE CHALLENGE!'; let fontSize = Math.round(cw * 0.045); ctx.font = `bold ${fontSize}px Arial`; let measured = ctx.measureText(text).width; const maxW = cw - 60; while (measured > maxW && fontSize > 12){ fontSize -=2; ctx.font = `bold ${fontSize}px Arial`; measured = ctx.measureText(text).width; } ctx.textAlign='center'; ctx.textBaseline='bottom'; const x=cw/2; const y=ch-40; ctx.lineWidth = Math.max(3, Math.round(fontSize*0.12)); ctx.strokeStyle='#000'; ctx.fillStyle='#FFF'; ctx.strokeText(text,x,y); ctx.fillText(text,x,y); }

// ============================================
// Start recording (WebAudio live-mix preferred)
// ============================================
async function startRecording(){
  try{
    startBtn.disabled = true; stopBtn.disabled = false;
    recordedChunks = []; recordingStartTime = Date.now();

    backingTrackAudio = new Audio('./crime-to-say-oke-challenge.mp3'); backingTrackAudio.crossOrigin='anonymous';
    await new Promise(r=>{ const t=setTimeout(r,1000); backingTrackAudio.addEventListener('canplay', ()=>{ clearTimeout(t); r(); },{once:true}); });

    const canvasStream = canvas.captureStream(30);

    // WebAudio live mix
    let mixedTrack = null;
    try{
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const dest = audioContext.createMediaStreamDestination();
      const micSrc = audioContext.createMediaStreamSource(stream);
      const micGain = audioContext.createGain(); micGain.gain.value = 1.0; micSrc.connect(micGain); micGain.connect(dest);
      const backSrc = audioContext.createMediaElementSource(backingTrackAudio);
      const backGain = audioContext.createGain(); backGain.gain.value = 0.7; backSrc.connect(backGain); backGain.connect(dest);
      mixedTrack = dest.stream.getAudioTracks()[0];
      if (mixedTrack){ canvasStream.getAudioTracks().forEach(t=>canvasStream.removeTrack(t)); canvasStream.addTrack(mixedTrack); statusDiv.innerText='Recording (live mix)'; }
      else throw new Error('no mixed audio track');
    }catch(e){ console.warn('live mix failed', e); statusDiv.innerText='Recording (fallback)'; canvasStream.getAudioTracks().forEach(t=>canvasStream.removeTrack(t)); if (stream && stream.getAudioTracks().length) canvasStream.addTrack(stream.getAudioTracks()[0]); }

    // MediaRecorder
    let mime=''; if (MediaRecorder.isTypeSupported('video/mp4')) mime='video/mp4'; else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')) mime='video/webm;codecs=vp9,opus'; else mime='video/webm';
    mediaRecorder = new MediaRecorder(canvasStream, { mimeType: mime });
    mediaRecorder.ondataavailable = e=>{ if (e.data && e.data.size) recordedChunks.push(e.data); };
    mediaRecorder.onstop = async ()=>{
      recordingDuration = (Date.now()-recordingStartTime)/1000; const blob = new Blob(recordedChunks, { type: mime });
      // If live-mix used, blob already has mixed audio; transcode to mp4 if possible
      if (audioContext && ffmpegReady && window.ffmpegInstance && mime.includes('webm')){
        try{ await transcodeToMp4(blob); return;}catch(e){ console.warn('transcode failed',e); }
      }
      await saveToGallery(blob, `crime-to-say-${Date.now()}.${mime.includes('mp4')? 'mp4':'webm'}`); statusDiv.innerText='Done';
    };
    mediaRecorder.onerror = e=>{ console.error('recorder error',e); statusDiv.innerText='Recording error'; startBtn.disabled=false; stopBtn.disabled=true; };

    mediaRecorder.start();
    try{ await backingTrackAudio.play(); }catch(e){ console.warn('playback blocked',e);}  
  }catch(err){ console.error('startRecording failed',err); statusDiv.innerText='Start failed'; startBtn.disabled=false; stopBtn.disabled=true; }
}

// ============================================
// Stop recording
// ============================================
function stopRecording(){ if (mediaRecorder && mediaRecorder.state==='recording') mediaRecorder.stop(); if (backingTrackAudio){ backingTrackAudio.pause(); backingTrackAudio.currentTime=0;} if (audioContext){ try{ audioContext.close(); }catch(e){} audioContext=null; } startBtn.disabled=false; stopBtn.disabled=true; statusDiv.innerText='Processing...'; }

// ============================================
// Transcode to MP4 using ffmpeg.wasm
// ============================================
async function transcodeToMp4(inputBlob){ if (!ffmpegReady || !window.ffmpegInstance || !window.ffmpegFetchFile) throw new Error('ffmpeg unavailable'); const ffmpeg = window.ffmpegInstance; const fetchFile = window.ffmpegFetchFile; statusDiv.innerText='Transcoding to MP4...'; const data = await fetchFile(inputBlob); ffmpeg.FS('writeFile','input.webm', data); await ffmpeg.run('-i','input.webm','-c:v','libx264','-preset','fast','-c:a','aac','-ac','2','output.mp4'); const out = ffmpeg.FS('readFile','output.mp4'); const mp4 = new Blob([out.buffer], { type: 'video/mp4' }); try{ ffmpeg.FS('unlink','input.webm'); }catch(e){} try{ ffmpeg.FS('unlink','output.mp4'); }catch(e){} await saveToGallery(mp4, `crime-to-say-${Date.now()}.mp4`); statusDiv.innerText='Done!'; }

// ============================================
// Save to gallery/download
// ============================================
async function saveToGallery(blob, filename){ try{ if (window.showSaveFilePicker){ const handle = await window.showSaveFilePicker({ suggestedName:filename, types:[{ description:'Video Files', accept:{ 'video/mp4':['.mp4'], 'video/webm':['.webm'] } }] }); const writable = await handle.createWritable(); await writable.write(blob); await writable.close(); statusDiv.innerText='Saved to Files'; return; } if (navigator.canShare && navigator.canShare({ files:[new File([blob], filename)] })){ await navigator.share({ files:[new File([blob], filename)], title:'Crime to Say Karaoke' }); statusDiv.innerText='Shared'; return; } const url = URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=filename; document.body.appendChild(a); a.click(); setTimeout(()=>{ document.body.removeChild(a); URL.revokeObjectURL(url); },200); statusDiv.innerText='Downloaded'; }catch(e){ console.error('save error',e); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=filename; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url); statusDiv.innerText='Downloaded (fallback)'; } }

// ============================================
// Load lyrics SRT/JSON
// ============================================
async function loadLyrics(){ try{ const res = await fetch('./lyrics.json'); if (res.ok){ lyrics = await res.json(); console.log('Loaded lyrics.json'); return; } }catch(e){} try{ const res = await fetch('./lyrics.srt'); if (res.ok){ const s=await res.text(); lyrics = parseSRT(s); console.log('Loaded lyrics.srt'); return; } }catch(e){} console.log('No lyrics file'); }
function parseTimecode(tc){ const m = tc.match(/(\d+):(\d+):(\d+)[,.](\d+)/); if (!m) return 0; return parseInt(m[1])*3600 + parseInt(m[2])*60 + parseInt(m[3]) + parseInt(m[4])/1000; }
function parseSRT(srt){ const parts = srt.split(/\n\s*\n/); const out=[]; for(const p of parts){ const lines = p.split('\n').map(l=>l.trim()).filter(Boolean); if(lines.length>=2){ const times = lines[1].split('-->'); const start=parseTimecode(times[0].trim()); const end=parseTimecode(times[1].trim()); const text = lines.slice(2).join(' ').trim(); const words = text.split(' ').map((w,i,arr)=>({ text:w, start: start + (i/arr.length)*(end-start), end: start + ((i+1)/arr.length)*(end-start) })); out.push({ start,end,text,words }); } } return out; }

// ============================================
// Events
// ============================================
startBtn.addEventListener('click', startRecording);
stopBtn.addEventListener('click', stopRecording);
window.addEventListener('load', init);
