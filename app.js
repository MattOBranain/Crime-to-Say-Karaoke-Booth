const { FFmpeg } = FFmpegWASM; // Access FFmpeg from the loaded script
let ffmpeg = null;
let mediaRecorder = null;
let recordedChunks = [];
let stream = null;
let animationFrameId;

const previewVideo = document.getElementById('preview');
const canvas = document.getElementById('processing-canvas');
const ctx = canvas.getContext('2d');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusDiv = document.getElementById('status');

// 1. Initialize Camera in 9:16 (1080x1920)
async function initCamera() {
    try {
        // Force vertical resolution
        const constraints = {
            video: {
                width: { ideal: 1080 },
                height: { ideal: 1920 },
                facingMode: "user"
            },
            audio: true
        };
        
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        previewVideo.srcObject = stream;
        
        // Wait for video to load to match canvas size if needed, 
        // though we hardcoded canvas to 1080x1920 for Instagram
        previewVideo.onloadedmetadata = () => {
            previewVideo.play();
            drawLoop(); // Start drawing video to canvas immediately
        };
    } catch (err) {
        statusDiv.innerText = "Error accessing camera: " + err.message;
        console.error(err);
    }
}

// 2. Draw Video + Lyrics to Canvas (The "Overlay" Logic)
function drawLoop() {
    if (!stream) return;

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw current video frame
    // Note: We flip horizontally to match the mirror preview
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(previewVideo, -canvas.width, 0, canvas.width, canvas.height);
    ctx.restore();

    // --- LYRICS OVERLAY LOGIC ---
    // Replace this text with your synced lyrics logic later
    ctx.font = "bold 40px Arial";
    ctx.fillStyle = "white";
    ctx.strokeStyle = "black";
    ctx.lineWidth = 2;
    ctx.textAlign = "center";
    
    const lyricsText = "🎤 Sing Along Here..."; 
    const x = canvas.width / 2;
    const y = canvas.height - 150; // Position near bottom

    ctx.strokeText(lyricsText, x, y);
    ctx.fillText(lyricsText, x, y);
    // ----------------------------

    animationFrameId = requestAnimationFrame(drawLoop);
}

// 3. Start Recording the Canvas Stream
async function startRecording() {
    if (!ffmpeg) {
        statusDiv.innerText = "Loading FFmpeg engine...";
        ffmpeg = new FFmpeg();
        await ffmpeg.load();
        statusDiv.innerText = "Engine ready. Starting...";
    }

    recordedChunks = [];
    // Capture the canvas stream (which includes video + lyrics)
    // We set a high frame rate for smoothness
    const canvasStream = canvas.captureStream(30); 
    
    // Add audio from the microphone to the canvas stream
    const audioTrack = stream.getAudioTracks()[0];
    if (audioTrack) {
        canvasStream.addTrack(audioTrack);
    }

    // Prefer H.264 if available, otherwise default
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=h264') 
                     ? 'video/webm;codecs=h264' 
                     : 'video/webm';

    mediaRecorder = new MediaRecorder(canvasStream, { mimeType });

    mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.start();
    
    startBtn.disabled = true;
    stopBtn.disabled = false;
    statusDiv.innerText = "Recording... (Sing!)";
}

// 4. Stop, Convert to MP4, and Download
async function stopRecording() {
    mediaRecorder.stop();
    cancelAnimationFrame(animationFrameId);
    startBtn.disabled = true;
    stopBtn.disabled = true;
    statusDiv.innerText = "Processing video (this may take a moment)...";

    mediaRecorder.onstop = async () => {
        const webmBlob = new Blob(recordedChunks, { type: 'video/webm' });
        
        // Write file to FFmpeg virtual file system
        await ffmpeg.writeFile('input.webm', await fetchFile(webmBlob));

        // Convert to MP4 with H.264 codec (Instagram Standard)
        // -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2" ensures exact 9:16
        await ffmpeg.exec([
            '-i', 'input.webm',
            '-c:v', 'libx264',
            '-preset', 'fast',
            '-crf', '22',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2',
            'output.mp4'
        ]);

        // Read the result
        const mp4Data = await ffmpeg.readFile('output.mp4');
        const mp4Blob = new Blob([mp4Data.buffer], { type: 'video/mp4' });

        // Trigger Download
        const url = URL.createObjectURL(mp4Blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `karaoke-${Date.now()}.mp4`;
        a.click();
        
        statusDiv.innerText = "Done! Video downloaded.";
        startBtn.disabled = false;
        
        // Cleanup
        URL.revokeObjectURL(url);
        
        // Restart loop for preview
        drawLoop();
    };
}

// Event Listeners
startBtn.addEventListener('click', startRecording);
stopBtn.addEventListener('click', stopRecording);

// Init on load
initCamera();   
