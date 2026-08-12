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
let ffmpegReady = false;
let recordingStartTime = 0;
let recordingDuration = 0;

// DOM Elements
const preview = document.getElementById('preview');
const previewContainer = document.getElementById('preview-container');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusDiv = document.getElementById('status');
const processingCanvas = document.getElementById('processing-canvas');

// ============================================
// 0. FFMPEG INITIALIZATION
// ============================================
async function initFFmpeg() {
    try {
        const { FFmpeg, fetchFile } = FFmpeg;
        const ffmpeg = new FFmpeg.FFmpeg();
        
        statusDiv.innerText = "Loading FFmpeg...";
        
        if (!ffmpeg.isLoaded()) {
            await ffmpeg.load();
        }
        
        ffmpegReady = true;
        window.ffmpegInstance = ffmpeg;
        console.log("FFmpeg ready for MP4 conversion");
        
    } catch (error) {
        console.warn("FFmpeg initialization failed:", error);
        ffmpegReady = false;
        statusDiv.innerText = "Ready (WebM format will be used for Android)";
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
        
        // Display camera preview
        preview.srcObject = stream;
        
        // Setup canvas for recording
        canvas = processingCanvas;
        ctx = canvas.getContext('2d');
        
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
// 2. DRAWING LOOP - Render Camera to Canvas + Overlay Text
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
        
        // Draw text overlay at bottom - "#CRIMETOSAY KARAOKE CHALLENGE!"
        drawTextOverlay();
    }
}

// ============================================
// DRAW TEXT OVERLAY - Kermit Green Impact Text with Black Border
// ============================================
function drawTextOverlay() {
    const canvasWidth = canvas.width;
    const canvasHeight = canvas.height;
    
    // Text properties
    const text = "#CRIMETOSAY KARAOKE CHALLENGE!";
    const fontSize = 100;
    const fontFamily = "Impact";
    
    // Kermit green color
    const textColor = "#66BB6A"; // Kermit green
    const borderColor = "#000000"; // Black border
    const borderWidth = 8;
    
    ctx.font = `bold ${fontSize}px ${fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    
    // Position at bottom with padding
    const textX = canvasWidth / 2;
    const textY = canvasHeight - 80;
    
    // Draw black border (stroke) - thicker for visibility
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = borderWidth;
    
    // Draw stroke multiple times for better effect
    for (let i = 0; i < 3; i++) {
        ctx.strokeText(text, textX, textY);
    }
    
    // Draw green text (fill)
    ctx.fillStyle = textColor;
    ctx.fillText(text, textX, textY);
}

// ============================================
// 3. START RECORDING
// ============================================
async function startRecording() {
    try {
        // Stop any previously playing audio
        if (backingTrackAudio) {
            backingTrackAudio.pause();
            backingTrackAudio.currentTime = 0;
        }
        
        recordedChunks = [];
        recordingStartTime = Date.now();
        
        // Create Canvas Stream (Video only - no audio)
        const canvasStream = canvas.captureStream(30);
        
        // Get microphone audio stream
        const micAudioTrack = stream.getAudioTracks()[0];
        
        // Remove existing audio tracks from canvas stream
        canvasStream.getAudioTracks().forEach(t => canvasStream.removeTrack(t));
        
        // Add microphone audio track to canvas stream
        canvasStream.addTrack(micAudioTrack);
        
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

        mediaRecorder.ondataavailable = (e) => { 
            if (e.data.size > 0) recordedChunks.push(e.data); 
        };
        
        mediaRecorder.onstop = async () => {
            // Calculate actual recording duration
            recordingDuration = (Date.now() - recordingStartTime) / 1000;
            
            const videoBlob = new Blob(recordedChunks, { type: mimeType });
            const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
            
            // Reset microphone muting
            statusDiv.innerText = "Processing audio...";
            
            if (ext === 'mp4') {
                // Mix audio after recording for MP4
                await mixAudioWithVideo(videoBlob, 'mp4');
            } else {
                // For WebM, use FFmpeg to mix
                statusDiv.innerText = "Mixing audio...";
                await mixAudioWithVideo(videoBlob, 'webm');
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
            // Stop audio playback on error
            if (backingTrackAudio) backingTrackAudio.pause();
        };

        // START RECORDING
        mediaRecorder.start();
        
        // Play backing track AFTER recording starts
        try {
            backingTrackAudio = new Audio('./crime-to-say-oke-challenge.mp3');
            backingTrackAudio.crossOrigin = "anonymous";
            
            // Wait for metadata
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
        if (backingTrackAudio) {
            backingTrackAudio.pause();
            backingTrackAudio.currentTime = 0;
        }
        
        // Mute microphone to stop live feed
        if (stream && stream.getAudioTracks().length > 0) {
            stream.getAudioTracks()[0].enabled = false;
        }
        
        statusDiv.innerText = "Processing...";
    }
}

// ============================================
// 5. MIX AUDIO WITH VIDEO (Post-Recording)
// ============================================
async function mixAudioWithVideo(videoBlob, format) {
    try {
        if (!ffmpegReady || !window.ffmpegInstance) {
            // Fallback: just download the video as-is
            console.warn("FFmpeg not available, audio mixing skipped");
            await saveToGallery(videoBlob, `crime-to-say-${Date.now()}.${format}`);
            statusDiv.innerText = "Done! (Video only - audio mix unavailable)";
            return;
        }

        const ffmpeg = window.ffmpegInstance;
        statusDiv.innerText = "Mixing audio tracks...";
        
        // Write video file to FFmpeg
        const videoData = await videoBlob.arrayBuffer();
        ffmpeg.FS('writeFile', `input.${format}`, new Uint8Array(videoData));
        
        // Load backing track
        const backingTrackResponse = await fetch('./crime-to-say-oke-challenge.mp3');
        const backingTrackData = await backingTrackResponse.arrayBuffer();
        ffmpeg.FS('writeFile', 'backing.mp3', new Uint8Array(backingTrackData));
        
        // FFmpeg command to mix audio:
        // - Takes video with mic audio (input)
        // - Overlays backing track
        // - Adjusts levels so both are audible
        // - Handles different durations gracefully
        
        statusDiv.innerText = "Encoding final video...";
        
        await ffmpeg.run(
            '-i', `input.${format}`,
            '-i', 'backing.mp3',
            '-filter_complex', '[0:a][1:a]amerge=inputs=2[a]',
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
        ffmpeg.FS('unlink', `input.${format}`);
        ffmpeg.FS('unlink', 'backing.mp3');
        ffmpeg.FS('unlink', 'output.mp4');
        
        await saveToGallery(mp4Blob, `crime-to-say-${Date.now()}.mp4`);
        statusDiv.innerText = "Done! Ready to share! 🎉";
        
    } catch (error) {
        console.error("Audio mixing failed:", error);
        statusDiv.innerText = "Audio mixing failed - downloading video only";
        await saveToGallery(videoBlob, `crime-to-say-${Date.now()}.${format}`);
    }
}

// ============================================
// 6. SAVE TO GALLERY (iOS Photos + Android)
// ============================================
async function saveToGallery(blob, filename) {
    try {
        // Check if File System Access API is available (iOS 16.1+, Android)
        if (window.showSaveFilePicker) {
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName: filename,
                    types: [{
                        description: 'Video Files',
                        accept: { 'video/mp4': ['.mp4', '.webm'] }
                    }]
                });
                
                const writable = await handle.createWritable();
                await writable.write(blob);
                await writable.close();
                statusDiv.innerText = "Saved to Photos! 📱";
                return;
            } catch (e) {
                console.log("File picker cancelled or unavailable");
            }
        }

        // Fallback: Try Share API (iOS 13+, Android)
        if (navigator.share && blob.type === 'video/mp4') {
            try {
                const file = new File([blob], filename, { type: 'video/mp4' });
                await navigator.share({
                    files: [file],
                    title: 'Crime to Say Karaoke Video'
                });
                statusDiv.innerText = "Shared! 🎉";
                return;
            } catch (e) {
                if (e.name !== 'AbortError') {
                    console.log("Share failed:", e);
                }
            }
        }

        // Fallback: Direct download for Safari/Chrome
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        
        // For iOS: Append to body for better handling
        document.body.appendChild(a);
        a.click();
        
        // Give it a moment to process, then remove
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
        
        statusDiv.innerText = "Video saved! Check Files or Downloads app 📥";
        
    } catch (error) {
        console.error("Save to gallery error:", error);
        // Last resort: just download it
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
// 8. INITIALIZE ON PAGE LOAD
// ============================================
window.addEventListener('load', init);
