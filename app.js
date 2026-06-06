/**
 * HoloPlace AR — Main Application
 * Three.js + WebXR AR with camera fallback
 */

'use strict';

// ── STATE ──────────────────────────────────────────────────────────────────
const State = {
  mode: 'place',       // place | move | rotate | scale
  shape: 'cube',
  hasObject: false,
  surfaceDetected: false,
  xrSession: null,
  xrMode: false,       // true = WebXR, false = camera fallback
  scale: 1.0,
  rotationY: 0,
  objectPosition: new THREE.Vector3(),
  // touch
  lastTouchX: 0,
  lastTouchY: 0,
  lastPinchDist: 0,
  isDragging: false,
};

// ── SCENE ──────────────────────────────────────────────────────────────────
let renderer, scene, camera, clock;
let placedMesh = null;
let reticleMesh = null;
let groundGrid = null;
let hitTestSource = null;
let hitTestSourceRequested = false;
let localSpace = null;
let viewerSpace = null;
let animFrame = null;

// ── DOM ────────────────────────────────────────────────────────────────────
const canvas       = document.getElementById('ar-canvas');
const hud          = document.getElementById('hud');
const toolbar      = document.getElementById('toolbar');
const surfaceInd   = document.getElementById('surface-indicator');
const modeLabel    = document.getElementById('mode-label');
const statusText   = document.getElementById('status-text');
const toastEl      = document.getElementById('toast');
const dimPanel     = document.getElementById('dimensions');
const coordPanel   = document.getElementById('coords');
const scaleVal     = document.getElementById('scale-val');
const videoBg      = document.getElementById('video-bg');
const scanlines    = document.getElementById('scanlines');
const vignette     = document.getElementById('vignette');

// ── INIT ───────────────────────────────────────────────────────────────────
async function startAR() {
  const splash = document.getElementById('splash');
  splash.classList.add('hidden');
  setTimeout(() => splash.style.display = 'none', 700);

  hud.classList.add('active');
  toolbar.classList.add('active');
  scanlines.classList.add('active');
  vignette.classList.add('active');

  initThree();
  showToast('CAMERA PERMISSION REQUIRED', 1800);

  const hasWebXR = 'xr' in navigator;
  let xrSupported = false;

  if (hasWebXR) {
    try {
      xrSupported = await navigator.xr.isSessionSupported('immersive-ar');
    } catch(e) { xrSupported = false; }
  }

  if (xrSupported) {
    await startWebXR();
  } else {
    await startCameraFallback();
  }
}

// ── THREE.JS INIT ──────────────────────────────────────────────────────────
function initThree() {
  clock = new THREE.Clock();

  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    premultipliedAlpha: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  renderer.setClearColor(0x000000, 0);

  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 100);
  camera.position.set(0, 1.6, 0);

  // Lighting (subtle, holographic feel)
  const ambient = new THREE.AmbientLight(0x002244, 1.5);
  scene.add(ambient);
  const dir = new THREE.DirectionalLight(0x00d4ff, 0.8);
  dir.position.set(1, 3, 2);
  scene.add(dir);

  buildReticle();
  buildGroundGrid();

  window.addEventListener('resize', onResize);
}

// ── RETICLE ────────────────────────────────────────────────────────────────
function buildReticle() {
  const geo = new THREE.RingGeometry(0.06, 0.08, 32);
  geo.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
  const mat = new THREE.MeshBasicMaterial({
    color: 0x00d4ff,
    transparent: true,
    opacity: 0.8,
    side: THREE.DoubleSide,
  });
  reticleMesh = new THREE.Mesh(geo, mat);
  reticleMesh.visible = false;

  // Inner dot
  const dotGeo = new THREE.CircleGeometry(0.02, 16);
  dotGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
  const dotMat = new THREE.MeshBasicMaterial({ color: 0x00d4ff, transparent: true, opacity: 0.5, side: THREE.DoubleSide });
  const dot = new THREE.Mesh(dotGeo, dotMat);
  reticleMesh.add(dot);

  scene.add(reticleMesh);
}

// ── GROUND GRID ────────────────────────────────────────────────────────────
function buildGroundGrid() {
  const size = 1.2, divisions = 12;
  const helper = new THREE.GridHelper(size, divisions, 0x00d4ff, 0x003355);
  helper.material.transparent = true;
  helper.material.opacity = 0.25;
  helper.visible = false;
  groundGrid = helper;
  scene.add(groundGrid);
}

// ── HOLOGRAPHIC MATERIAL ───────────────────────────────────────────────────
function holoMaterial() {
  return new THREE.MeshBasicMaterial({
    color: 0x00d4ff,
    wireframe: true,
    transparent: true,
    opacity: 0.75,
  });
}

function holoEdgeMaterial() {
  return new THREE.LineBasicMaterial({
    color: 0x00d4ff,
    transparent: true,
    opacity: 0.9,
  });
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

  // Wireframe fill
  const mesh = new THREE.Mesh(geo, holoMaterial());
  group.add(mesh);

  // Bold edges
  const edges = new THREE.EdgesGeometry(geo);
  const lineMat = holoEdgeMaterial();
  const lines = new THREE.LineSegments(edges, lineMat);
  group.add(lines);

  group.userData.type = type;
  group.userData.baseSize = baseSize;
  group.userData.scale = 1.0;

  return group;
}

// ── PLACE OBJECT ───────────────────────────────────────────────────────────
function placeObject(position) {
  if (placedMesh) {
    scene.remove(placedMesh);
    placedMesh.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }

  placedMesh = buildShape(State.shape);
  placedMesh.position.copy(position);

  // Lift shape so base sits on surface
  const bs = placedMesh.userData.baseSize;
  const halfH = (State.shape === 'sphere') ? bs.h / 2 : bs.h / 2;
  placedMesh.position.y += halfH * State.scale;

  placedMesh.scale.setScalar(State.scale);
  placedMesh.rotation.y = State.rotationY;

  scene.add(placedMesh);
  State.hasObject = true;
  State.objectPosition.copy(position);

  // Ground grid at same position
  groundGrid.position.set(position.x, position.y, position.z);
  groundGrid.visible = true;

  updateHUD();
  showToast('OBJECT PLACED', 1000);
}

// ── DELETE ─────────────────────────────────────────────────────────────────
function deleteObject() {
  if (!placedMesh) { showToast('NO OBJECT TO DELETE', 800); return; }
  scene.remove(placedMesh);
  placedMesh.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  });
  placedMesh = null;
  State.hasObject = false;
  groundGrid.visible = false;
  dimPanel.classList.remove('visible');
  coordPanel.classList.remove('visible');
  State.scale = 1.0;
  State.rotationY = 0;
  showToast('OBJECT DELETED', 800);
  setMode('place');
}

// ── UPDATE HUD ─────────────────────────────────────────────────────────────
function updateHUD() {
  if (!placedMesh) return;
  const bs = placedMesh.userData.baseSize;
  const s = State.scale;
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

// ── MODE ───────────────────────────────────────────────────────────────────
function setMode(m) {
  State.mode = m;
  ['place','move','rotate','scale'].forEach(id => {
    document.getElementById('btn-' + id).classList.toggle('active', id === m);
  });
  const labels = { place: 'PLACE MODE', move: 'MOVE MODE', rotate: 'ROTATE MODE', scale: 'PINCH TO SCALE' };
  modeLabel.textContent = labels[m];
  modeLabel.classList.add('visible');
  setTimeout(() => modeLabel.classList.remove('visible'), 2000);
  showToast(labels[m], 800);
}

// ── SHAPE SELECTION ────────────────────────────────────────────────────────
function selectShape(type) {
  State.shape = type;
  ['cube','sphere','cylinder'].forEach(s => {
    document.getElementById('shape-' + s).classList.toggle('active', s === type);
  });
  setMode('place');
  showToast('SHAPE: ' + type.toUpperCase(), 700);
}

// ── TOAST ──────────────────────────────────────────────────────────────────
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
    session.addEventListener('end', onXREnd);
    renderer.setAnimationLoop(xrRenderLoop);
    setupTouchHandlers();
    statusText.innerHTML = 'SCANNING SURFACE<span class="blink">_</span>';
  } catch(e) {
    console.warn('WebXR failed:', e);
    await startCameraFallback();
  }
}

function onXREnd() {
  State.xrSession = null;
  State.xrMode = false;
  hitTestSource = null;
  hitTestSourceRequested = false;
}

async function xrRenderLoop(timestamp, frame) {
  if (!frame) return;

  // Hit test setup
  if (!hitTestSourceRequested) {
    hitTestSourceRequested = true;
    const session = renderer.xr.getSession();
    try {
      const refSpace = await session.requestReferenceSpace('viewer');
      viewerSpace = refSpace;
      const src = await session.requestHitTestSource({ space: refSpace });
      hitTestSource = src;
      localSpace = await session.requestReferenceSpace('local');
    } catch(e) {}
  }

  if (hitTestSource && frame) {
    try {
      const results = frame.getHitTestResults(hitTestSource);
      if (results.length > 0) {
        const pose = results[0].getPose(localSpace || renderer.xr.getReferenceSpace());
        if (pose) {
          State.surfaceDetected = true;
          reticleMesh.visible = (State.mode === 'place');
          reticleMesh.matrix.fromArray(pose.transform.matrix);
          reticleMesh.matrix.decompose(reticleMesh.position, reticleMesh.quaternion, reticleMesh.scale);
          surfaceInd.classList.add('visible');
          statusText.innerHTML = 'SURFACE LOCKED · TAP TO PLACE';
        }
      } else {
        State.surfaceDetected = false;
        reticleMesh.visible = false;
        surfaceInd.classList.remove('visible');
        statusText.innerHTML = 'SCANNING SURFACE<span class="blink">_</span>';
      }
    } catch(e) {}
  }

  renderer.render(scene, camera);
  if (placedMesh) animateMesh();
}

// ══════════════════════════════════════════════════════════════════════════
// CAMERA FALLBACK (non-WebXR browsers)
// ══════════════════════════════════════════════════════════════════════════
let fallbackStream = null;

async function startCameraFallback() {
  State.xrMode = false;
  showToast('AR MODE: CAMERA FALLBACK', 2000);

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'environment',
        width: { ideal: window.innerWidth },
        height: { ideal: window.innerHeight },
      },
      audio: false,
    });
    fallbackStream = stream;
    videoBg.srcObject = stream;
    videoBg.style.display = 'block';
    canvas.style.background = 'transparent';

  } catch(e) {
    showToast('CAMERA UNAVAILABLE', 2000);
    canvas.style.background = 'linear-gradient(135deg, #000a1a 0%, #001122 100%)';
  }

  // Place camera so scene is visible
  camera.position.set(0, 1.6, 2);
  camera.lookAt(0, 0, 0);

  // Build a "virtual floor" for raycasting
  buildFallbackFloor();

  State.surfaceDetected = true;
  reticleMesh.visible = true;
  surfaceInd.classList.add('visible');
  statusText.innerHTML = 'TAP TO PLACE OBJECT';

  setupTouchHandlers();
  fallbackRenderLoop();
}

let floorPlane = null;
function buildFallbackFloor() {
  const geo = new THREE.PlaneGeometry(20, 20);
  geo.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
  const mat = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide });
  floorPlane = new THREE.Mesh(geo, mat);
  floorPlane.position.y = 0;
  scene.add(floorPlane);

  // Visible grid
  const grid = new THREE.GridHelper(10, 20, 0x003355, 0x001122);
  grid.material.transparent = true;
  grid.material.opacity = 0.2;
  scene.add(grid);
}

function fallbackRenderLoop() {
  animFrame = requestAnimationFrame(fallbackRenderLoop);
  renderer.render(scene, camera);
  if (placedMesh) animateMesh();

  // Float reticle in view center at floor level
  if (State.mode === 'place' && !State.hasObject) {
    reticleMesh.position.set(0, 0, -0.5);
    reticleMesh.visible = true;
  } else {
    reticleMesh.visible = false;
  }
}

// ── MESH ANIMATION ─────────────────────────────────────────────────────────
function animateMesh() {
  if (!placedMesh) return;
  // Subtle pulse via opacity
  const t = clock.getElapsedTime();
  placedMesh.traverse(child => {
    if (child.material && child.material.wireframe) {
      child.material.opacity = 0.55 + 0.2 * Math.sin(t * 1.5);
    } else if (child.material && child.isLineSegments) {
      child.material.opacity = 0.7 + 0.25 * Math.sin(t * 1.5 + 0.5);
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════
// TOUCH / INTERACTION
// ══════════════════════════════════════════════════════════════════════════
function setupTouchHandlers() {
  canvas.addEventListener('click', onTap);
  canvas.addEventListener('touchstart', onTouchStart, { passive: false });
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  canvas.addEventListener('touchend', onTouchEnd, { passive: false });
}

const raycaster = new THREE.Raycaster();

function getScreenNDC(clientX, clientY) {
  return new THREE.Vector2(
    (clientX / window.innerWidth) * 2 - 1,
    -(clientY / window.innerHeight) * 2 + 1
  );
}

// ── TAP ────────────────────────────────────────────────────────────────────
function onTap(e) {
  // In XR mode tap is handled differently; only handle for fallback
  if (State.xrMode) return;
  if (State.mode !== 'place') return;

  const ndc = getScreenNDC(e.clientX, e.clientY);
  raycaster.setFromCamera(ndc, camera);

  // Intersect floor plane
  const targets = floorPlane ? [floorPlane] : [];
  const hits = raycaster.intersectObjects(targets);

  if (hits.length > 0) {
    placeObject(hits[0].point);
  } else {
    // Fallback: place at fixed distance
    const pos = new THREE.Vector3(0, 0, -1).applyMatrix4(camera.matrixWorld);
    pos.y = 0;
    placeObject(pos);
  }
}

// ── TOUCH START ────────────────────────────────────────────────────────────
function onTouchStart(e) {
  e.preventDefault();
  if (e.touches.length === 1) {
    const t = e.touches[0];
    State.lastTouchX = t.clientX;
    State.lastTouchY = t.clientY;
    State.isDragging = false;

    // XR: place on tap
    if (State.xrMode && State.mode === 'place' && State.surfaceDetected) {
      placeObject(reticleMesh.position.clone());
      return;
    }
  }

  if (e.touches.length === 2) {
    State.lastPinchDist = getPinchDist(e.touches);
  }
}

// ── TOUCH MOVE ────────────────────────────────────────────────────────────
function onTouchMove(e) {
  e.preventDefault();
  if (!placedMesh) return;

  if (e.touches.length === 1) {
    const t = e.touches[0];
    const dx = t.clientX - State.lastTouchX;
    const dy = t.clientY - State.lastTouchY;
    State.isDragging = true;

    switch (State.mode) {
      case 'move':
        moveDrag(dx, dy);
        break;
      case 'rotate':
        placedMesh.rotation.y += dx * 0.01;
        State.rotationY = placedMesh.rotation.y;
        break;
      case 'scale':
        // Single-finger scale: vertical drag
        const factor = 1 - dy * 0.005;
        State.scale = Math.max(0.1, Math.min(5, State.scale * factor));
        applyScale();
        break;
    }

    State.lastTouchX = t.clientX;
    State.lastTouchY = t.clientY;
    updateHUD();
  }

  // Pinch to scale
  if (e.touches.length === 2) {
    const dist = getPinchDist(e.touches);
    const delta = dist / State.lastPinchDist;
    State.lastPinchDist = dist;
    State.scale = Math.max(0.1, Math.min(5, State.scale * delta));
    applyScale();
    updateHUD();
  }
}

function onTouchEnd(e) {
  e.preventDefault();
  if (State.isDragging) { State.isDragging = false; return; }

  // Tap in fallback place mode
  if (!State.xrMode && State.mode === 'place' && e.changedTouches.length > 0) {
    const t = e.changedTouches[0];
    const ndc = getScreenNDC(t.clientX, t.clientY);
    raycaster.setFromCamera(ndc, camera);
    const targets = floorPlane ? [floorPlane] : [];
    const hits = raycaster.intersectObjects(targets);
    if (hits.length > 0) {
      placeObject(hits[0].point);
    } else {
      const pos = new THREE.Vector3(0, 0, -1).applyMatrix4(camera.matrixWorld);
      pos.y = 0;
      placeObject(pos);
    }
  }
}

// ── MOVE DRAG ─────────────────────────────────────────────────────────────
function moveDrag(dx, dy) {
  if (!placedMesh) return;
  const speed = 0.002;
  const cam = camera.matrixWorld;
  const right = new THREE.Vector3(cam.elements[0], 0, cam.elements[8]).normalize();
  const forward = new THREE.Vector3(cam.elements[2], 0, cam.elements[10]).normalize().negate();
  placedMesh.position.addScaledVector(right, dx * speed);
  placedMesh.position.addScaledVector(forward, -dy * speed);
  groundGrid.position.copy(placedMesh.position);
  groundGrid.position.y = 0;
}

// ── SCALE APPLY ───────────────────────────────────────────────────────────
function applyScale() {
  if (!placedMesh) return;
  placedMesh.scale.setScalar(State.scale);
  // Re-lift
  const bs = placedMesh.userData.baseSize;
  const base = placedMesh.position.clone();
  base.y = bs.h / 2 * State.scale;
  placedMesh.position.y = base.y;
}

// ── UTILS ─────────────────────────────────────────────────────────────────
function getPinchDist(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

// ── SERVICE WORKER ────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then(() => {
      console.log('[HoloPlace] Service Worker registered');
    }).catch(e => console.warn('[HoloPlace] SW failed:', e));
  });
}

// Expose globals for HTML onclick
window.startAR = startAR;
window.setMode = setMode;
window.selectShape = selectShape;
window.deleteObject = deleteObject;
