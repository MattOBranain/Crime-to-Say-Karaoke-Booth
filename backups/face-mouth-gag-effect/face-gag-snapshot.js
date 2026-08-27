// Snapshot of the UK-flag mouth-gag effect as it stood when removed from
// app.js. Not wired up to anything — see README.md in this folder for why
// it was shelved and what to check before reviving it.

// Top-level import — DO NOT reuse this pattern. On at least one older
// device this alone likely broke the entire app. Use a dynamic import()
// inside a try/catch instead, gated behind explicit opt-in.
//
// import { FaceLandmarker, FilesetResolver } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';

const FACE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

let faceLandmarker = null;
let faceLandmarkerReady = false;
let faceFrameCounter = 0;
let smoothedMouth = null;
let lastFaceSeenAt = 0;

async function initFaceLandmarker() {
  try {
    const vision = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
    );
    faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: FACE_MODEL_URL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numFaces: 1
    });
    faceLandmarkerReady = true;
  } catch (e) {
    console.warn('Face tracking unavailable', e);
    faceLandmarkerReady = false;
  }
}

function updateFaceTracking(GAG_ENABLED, PREVIEW, CANVAS) {
  if (!GAG_ENABLED || !faceLandmarkerReady || PREVIEW.readyState < 2) return;
  faceFrameCounter++;
  if (faceFrameCounter % 2 !== 0) return; // throttle to ~every other frame

  let result;
  try {
    result = faceLandmarker.detectForVideo(PREVIEW, performance.now());
  } catch (e) {
    return;
  }
  if (!result || !result.faceLandmarks || !result.faceLandmarks.length) return;

  const lm = result.faceLandmarks[0];
  const p1 = lm[61];
  const p2 = lm[291];
  if (!p1 || !p2) return;

  // Landmarks are normalized [0,1] against the source video frame; mirror X
  // to match the mirrored canvas we draw the preview onto.
  const mx1 = CANVAS.width * (1 - p1.x);
  const my1 = CANVAS.height * p1.y;
  const mx2 = CANVAS.width * (1 - p2.x);
  const my2 = CANVAS.height * p2.y;

  const rawCx = (mx1 + mx2) / 2;
  const rawCy = (my1 + my2) / 2;
  const rawWidth = Math.hypot(mx2 - mx1, my2 - my1);
  const rawAngle = Math.atan2(my2 - my1, mx2 - mx1);

  if (!smoothedMouth) {
    smoothedMouth = { cx: rawCx, cy: rawCy, angle: rawAngle, width: rawWidth };
  } else {
    const a = 0.35;
    smoothedMouth.cx += (rawCx - smoothedMouth.cx) * a;
    smoothedMouth.cy += (rawCy - smoothedMouth.cy) * a;
    smoothedMouth.width += (rawWidth - smoothedMouth.width) * a;
    let da = rawAngle - smoothedMouth.angle;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    smoothedMouth.angle += da * a;
  }
  lastFaceSeenAt = performance.now();
}

function buildFlagSprite() {
  const w = 300, h = 180;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');

  g.fillStyle = '#00247d';
  g.fillRect(0, 0, w, h);

  g.strokeStyle = '#ffffff';
  g.lineWidth = h * 0.34;
  g.beginPath(); g.moveTo(0, 0); g.lineTo(w, h); g.moveTo(w, 0); g.lineTo(0, h); g.stroke();

  g.strokeStyle = '#cf142b';
  g.lineWidth = h * 0.14;
  g.beginPath(); g.moveTo(0, 0); g.lineTo(w, h); g.stroke();
  g.beginPath(); g.moveTo(w, 0); g.lineTo(0, h); g.stroke();

  g.strokeStyle = '#ffffff';
  g.lineWidth = h * 0.4;
  g.beginPath(); g.moveTo(w / 2, 0); g.lineTo(w / 2, h); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();

  g.strokeStyle = '#cf142b';
  g.lineWidth = h * 0.18;
  g.beginPath(); g.moveTo(w / 2, 0); g.lineTo(w / 2, h); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();

  g.strokeStyle = 'rgba(0,0,0,0.55)';
  g.lineWidth = 4;
  g.strokeRect(2, 2, w - 4, h - 4);

  return c;
}

function drawMouthGag(CTX, GAG_ENABLED, flagSprite) {
  if (!GAG_ENABLED || !smoothedMouth) return;
  if (performance.now() - lastFaceSeenAt > 450) return;

  const { cx, cy, angle, width } = smoothedMouth;
  const flagW = width * 2.1;
  const flagH = flagW * (flagSprite.height / flagSprite.width);

  CTX.save();
  CTX.translate(cx, cy);
  CTX.rotate(angle);

  CTX.strokeStyle = 'rgba(15,15,15,0.85)';
  CTX.lineWidth = Math.max(4, width * 0.07);
  CTX.lineCap = 'round';
  CTX.beginPath();
  CTX.moveTo(-flagW * 0.48, 0);
  CTX.lineTo(-flagW * 0.95, -flagH * 0.2);
  CTX.moveTo(flagW * 0.48, 0);
  CTX.lineTo(flagW * 0.95, -flagH * 0.2);
  CTX.stroke();

  CTX.drawImage(flagSprite, -flagW / 2, -flagH / 2, flagW, flagH);
  CTX.restore();
}
