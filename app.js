// ... (imports and global variables remain the same)

// 3. Start Recording (FIXED for iOS/Firefox)
async function startRecording() {
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
}

// ... (rest of the code remains the same)   
