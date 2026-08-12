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

// 1. Initialize Camera (9:16 Portrait Only)
async function initCamera() {
    try {
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
    
    // Draw Video
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(previewVideo, -canvas.width, 0, canvas.width, canvas.height);
    ctx.restore();

    // Draw Lyrics
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

    // Detect Bes   
