import './style.css';
import GUI from 'lil-gui';
import { Fly } from './Fly.js';
import { LookLoop, loadFace, loadSequence } from './LookLoop.js';

// ?loop=<nom> charge public/loops/<nom>/ : pratique pour essayer un clip extrait
// sans toucher au code.
const loopName = new URLSearchParams(location.search).get('loop') || 'maine-coon';
const manifestUrl = `${import.meta.env.BASE_URL}loops/${loopName}/manifest.json`;
const flyUrl = `${import.meta.env.BASE_URL}sprites/fly/manifest.json`;

const $ = (selector) => document.querySelector(selector);
const stage = $('[data-stage]');
const anchorDot = $('[data-anchor]');

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const DIRECTIONS = ['droite', 'bas-droite', 'bas', 'bas-gauche', 'gauche', 'haut-gauche', 'haut', 'haut-droite'];
const MODES = { follow: 'Suivi du curseur', fly: 'Suivi de la mouche', play: 'Tour du regard', scrub: 'Calibration' };

const toDegrees = (rad) => (rad * 180) / Math.PI;
const direction = (rad) => DIRECTIONS[((Math.round(toDegrees(rad) / 45) % 8) + 8) % 8];

let player;
let fly = null;
let keys = [];

// État affiché et piloté par le panneau lil-gui (replié par défaut).
const state = {
  regard: '—',
  image: '—',
  mode: '—',
  // Le regard suit la mouche plutôt que le pointeur.
  fly: true,
  anchor: false,
  calibrate: false,
  frame: 0,
  keysLabel: '',
};

try {
  const [sequence, flySequence] = await Promise.all([
    loadSequence(manifestUrl, (ratio) => {
      $('[data-progress]').style.inlineSize = `${ratio * 100}%`;
    }),
    // Sans sprite, la démo retombe sur le pointeur.
    loadSequence(flyUrl).catch((error) => {
      console.warn(error);
      return null;
    }),
  ]);
  // Regard de face : rayons déclarés par le manifeste, chargés après la boucle.
  $('[data-loader-text]').textContent = 'Chargement du regard de face…';
  sequence.face = await loadFace(manifestUrl, sequence.manifest, (ratio) => {
    $('[data-progress]').style.inlineSize = `${ratio * 100}%`;
  });
  keys = [...(sequence.manifest.keys ?? [])];
  // Couleur du bord des images du clip, pour que la scène se fonde dans la page.
  if (sequence.manifest.background) {
    document.documentElement.style.setProperty('--bg', sequence.manifest.background);
    stage.classList.add('is-opaque');
  }

  player = new LookLoop($('[data-canvas]'), sequence, {
    // Pas d'animation spontanée pour qui l'a désactivée ; le suivi, déclenché par
    // l'utilisateur, reste actif.
    idleDelay: reducedMotion ? 0 : 6000,
    // Le regard est piloté ici : par la mouche, ou par le pointeur.
    trackPointer: false,
    onFrame: updateReadout,
  });

  if (flySequence) {
    fly = new Fly(flySequence, {
      calm: reducedMotion,
      // Pointeur immobile : la mouche explore les abords du chat.
      roam: () => {
        const rect = stage.getBoundingClientRect();
        const margin = rect.width * 0.15;
        return new DOMRect(rect.left - margin, rect.top - margin, rect.width + margin * 2, rect.height * 0.8 + margin);
      },
      onMove: (x, y) => state.fly && player.lookAt(x, y),
    });
    fly.start();
  } else {
    state.fly = false;
  }
  // Démo : la mouche remplace le curseur natif partout (sauf sur le panneau lil-gui).
  document.body.classList.toggle('has-fly', state.fly);

  const onPointer = (event) => {
    if (!state.fly) player.lookAt(event.clientX, event.clientY);
  };
  window.addEventListener('pointermove', onPointer, { passive: true });
  window.addEventListener('pointerdown', onPointer, { passive: true });

  bindControls();
  buildGui();
  player.start();

  $('[data-loader]').hidden = true;
} catch (error) {
  $('[data-loader-text]').textContent = error.message;
  throw error;
}

function updateReadout({ frame, count, angle, spoke, mode }) {
  if (spoke === 'face') {
    state.regard = 'de face';
    state.image = 'face';
  } else if (spoke) {
    state.regard = `${direction(angle)} · vers la face`;
    state.image = `rayon ${spoke.name} ${spoke.step} / ${spoke.length}`;
  } else {
    state.regard = `${direction(angle)} · ${Math.round(toDegrees(angle))}°`;
    state.image = `${String(frame).padStart(String(count - 1).length, '0')} / ${count}`;
  }
  state.mode = MODES[mode === 'follow' && state.fly ? 'fly' : mode];
  if (mode === 'scrub') state.frame = frame;
  if (!anchorDot.hidden) placeAnchor();
}

function placeAnchor() {
  const rect = stage.getBoundingClientRect();
  const { x, y } = player.anchorPoint();
  anchorDot.style.translate = `${x - rect.left}px ${y - rect.top}px`;
}

function bindControls() {
  window.addEventListener('resize', () => !anchorDot.hidden && placeAnchor());

  // Un clic sur la scène pendant la calibration = « l'image courante regarde par là ».
  stage.addEventListener('click', (event) => {
    if (!state.calibrate) return;
    const angle = Math.round(toDegrees(player.angleTo(event.clientX, event.clientY)));
    keys = [...keys.filter((key) => key.frame !== player.frame), { frame: player.frame, angle }].sort((a, b) => a.frame - b.frame);
    applyKeys();
  });
}

function buildGui() {
  const gui = new GUI({ title: 'Réglages' });
  gui.close();

  const reading = gui.addFolder('Lecture');
  reading.add(state, 'regard').name('Regard').disable().listen();
  reading.add(state, 'image').name('Image').disable().listen();
  reading.add(state, 'mode').name('Mode').disable().listen();

  const motion = gui.addFolder('Mouvement');
  motion.add(player.options, 'stiffness', 2, 30, 1).name('Réactivité (1/s)');
  motion.add(player.options, 'maxSpeed', 20, 300, 10).name('Vitesse max (img/s)');
  motion.add(player.options, 'idleDelay', 0, 15000, 1000).name('Tour du regard après (ms)');
  if (fly) {
    motion
      .add(state, 'fly')
      .name('Mouche à la place du curseur')
      .onChange((on) => {
        fly.canvas.hidden = !on || state.calibrate;
        document.body.classList.toggle('has-fly', on && !state.calibrate);
      });
  }
  motion
    .add(state, 'anchor')
    .name('Afficher l’ancre du regard')
    .onChange((on) => {
      anchorDot.hidden = !on;
      if (on) placeAnchor();
    });

  const calibration = gui.addFolder('Calibration');
  calibration.close();
  calibration
    .add(state, 'calibrate')
    .name('Calibrer (clic sur la scène)')
    .onChange((on) => {
      stage.classList.toggle('is-calibrating', on);
      // Calibration : mouche masquée, curseur natif de retour pour viser.
      if (fly) fly.canvas.hidden = on || !state.fly;
      document.body.classList.toggle('has-fly', state.fly && !on);
      if (on) player.scrub(state.frame);
      else player.resume();
    });
  calibration
    .add(state, 'frame', 0, player.count - 1, 1)
    .name('Image de la boucle')
    .listen()
    .onChange((frame) => state.calibrate && player.scrub(frame));
  calibration.add(state, 'keysLabel').name('Repères').disable().listen();
  calibration
    .add({ copy: () => navigator.clipboard.writeText(`"keys": ${JSON.stringify(keys)}`) }, 'copy')
    .name('Copier les repères (JSON)');
  calibration
    .add(
      {
        clear: () => {
          keys = [];
          applyKeys();
        },
      },
      'clear',
    )
    .name('Effacer les repères');

  renderKeys();
}

function applyKeys() {
  player.setKeys(keys);
  renderKeys();
  if (state.calibrate) player.scrub(player.frame);
}

function renderKeys() {
  state.keysLabel = keys.length ? `${keys.length} repères` : 'aucun (rotation régulière)';
}
