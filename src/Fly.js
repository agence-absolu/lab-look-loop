// Mouche qui remplace le curseur : un sprite pré-rendu (séquence détourée, ailes
// en mouvement) qui bourdonne autour du pointeur et continue d'explorer seule
// quand il s'immobilise.
//
// Le vol est continu, sans à-coups : un ressort amorti critique (aucun
// dépassement) tire la mouche vers sa cible, et cette cible ondule autour du
// pointeur selon une somme de sinusoïdes de fréquences non multiples — une petite
// trajectoire en huit qui ne se répète jamais exactement.

const TAU = Math.PI * 2;

const random = (min, max) => min + Math.random() * (max - min);

export class Fly {
  /**
   * @param {{ manifest: object, frames: HTMLImageElement[] }} sequence  ailes en boucle, tête vers le haut
   * @param {object} [options]
   * @param {number} [options.size]        taille affichée, en px CSS
   * @param {number} [options.buzz]        amplitude du bourdonnement autour du pointeur, en px
   * @param {number} [options.stiffness]   pulsation du ressort, en rad/s (plus haut = suit de plus près)
   * @param {number} [options.maxSpeed]    vitesse max, en px/s
   * @param {number} [options.turnDistance]  déplacement minimal avant de changer de cap, en px
   * @param {number} [options.roamStep]    longueur max d'une étape d'exploration, en px
   * @param {number} [options.roamSpeed]   vitesse d'exploration, en px/s
   * @param {number} [options.idleDelay]   immobilité du pointeur avant l'exploration, en ms
   * @param {() => DOMRect} [options.roam] zone explorée quand le pointeur est immobile
   * @param {boolean} [options.calm]       suivi direct, sans bourdonnement ni exploration (prefers-reduced-motion)
   * @param {(x: number, y: number) => void} [options.onMove]  position client, à chaque image
   */
  constructor({ manifest, frames }, options = {}) {
    this.manifest = manifest;
    this.frames = frames;
    this.options = {
      size: 50,
      buzz: 24,
      stiffness: 16,
      maxSpeed: 1100,
      turnDistance: 40,
      roamStep: 90,
      roamSpeed: 70,
      idleDelay: 2500,
      roam: null,
      calm: false,
      onMove: null,
      ...options,
    };

    this.x = innerWidth / 2;
    this.y = innerHeight / 2;
    this.vx = 0;
    this.vy = 0;
    this.heading = -Math.PI / 2;
    this.headingGoal = this.heading;
    // Position au dernier changement de cap : on ne se réoriente qu'après s'en être assez éloigné.
    this.headingFrom = { x: this.x, y: this.y };
    this.pointer = null;
    this.lastPointer = 0;
    // Exploration : point qui glisse lentement vers une étape, elle-même tirée au hasard.
    this.roamPoint = null;
    this.roamGoal = null;
    this.phases = Array.from({ length: 4 }, () => random(0, TAU));
    this.time = 0;
    this.frame = 0;
    this.lastTick = 0;
    this.raf = 0;

    // Canvas plus grand que la mouche : elle y est dessinée tournée, et l'ombre
    // portée (filtre CSS du canvas, lui non tourné) reste toujours vers le bas.
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.box = Math.ceil(this.options.size * 1.5);
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'fly';
    this.canvas.width = this.canvas.height = Math.round(this.box * dpr);
    this.canvas.style.inlineSize = this.canvas.style.blockSize = `${this.box}px`;
    this.canvas.setAttribute('aria-hidden', 'true');
    this.ctx = this.canvas.getContext('2d');
    this.ctx.scale(dpr, dpr);

    this.onPointer = (event) => {
      this.pointer = { x: event.clientX, y: event.clientY };
      this.lastPointer = performance.now();
      this.roamPoint = null;
    };
    this.tick = this.tick.bind(this);
  }

  start(parent = document.body) {
    parent.append(this.canvas);
    window.addEventListener('pointermove', this.onPointer, { passive: true });
    window.addEventListener('pointerdown', this.onPointer, { passive: true });
    this.lastTick = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.canvas.remove();
    window.removeEventListener('pointermove', this.onPointer);
    window.removeEventListener('pointerdown', this.onPointer);
  }

  /** Centre du bourdonnement : le pointeur, ou le point d'exploration s'il est immobile. */
  anchor(now, dt) {
    const { roam, idleDelay, calm, roamStep, roamSpeed } = this.options;
    const idle = !this.pointer || now - this.lastPointer > idleDelay;
    if (!idle || !roam || calm) return this.pointer ?? { x: this.x, y: this.y };

    const bounds = roam();
    this.roamPoint ??= { x: this.x, y: this.y };
    const dx = (this.roamGoal?.x ?? 0) - this.roamPoint.x;
    const dy = (this.roamGoal?.y ?? 0) - this.roamPoint.y;
    const distance = Math.hypot(dx, dy);
    if (!this.roamGoal || distance < 4) {
      const angle = random(0, TAU);
      const step = random(0.4, 1) * roamStep;
      this.roamGoal = {
        x: Math.min(Math.max(this.roamPoint.x + Math.cos(angle) * step, bounds.left), bounds.right),
        y: Math.min(Math.max(this.roamPoint.y + Math.sin(angle) * step, bounds.top), bounds.bottom),
      };
    } else {
      const move = Math.min(distance, roamSpeed * dt);
      this.roamPoint.x += (dx / distance) * move;
      this.roamPoint.y += (dy / distance) * move;
    }
    return this.roamPoint;
  }

  tick(now) {
    // Le premier horodatage de requestAnimationFrame peut précéder le performance.now() de start().
    const dt = Math.max(0, Math.min(0.05, (now - this.lastTick) / 1000));
    this.lastTick = now;
    this.time += dt;
    const { calm, buzz, stiffness, maxSpeed } = this.options;

    // Cible : centre + bourdonnement en courbes douces.
    const center = this.anchor(now, dt);
    const [a, b, c, d] = this.phases;
    const t = this.time;
    const amplitude = calm ? 0 : buzz;
    // Fréquences basses (0,45 à 1,4 Hz) : une dérive souple, pas un tremblement.
    const tx = center.x + amplitude * (0.7 * Math.sin(TAU * 0.45 * t + a) + 0.3 * Math.sin(TAU * 1.1 * t + b));
    const ty = center.y + amplitude * (0.7 * Math.sin(TAU * 0.6 * t + c) + 0.3 * Math.sin(TAU * 1.4 * t + d));

    // Ressort amorti critique : rejoint la cible au plus vite sans la dépasser.
    const omega = calm ? 10 : stiffness;
    this.vx += (omega * omega * (tx - this.x) - 2 * omega * this.vx) * dt;
    this.vy += (omega * omega * (ty - this.y) - 2 * omega * this.vy) * dt;
    const speed = Math.hypot(this.vx, this.vy);
    if (speed > maxSpeed) {
      this.vx *= maxSpeed / speed;
      this.vy *= maxSpeed / speed;
    }
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // Cap : la mouche ne se réoriente qu'après un vrai déplacement (turnDistance),
    // dans la direction de ce déplacement ; le bourdonnement sur place ne la fait pas
    // tourner. La rotation vers le nouveau cap est progressive.
    const moved = Math.hypot(this.x - this.headingFrom.x, this.y - this.headingFrom.y);
    if (moved >= this.options.turnDistance) {
      this.headingGoal = Math.atan2(this.y - this.headingFrom.y, this.x - this.headingFrom.x);
      this.headingFrom = { x: this.x, y: this.y };
    }
    const delta = ((((this.headingGoal - this.heading + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
    this.heading += delta * (1 - Math.exp(-6 * dt));

    this.frame = (this.frame + (this.manifest.fps ?? 30) * dt) % this.frames.length;
    this.render();
    this.options.onMove?.(this.x, this.y);
    this.raf = requestAnimationFrame(this.tick);
  }

  render() {
    const { size } = this.options;
    const half = this.box / 2;
    this.canvas.style.translate = `${(this.x - half).toFixed(1)}px ${(this.y - half).toFixed(1)}px`;

    const img = this.frames[Math.floor(this.frame)];
    const ratio = img.naturalHeight / img.naturalWidth;
    this.ctx.clearRect(0, 0, this.box, this.box);
    this.ctx.save();
    this.ctx.translate(half, half);
    // Le sprite regarde vers le haut (-90°).
    this.ctx.rotate(this.heading + Math.PI / 2);
    this.ctx.drawImage(img, -size / 2, (-size * ratio) / 2, size, size * ratio);
    this.ctx.restore();
  }
}
