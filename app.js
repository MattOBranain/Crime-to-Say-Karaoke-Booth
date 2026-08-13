// ============================================
// CRIME TO SAY... KARAOKE BOOTH - Main App (updated)
// ============================================

// Global Variables
let stream = null;
let canvas = null;
let ctx = null;
let mediaRecorder = null;
let recordedChunks = [];
let ffmpegReady = false;
let recordingStartTime = 0;
let recordingDuration = 0;
let backingTrackAudio = null;

// DOM Elements
const preview = document.getElementById('preview');
const previewContainer = document.getElementById('preview-container');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusDiv = document.getElementById('status');
const processingCanvas = document.getElementById('processing-canvas');

// ============================================
// 0. FFMPEG INITIALIZATION (fixed)
// ============================================
async function initFFmpeg() {
    try {
        // FFmpeg is loaded from CDN and exposes a global named FFmpeg
        const { createFFmpeg, fetchFile } = FFmpeg;
        const ffmpeg = createFFmpeg({ log: true });

        statusDiv.innerText = "Loading FFmpeg...";
        if (!ffmpeg.isLoaded()) {
            await ffmpeg.load();
        }

        ffmpegReady = true;
        window.ffmpegInstance = ffmpeg;
        window.ffmpegFetchFile = fetchFile;
        console.log("FFmpeg ready for MP4 conversion");
        statusDiv.innerText = "Ready (FFmpeg loaded)";

    } catch (error) {
        console.warn("FFmpeg initialization failed:", error);
        ffmpegReady = false;
        statusDiv.innerText = "Ready (WebM format will be used; audio mixing unavailable)";
    }
}

// ============================================
// 1. INITIALIZATION - Request Camera & Setup
// ============================================
async function init() {
    try {
        statusDiv.innerText = "Requesting camera...";

        // Request camera with proper constraints for 9:16 aspect ratio
        stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: 'user',
                width: { ideal: 1080 },
                height: { ideal: 1920 }
            },
            audio: true // We'll use the mic for recording only
        });

        // Keep the video element muted and hidden; we draw the frames onto canvas
        preview.srcObject = stream;
        preview.play().catch(()=>{});

        // Setup canvas for recording and for visible overlay
        canvas = processingCanvas;
        ctx = canvas.getContext('2d');

        // Make sure the canvas is visible and sits over the preview container
        canvas.style.display = 'block';
        canvas.style.position = 'absolute';
        canvas.style.top = '0';
        canvas.style.left = '0';
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.zIndex = '5';
        canvas.style.pointerEvents = 'none';

        // Hide the raw video element to avoid double visuals
        preview.style.display = 'none';

        // Start drawing loop
        drawLoop();

        // Initialize FFmpeg for MP4 conversion
        await initFFmpeg();

        statusDiv.innerText = "Ready";
        startBtn.disabled = false;

    } catch (error) {
        console.error("Camera access error:", error);
        statusDiv.innerText = "Camera access denied or unavailable";
        startBtn.disabled = true;
    }
}

// ============================================
// 2. DRAWING LOOP - Render Camera to Canvas + Overlay Text + Karaoke
// ============================================
let lyrics = null; // will be populated from SRT/JSON externally if present
let currentLyricIndex = 0;

function drawLoop() {
    requestAnimationFrame(drawLoop);

    if (!canvas || !preview) return;

    // Only draw when we have video data
    if (preview.readyState === preview.HAVE_ENOUGH_DATA) {
        const canvasWidth = canvas.width;
        const canvasHeight = canvas.height;

        // Clear canvas (transparent so overlays sit over any background)
        ctx.clearRect(0, 0, canvasWidth, canvasHeight);

        // Draw mirrored video (flip horizontally)
        ctx.save();
        ctx.translate(canvasWidth, 0);
        ctx.scale(-1, 1);

        // Fit video to canvas while preserving aspect ratio
        const videoAspect = preview.videoWidth / preview.videoHeight || (9/16);
        const canvasAspect = canvasWidth / canvasHeight;
        let drawWidth, drawHeight, offsetX, offsetY;
        if (videoAspect > canvasAspect) {
            drawHeight = canvasHeight;
            drawWidth = drawHeight * videoAspect;
            offsetX = (canvasWidth - drawWidth) / 2;
            offsetY = 0;
        } else {
            drawWidth = canvasWidth;
            drawHeight = drawWidth / videoAspect;
            offsetX = 0;
            offsetY = (canvasHeight - drawHeight) / 2;
        }

        ctx.drawImage(preview, canvasWidth - offsetX - drawWidth, offsetY, drawWidth, drawHeight);
        ctx.restore();

        // Draw the karaoke overlay (bouncing ball + highlighted word)
        drawKaraokeOverlay();

        // Draw static lower caption (smaller, fits width)
        drawBottomCaption();
    }
}

// ============================================
// DRAW KARAOKE OVERLAY - words + bouncing ball
// ============================================
function drawKaraokeOverlay() {
    // Simple placeholder that uses lyrics (if loaded) to highlight current word
    // For now we assume lyrics is an array of {start, end, text, words:[{text,start,end}]}.
    if (!lyrics || !Array.isArray(lyrics) || lyrics.length === 0) return;

    const now = (Date.now() - recordingStartTime) / 1000; // seconds since recording started

    // Find active line
    let activeLine = null;
    for (let i = 0; i < lyrics.length; i++) {
        if (now >= lyrics[i].start && now <= lyrics[i].end) { activeLine = lyrics[i]; currentLyricIndex = i; break; }
    }

    if (!activeLine) return;

    // Layout the line center-bottom-ish
    const canvasWidth = canvas.width;
    const bottomY = canvas.height - 220; // leave safe area

    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';

    // Use Arial and compute font size so full line fits
    let fontSize = Math.round(canvas.width * 0.06); // starting guess
    ctx.font = `bold ${fontSize}px Arial`;
    const padding = 80;
    let measured = ctx.measureText(activeLine.text);
    while (measured.width > (canvasWidth - padding) && fontSize > 18) {
        fontSize -= 2;
        ctx.font = `bold ${fontSize}px Arial`;
        measured = ctx.measureText(activeLine.text);
    }

    // Draw black stroke for contrast
    ctx.lineWidth = Math.max(6, Math.round(fontSize * 0.12));
    ctx.strokeStyle = '#000';
    ctx.fillStyle = '#66BB6A'; // Kermit / parakeet green for highlight

    // Compute starting X to center the whole line
    const startX = (canvasWidth - measured.width) / 2;
    let x = startX;

    // Walk through words and highlight the currently active word
    if (!activeLine.words || activeLine.words.length === 0) {
        ctx.textAlign = 'center';
        ctx.strokeText(activeLine.text, canvasWidth/2, bottomY);
        ctx.fillText(activeLine.text, canvasWidth/2, bottomY);
        return;
    }

    // Determine active word based on now
    let activeWordIndex = 0;
    for (let w = 0; w < activeLine.words.length; w++) {
        if (now >= activeLine.words[w].start && now <= activeLine.words[w].end) { activeWordIndex = w; break; }
        if (now > activeLine.words[w].end) activeWordIndex = w; // fallback last seen
    }

    // Draw each word individually so we can highlight active word
    for (let w = 0; w < activeLine.words.length; w++) {
        const word = activeLine.words[w].text + (w < activeLine.words.length-1 ? ' ' : '');
        const wordWidth = ctx.measureText(word).width;

        // stroke
        ctx.strokeText(word, x + wordWidth/2, bottomY);

        if (w === activeWordIndex) {
            // fill highlighted
            ctx.fillStyle = '#66BB6A';
            ctx.fillText(word, x + wordWidth/2, bottomY);

            // draw bouncing ball above the word
            const midX = x + wordWidth/2;
            const t = (now - activeLine.words[w].start) / Math.max(0.001, (activeLine.words[w].end - activeLine.words[w].start));
            const bounce = Math.sin(t * Math.PI) * 28; // bounce height
            ctx.beginPath();
            ctx.fillStyle = '#FFD700';
            ctx.arc(midX, bottomY - fontSize - 12 - bounce, Math.max(8, fontSize * 0.12), 0, Math.PI*2);
            ctx.fill();
        } else {
            // normal fill (semi-white)
            ctx.fillStyle = '#FFFFFF';
            ctx.fillText(word, x + wordWidth/2, bottomY);
        }

        x += wordWidth;
    }
}

// ============================================
// DRAW BOTTOM CAPTION - fits across width & Arial
// ============================================
function drawBottomCaption() {
    const canvasWidth = canvas.width;
    const canvasHeight = canvas.height;

    const text = "#CRIMETOSAY KARAOKE CHALLENGE!";
    let fontSize = Math.round(canvasWidth * 0.045);
    ctx.font = `bold ${fontSize}px Arial`;
    let measured = ctx.measureText(text);
    const maxWidth = canvasWidth - 60;
    while (measured.width > maxWidth && fontSize > 12) {
        fontSize -= 2;
        ctx.font = `bold ${fontSize}px Arial`;
        measured = ctx.measureText(text);
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';

    const textX = canvasWidth / 2;
    const textY = canvasHeight - 40;

    // stroke + fill
    ctx.lineWidth = Math.max(4, Math.round(fontSize * 0.12));
    ctx.strokeStyle = '#000';
    ctx.fillStyle = '#FFFFFF';
    ctx.strokeText(text, textX, textY);
    ctx.fillText(text, textX, textY);
}

// ============================================
// 3. START RECORDING
// ============================================
async function startRecording() {
    try {
        // Reset any previous audio
        if (backingTrackAudio) { backingTrackAudio.pause(); backingTrackAudio.currentTime = 0; }

        recordedChunks = [];
        recordingStartTime = Date.now();

        // Create Canvas Stream (Video only - no audio)
        const canvasStream = canvas.captureStream(30);

        // Get microphone audio track
        const micAudioTrack = stream.getAudioTracks()[0];

        // Remove existing audio from canvas stream
        canvasStream.getAudioTracks().forEach(t => canvasStream.removeTrack(t));
        canvasStream.addTrack(micAudioTrack);

        // Determine supported mimeType (prefer webm for broad browser support)
        let mimeType = '';
        if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')) mimeType = 'video/webm;codecs=vp9,opus';
        else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')) mimeType = 'video/webm;codecs=vp8,opus';
        else if (MediaRecorder.isTypeSupported('video/mp4')) mimeType = 'video/mp4';
        else mimeType = 'video/webm';

        try {
            mediaRecorder = new MediaRecorder(canvasStream, { mimeType });
        } catch (e) {
            console.error("MediaRecorder failed:", e);
            statusDiv.innerText = "Error: Browser not supported.";
            startBtn.disabled = false;
            return;
        }

        mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };

        mediaRecorder.onstop = async () => {
            recordingDuration = (Date.now() - recordingStartTime) / 1000;
            const videoBlob = new Blob(recordedChunks, { type: mimeType });
            const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';

            statusDiv.innerText = "Processing audio...";

            // Attempt mixing if FFmpeg loaded
            if (ffmpegReady && window.ffmpegInstance) {
                try {
                    await mixAudioWithVideo(videoBlob, ext);
                } catch (err) {
                    console.error('Mixing failed:', err);
                    // fallback: download raw video
                    await saveToGallery(videoBlob, `crime-to-say-${Date.now()}.${ext}`);
                    statusDiv.innerText = "Done (video only)";
                }
            } else {
                // FFmpeg not available -> download raw
                await saveToGallery(videoBlob, `crime-to-say-${Date.now()}.${ext}`);
                statusDiv.innerText = "Done (video only - FFmpeg unavailable)";
            }

            startBtn.disabled = false;
            stopBtn.disabled = true;
        };

        mediaRecorder.onerror = (e) => {
            console.error("Recorder Error:", e.error);
            statusDiv.innerText = "Recording Error: " + (e.error && e.error.name ? e.error.name : 'unknown');
            startBtn.disabled = false;
            stopBtn.disabled = true;
            if (backingTrackAudio) backingTrackAudio.pause();
        };

        // START RECORDING
        mediaRecorder.start();

        // Play backing track AFTER recording starts
        try {
            backingTrackAudio = new Audio('./crime-to-say-oke-challenge.mp3');
            backingTrackAudio.crossOrigin = 'anonymous';
            await new Promise(resolve => {
                if (backingTrackAudio.readyState >= 1) resolve();
                else backingTrackAudio.addEventListener('loadedmetadata', resolve, { once: true });
            });
            await backingTrackAudio.play();
            statusDiv.innerText = "Recording... (singing now!)";
        } catch (playError) {
            console.error("Audio play failed:", playError);
            statusDiv.innerText = "Audio blocked. Tap page then try again.";
            mediaRecorder.stop();
            startBtn.disabled = false;
            return;
        }

        startBtn.disabled = true;
        stopBtn.disabled = false;

    } catch (error) {
        console.error("Recording error:", error);
        statusDiv.innerText = "Recording failed: " + error.message;
        startBtn.disabled = false;
    }
}

// ============================================
// 4. STOP RECORDING
// ============================================
function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();

        // Stop backing track immediately
        if (backingTrackAudio) { backingTrackAudio.pause(); backingTrackAudio.currentTime = 0; }

        // Disable microphone track to stop live feed
        if (stream && stream.getAudioTracks().length > 0) stream.getAudioTracks()[0].enabled = false;

        statusDiv.innerText = "Processing...";
    }
}

// ============================================
// 5. MIX AUDIO WITH VIDEO (Post-Recording) - using ffmpeg.wasm
// ============================================
async function mixAudioWithVideo(videoBlob, format) {
    try {
        const ffmpeg = window.ffmpegInstance;
        const fetchFile = window.ffmpegFetchFile;

        statusDiv.innerText = "Preparing files for mixing...";

        // Convert Blob to Uint8Array using fetchFile helper
        const videoData = await fetchFile(videoBlob);
        ffmpeg.FS('writeFile', `input.${format}`, videoData);

        // Fetch backing track and write
        const backingResp = await fetch('./crime-to-say-oke-challenge.mp3');
        const backingArr = await backingResp.arrayBuffer();
        const backingData = await fetchFile(backingArr);
        ffmpeg.FS('writeFile', 'backing.mp3', backingData);

        statusDiv.innerText = "Encoding final video...";

        // Mix audio: adjust volumes (mic louder than backing) and map video
        await ffmpeg.run(
            '-i', `input.${format}`,
            '-i', 'backing.mp3',
            '-filter_complex', '[0:a]volume=1.0[a0];[1:a]volume=0.7[a1];[a0][a1]amix=inputs=2:dropout_transition=2[a]',
            '-map', '0:v',
            '-map', '[a]',
            '-c:v', 'libx264',
            '-preset', 'fast',
            '-c:a', 'aac',
            '-ac', '2',
            'output.mp4'
        );

        const output = ffmpeg.FS('readFile', 'output.mp4');
        const mp4Blob = new Blob([output.buffer], { type: 'video/mp4' });

        // Cleanup
        try { ffmpeg.FS('unlink', `input.${format}`); } catch(e){}
        try { ffmpeg.FS('unlink', 'backing.mp3'); } catch(e){}
        try { ffmpeg.FS('unlink', 'output.mp4'); } catch(e){}

        await saveToGallery(mp4Blob, `crime-to-say-${Date.now()}.mp4`);
        statusDiv.innerText = "Done! Ready to share! 🎉";

    } catch (error) {
        console.error("Audio mixing failed:", error);
        statusDiv.innerText = "Audio mixing failed - downloading video only";
        await saveToGallery(new Blob(recordedChunks, { type: `video/${format}` }), `crime-to-say-${Date.now()}.${format}`);
    }
}

// ============================================
// 6. SAVE TO GALLERY (iOS Photos + Android)
// ============================================
async function saveToGallery(blob, filename) {
    try {
        if (window.showSaveFilePicker) {
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName: filename,
                    types: [{ description: 'Video Files', accept: { 'video/mp4': ['.mp4', '.webm'] } }]
                });
                const writable = await handle.createWritable();
                await writable.write(blob);
                await writable.close();
                statusDiv.innerText = "Saved to Photos! 📱";
                return;
            } catch (e) { console.log("File picker cancelled or unavailable"); }
        }

        if (navigator.share && blob.type === 'video/mp4') {
            try {
                const file = new File([blob], filename, { type: 'video/mp4' });
                await navigator.share({ files: [file], title: 'Crime to Say Karaoke Video' });
                statusDiv.innerText = "Shared! 🎉";
                return;
            } catch (e) { if (e.name !== 'AbortError') console.log('Share failed:', e); }
        }

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 200);
        statusDiv.innerText = "Video saved! Check Downloads or Files app 📥";

    } catch (error) {
        console.error("Save to gallery error:", error);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        statusDiv.innerText = "Video downloaded! Check Downloads or Files app 📥";
    }
}

// ============================================
// 7. EVENT LISTENERS
// ============================================
startBtn.addEventListener('click', startRecording);
stopBtn.addEventListener('click', stopRecording);

// ============================================
// 8. LOAD LYRICS SRT/JSON IF AVAILABLE (non-editable)
// ============================================

async function loadLyrics() {
    try {
        const res = await fetch('./lyrics.json');
        if (res.ok) {
            const data = await res.json();
            lyrics = data;
            console.log('Lyrics loaded from lyrics.json');
            return;
        }
    } catch (e) {}
    try {
        const res = await fetch('./lyrics.srt');
        if (res.ok) {
            const text = await res.text();
            lyrics = parseSRT(text);
            console.log('Lyrics loaded from lyrics.srt');
            return;
        }
    } catch (e) {}
    console.log('No lyrics timing file found.');
}

function parseTimecode(tc) {
    const m = tc.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) return 0;
    return parseInt(m[1])*3600 + parseInt(m[2])*60 + parseInt(m[3]) + parseInt(m[4])/1000;
}

function parseSRT(srt) {
    const parts = srt.split(/\n\s*\n/);
    const out = [];
    for (const p of parts) {
        const lines = p.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length >= 2) {
            const times = lines[1].split('-->');
            const start = parseTimecode(times[0].trim());
            const end = parseTimecode(times[1].trim());
            const text = lines.slice(2).join(' ').trim();
            const words = text.split(' ').map((w,i,arr)=>({ text: w, start: start + (i/arr.length)*(end-start), end: start + ((i+1)/arr.length)*(end-start)}));
            out.push({ start, end, text, words });
        }
    }
    return out;
}

// ============================================
// 9. INITIALIZE ON PAGE LOAD
// ============================================
window.addEventListener('load', async () => { await loadLyrics(); init(); });
