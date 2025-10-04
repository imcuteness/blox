// public/client.js
// - Логика регистрации/логина (fetch /api/register & /api/login)
// - Соединение по Socket.IO с токеном
// - Рендеринг мира и игроков через Three.js (простые кубы)
// - Обработка установки и слома блоков (Raycast, ЛКМ - ломать, ПКМ - ставить)
// - Синхронизация позиций и блоков в реальном времени

let socket = null;
let token = null;
let myUsername = null;

// ---------- AUTH UI ----------
const overlay = document.getElementById('overlay');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const btnRegister = document.getElementById('btn-register');
const btnLogin = document.getElementById('btn-login');
const authMsg = document.getElementById('auth-msg');

btnRegister.onclick = async () => {
  const u = usernameInput.value.trim();
  const p = passwordInput.value;
  if (!u || !p) { authMsg.innerText = 'Введите имя и пароль'; return; }
  try {
    const res = await fetch('/api/register', {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username: u, password: p })
    });
    const data = await res.json();
    if (!res.ok) { authMsg.innerText = data.error || 'Ошибка'; return; }
    token = data.token; myUsername = data.username;
    startGame();
  } catch (e) { authMsg.innerText = 'Ошибка сети'; }
};

btnLogin.onclick = async () => {
  const u = usernameInput.value.trim();
  const p = passwordInput.value;
  if (!u || !p) { authMsg.innerText = 'Введите имя и пароль'; return; }
  try {
    const res = await fetch('/api/login', {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username: u, password: p })
    });
    const data = await res.json();
    if (!res.ok) { authMsg.innerText = data.error || 'Ошибка'; return; }
    token = data.token; myUsername = data.username;
    startGame();
  } catch (e) { authMsg.innerText = 'Ошибка сети'; }
};

// ---------- Three.js scene setup ----------
let scene, camera, renderer;
let blockSize = 1;
let blocksGroup;
let playersGroup;
let myPlayerId = null;
let players = {}; // socketId -> mesh & data
let blockMap = {}; // key -> mesh

function initThree() {
  const container = document.getElementById('game-container');
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87ceeb); // sky

  camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 1000);
  camera.position.set(5,8,12);
  camera.lookAt(0,0,0);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  // lights
  const ambient = new THREE.AmbientLight(0xffffff, 0.8);
  scene.add(ambient);

  const dir = new THREE.DirectionalLight(0xffffff, 0.6);
  dir.position.set(10,20,10);
  scene.add(dir);

  // groups
  blocksGroup = new THREE.Group();
  scene.add(blocksGroup);

  playersGroup = new THREE.Group();
  scene.add(playersGroup);

  // grid helper for reference
  const grid = new THREE.GridHelper(50, 50);
  scene.add(grid);

  // Raycaster
  raycaster = new THREE.Raycaster();
  mouse = new THREE.Vector2();

  window.addEventListener('resize', onWindowResize);
  animate();
}

function onWindowResize() {
  const container = document.getElementById('game-container');
  camera.aspect = container.clientWidth / container.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(container.clientWidth, container.clientHeight);
}

// ---------- Utility: key for blockMap ----------
function blockKey(x,y,z){ return `${x},${y},${z}`; }

// ---------- Add / remove block visuals (called when server notifies) ----------
function addBlockVisual(block) {
  const k = blockKey(block.x,block.y,block.z);
  if (blockMap[k]) return;
  const geometry = new THREE.BoxGeometry(blockSize, blockSize, blockSize);
  const material = new THREE.MeshStandardMaterial({ color: block.color || '#ffffff' });
  const cube = new THREE.Mesh(geometry, material);
  cube.position.set(block.x + 0.5*blockSize - 0.5, block.y + 0.5*blockSize - 0.5, block.z + 0.5*blockSize - 0.5);
  cube.userData.blockPos = { x:block.x, y:block.y, z:block.z };
  blocksGroup.add(cube);
  blockMap[k] = cube;
}

function removeBlockVisual(x,y,z) {
  const k = blockKey(x,y,z);
  const mesh = blockMap[k];
  if (!mesh) return;
  blocksGroup.remove(mesh);
  if (mesh.geometry) mesh.geometry.dispose();
  if (mesh.material) mesh.material.dispose();
  delete blockMap[k];
}

// ---------- Players visuals ----------
function addOrUpdatePlayerVisual(socketId, pdata) {
  if (players[socketId]) {
    // update position
    players[socketId].mesh.position.set(pdata.x, pdata.y, pdata.z);
    return;
  }
  const geom = new THREE.BoxGeometry(0.8, 1.8, 0.8);
  const mat = new THREE.MeshStandardMaterial({ color: pdata.color || '#ff0000' });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(pdata.x, pdata.y, pdata.z);
  playersGroup.add(mesh);
  players[socketId] = { mesh, pdata };
}

function removePlayerVisual(socketId) {
  if (!players[socketId]) return;
  playersGroup.remove(players[socketId].mesh);
  // dispose resources
  if (players[socketId].mesh.geometry) players[socketId].mesh.geometry.dispose();
  if (players[socketId].mesh.material) players[socketId].mesh.material.dispose();
  delete players[socketId];
}

// ---------- Input & movement ----------
const keys = {};
window.addEventListener('keydown',(e)=>{ keys[e.key.toLowerCase()] = true; });
window.addEventListener('keyup',(e)=>{ keys[e.key.toLowerCase()] = false; });

let myPos = { x:0, y:2, z:0 };
let lastSent = 0;

function handleMovement(delta) {
  const speed = 4; // units per second
  let dx = 0, dz = 0;
  if (keys['w']) dz -= 1;
  if (keys['s']) dz += 1;
  if (keys['a']) dx -= 1;
  if (keys['d']) dx += 1;
  if (keys[' ']) myPos.y += speed * delta; // jump / up
  // simple move relative to world axes
  if (dx !== 0 || dz !== 0) {
    const len = Math.sqrt(dx*dx + dz*dz);
    dx /= len; dz /= len;
    myPos.x += dx * speed * delta;
    myPos.z += dz * speed * delta;
  }
  // send updates ~20 times per second
  const now = performance.now();
  if (socket && now - lastSent > 50) {
    socket.emit('move', { x: myPos.x, y: myPos.y, z: myPos.z });
    lastSent = now;
  }
  // update my visual
  if (myPlayerId && players[myPlayerId]) {
    players[myPlayerId].mesh.position.set(myPos.x, myPos.y, myPos.z);
  }
}

// ---------- Mouse picking (raycast) for placing/breaking ----------
let raycaster, mouse;
let selectedIntersect = null;

renderer && renderer.domElement && renderer.domElement.addEventListener && renderer.domElement.addEventListener('pointerdown', () => {});
// We'll attach pointer events after renderer is created.

function screenToRay(x,y) {
  const container = renderer.domElement;
  const rect = container.getBoundingClientRect();
  mouse.x = ((x - rect.left) / rect.width ) * 2 - 1;
  mouse.y = - ((y - rect.top) / rect.height ) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects(blocksGroup.children);
  return intersects;
}

function setupPointerControls() {
  const canvas = renderer.domElement;
  canvas.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    const intersects = screenToRay(ev.clientX, ev.clientY);
    if (ev.button === 0) {
      // ЛКМ - ломать: удаляем ближайший блок
      if (intersects.length > 0) {
        const it = intersects[0];
        const pos = it.object.userData.blockPos;
        socket.emit('break_block', { x: pos.x, y: pos.y, z: pos.z });
      }
    } else if (ev.button === 2) {
      // ПКМ - ставить: ставим блок на соседнюю сторону
      if (intersects.length > 0) {
        const it = intersects[0];
        const pos = it.object.userData.blockPos;
        // normal gives direction; compute adjacent cell
        const n = it.face.normal;
        const placeX = pos.x + Math.round(n.x);
        const placeY = pos.y + Math.round(n.y);
        const placeZ = pos.z + Math.round(n.z);
        // place a block of random color for demo
        const color = '#'+Math.floor(Math.random()*16777215).toString(16).padStart(6,'0');
        socket.emit('place_block', { x: placeX, y: placeY, z: placeZ, type: 'custom', color });
      } else {
        // if no intersect, place block at some position in front of camera
        const dir = new THREE.Vector3();
        camera.getWorldDirection(dir);
        const place = camera.position.clone().add(dir.multiplyScalar(5));
        const px = Math.floor(place.x+0.5);
        const py = Math.floor(place.y+0.5);
        const pz = Math.floor(place.z+0.5);
        const color = '#'+Math.floor(Math.random()*16777215).toString(16).padStart(6,'0');
        socket.emit('place_block', { x: px, y: py, z: pz, type:'custom', color });
      }
    }
  });
  // disable context menu on canvas (so right-click works)
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

// ---------- Animation loop ----------
let lastTime = performance.now();
function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const delta = (now - lastTime) / 1000;
  lastTime = now;

  handleMovement(delta);
  renderer && renderer.render(scene, camera);
}

// ---------- Start game after auth ----------
function startGame() {
  overlay.style.display = 'none';
  initThree();

  // Connect socket.io with token (auth)
  socket = io({ auth: { token } });

  socket.on('connect_error', (err) => {
    alert('Socket connection error: ' + (err.message || err));
    console.error(err);
  });

  // --- Initialization from server: blocks + players ---
  socket.on('init', (data) => {
    // data.blocks: array of {x,y,z,type,color}
    // data.players: object of players
    // clear any existing visuals (in case of reconnect)
    for (const k in blockMap) removeBlockVisual(...k.split(',').map(Number));
    for (const child of blocksGroup.children.slice()) blocksGroup.remove(child);

    // build visuals
    data.blocks.forEach(addBlockVisual);

    // players: map socketId -> pdata
    for (const sId in data.players) {
      const p = data.players[sId];
      addOrUpdatePlayerVisual(sId, p);
    }

    // set myPlayerId to my socket id and store my initial pos
    myPlayerId = socket.id;
    // ensure there is a player visual for me
    if (!players[myPlayerId]) {
      const me = { x: 0, y:2, z:0, color: '#ffee00', username: myUsername };
      addOrUpdatePlayerVisual(myPlayerId, me);
    }
    // set my position variable to current visual pos
    myPos = players[myPlayerId] ? {
      x: players[myPlayerId].mesh.position.x,
      y: players[myPlayerId].mesh.position.y,
      z: players[myPlayerId].mesh.position.z
    } : { x:0,y:2,z:0 };

  });

  // --- Player join/leave/move events ---
  socket.on('player_join', (d) => {
    addOrUpdatePlayerVisual(d.socketId, d.player);
  });
  socket.on('player_leave', (d) => {
    removePlayerVisual(d.socketId);
  });
  socket.on('player_move', (d) => {
    if (players[d.socketId]) {
      players[d.socketId].mesh.position.set(d.pos.x, d.pos.y, d.pos.z);
    }
  });

  // --- Block events ---
  socket.on('block_placed', (block) => {
    addBlockVisual(block);
  });
  socket.on('block_removed', (b) => {
    removeBlockVisual(b.x,b.y,b.z);
  });

  // setup pointer controls (after renderer exists)
  setupPointerControls();
}

// prevent right click menu on whole page to allow PCМ
window.addEventListener('contextmenu', e=>e.preventDefault());
