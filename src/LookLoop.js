// Lecteur de boucle « tour du regard » : une séquence pré-rendue où le personnage
// regarde successivement dans toutes les directions. Chaque image correspond à un
// angle de regard ; le lecteur cherche l'image qui regarde vers le curseur et s'y
// rend en parcourant la boucle par le chemin le plus court.
//
// Angles en degrés dans le repère écran : 0° = droite, 90° = bas, 180° = gauche,
// -90° (270°) = haut. « clockwise » = le regard tourne dans le sens horaire.
//
// Regard de face (facultatif, champ « face » du manifeste) : la boucle ne code
// qu'une direction, jamais « droit devant ». Des « rayons » — courtes séquences de
// la pose de face vers une image de la boucle — en font un graphe : boucle +
// rayons qui convergent vers la face. Près du nez, le regard descend le long du
// rayon le plus proche ; le lecteur suit toujours le plus court chemin du graphe
// (pour passer de gauche à droite, la tête peut tourner en passant par la face).

const TAU = Math.PI * 2;
const RAD = Math.PI / 180;
const LOOKUP_BINS = 720;
const LOAD_CONCURRENCY = 6;

/** Ramène un angle (radians) dans [0, 2π). */
const wrapAngle = (a) => ((a % TAU) + TAU) % TAU;

/** Ramène une position dans [0, n). */
const wrapIndex = (i, n) => ((i % n) + n) % n;

/** Distance angulaire absolue, dans [0, π]. */
function angularDistance(a, b) {
  const d = wrapAngle(a - b);
  return d > Math.PI ? TAU - d : d;
}

/**
 * Charge et décode la séquence décrite par un manifest.json (voir
 * scripts/extract-frames.js). Les images restent des HTMLImageElement : le
 * navigateur gère leur mémoire décodée, là où 190 ImageBitmap en 720 px
 * occuperaient près de 400 Mo.
 */
export async function loadSequence(manifestUrl, onProgress) {
  const url = new URL(manifestUrl, location.href);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Manifeste introuvable : ${url.pathname}`);
  const manifest = await response.json();

  const frames = new Array(manifest.count);
  let next = 0;
  let loaded = 0;

  // Quelques chargements en parallèle seulement : lancés tous ensemble, les
  // decode() de Chrome finissent par échouer (« The source image cannot be decoded »).
  const worker = async () => {
    while (next < manifest.count) {
      const i = next++;
      frames[i] = await loadFrame(new URL(manifest.pattern.replace('{n}', String(i).padStart(manifest.pad ?? 0, '0')), url).href);
      onProgress?.(++loaded / manifest.count);
    }
  };
  await Promise.all(Array.from({ length: LOAD_CONCURRENCY }, worker));

  return { manifest, frames };
}

/**
 * Charge les rayons du regard de face déclarés par le manifeste de la boucle
 * (chemins relatifs à celui-ci). Chaque rayon va de la face (image 0) à l'image
 * `ring` de la boucle (dernière image).
 */
export async function loadFace(manifestUrl, manifest, onProgress) {
  if (!manifest.face?.spokes?.length) return null;
  const base = new URL(manifestUrl, location.href);
  const { spokes } = manifest.face;
  const progress = new Array(spokes.length).fill(0);
  const loaded = await Promise.all(
    spokes.map((spoke, i) =>
      loadSequence(new URL(`${spoke.path.replace(/\/?$/, '/')}manifest.json`, base), (ratio) => {
        progress[i] = ratio;
        onProgress?.(progress.reduce((sum, r) => sum + r, 0) / spokes.length);
      }).then(({ frames }) => ({ ...spoke, frames })),
    ),
  );
  return { radius: manifest.face.radius ?? 0.22, step: manifest.face.step ?? 1, spokes: loaded };
}

async function loadFrame(src) {
  const img = new Image();
  img.src = src;
  try {
    await img.decode();
  } catch (error) {
    // decode() peut échouer sous pression mémoire alors que l'image est chargée :
    // elle sera alors décodée au premier dessin. Seule une image absente est fatale.
    if (!img.complete || !img.naturalWidth) throw new Error(`Image illisible : ${src}`, { cause: error });
  }
  return img;
}

/**
 * Angle de regard de chaque image, en radians.
 *
 * Sans repère, la rotation est supposée régulière à partir de startAngle. Avec des
 * repères de calibration ({ frame, angle }), l'angle est interpolé entre repères
 * consécutifs, dans le sens de rotation du clip : un clip généré par IA tourne
 * rarement à vitesse constante.
 */
export function frameAngles({ count, startAngle = 0, clockwise = true, keys = [] }) {
  const dir = clockwise ? 1 : -1;
  const sorted = [...keys].sort((a, b) => a.frame - b.frame);

  if (sorted.length < 2) {
    const origin = sorted[0] ?? { frame: 0, angle: startAngle };
    return Array.from({ length: count }, (_, i) => wrapAngle((origin.angle + (dir * 360 * (i - origin.frame)) / count) * RAD));
  }

  const angles = new Array(count);
  sorted.forEach((key, k) => {
    const next = sorted[(k + 1) % sorted.length];
    const frames = wrapIndex(next.frame - key.frame, count) || count;
    // Portée angulaire comptée dans le sens de rotation, dans [0°, 360°[.
    const span = wrapIndex(dir * (next.angle - key.angle), 360);
    for (let j = 0; j < frames; j++) {
      angles[wrapIndex(key.frame + j, count)] = wrapAngle((key.angle + (dir * span * j) / frames) * RAD);
    }
  });
  return angles;
}

export class LookLoop {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ manifest: object, frames: HTMLImageElement[], face?: object }} sequence  face : voir loadFace()
   * @param {object} [options]
   * @param {number} [options.stiffness]  réactivité du suivi, en 1/s (plus haut = plus vif)
   * @param {number} [options.maxSpeed]   vitesse maximale, en images par seconde
   * @param {number} [options.deadZone]   rayon autour de l'ancre où le curseur est ignoré, en fraction du canvas
   * @param {number} [options.idleDelay]  inactivité avant de « regarder autour » tout seul, en ms (0 = jamais)
   * @param {boolean} [options.trackPointer]  suivre le pointeur ; false pour piloter le regard soi-même via lookAt()
   * @param {number} [options.smoothNear]  lissage de la cible près de l'ancre, en s (quelques pixels y changent beaucoup l'angle)
   * @param {number} [options.smoothFar]   lissage de la cible loin de l'ancre, en s
   * @param {number} [options.spokeHysteresis]  avance angulaire minimale d'un autre rayon pour en changer, en degrés
   * @param {(state: object) => void} [options.onFrame]  appelé à chaque changement d'image ou de mode
   */
  constructor(canvas, { manifest, frames, face = null }, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.manifest = manifest;
    this.frames = frames;
    this.count = frames.length;
    this.face = face;
    this.options = {
      stiffness: 16,
      maxSpeed: 250,
      deadZone: 0.08,
      idleDelay: 6000,
      trackPointer: true,
      smoothNear: 0.2,
      smoothFar: 0.06,
      spokeHysteresis: 15,
      onFrame: null,
      ...options,
    };

    this.buildGraph();
    // Nœud affiché, nœud visé, chemin restant et avancée fractionnaire vers le nœud suivant.
    this.node = 0;
    this.target = 0;
    this.path = [];
    this.progress = 0;
    this.playClock = 0;
    // Cible du regard : position brute (lookAt) et version lissée, en coordonnées client.
    this.aimRaw = null;
    this.aimSmooth = null;
    // Rayon suivi près de la face, conservé tant qu'un autre n'est pas nettement plus proche.
    this.spoke = null;
    this.mode = 'follow';
    this.shown = -1;
    this.lastInput = performance.now();
    this.lastTick = 0;
    this.raf = 0;

    this.setKeys(manifest.keys ?? []);

    this.onPointer = (event) => this.lookAt(event.clientX, event.clientY);
    this.tick = this.tick.bind(this);
    this.resizeObserver = new ResizeObserver(() => this.resize());
  }

  start() {
    this.resizeObserver.observe(this.canvas);
    if (this.options.trackPointer) {
      window.addEventListener('pointermove', this.onPointer, { passive: true });
      window.addEventListener('pointerdown', this.onPointer, { passive: true });
    }
    this.resize();
    this.lastTick = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    window.removeEventListener('pointermove', this.onPointer);
    window.removeEventListener('pointerdown', this.onPointer);
  }

  /**
   * Graphe des images. Nœuds 0…count-1 : la boucle ; puis la face ; puis les images
   * intermédiaires des rayons. Arêtes pondérées par l'écart en images du clip
   * d'origine (un rayon sous-échantillonné avance de `step` images par nœud), pour
   * que la vitesse reste homogène.
   */
  buildGraph() {
    this.images = [...this.frames];
    this.edges = this.frames.map((_, i) => [
      [wrapIndex(i - 1, this.count), 1],
      [wrapIndex(i + 1, this.count), 1],
    ]);
    // Rôle de chaque nœud : { spoke, step } hors boucle.
    this.roles = this.frames.map(() => null);
    if (!this.face) return;

    const link = (a, b, w) => {
      this.edges[a].push([b, w]);
      this.edges[b].push([a, w]);
    };
    this.faceNode = this.images.length;
    this.images.push(this.face.spokes[0].frames[0]);
    this.edges.push([]);
    this.roles.push({ spoke: null, step: 0 });

    this.face.spokes.forEach((spoke, s) => {
      const last = spoke.frames.length - 1;
      spoke.nodes = spoke.frames.map((img, k) => {
        if (k === 0) return this.faceNode;
        if (k === last) return spoke.ring;
        this.images.push(img);
        this.edges.push([]);
        this.roles.push({ spoke: s, step: k });
        return this.images.length - 1;
      });
      spoke.nodes.slice(1).forEach((node, k) => link(spoke.nodes[k], node, this.face.step));
    });
  }

  /** Plus court chemin (Dijkstra) du nœud courant vers `to`, sans le nœud de départ. */
  shortestPath(to) {
    const n = this.images.length;
    const cost = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    cost[this.node] = 0;
    for (;;) {
      let u = -1;
      for (let i = 0; i < n; i++) if (!done[i] && cost[i] < Infinity && (u < 0 || cost[i] < cost[u])) u = i;
      if (u < 0 || u === to) break;
      done[u] = 1;
      for (const [v, w] of this.edges[u]) {
        if (cost[u] + w < cost[v]) {
          cost[v] = cost[u] + w;
          prev[v] = u;
        }
      }
    }
    const path = [];
    for (let v = to; v !== this.node && v >= 0; v = prev[v]) path.unshift(v);
    return path;
  }

  /** Poids de l'arête entre deux nœuds voisins. */
  weight(a, b) {
    return this.edges[a].find(([v]) => v === b)?.[1] ?? 1;
  }

  setTarget(node) {
    if (node === this.target && this.path.length) return;
    this.target = node;
    this.path = node === this.node ? [] : this.shortestPath(node);
  }

  /** Remplace les repères de calibration et recalcule la table angle → image. */
  setKeys(keys) {
    this.keys = keys;
    this.angles = frameAngles({ ...this.manifest, count: this.count, keys });
    this.lookup = new Uint16Array(LOOKUP_BINS);
    for (let b = 0; b < LOOKUP_BINS; b++) {
      const angle = (b / LOOKUP_BINS) * TAU;
      let best = 0;
      for (let i = 1; i < this.count; i++) {
        if (angularDistance(angle, this.angles[i]) < angularDistance(angle, this.angles[best])) best = i;
      }
      this.lookup[b] = best;
    }
  }

  /** Image dont le regard est le plus proche de l'angle donné (radians). */
  frameForAngle(angle) {
    return this.lookup[Math.floor((wrapAngle(angle) / TAU) * LOOKUP_BINS) % LOOKUP_BINS];
  }

  /** Origine du regard (ancre du manifeste) en coordonnées client. */
  anchorPoint() {
    const { x, y, width, height } = this.imageRect();
    const rect = this.canvas.getBoundingClientRect();
    const [ax, ay] = this.manifest.anchor ?? [0.5, 0.5];
    const dpr = this.canvas.width / rect.width || 1;
    return { x: rect.left + (x + ax * width) / dpr, y: rect.top + (y + ay * height) / dpr };
  }

  /** Angle (radians) du point client vu depuis l'ancre. */
  angleTo(clientX, clientY) {
    const anchor = this.anchorPoint();
    return Math.atan2(clientY - anchor.y, clientX - anchor.x);
  }

  /**
   * Oriente le regard vers un point client. Ignoré pendant la calibration. La cible
   * réellement suivie est lissée dans tick() : le regard ne réagit pas à chaque
   * tremblement de la mouche, seulement à ses déplacements.
   */
  lookAt(clientX, clientY) {
    if (this.mode === 'scrub') return;
    this.lastInput = performance.now();
    this.aimRaw = { x: clientX, y: clientY };
    this.aimSmooth ??= { ...this.aimRaw };
    this.setMode('follow');
  }

  /** Lissage exponentiel de la cible, plus fort près de l'ancre. */
  smoothAim(dt) {
    const { smoothNear, smoothFar } = this.options;
    const anchor = this.anchorPoint();
    const rect = this.canvas.getBoundingClientRect();
    const distance = Math.hypot(this.aimRaw.x - anchor.x, this.aimRaw.y - anchor.y) / Math.min(rect.width, rect.height);
    const radius = this.face?.radius ?? this.options.deadZone;
    const near = Math.max(0, 1 - distance / (radius * 2));
    const tau = smoothFar + (smoothNear - smoothFar) * near;
    const k = 1 - Math.exp(-dt / tau);
    this.aimSmooth.x += (this.aimRaw.x - this.aimSmooth.x) * k;
    this.aimSmooth.y += (this.aimRaw.y - this.aimSmooth.y) * k;
    this.aim(this.aimSmooth.x, this.aimSmooth.y);
  }

  /** Choisit le nœud visé pour un point client. */
  aim(clientX, clientY) {
    const anchor = this.anchorPoint();
    const rect = this.canvas.getBoundingClientRect();
    const dx = clientX - anchor.x;
    const dy = clientY - anchor.y;
    const angle = Math.atan2(dy, dx);
    const distance = Math.hypot(dx, dy) / Math.min(rect.width, rect.height);

    if (this.face && distance < this.face.radius) {
      // Près du nez : le long du rayon le plus proche en angle, d'autant plus près
      // de la face que le point est proche.
      const gap = (s) => angularDistance(angle, this.angles[s.ring]);
      const best = this.face.spokes.reduce((a, b) => (gap(b) < gap(a) ? b : a));
      // Hystérésis : on garde le rayon suivi tant qu'un autre ne le bat pas nettement.
      if (!this.spoke || gap(this.spoke) - gap(best) > this.options.spokeHysteresis * RAD) this.spoke = best;
      const k = Math.round((distance / this.face.radius) * (this.spoke.nodes.length - 1));
      this.setTarget(this.spoke.nodes[k]);
    } else if (!this.face && distance < this.options.deadZone) {
      // Trop près de l'ancre, l'angle n'a plus de sens : il basculerait au moindre pixel.
      return;
    } else {
      this.spoke = null;
      this.setTarget(this.frameForAngle(angle));
    }
  }

  /** Laisse le personnage faire le tour du regard, jusqu'au prochain mouvement du curseur. */
  play() {
    this.setMode('play');
  }

  /** Affiche une image précise et suspend le suivi (calibration). */
  scrub(frame) {
    this.node = this.target = wrapIndex(Math.round(frame), this.count);
    this.path = [];
    this.progress = 0;
    this.setMode('scrub');
    this.render(true);
  }

  /** Reprend le suivi du curseur après une calibration. */
  resume() {
    this.lastInput = performance.now();
    this.setMode('follow');
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.notify();
  }

  tick(now) {
    // Plafonné : au retour d'un onglet en arrière-plan, dt vaudrait plusieurs secondes.
    // Le premier horodatage de requestAnimationFrame peut précéder le performance.now() de start().
    const dt = Math.max(0, Math.min(0.05, (now - this.lastTick) / 1000));
    this.lastTick = now;
    const { idleDelay, stiffness, maxSpeed } = this.options;

    if (this.mode === 'follow' && idleDelay > 0 && now - this.lastInput > idleDelay) this.setMode('play');

    if (this.mode === 'play' && this.node < this.count) {
      // Lecture du clip dans son ordre d'origine, à sa cadence : c'est l'animation telle que générée.
      this.playClock += (this.manifest.fps ?? 30) * dt;
      while (this.playClock >= 1) {
        this.playClock -= 1;
        this.node = wrapIndex(this.node + 1, this.count);
      }
      this.target = this.node;
      this.path = [];
    } else if (this.mode !== 'scrub') {
      if (this.mode === 'follow' && this.aimRaw) this.smoothAim(dt);
      // En mode « tour du regard » depuis un rayon : d'abord rejoindre la boucle.
      if (this.mode === 'play' && !this.path.length) this.setTarget(this.face.spokes[this.roles[this.node].spoke ?? 0].ring);
      this.advance(dt, stiffness, maxSpeed);
    }

    this.render();
    this.raf = requestAnimationFrame(this.tick);
  }

  /**
   * Avance le long du chemin : approche exponentielle (amortie en fin de course),
   * bornée par la vitesse maximale (cadence régulière sur les grands trajets).
   */
  advance(dt, stiffness, maxSpeed) {
    if (!this.path.length) {
      this.progress = 0;
      return;
    }
    let remaining = -this.progress;
    let from = this.node;
    for (const node of this.path) {
      remaining += this.weight(from, node);
      from = node;
    }
    this.progress += Math.min(maxSpeed * dt, remaining * (1 - Math.exp(-stiffness * dt)));
    while (this.path.length && this.progress >= this.weight(this.node, this.path[0]) - 0.02) {
      this.progress = Math.max(0, this.progress - this.weight(this.node, this.path[0]));
      this.node = this.path.shift();
    }
  }

  /** Image de la boucle affichée, ou null sur un rayon (ou la face). */
  get frame() {
    return this.node < this.count ? this.node : null;
  }

  /** Angle (radians) et éloignement de la face (0 = face, 1 = boucle) d'un nœud. */
  gaze(node) {
    if (node < this.count) return { angle: this.angles[node], reach: 1 };
    const role = this.roles[node];
    if (role.spoke === null) return { angle: 0, reach: 0 };
    const spoke = this.face.spokes[role.spoke];
    return { angle: this.angles[spoke.ring], reach: role.step / (spoke.nodes.length - 1) };
  }

  /** Zone occupée par l'image dans le canvas (en pixels du canvas), ajustée en « contain ». */
  imageRect() {
    const { width: cw, height: ch } = this.canvas;
    const iw = this.manifest.width ?? this.frames[0].naturalWidth;
    const ih = this.manifest.height ?? this.frames[0].naturalHeight;
    const scale = Math.min(cw / iw, ch / ih);
    const width = iw * scale;
    const height = ih * scale;
    return { x: (cw - width) / 2, y: (ch - height) / 2, width, height };
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.imageSmoothingQuality = 'high';
    this.render(true);
  }

  render(force = false) {
    if (!force && this.node === this.shown) return;
    this.shown = this.node;

    const { x, y, width, height } = this.imageRect();
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.drawImage(this.images[this.node], x, y, width, height);
    this.notify();
  }

  notify() {
    const role = this.roles[this.node];
    const spoke = role && role.spoke !== null ? this.face.spokes[role.spoke] : null;
    this.options.onFrame?.({
      frame: this.frame,
      count: this.count,
      ...this.gaze(this.node),
      target: this.gaze(this.target),
      // Sur un rayon : son nom et la position sur celui-ci ; « face » pour la pose de face.
      spoke: role ? (spoke ? { name: spoke.name, step: role.step, length: spoke.nodes.length - 1 } : 'face') : null,
      mode: this.mode,
    });
  }
}
