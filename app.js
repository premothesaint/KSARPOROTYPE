/**
 * HoloPlace AR — Main Application
 * Three.js + WebXR AR with camera fallback
 * Surface Scan → Confirm → Place flow
 */

'use strict';

// ══════════════════════════════════════════════════════════════════════════
// SCAN PHASE STATE MACHINE
//   phases: 'scanning' → 'confirming' → 'placed' → (back to 'place' mode)
// ══════════════════════════════════════════════════════════════════════════
const ScanPhase = {
  SCANNING:    'scanning',    // actively sweeping, no surface locked
  CONFIRMING:  'confirming',  // surface found, showing confirm UI
  PLACING:     'placing',     // user confirmed, now in placement mode
};

// ── STATE ──────────────────────────────────────────────────────────────────
const State = {
  scanPhase:       ScanPhase.SCANNING,
  mode:            'place',     // place | move | rotate | scale
  shape:           'cube',
  hasObject:       false,
  surfaceDetected: false,
  xrSession:       null,
  xrMode:          false,
  scale:           1.0,
  rotationY:       0,
  objectPosition:  new THREE.Vector3(),
  confirmedPos:    null,        // locked surface position after confirm
  scanProgress:    0,           // 0–1 progress bar for scan animation
  scanHits:        0,           // count of consecutive valid hits
  SCAN_HITS_NEEDED: 28,         // frames of stable hit-test to trigger confirm
  lastTouchX:      0,
  lastTouchY:      0,
  lastPinchDist:   0,
  isDragging:      false,
};

// ── SCENE ──────────────────────────────────────────────────────────────────
let renderer, scene, camera, clock;
let placedMesh    = null;
let reticleMesh   = null;
let scanRingGroup = null;     // animated ring shown during SCANNING
let confirmRing   = null;     // pulsing ring shown during CONFIRMING
let groundGrid    = null;
let hitTestSource          = null;
let hitTestSourceRequested = false;
let localSpace    = null;
let animFrame     = null;

// ── DOM ────────────────────────────────────────────────────────────────────
const canvas     = document.getElementById('ar-canvas');
const hud        = document.getElementById('hud');
const toolbar    = document.getElementById('toolbar');
const surfaceInd = document.getElementById('surface-indicator');
const modeLabel  = document.getElementById('mode-label');
const statusText = document.getElementById('status-text');
const toastEl    = document.getElementById('toast');
const dimPanel   = document.getElementById('dimensions');
const coordPanel = document.getElementById('coords');
const scaleVal   = document.getElementById('scale-val');
const videoBg    = document.getElementById('video-bg');
const scanlines  = document.getElementById('scanlines');
const vignette   = document.getElementById('vignette');

// Scan-phase specific DOM
const scanOverlay    = document.getElementById('scan-overlay');
const scanBar        = document.getElementById('scan-bar');
const scanBarFill    = document.getElementById('scan-bar-fill');
const scanPhaseLabel = document.getElementById('scan-phase-label');
const confirmPanel   = document.getElementById('confirm-panel');
const confirmBtn     = document.getElementById('confirm-btn');
const rescanBtn      = document.getElementById('rescan-btn');

// ══════════════════════════════════════════════════════════════════════════
// BOOTSTRAP
// ══════════════════════════════════════════════════════════════════════════
async function startAR() {
  document.getElementById('splash').classList.add('hidden');
  setTimeout(() => document.getElementById('splash').style.display = 'none', 700);

  hud.classList.add('active');
  toolbar.classList.add('active');
  scanlines.classList.add('active');
  vignette.classList.add('active');

  initThree();
  enterScanPhase();           // always start in scanning state
  showToast('REQUESTING CAMERA', 1500);

  let xrSupported = false;
  if ('xr' in navigator) {
    try { xrSupported = await navigator.xr.isSessionSupported('immersive-ar'); }
    catch(e) {}
  }

  if (xrSupported) {
    await startWebXR();
  } else {
    await startCameraFallback();
  }
}

// ══════════════════════════════════════════════════════════════════════════
// SCAN PHASE MACHINE
// ══════════════════════════════════════════════════════════════════════════
function enterScanPhase() {
  State.scanPhase   = ScanPhase.SCANNING;
  State.scanHits    = 0;
  State.scanProgress = 0;
  State.confirmedPos = null;

  scanOverlay.classList.add('active');
  scanBar.classList.add('visible');
  scanBarFill.style.width = '0%';
  scanPhaseLabel.textContent = 'SCANNING SURFACE…';
  scanPhaseLabel.classList.remove('confirmed');
  confirmPanel.classList.remove('visible');
  surfaceInd.classList.remove('visible');

  if (scanRingGroup) scanRingGroup.visible = true;
  if (confirmRing)   confirmRing.visible   = false;
  if (reticleMesh)   reticleMesh.visible   = false;

  // Disable toolbar during scanning
  toolbar.classList.remove('active');
  statusText.innerHTML = 'SCANNING SURFACE<span class="blink">_</span>';
}

function enterConfirmingPhase(position) {
  State.scanPhase    = ScanPhase.CONFIRMING;
  State.confirmedPos = position.clone();

  scanBar.classList.remove('visible');
  scanBarFill.style.width = '100%';
  scanPhaseLabel.textContent = '✓ SURFACE DETECTED';
  scanPhaseLabel.classList.add('confirmed');
  confirmPanel.classList.add('visible');
  surfaceInd.classList.add('visible');

  if (scanRingGroup) {
    scanRingGroup.position.copy(position);
    scanRingGroup.visible = false;
  }
  if (confirmRing) {
    confirmRing.position.copy(position);
    confirmRing.visible = true;
  }
  if (reticleMesh) reticleMesh.visible = false;

  statusText.innerHTML = 'SURFACE LOCKED · CONFIRM TO PROCEED';
  showToast('SURFACE CONFIRMED — TAP CONFIRM', 2200);
}

function confirmSurface() {
  if (State.scanPhase !== ScanPhase.CONFIRMING) return;
  State.scanPhase = ScanPhase.PLACING;

  // Hide scan UI
  scanOverlay.classList.remove('active');
  confirmPanel.classList.remove('visible');
  if (confirmRing) confirmRing.visible = false;
  if (scanRingGroup) scanRingGroup.visible = false;

  // Show placement UI
  toolbar.classList.add('active');
  reticleMesh.visible = true;

  // Place ground grid at confirmed surface
  groundGrid.position.copy(State.confirmedPos);
  groundGrid.position.y = State.confirmedPos.y;
  groundGrid.visible = true;

  statusText.innerHTML = 'TAP TO PLACE OBJECT';
  showToast('READY — TAP TO PLACE', 1500);
}

function rescanSurface() {
  // Remove any placed object first
  if (placedMesh) {
    scene.remove(placedMesh);
    placedMesh.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    placedMesh = null;
    State.hasObject = false;
  }
  groundGrid.visible = false;
  dimPanel.classList.remove('visible');
  coordPanel.classList.remove('visible');
  State.scale = 1.0;
  State.rotationY = 0;

  // Reset hit-test state so XR reacquires
  hitTestSourceRequested = false;
  hitTestSource = null;

  enterScanPhase();
  showToast('RE-SCANNING…', 1200);
}

// ══════════════════════════════════════════════════════════════════════════
// THREE.JS INIT
// ══════════════════════════════════════════════════════════════════════════
function initThree() {
  clock = new THREE.Clock();

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, premultipliedAlpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  renderer.setClearColor(0x000000, 0);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 100);
  camera.position.set(0, 1.6, 0);

  const ambient = new THREE.AmbientLight(0x002244, 1.5);
  scene.add(ambient);
  const dir = new THREE.DirectionalLight(0x00d4ff, 0.8);
  dir.position.set(1, 3, 2);
  scene.add(dir);

  buildReticle();
  buildScanRing();
  buildConfirmRing();
  buildGroundGrid();

  window.addEventListener('resize', onResize);
}

// ── RETICLE ────────────────────────────────────────────────────────────────
function buildReticle() {
  const geo = new THREE.RingGeometry(0.06, 0.09, 36);
  geo.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
  const mat = new THREE.MeshBasicMaterial({ color: 0x00d4ff, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
  reticleMesh = new THREE.Mesh(geo, mat);
  reticleMesh.visible = false;

  const dotGeo = new THREE.CircleGeometry(0.025, 16);
  dotGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
  const dot = new THREE.Mesh(dotGeo, new THREE.MeshBasicMaterial({ color: 0x00d4ff, transparent: true, opacity: 0.5, side: THREE.DoubleSide }));
  reticleMesh.add(dot);
  scene.add(reticleMesh);
}

// ── SCAN RING (sweeping animation during SCANNING phase) ──────────────────
function buildScanRing() {
  scanRingGroup = new THREE.Group();

  // Outer dashed ring
  const pts = [];
  const segs = 64;
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * 0.22, 0, Math.sin(a) * 0.22));
  }
  const ringCurve = new THREE.CatmullRomCurve3(pts, true);
  const ringGeo = new THREE.TubeGeometry(ringCurve, 128, 0.003, 4, true);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x00d4ff, transparent: true, opacity: 0.6 });
  scanRingGroup.add(new THREE.Mesh(ringGeo, ringMat));

  // Inner ring
  const ipts = [];
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    ipts.push(new THREE.Vector3(Math.cos(a) * 0.12, 0, Math.sin(a) * 0.12));
  }
  const iCurve = new THREE.CatmullRomCurve3(ipts, true);
  const iGeo = new THREE.TubeGeometry(iCurve, 64, 0.002, 4, true);
  const iMat = new THREE.MeshBasicMaterial({ color: 0x00d4ff, transparent: true, opacity: 0.35 });
  scanRingGroup.add(new THREE.Mesh(iGeo, iMat));

  // Radial spokes
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const spokeGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(Math.cos(a) * 0.04, 0, Math.sin(a) * 0.04),
      new THREE.Vector3(Math.cos(a) * 0.22, 0, Math.sin(a) * 0.22),
    ]);
    scanRingGroup.add(new THREE.Line(spokeGeo, new THREE.LineBasicMaterial({ color: 0x00d4ff, transparent: true, opacity: 0.2 })));
  }

  // Centre dot
  const cGeo = new THREE.CircleGeometry(0.03, 16);
  cGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
  scanRingGroup.add(new THREE.Mesh(cGeo, new THREE.MeshBasicMaterial({ color: 0x00d4ff, transparent: true, opacity: 0.5, side: THREE.DoubleSide })));

  scanRingGroup.visible = false;
  scene.add(scanRingGroup);
}

// ── CONFIRM RING (pulsing ring during CONFIRMING phase) ───────────────────
function buildConfirmRing() {
  confirmRing = new THREE.Group();

  // Three concentric rings that pulse outward
  [0.14, 0.22, 0.32].forEach((r, i) => {
    const pts = [];
    for (let j = 0; j <= 80; j++) {
      const a = (j / 80) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
    }
    const curve = new THREE.CatmullRomCurve3(pts, true);
    const geo = new THREE.TubeGeometry(curve, 160, 0.004 - i * 0.001, 4, true);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x00ff88,
      transparent: true,
      opacity: 0.7 - i * 0.15,
    });
    const ring = new THREE.Mesh(geo, mat);
    ring.userData.baseOpacity = 0.7 - i * 0.15;
    ring.userData.phaseOffset = i * 0.6;
    confirmRing.add(ring);
  });

  // Centre fill
  const fillGeo = new THREE.CircleGeometry(0.08, 32);
  fillGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
  confirmRing.add(new THREE.Mesh(fillGeo, new THREE.MeshBasicMaterial({ color: 0x00ff88, transparent: true, opacity: 0.12, side: THREE.DoubleSide })));

  confirmRing.visible = false;
  scene.add(confirmRing);
}

// ── GROUND GRID ────────────────────────────────────────────────────────────
function buildGroundGrid() {
  groundGrid = new THREE.GridHelper(1.4, 14, 0x00d4ff, 0x003355);
  groundGrid.material.transparent = true;
  groundGrid.material.opacity = 0.3;
  groundGrid.visible = false;
  scene.add(groundGrid);
}

// ── HOLOGRAPHIC MATERIALS ─────────────────────────────────────────────────
function holoMaterial() {
  return new THREE.MeshBasicMaterial({ color: 0x00d4ff, wireframe: true, transparent: true, opacity: 0.7 });
}
function holoEdgeMaterial() {
  return new THREE.LineBasicMaterial({ color: 0x00d4ff, transparent: true, opacity: 0.95 });
}

// ── BUILD SHAPES ───────────────────────────────────────────────────────────
function buildShape(type) {
  const group = new THREE.Group();
  let geo, baseSize;

  switch (type) {
    case 'cube':
      baseSize = { w: 0.3, h: 0.3, d: 0.3 };
      geo = new THREE.BoxGeometry(0.3, 0.3, 0.3, 3, 3, 3);
      break;
    case 'sphere':
      baseSize = { w: 0.3, h: 0.3, d: 0.3 };
      geo = new THREE.SphereGeometry(0.15, 12, 8);
      break;
    case 'cylinder':
      baseSize = { w: 0.2, h: 0.4, d: 0.2 };
      geo = new THREE.CylinderGeometry(0.1, 0.1, 0.4, 16, 4);
      break;
  }

  group.add(new THREE.Mesh(geo, holoMaterial()));
  group.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), holoEdgeMaterial()));
  group.userData.type = type;
  group.userData.baseSize = baseSize;
  return group;
}

// ── PLACE OBJECT ───────────────────────────────────────────────────────────
function placeObject(position) {
  if (State.scanPhase !== ScanPhase.PLACING) return;

  if (placedMesh) {
    scene.remove(placedMesh);
    placedMesh.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  }

  placedMesh = buildShape(State.shape);
  placedMesh.position.copy(position);
  const bs = placedMesh.userData.baseSize;
  placedMesh.position.y += (bs.h / 2) * State.scale;
  placedMesh.scale.setScalar(State.scale);
  placedMesh.rotation.y = State.rotationY;

  scene.add(placedMesh);
  State.hasObject = true;
  State.objectPosition.copy(position);

  groundGrid.position.set(position.x, position.y, position.z);
  groundGrid.visible = true;

  updateHUD();
  showToast('OBJECT PLACED', 1000);
  statusText.innerHTML = 'OBJECT ACTIVE';
}

// ── DELETE ─────────────────────────────────────────────────────────────────
function deleteObject() {
  if (!placedMesh) { showToast('NO OBJECT TO DELETE', 800); return; }
  scene.remove(placedMesh);
  placedMesh.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  placedMesh = null;
  State.hasObject = false;
  groundGrid.visible = false;
  dimPanel.classList.remove('visible');
  coordPanel.classList.remove('visible');
  State.scale = 1.0;
  State.rotationY = 0;
  showToast('OBJECT DELETED', 800);
  setMode('place');
  reticleMesh.visible = true;
  statusText.innerHTML = 'TAP TO PLACE OBJECT';
}

// ── HUD ─────────────────────────────────────────────────────────────────────
function updateHUD() {
  if (!placedMesh) return;
  const bs = placedMesh.userData.baseSize, s = State.scale;
  document.querySelector('#dim-w .dim-value').textContent = (bs.w * s).toFixed(2) + 'm';
  document.querySelector('#dim-h .dim-value').textContent = (bs.h * s).toFixed(2) + 'm';
  document.querySelector('#dim-d .dim-value').textContent = (bs.d * s).toFixed(2) + 'm';
  scaleVal.textContent = s.toFixed(2);
  dimPanel.classList.add('visible');
  const p = placedMesh.position;
  document.getElementById('cx').textContent = p.x.toFixed(2);
  document.getElementById('cy').textContent = p.y.toFixed(2);
  document.getElementById('cz').textContent = p.z.toFixed(2);
  coordPanel.classList.add('visible');
}

// ── MODE ──────────────────────────────────────────────────────────────────
function setMode(m) {
  State.mode = m;
  ['place','move','rotate','scale'].forEach(id =>
    document.getElementById('btn-' + id).classList.toggle('active', id === m)
  );
  const labels = { place: 'PLACE MODE', move: 'MOVE MODE', rotate: 'ROTATE MODE', scale: 'PINCH TO SCALE' };
  modeLabel.textContent = labels[m];
  modeLabel.classList.add('visible');
  setTimeout(() => modeLabel.classList.remove('visible'), 2000);
}

// ── SHAPE SELECTION ───────────────────────────────────────────────────────
function selectShape(type) {
  State.shape = type;
  ['cube','sphere','cylinder'].forEach(s =>
    document.getElementById('shape-' + s).classList.toggle('active', s === type)
  );
  setMode('place');
  showToast('SHAPE: ' + type.toUpperCase(), 700);
}

// ── TOAST ─────────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, duration = 1500) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), duration);
}

// ── RESIZE ────────────────────────────────────────────────────────────────
function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// ══════════════════════════════════════════════════════════════════════════
// SCAN RING ANIMATION (called every frame during SCANNING)
// ══════════════════════════════════════════════════════════════════════════
function animateScanRing(t) {
  if (!scanRingGroup || !scanRingGroup.visible) return;
  scanRingGroup.rotation.y = t * 0.8;
  const pulse = 0.85 + 0.15 * Math.sin(t * 3);
  scanRingGroup.scale.setScalar(pulse);
  scanRingGroup.children.forEach((c, i) => {
    if (c.material) {
      const base = (i < 2) ? (i === 0 ? 0.6 : 0.35) : (i < 10 ? 0.2 : 0.5);
      c.material.opacity = base * (0.7 + 0.3 * Math.sin(t * 2 + i));
    }
  });
}

// ── CONFIRM RING ANIMATION (pulsing during CONFIRMING) ────────────────────
function animateConfirmRing(t) {
  if (!confirmRing || !confirmRing.visible) return;
  confirmRing.children.forEach((child, i) => {
    if (child.material && child.userData.baseOpacity !== undefined) {
      const phase = child.userData.phaseOffset || 0;
      child.material.opacity = child.userData.baseOpacity * (0.6 + 0.4 * Math.sin(t * 2.5 + phase));
      const s = 1 + 0.06 * Math.sin(t * 2 + phase);
      child.scale.setScalar(s);
    }
  });
}

// ── PLACED MESH ANIMATION ─────────────────────────────────────────────────
function animateMesh(t) {
  if (!placedMesh) return;
  placedMesh.traverse(child => {
    if (child.material?.wireframe)    child.material.opacity = 0.5 + 0.2  * Math.sin(t * 1.5);
    if (child.isLineSegments)         child.material.opacity = 0.7 + 0.25 * Math.sin(t * 1.5 + 0.5);
  });
}

// ── SCAN PROGRESS TICKER ──────────────────────────────────────────────────
function tickScanProgress() {
  State.scanHits++;
  State.scanProgress = Math.min(State.scanHits / State.SCAN_HITS_NEEDED, 1);
  scanBarFill.style.width = (State.scanProgress * 100) + '%';

  // colour shift from blue → green as we fill
  const r = Math.round(0   + State.scanProgress * 0);
  const g = Math.round(212 + State.scanProgress * (255 - 212));
  const b = Math.round(255 + State.scanProgress * (136 - 255));
  scanBarFill.style.background = `rgb(${r},${g},${b})`;
  scanBarFill.style.boxShadow  = `0 0 8px rgba(${r},${g},${b},0.8)`;
}

// ══════════════════════════════════════════════════════════════════════════
// WebXR MODE
// ══════════════════════════════════════════════════════════════════════════
async function startWebXR() {
  State.xrMode = true;
  try {
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay', 'light-estimation'],
      domOverlay: { root: document.body },
    });
    State.xrSession = session;
    renderer.xr.setReferenceSpaceType('local');
    await renderer.xr.setSession(session);
    session.addEventListener('end', () => { State.xrSession = null; State.xrMode = false; hitTestSource = null; hitTestSourceRequested = false; });
    renderer.setAnimationLoop(xrRenderLoop);
    setupTouchHandlers();
  } catch(e) {
    console.warn('WebXR failed:', e);
    await startCameraFallback();
  }
}

async function xrRenderLoop(timestamp, frame) {
  if (!frame) return;
  const t = clock.getElapsedTime();

  // Acquire hit-test source once
  if (!hitTestSourceRequested) {
    hitTestSourceRequested = true;
    const session = renderer.xr.getSession();
    try {
      const viewerRef = await session.requestReferenceSpace('viewer');
      hitTestSource   = await session.requestHitTestSource({ space: viewerRef });
      localSpace      = await session.requestReferenceSpace('local');
    } catch(e) {}
  }

  if (hitTestSource && frame) {
    try {
      const results = frame.getHitTestResults(hitTestSource);

      if (results.length > 0) {
        const pose = results[0].getPose(localSpace || renderer.xr.getReferenceSpace());
        if (pose) {
          const pos = new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().fromArray(pose.transform.matrix));

          if (State.scanPhase === ScanPhase.SCANNING) {
            // Show scan ring at surface hit
            scanRingGroup.visible = true;
            scanRingGroup.position.copy(pos);
            tickScanProgress();

            if (State.scanHits >= State.SCAN_HITS_NEEDED) {
              enterConfirmingPhase(pos);
            }
          }

          if (State.scanPhase === ScanPhase.PLACING) {
            reticleMesh.visible = (State.mode === 'place' && !State.hasObject);
            reticleMesh.position.copy(pos);
          }
        }
      } else {
        // Lost surface
        if (State.scanPhase === ScanPhase.SCANNING) {
          // Decay progress slowly when no hit
          State.scanHits = Math.max(0, State.scanHits - 1);
          State.scanProgress = State.scanHits / State.SCAN_HITS_NEEDED;
          scanBarFill.style.width = (State.scanProgress * 100) + '%';
          scanRingGroup.visible = false;
        }
        if (State.scanPhase === ScanPhase.PLACING) {
          reticleMesh.visible = false;
        }
      }
    } catch(e) {}
  }

  animateScanRing(t);
  animateConfirmRing(t);
  if (placedMesh) animateMesh(t);
  renderer.render(scene, camera);
}

// ══════════════════════════════════════════════════════════════════════════
// CAMERA FALLBACK
// ══════════════════════════════════════════════════════════════════════════
let floorPlane = null;

async function startCameraFallback() {
  State.xrMode = false;
  showToast('AR MODE: CAMERA FALLBACK', 2000);

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: window.innerWidth }, height: { ideal: window.innerHeight } },
      audio: false,
    });
    videoBg.srcObject = stream;
    videoBg.style.display = 'block';
    canvas.style.background = 'transparent';
  } catch(e) {
    canvas.style.background = 'linear-gradient(135deg, #000a1a 0%, #001122 100%)';
  }

  camera.position.set(0, 1.6, 2);
  camera.lookAt(0, 0, 0);

  // Invisible floor for raycasting
  const fGeo = new THREE.PlaneGeometry(20, 20);
  fGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
  floorPlane = new THREE.Mesh(fGeo, new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }));
  scene.add(floorPlane);

  // Light background grid
  const bgGrid = new THREE.GridHelper(10, 20, 0x003355, 0x001122);
  bgGrid.material.transparent = true;
  bgGrid.material.opacity = 0.15;
  scene.add(bgGrid);

  setupTouchHandlers();
  fallbackRenderLoop();

  // Simulate surface scan: ring appears at world origin and auto-progresses
  scanRingGroup.position.set(0, 0, 0);
  scanRingGroup.visible = true;
  simulateFallbackScan();
}

// Simulate progressive scan for fallback (no real depth)
function simulateFallbackScan() {
  if (State.scanPhase !== ScanPhase.SCANNING) return;

  const interval = setInterval(() => {
    if (State.scanPhase !== ScanPhase.SCANNING) { clearInterval(interval); return; }
    tickScanProgress();
    if (State.scanHits >= State.SCAN_HITS_NEEDED) {
      clearInterval(interval);
      enterConfirmingPhase(new THREE.Vector3(0, 0, 0));
    }
  }, 60);
}

function fallbackRenderLoop() {
  requestAnimationFrame(fallbackRenderLoop);
  const t = clock.getElapsedTime();

  if (State.scanPhase === ScanPhase.PLACING) {
    if (State.mode === 'place' && !State.hasObject) {
      reticleMesh.position.set(0, 0.001, -0.5);
      reticleMesh.visible = true;
    } else {
      reticleMesh.visible = false;
    }
  }

  animateScanRing(t);
  animateConfirmRing(t);
  if (placedMesh) animateMesh(t);
  renderer.render(scene, camera);
}

// ══════════════════════════════════════════════════════════════════════════
// TOUCH / INTERACTION
// ══════════════════════════════════════════════════════════════════════════
function setupTouchHandlers() {
  canvas.addEventListener('click',      onTap);
  canvas.addEventListener('touchstart', onTouchStart, { passive: false });
  canvas.addEventListener('touchmove',  onTouchMove,  { passive: false });
  canvas.addEventListener('touchend',   onTouchEnd,   { passive: false });
}

const raycaster = new THREE.Raycaster();
function ndcOf(x, y) {
  return new THREE.Vector2((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
}

function onTap(e) {
  if (State.xrMode) return;
  if (State.scanPhase !== ScanPhase.PLACING) return;
  if (State.mode !== 'place') return;
  doFallbackPlace(e.clientX, e.clientY);
}

function doFallbackPlace(cx, cy) {
  raycaster.setFromCamera(ndcOf(cx, cy), camera);
  const hits = raycaster.intersectObjects(floorPlane ? [floorPlane] : []);
  const pos = hits.length > 0
    ? hits[0].point.clone()
    : new THREE.Vector3(0, 0, -1).applyMatrix4(camera.matrixWorld).setY(0);
  placeObject(pos);
}

function onTouchStart(e) {
  e.preventDefault();
  if (e.touches.length === 1) {
    State.lastTouchX = e.touches[0].clientX;
    State.lastTouchY = e.touches[0].clientY;
    State.isDragging = false;

    if (State.xrMode && State.scanPhase === ScanPhase.PLACING && State.mode === 'place' && !State.hasObject) {
      placeObject(reticleMesh.position.clone());
    }
  }
  if (e.touches.length === 2) State.lastPinchDist = pinchDist(e.touches);
}

function onTouchMove(e) {
  e.preventDefault();
  if (!placedMesh || State.scanPhase !== ScanPhase.PLACING) return;

  if (e.touches.length === 1) {
    const dx = e.touches[0].clientX - State.lastTouchX;
    const dy = e.touches[0].clientY - State.lastTouchY;
    State.isDragging = true;

    if (State.mode === 'move') {
      const cam = camera.matrixWorld;
      const right   = new THREE.Vector3(cam.elements[0], 0, cam.elements[8]).normalize();
      const forward = new THREE.Vector3(cam.elements[2], 0, cam.elements[10]).normalize().negate();
      placedMesh.position.addScaledVector(right, dx * 0.002);
      placedMesh.position.addScaledVector(forward, -dy * 0.002);
      groundGrid.position.copy(placedMesh.position).setY(0);
    } else if (State.mode === 'rotate') {
      placedMesh.rotation.y += dx * 0.01;
      State.rotationY = placedMesh.rotation.y;
    } else if (State.mode === 'scale') {
      State.scale = Math.max(0.1, Math.min(5, State.scale * (1 - dy * 0.005)));
      applyScale();
    }

    State.lastTouchX = e.touches[0].clientX;
    State.lastTouchY = e.touches[0].clientY;
    updateHUD();
  }

  if (e.touches.length === 2) {
    const d = pinchDist(e.touches);
    State.scale = Math.max(0.1, Math.min(5, State.scale * (d / State.lastPinchDist)));
    State.lastPinchDist = d;
    applyScale(); updateHUD();
  }
}

function onTouchEnd(e) {
  e.preventDefault();
  if (State.isDragging) { State.isDragging = false; return; }
  if (!State.xrMode && State.scanPhase === ScanPhase.PLACING && State.mode === 'place' && e.changedTouches.length > 0) {
    const t = e.changedTouches[0];
    doFallbackPlace(t.clientX, t.clientY);
  }
}

function applyScale() {
  if (!placedMesh) return;
  placedMesh.scale.setScalar(State.scale);
  placedMesh.position.y = placedMesh.userData.baseSize.h / 2 * State.scale;
}

function pinchDist(t) {
  const dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY;
  return Math.sqrt(dx*dx + dy*dy);
}

// ── SERVICE WORKER ─────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .then(() => console.log('[HoloPlace] SW registered'))
      .catch(e => console.warn('[HoloPlace] SW failed:', e));
  });
}

// ── GLOBALS ────────────────────────────────────────────────────────────────
window.startAR        = startAR;
window.setMode        = setMode;
window.selectShape    = selectShape;
window.deleteObject   = deleteObject;
window.confirmSurface = confirmSurface;
window.rescanSurface  = rescanSurface;