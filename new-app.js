/* new-app.js - rebuilt single-file app that satisfies the one-shot requirements
   - Uses Web Audio API for precise count-in
   - Parses Enhanced LRC
   - Composites camera + overlays onto canvas
   - Records canvas with mixed audio (mic + backing track) via MediaRecorder
   - Uses ffmpeg.wasm if available to transcode to mp4; otherwise offers webm
   - Accessibility & mobile-first layout
*/

const AUDIO_FILE = './crime-2-say-oke-shortest.mp3';
const LRC_FILE = './crime-2-say-oke-shortest.lrc';
const OUTPUT_NAME_PREFIX = 'Crime2Say-';

const preview = document.getElementById('preview');
const canvas = document.getElementById('compose-canvas');
const ctx = canvas.getContext('2d');
const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const countinDiv = document.getElementById('countin');
const statusDiv = document.getElementById('status');

const OUT_W = 1080, OUT_H = 1920;
let deviceRatio = Math.max(1, Math.floor(window.devicePixelRatio) || 1);
canvas.width = OUT_W * deviceRatio; canvas.height = OUT_H * deviceRatio; ctx.setTransform(deviceRatio,0,0,deviceRatio,0,0);

let userStream = null;
let audioCtx = null; // created at startRecording for mixing
let backingEl = null;
let mixDest = null;
let mediaRecorder = null;
let recordedChunks = [];
let lyrics = [];
let ffmpegReady = false;
let ffmpegInstance = null;

// small utils
const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
function ease(t){ return t<0.5?2*t*t:-1+(4-2*t)*t; }

async function init(){
  statusDiv.textContent = 'Requesting camera & mic...';
  try{
    userStream = await navigator.mediaDevices.getUserMedia({video:{facingMode:'user'}, audio:true});
    preview.srcObject = userStream; await preview.play().catch(()=>{});
    await loadLRC();
    statusDiv.textContent = 'Ready';
    startBtn.disabled = false;
    // lazy init ffmpeg
    initFFmpeg().catch(e=>console.warn('ffmpeg init error',e));
    requestAnimationFrame(renderLoop);
  }catch(e){ console.error(e); statusDiv.textContent = 'Camera or mic unavailable'; startBtn.disabled=true }
}

async function initFFmpeg(){ if (!('FFmpeg' in window)) return; try{ const { createFFmpeg, fetchFile } = FFmpeg; const ff = createFFmpeg({log:false}); await ff.load(); ffmpegReady=true; ffmpegInstance=ff; statusDiv.textContent='Ready (ffmpeg loaded)'; }catch(e){console.warn('ffmpeg load failed',e);} }

async function loadLRC(){ try{ const txt = await (await fetch(LRC_FILE)).text(); lyrics = parseEnhancedLRC(txt); console.log('loaded lyrics',lyrics); }catch(e){ console.warn('lrc load failed',e)} }

function parseEnhancedLRC(text){ const lines = text.split(/\n+/).map(l=>l.trim()).filter(Boolean); const out=[]; for(const line of lines){ const m = line.match(/^\[(\d{2}:\d{2}\.\d{3})\]\s*(.*)$/); if(!m) continue; const start = timecodeToSec(m[1]); const rest = m[2]; // parse word timings like <00:00.274> WORD <00:00.579> etc
    const wordRe = /<([0-9:\.]+)>\s*([^<]+)/g; let words=[]; let lastEnd = start; let w; while((w = wordRe.exec(rest))){ const wt = timecodeToSec(w[1]); const txt = w[2].trim(); words.push({text:txt, start:wt}); lastEnd = wt; }
    // estimate end: next line start or last word+0.8
    out.push({start:start, words:words, end: (words.length? words[words.length-1].start + 0.8 : start+2.5)});
  }
  // fill end times precisely by looking at next line
  for(let i=0;i<out.length;i++){ if(i+1<out.length) out[i].end = out[i+1].start; }
  // compute per-word end times
  for(const ln of out){ for(let i=0;i<ln.words.length;i++){ ln.words[i].end = (i+1<ln.words.length)? ln.words[i+1].start : ln.end; } }
  return out;
}
function timecodeToSec(tc){ // formats: mm:ss.mmm or hh:mm:ss.mmm sometimes
  const parts = tc.split(':').map(x=>x.replace(',', '.')); if(parts.length===2){ return parseFloat(parts[0])*60 + parseFloat(parts[1]); } if(parts.length===3){ return parseFloat(parts[0])*3600 + parseFloat(parts[1])*60 + parseFloat(parts[2]); } return 0; }

// render live composition
function renderLoop(){ requestAnimationFrame(renderLoop); if(!preview || !canvas) return; const cw = OUT_W, ch = OUT_H; ctx.clearRect(0,0,cw,ch);
  if(preview.readyState>=2){ // draw mirrored video
    const videoAspect = preview.videoWidth/preview.videoHeight || (9/16);
    const canvasAspect = cw/ch;
    let dw,dh,dx,dy; if(videoAspect>canvasAspect){ dw=cw; dh=cw/videoAspect; dx=0; dy=(ch-dh)/2; } else { dh=ch; dw=ch*videoAspect; dx=(cw-dw)/2; dy=0; }
    ctx.save(); ctx.translate(cw,0); ctx.scale(-1,1); ctx.drawImage(preview, cw-dx-dw, dy, dw, dh); ctx.restore();
  }
  drawLyricsOverlay();
  drawFinalText();
}

function drawLyricsOverlay(){ if(!lyrics.length) return; // determine current playback time from backingEl if playing, or from Date.now as fallback
  let now = 0; if(backingEl && !backingEl.paused){ now = backingEl.currentTime; } else if(startTimePreview){ now = (Date.now()-startTimePreview)/1000; } else return;
  const active = lyrics.find(l=> now>=l.start && now<=l.end) || null; if(!active) return; const cw = OUT_W; const bottomY = OUT_H - 220;
  // measure font and adjust size
  ctx.font = `bold ${Math.round(cw*0.07)}px Arial`; let fontSize = Math.round(cw*0.07);
  while(ctx.measureText(active.words.map(w=>w.text).join(' ')).width > (cw-120) && fontSize>18){ fontSize-=2; ctx.font = `bold ${fontSize}px Arial`; }
  // prepare words
  const words = active.words.map(w=>({...w, width: ctx.measureText(w.text).width})); const space = ctx.measureText(' ').width; const totalW = words.reduce((s,w)=>s+w.width,0) + space*(words.length-1);
  let x = Math.max(40, Math.round((cw-totalW)/2)); ctx.textBaseline='middle';
  // draw inactive words dim with stroke
  ctx.lineWidth = Math.max(2, Math.floor(fontSize*0.08)); ctx.strokeStyle='rgba(0,0,0,0.9)';
  for(let i=0;i<words.length;i++){ const w=words[i]; const cx = x + w.width/2; ctx.fillStyle='rgba(255,255,255,0.9)'; ctx.globalAlpha = 0.35; ctx.strokeText(w.text, x, bottomY); ctx.fillText(w.text, x, bottomY); x += w.width + space; }
  ctx.globalAlpha = 1;
  // find active word
  let activeIndex = words.findIndex((w,idx)=> now>=w.start && now<=w.end);
  if(activeIndex===-1 && now>active.end) activeIndex = words.length-1;
  // draw words again with active highlighted and bouncing ball
  x = Math.max(40, Math.round((cw-totalW)/2)); let prevCenter = x + words[0].width/2;
  for(let i=0;i<words.length;i++){ const w=words[i]; const center = x + w.width/2; if(i<activeIndex){ ctx.fillStyle='#fff'; ctx.strokeStyle='rgba(0,0,0,0.9)'; ctx.fillText(w.text, x, bottomY); ctx.strokeText(w.text,x,bottomY); }
    else if(i===activeIndex){ ctx.fillStyle='${'#00FF7F'}'; ctx.fillText(w.text, x, bottomY); // ball
      const t = clamp((now - w.start)/Math.max(0.0001,(w.end-w.start)),0,1); const e = ease(t); const ballX = prevCenter + (center-prevCenter)*e; const maxArc = 80; const arc = Math.sin(Math.PI*e)*maxArc; const ballY = bottomY - (fontSize*1.6) - arc; ctx.beginPath(); ctx.fillStyle='#00FF7F'; ctx.arc(ballX, ballY, Math.max(12, Math.round(fontSize*0.28)),0,Math.PI*2); ctx.fill(); ctx.closePath(); }
    else { ctx.fillStyle='#fff'; ctx.globalAlpha = 0.65; ctx.fillText(w.text, x, bottomY); ctx.globalAlpha=1; }
    prevCenter = center; x += w.width + space;
  }
}

function drawFinalText(){ const cw = OUT_W; ctx.font = `24px Courier`; ctx.fillStyle='#fff'; ctx.textAlign='center'; ctx.fillText('Crime to Say Karaoke Challenge', cw/2, OUT_H - 140); ctx.fillText('CRIME2SAY.UK', cw/2, OUT_H - 110); }

let startTimePreview = 0;

async function startRecording(){ startBtn.disabled=true; stopBtn.disabled=false; statusDiv.textContent='Counting in...';
  // play 4-count beeps at 80 BPM (0.75s between beats), show visual count on the live preview only
  const bpm = 80; const beatSec = 60/bpm; const count = ['3','2','1','GO'];
  // Use a separate AudioContext for count beeps so they are NOT mixed into the final recording
  const ciCtx = new (window.AudioContext || window.webkitAudioContext)();
  // show visuals timed
  for(let i=0;i<count.length;i++){
    const label = count[i]; countinDiv.textContent = label; const when = ciCtx.currentTime + i*beatSec;
    playBeep(ciCtx, when, 0.12, 246.94);
    await sleep(beatSec*1000);
  }
  countinDiv.textContent='';
  // now start audio mix + recording
  statusDiv.textContent='Recording';
  // prepare audio context for mix
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  await audioCtx.resume();
  mixDest = audioCtx.createMediaStreamDestination();

  // backing track element
  backingEl = new Audio(AUDIO_FILE); backingEl.crossOrigin = 'anonymous'; backingEl.preload = 'auto';
  const backSrc = audioCtx.createMediaElementSource(backingEl);
  const backGain = audioCtx.createGain(); backGain.gain.value = 0.85; backSrc.connect(backGain).connect(mixDest);

  // mic
  const micSrc = audioCtx.createMediaStreamSource(userStream);
  const micGain = audioCtx.createGain(); micGain.gain.value = 1.0; micSrc.connect(micGain).connect(mixDest);

  // start backing exactly now
  backingEl.currentTime = 0; try{ await backingEl.play(); }catch(e){ console.warn('backing play blocked',e); }

  startTimePreview = Date.now();

  // capture canvas and attach mixed audio
  const cs = canvas.captureStream(30);
  mixDest.stream.getAudioTracks().forEach(t=> cs.addTrack(t));

  recordedChunks = [];
  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')? 'video/webm;codecs=vp9,opus' : (MediaRecorder.isTypeSupported('video/webm')? 'video/webm' : 'video/mp4');
  mediaRecorder = new MediaRecorder(cs, { mimeType: mime });
  mediaRecorder.ondataavailable = e=>{ if(e.data && e.data.size) recordedChunks.push(e.data); };
  mediaRecorder.onstop = async ()=>{ statusDiv.textContent='Processing...'; const blob = new Blob(recordedChunks, {type: mime}); if(ffmpegReady && ffmpegInstance && mime.includes('webm')){
      try{ await transcodeToMp4(blob); return; }catch(e){ console.warn('ffmpeg transcode failed',e); }
    }
    await saveBlob(blob, `${OUTPUT_NAME_PREFIX}${Date.now()}.${mime.includes('mp4')?'mp4':'webm'}`);
    statusDiv.textContent='Done';
  };
  mediaRecorder.start();
}

function stopRecording(){ stopBtn.disabled=true; startBtn.disabled=false; statusDiv.textContent='Stopping...'; try{ if(mediaRecorder && mediaRecorder.state==='recording') mediaRecorder.stop(); }catch(e){console.warn(e)} if(backingEl){ backingEl.pause(); backingEl.currentTime=0; }
  // stop tracks & audio context
  if(userStream){ userStream.getTracks().forEach(t=>t.stop()); }
  if(audioCtx){ try{ audioCtx.close(); }catch(e){} audioCtx=null; }
}

startBtn.addEventListener('click', startRecording);
stopBtn.addEventListener('click', stopRecording);

function playBeep(ctx, when, dur=0.08, freq=246.94){ const o = ctx.createOscillator(); const g = ctx.createGain(); o.type='sine'; o.frequency.value = freq; g.gain.setValueAtTime(0, when); g.gain.linearRampToValueAtTime(0.15, when+0.01); g.gain.exponentialRampToValueAtTime(0.001, when+dur); o.connect(g); g.connect(ctx.destination); o.start(when); o.stop(when+dur+0.02); }

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function transcodeToMp4(blob){ statusDiv.textContent='Transcoding to MP4...'; const ff = ffmpegInstance; const data = await fetch(blob).then(r=>r.arrayBuffer()); ff.FS('writeFile','input.webm', new Uint8Array(data)); await ff.run('-i','input.webm','-c:v','libx264','-preset','veryfast','-c:a','aac','-b:a','128k','output.mp4'); const out = ff.FS('readFile','output.mp4'); const mp4 = new Blob([out.buffer], {type:'video/mp4'}); // cleanup
  try{ ff.FS('unlink','input.webm'); ff.FS('unlink','output.mp4'); }catch(e){}
  await saveBlob(mp4, `${OUTPUT_NAME_PREFIX}${Date.now()}.mp4`);
}

async function saveBlob(blob, filename){ // mobile-friendly save
  try{
    if(navigator.canShare && navigator.canShare({files:[new File([blob],filename,{type:blob.type})]})){
      await navigator.share({files:[new File([blob],filename,{type:blob.type})], title: filename});
    } else if(window.showSaveFilePicker){ const handle = await window.showSaveFilePicker({suggestedName: filename, types:[{description:'Video',accept:{'video/mp4':['.mp4'],'video/webm':['.webm']}}]}); const w = await handle.createWritable(); await w.write(blob); await w.close();
    } else { const url = URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url), 60000); }
  }catch(e){ console.warn('save failed',e); }
}

// Stop mic monitoring if any (we don't monitor), but hook for future

// Render loop started in init

window.addEventListener('load', init);
