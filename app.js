// ============================================
// CRIME TO SAY... KARAOKE BOOTH - Main App
// ============================================

// Global Variables
let stream = null;
let canvas = null;
let ctx = null;
let mediaRecorder = null;
let recordedChunks = [];
let audioContext = null;
let backingTrackAudio = null;

// DOM Elements
const preview = document.getElementById('preview');
const previewContainer = document.getElementById('preview-container');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusDiv = document.getElementById('status');
const processingCanvas = document.getElementById('processing-canvas');

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
            audio: true // We'll use the mic for recording only, not for live preview
        });
        
        // Display camera preview
        preview.srcObject = stream;
        
        // Setup canvas for recording
        canvas = processingCanvas;
        ctx = canvas.getContext('2d');
        
        // Start drawing loop
        drawLoop();
        
        statusDiv.innerText = "Ready";
        startBtn.disabled = false;
        
    } catch (error) {
        console.error("Camera access error:", error);
        statusDiv.innerText = "Camera access denied or unavailable";
        startBtn.disabled = true;
    }
}

// ============================================
// 2. DRAWING LOOP - Render Camera to Canvas
// ============================================
function drawLoop() {
    requestAnimationFrame(drawLoop);
    
    if (preview.readyState === preview.HAVE_ENOUGH_DATA) {
        // Get canvas dimensions
        const canvasWidth = canvas.width;
        const canvasHeight = canvas.height;
        
        // Calculate scaling to maintain 9:16 aspect ratio
        const videoAspect = preview.videoWidth / preview.videoHeight;
        const canvasAspect = canvasWidth / canvasHeight; // 1080/1920 = 0.5625
        
        let drawWidth, drawHeight, offsetX, offsetY;
        
        if (videoAspect > canvasAspect) {
            // Video is wider - fit to height
            drawHeight = canvasHeight;
            drawWidth = canvasHeight * videoAspect;
            offsetX = (canvasWidth - drawWidth) / 2;
            offsetY = 0;
        } else {
            // Video is taller - fit to width
            drawWidth = canvasWidth;
            drawHeight = canvasWidth / videoAspect;
            offsetX = 0;
            offsetY = (canvasHeight - drawHeight) / 2;
        }
        
        // Clear canvas
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);
        
        // Draw mirrored video (flip horizontally)
        ctx.save();
        ctx.translate(canvasWidth, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(preview, canvasWidth - offsetX - drawWidth, offsetY, drawWidth, drawHeight);
        ctx.restore();
    }
}

// ============================================
// 3. START RECORDING
// ============================================
async function startRecording() {
    try {
        recordedChunks = [];
        
        // 1. Create Audio Context
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        
        // CRITICAL FIX: Explicitly resume the context inside the user gesture
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }

        // 2. Create destination for the mixed audio
        const mixedDestination = audioContext.createMediaStreamDestination();
        
        // 3. Connect Microphone
        const micSource = audioContext.createMediaStreamSource(stream);
        micSource.connect(mixedDestination);
        
        // 4. Load and Connect Backing Track
        backingTrackAudio = new Audio('crime-to-say-oke-challenge.mp3');
        backingTrackAudio.crossOrigin = "anonymous";
        
        // Wait for metadata to ensure duration is known
        await new Promise(resolve => {
            if (backingTrackAudio.readyState >= 1) resolve();
            else backingTrackAudio.addEventListener('loadedmetadata', resolve, { once: true });
        });

        const trackSource = audioContext.createMediaElementSource(backingTrackAudio);
        trackSource.connect(mixedDestination);
        
        // Connect to speakers so user can hear themselves and music
        trackSource.connect(audioContext.destination); 
        micSource.connect(audioContext.destination); 

        // 5. Create Canvas Stream (Video)
        const canvasStream = canvas.captureStream(30);
        
        // 6. Replace Audio Track with Mixed Track
        const mixedAudioTrack = mixedDestination.stream.getAudioTracks()[0];
        // Remove existing audio tracks from canvas stream if any
        canvasStream.getAudioTracks().forEach(t => canvasStream.removeTrack(t));
        canvasStream.addTrack(mixedAudioTrack);

        // Detect Format
        let mimeType = '';
        if (MediaRecorder.isTypeSupported('video/mp4')) {
            mimeType = 'video/mp4'; // iOS
        } else if (MediaRecorder.isTypeSupported('video/webm;codecs=h264')) {
            mimeType = 'video/webm;codecs=h264'; // Android
        } else {
            mimeType = 'video/webm';
        }

        // Initialize Recorder
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
            const blob = new Blob(recordedChunks, { type: mimeType });
            const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
            
            // Stop backing track
            if (backingTrackAudio) {
                backingTrackAudio.pause();
                backingTrackAudio.currentTime = 0;
            }
            
            if (ext === 'mp4') {
                downloadFile(blob, `crime-to-say-${Date.now()}.mp4`);
                statusDiv.innerText = "Done! (MP4)";
            } else {
                statusDiv.innerText = "Converting to MP4... (Do not close)";
                await convertToMp4(blob);
            }
            startBtn.disabled = false;
            stopBtn.disabled = true;
            drawLoop();
        };

        mediaRecorder.onerror = (e) => {
            console.error("Recorder Error:", e.error);
            statusDiv.innerText = "Recording Error: " + e.error.name;
            startBtn.disabled = false;
            stopBtn.disabled = true;
        };

        // START EVERYTHING SIMULTANEOUSLY
        mediaRecorder.start();
        
        // Critical: Play audio ONLY after context is resumed and recorder started
        try {
            await backingTrackAudio.play();
            statusDiv.innerText = "Recording...";
        } catch (playError) {
            console.error("Audio play failed:", playError);
            statusDiv.innerText = "Audio blocked. Tap page then try again.";
            mediaRecorder.stop();
            startBtn.disabled = false;
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
        statusDiv.innerText = "Processing...";
    }
}

// ============================================
// 5. CONVERT WebM to MP4 (using FFmpeg.wasm)
// ============================================
async function convertToMp4(webmBlob) {
    // This requires FFmpeg.wasm library
    // For now, just download as WebM if conversion library not available
    if (typeof FFmpeg === 'undefined') {
        console.warn("FFmpeg not available, downloading as WebM");
        downloadFile(webmBlob, `crime-to-say-${Date.now()}.webm`);
        statusDiv.innerText = "Downloaded as WebM (install FFmpeg.wasm for MP4 support)";
        return;
    }

    try {
        const { FFmpeg, FFmpegUtil } = window.FFmpeg;
        const ffmpeg = new FFmpeg.FFmpeg();
        
        if (!ffmpeg.isLoaded()) {
            statusDiv.innerText = "Loading encoder...";
            await ffmpeg.load();
        }

        const data = await webmBlob.arrayBuffer();
        ffmpeg.FS('writeFile', 'input.webm', new Uint8Array(data));
        
        await ffmpeg.run('-i', 'input.webm', '-c:v', 'libx264', '-preset', 'fast', '-c:a', 'aac', 'output.mp4');
        
        const output = ffmpeg.FS('readFile', 'output.mp4');
        const mp4Blob = new Blob([output.buffer], { type: 'video/mp4' });
        
        downloadFile(mp4Blob, `crime-to-say-${Date.now()}.mp4`);
        statusDiv.innerText = "Done! (MP4 - Converted)";
        
    } catch (error) {
        console.error("Conversion failed:", error);
        statusDiv.innerText = "Conversion failed, downloading as WebM";
        downloadFile(webmBlob, `crime-to-say-${Date.now()}.webm`);
    }
}

// ============================================
// 6. DOWNLOAD FILE
// ============================================
function downloadFile(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ============================================
// 7. EVENT LISTENERS
// ============================================
startBtn.addEventListener('click', startRecording);
stopBtn.addEventListener('click', stopRecording);

// ============================================
// 8. INITIALIZE ON PAGE LOAD
// ============================================
window.addEventListener('load', init);
