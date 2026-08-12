import { FFmpeg } from 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.7/dist/esm/index.js';
import { fetchFile } from 'https://unpkg.com/@ffmpeg/util@0.12.1/dist/esm/index.js';

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

// 1. Initialize Camera (9:16 Portrait)
async function initCamera() {
    try {
        const constraints = {
            video: { width: { ideal: 1080 }, height: { ideal: 1920 }, facingMode: "user" },
            audio: true
        };
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        previewVideo.srcObject = stream;
        previewVideo.onloadedmetadata = () => {
            previewVideo.play();
            drawLoop();
        };
    } catch (err) {
        statusDiv.innerText = "Camera Error: " + err.message;
    }
}

// 2. Draw Loop (Video + Lyrics)
function drawLoop() {
    if (!stream) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(previewVideo, -canvas.width, 0, canvas.width, canvas.height);
    ctx.restore();

    ctx.font = "bold 40px Arial";
    ctx.fillStyle = "white";
    ctx.strokeStyle = "black";
    ctx.lineWidth = 2;
    ctx.textAlign = "center";
    ctx.strokeText("CRIME TO SAY...", canvas.width / 2, canvas.height - 150);
    ctx.fillText("CRIME TO SAY...", canvas.width / 2, canvas.height - 150);

    animationFrameId = requestAnimationFrame(drawLoop);
}

// 3. Start Recording
async function startRecording() {
    recordedChunks = [];
    const canvasStream = canvas.captureStream(30);
    const audioTrack = stream.getAudioTracks()[0];
    if (audioTrack) canvasStream.addTrack(audioTrack);

    // Detect Format
    let mimeType = '';
    if (MediaRecorder.isTypeSupported('video/mp4')) {
        mimeType = 'video/mp4'; // iOS
    } else if (MediaRecorder.isTypeSupported('video/webm;codecs=h264')) {
        mimeType = 'video/webm;codecs=h264'; // Android
    } else {
        mimeType = 'video/webm';
    }

    mediaRecorder = new MediaRecorder(canvasStream, { mimeType });
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
    
    mediaRecorder.onstop = async () => {
        const blob = new Blob(recordedChunks, { type: mimeType });
        const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
        
        if (ext === 'mp4') {
            downloadFile(blob, `crime-to-say-${Date.now()}.mp4`);
            statusDiv.innerText = "Done! (MP4)";
        } else {
            statusDiv.innerText = "Converting to MP4... (Do not close)";
            await convertToMp4(blob);
        }
        startBtn.disabled = false;
        drawLoop();
    };

    mediaRecorder.start();
    startBtn.disabled = true;
    stopBtn.disabled = false;
    statusDiv.innerText = "Recording...";
}

// 4. Convert WebM to MP4 (Client-Side)
async function convertToMp4(webmBlob) {
    const ffmpeg = new FFmpeg();
    
    // Load Multi-Threaded Core (Fast, requires Netlify headers)
    const baseURL = 'https://unpkg.com/@ffmpeg/core-mt@0.12.6/dist/umd';
    try {
        await ffmpeg.load({
            coreURL: `${baseURL}/ffmpeg-core.js`,
            wasmURL: `${baseURL}/ffmpeg-core.wasm`,
            workerURL: `${baseURL}/ffmpeg-core.worker.js`
        });

        await ffmpeg.writeFile('input.webm', await fetchFile(webmBlob));
        
        await ffmpeg.exec([
            '-i', 'input.webm',
            '-c:v', 'libx264',
            '-preset', 'fast',
            '-crf', '22',
            '-c:a', 'aac',
            '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2',
            'output.mp4'
        ]);

        const mp4Data = await ffmpeg.readFile('output.mp4');
        const mp4Blob = new Blob([mp4Data.buffer], { type: 'video/mp4' });
        downloadFile(mp4Blob, `crime-to-say-${Date.now()}.mp4`);
        statusDiv.innerText = "Done! (Converted)";
    } catch (err) {
        console.error(err);
        statusDiv.innerText = "Error converting. Try again.";
        downloadFile(webmBlob, `crime-to-say-${Date.now()}.webm`);
    }
}

function downloadFile(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

startBtn.addEventListener('click', startRecording);
stopBtn.addEventListener('click', () => mediaRecorder.stop());
initCamera();   
