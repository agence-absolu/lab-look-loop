// Découpe un clip « tour du regard » (vidéo générée par IA, rendu 3D…) en une
// séquence WebP lisible par LookLoop, et écrit le manifest.json qui la décrit.
//
//   node scripts/extract-frames.js <vidéo> <dossier> [options]
//
//   --width <px>          largeur des images (défaut 720, hauteur proportionnelle)
//   --quality <0-100>     qualité WebP (défaut 82)
//   --every <n>           ne garder qu'une image sur n (défaut 1)
//   --drop-last           retirer la dernière image si elle double la première
//   --start-angle=<deg>   regard de l'image 0 (0 = droite, 90 = bas, -90 = haut ;
//                         le « = » est requis pour une valeur négative)
//   --ccw                 le regard tourne dans le sens antihoraire
//   --anchor <x,y>        origine du regard dans l'image, en fractions (défaut 0.5,0.45)
//   --fps <n>             cadence de lecture en mode « regarder autour »
//   --from <n>, --to <n>  ne garder que les images n° from à to (incluses) de la vidéo
//   --reverse             inverser l'ordre des images
//   --trim                recadrer, en carré centré, sur la zone non transparente
//                         commune à toutes les images (sprite détouré)
//   --stabilize           avec --trim : recaler chaque image sur le centre de sa
//                         partie opaque (supprime la dérive du sujet dans le clip)
//   --wings-from <vidéo>  la même vidéo, non détourée, sur fond blanc : le flou clair
//                         que le détourage a jeté (ailes en mouvement) y est récupéré
//                         par « blanc → transparence » et ajouté, teinté en blanc
//   --shadow-from <vidéo> la même vidéo, non détourée : l'ombre de contact sous le
//                         sujet (et elle seule) y est mesurée sur la première image
//                         retenue, puis placée sous chaque image détourée
//   --shadow-top <0-1>    hauteur où commence le sol, en fraction (défaut 0.75)
//   --lift <0-1>          éclaircir et renforcer les zones semi-transparentes (ailes
//                         floues) pour qu'elles restent visibles sur un fond sombre
//
// Une vidéo WebM détourée (VP8/VP9 avec alpha) donne des WebP transparents.
//
// Un manifest.json existant est conservé et seulement complété : les repères de
// calibration (keys) relevés dans la démo ne sont pas perdus si l'on réextrait.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import sharp from 'sharp';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    width: { type: 'string', default: '720' },
    quality: { type: 'string', default: '82' },
    every: { type: 'string', default: '1' },
    'drop-last': { type: 'boolean', default: false },
    'start-angle': { type: 'string' },
    ccw: { type: 'boolean' },
    anchor: { type: 'string' },
    fps: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    trim: { type: 'boolean', default: false },
    reverse: { type: 'boolean', default: false },
    stabilize: { type: 'boolean', default: false },
    lift: { type: 'string' },
    'wings-from': { type: 'string' },
    'shadow-from': { type: 'string' },
    'shadow-top': { type: 'string', default: '0.75' },
  },
});

const [video, outDir] = positionals;
if (!video || !outDir) {
  console.error('Usage : node scripts/extract-frames.js <vidéo> <dossier> [options]');
  process.exit(1);
}

const every = Math.max(1, Number(values.every));
const tmp = mkdtempSync(join(tmpdir(), 'look-loop-frames-'));

try {
  // Le décodeur VP8/VP9 natif de ffmpeg ignore la couche alpha d'un WebM détouré :
  // libvpx la restitue.
  const codec = execFileSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', video],
    { encoding: 'utf8' },
  ).trim();
  const decoder = { vp9: ['-c:v', 'libvpx-vp9'], vp8: ['-c:v', 'libvpx'] }[codec] ?? [];

  const from = Number(values.from ?? 0);
  const to = values.to !== undefined ? Number(values.to) : Infinity;
  const select = [`gte(n\\,${from})`, Number.isFinite(to) ? `lte(n\\,${to})` : '', `not(mod(n-${from}\\,${every}))`]
    .filter(Boolean)
    .join('*');

  // PNG intermédiaires : le ffmpeg de Homebrew n'embarque pas toujours libwebp,
  // sharp se charge de l'encodage. Avec --trim, l'image reste en pleine
  // résolution jusqu'au recadrage.
  const scale = values.trim ? '' : `,scale=${values.width}:-2:flags=lanczos`;
  const extract = (input, args, dir) => {
    mkdirSync(dir, { recursive: true });
    execFileSync(
      'ffmpeg',
      ['-v', 'error', ...args, '-i', input, '-vf', `select='${select}'${values.reverse ? ',reverse' : ''}${scale}`,
        '-fps_mode', 'passthrough', '-start_number', '0', join(dir, '%04d.png')],
      { stdio: 'inherit' },
    );
    return readdirSync(dir).filter((name) => name.endsWith('.png')).sort();
  };

  const sources = extract(video, decoder, tmp);
  if (values['wings-from']) {
    const whites = extract(values['wings-from'], [], join(tmp, 'white'));
    await Promise.all(sources.map((name, i) => addWings(join(tmp, name), join(tmp, 'white', whites[i]))));
  }
  if (values['shadow-from']) {
    const [plate] = extract(values['shadow-from'], [], join(tmp, 'plate'));
    const shadow = await contactShadow(join(tmp, sources[0]), join(tmp, 'plate', plate), Number(values['shadow-top']));
    await Promise.all(sources.map((name) => underlay(join(tmp, name), shadow)));
  }
  if (values['drop-last']) sources.pop();
  if (!sources.length) throw new Error('Aucune image extraite.');

  const previousPath = join(outDir, 'manifest.json');
  const previous = existsSync(previousPath) ? JSON.parse(readFileSync(previousPath, 'utf8')) : {};

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const paths = sources.map((name) => join(tmp, name));
  const crop = values.trim ? await opaqueSquare(paths) : null;
  const crops = crop && values.stabilize ? await stabilizedCrops(paths, crop) : paths.map(() => crop);

  const pad = String(sources.length - 1).length;
  const output = (i) => join(outDir, `${String(i).padStart(pad, '0')}.webp`);
  for (let i = 0; i < sources.length; i += 8) {
    await Promise.all(
      sources.slice(i, i + 8).map((name, k) => {
        let image = sharp(join(tmp, name));
        if (crop) image = image.extract(crops[i + k]).resize(Number(values.width), Number(values.width));
        if (values.lift) image = liftTranslucent(image, Number(values.lift));
        return Promise.resolve(image).then((img) => img.webp({ quality: Number(values.quality), alphaQuality: 100 }).toFile(output(i + k)));
      }),
    );
  }

  const { width, height } = await sharp(output(0)).metadata();
  const manifest = {
    // Les champs ajoutés à la main (background…) survivent à une nouvelle extraction.
    ...previous,
    count: sources.length,
    pattern: '{n}.webp',
    pad,
    width,
    height,
    fps: values.fps ? Number(values.fps) : (previous.fps ?? 30),
    startAngle: values['start-angle'] !== undefined ? Number(values['start-angle']) : (previous.startAngle ?? 0),
    clockwise: values.ccw !== undefined ? !values.ccw : (previous.clockwise ?? true),
    anchor: values.anchor ? values.anchor.split(',').map(Number) : (previous.anchor ?? [0.5, 0.45]),
    keys: previous.count === sources.length ? (previous.keys ?? []) : [],
  };
  writeFileSync(previousPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`✔ ${sources.length} images ${width}×${height} → ${outDir}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

/**
 * Éclaircit et renforce les pixels semi-transparents, d'autant plus qu'ils sont
 * transparents : le flou des ailes ressort, le corps opaque reste intact.
 */
async function liftTranslucent(image, amount) {
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    // Pixels quasi vides (bruit du détourage) : on n'y touche pas.
    if (a < 0.02) continue;
    // Seulement les zones claires : le flou des ailes est clair, les bords des pattes sont sombres.
    const luma = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    const light = Math.min(1, Math.max(0, (luma - 0.3) / 0.25));
    const weight = amount * light * Math.min(1, Math.max(0, (0.9 - a) / 0.9));
    data[i + 3] = Math.round(255 * (a + weight * (Math.min(0.85, a * 4) - a)));
    for (let c = 0; c < 3; c++) data[i + c] = Math.round(data[i + c] + weight * 0.65 * (255 - data[i + c]));
  }
  return sharp(data, { raw: info });
}

/**
 * Ajoute au détourage le flou clair visible sur la version fond blanc : alpha
 * « blanc → transparence » (écart au blanc du fond, mesuré ligne par ligne sur
 * les bords), teinté en blanc. Le sujet détouré reste prioritaire.
 */
async function addWings(cutoutPath, whitePath) {
  const cut = await sharp(cutoutPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const white = await sharp(whitePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = cut.info;
  const luma = (i) => 0.2126 * white.data[i] + 0.7152 * white.data[i + 1] + 0.0722 * white.data[i + 2];
  const edge = Math.round(width * 0.06);

  // Pointe de l'abdomen (sujet opaque le plus bas sur l'axe central, sans les
  // pattes) : en dessous, le flou est l'ombre portée sur le fond, pas les ailes.
  // Il s'efface progressivement à partir de là.
  let [sx, n] = [0, 0];
  for (let i = 0; i < width * height; i++) {
    if (cut.data[i * 4 + 3] > 220) {
      sx += i % width;
      n++;
    }
  }
  const axis = sx / n;
  const band = width * 0.03;
  let bottom = 0;
  for (let y = 0; y < height; y++) {
    for (let x = Math.round(axis - band); x <= axis + band; x++) {
      if (cut.data[(y * width + x) * 4 + 3] > 220) bottom = y;
    }
  }
  const fade = height * 0.08;

  for (let y = 0; y < height; y++) {
    // Fond de la ligne : moyenne de ses deux bords (le fond n'est pas d'un blanc uniforme).
    let background = 0;
    for (let x = 0; x < edge; x++) background += luma((y * width + x) * 3) + luma((y * width + width - 1 - x) * 3);
    background /= edge * 2;

    for (let x = 0; x < width; x++) {
      const w = (y * width + x) * 3;
      const c = (y * width + x) * 4;
      // Écart au fond : 0 sur le fond, 1 à 27 % plus sombre ; on écarte le bruit.
      let wing = (background - luma(w)) / (background * 0.27);
      wing = wing < 0.08 ? 0 : Math.min(1, wing) * 0.75;
      wing *= Math.min(1, Math.max(0, 1 - (y - bottom) / fade));
      const subject = cut.data[c + 3] / 255;
      if (wing <= subject) continue;
      // Couleur : celle du sujet là où il y en a un peu, blanc cassé sinon.
      const mix = subject / wing;
      for (let k = 0; k < 3; k++) cut.data[c + k] = Math.round(cut.data[c + k] * mix + 236 * (1 - mix));
      cut.data[c + 3] = Math.round(wing * 255);
    }
  }
  await sharp(cut.data, { raw: cut.info }).png().toFile(cutoutPath);
}

/**
 * Ombre de contact : sur l'image non détourée, ce qui est plus sombre que le sol
 * « vide ». Le sol vide est une surface quadratique en (x, y) ajustée sur tout le
 * sol, hors d'une ellipse autour des pattes : sous le sujet, elle est encadrée par
 * les côtés et par le premier plan. Seule la zone sous le sujet est gardée, avec
 * des fondus. Retourne un calque alpha (noir).
 */
async function contactShadow(cutoutPath, platePath, top) {
  const cut = await sharp(cutoutPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const plate = await sharp(platePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = cut.info;
  const luma = (i) => 0.2126 * plate.data[i] + 0.7152 * plate.data[i + 1] + 0.0722 * plate.data[i + 2];
  const smooth = (e0, e1, v) => Math.min(1, Math.max(0, (v - e0) / (e1 - e0)));

  // Axe, largeur et bas (pattes) du sujet, d'après le détourage.
  let [left, right, bottom] = [width, 0, 0];
  for (let i = 0; i < width * height; i++) {
    if (cut.data[i * 4 + 3] > 128) {
      left = Math.min(left, i % width);
      right = Math.max(right, i % width);
      bottom = Math.max(bottom, Math.floor(i / width));
    }
  }
  const axis = (left + right) / 2;
  const half = (right - left) / 2;
  const [rx, ry, cy] = [half * 1.8, height * 0.13, bottom - height * 0.04];
  const inShadowZone = (x, y) => ((x - axis) / rx) ** 2 + ((y - cy) / ry) ** 2 < 1;

  // Moindres carrés : L = Σ p_k · φ_k(u, v), φ = [1, u, v, u², v², uv].
  const y0 = Math.round(height * top);
  const basis = (x, y) => {
    const u = (x - axis) / width;
    const v = (y - y0) / height;
    return [1, u, v, u * u, v * v, u * v];
  };
  const m = Array.from({ length: 6 }, () => new Array(6).fill(0));
  const rhs = new Array(6).fill(0);
  for (let y = y0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      if (inShadowZone(x, y) || cut.data[(y * width + x) * 4 + 3] > 8) continue;
      const phi = basis(x, y);
      const l = luma((y * width + x) * 3);
      for (let r = 0; r < 6; r++) {
        rhs[r] += phi[r] * l;
        for (let c = 0; c < 6; c++) m[r][c] += phi[r] * phi[c];
      }
    }
  }
  const p = solve(m, rhs);

  // Proximité du sujet : son détourage, très flouté. Une ombre de contact colle au
  // sujet ; plus loin, un écart au sol estimé n'est qu'une erreur d'ajustement.
  const mask = Buffer.alloc(width * height);
  for (let i = 0; i < width * height; i++) mask[i] = cut.data[i * 4 + 3] > 128 ? 255 : 0;
  const near = await sharp(mask, { raw: { width, height, channels: 1 } }).blur(70).extractChannel(0).raw().toBuffer();

  const alpha = new Uint8Array(width * height);
  for (let y = y0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const floor = basis(x, y).reduce((sum, phi, k) => sum + phi * p[k], 0);
      const darkening = (floor - luma((y * width + x) * 3)) / floor;
      const zone = (1 - smooth(0.7, 1.4, Math.hypot((x - axis) / rx, (y - cy) / ry))) * smooth(0.02, 0.15, near[y * width + x] / 255);
      const topFade = smooth(y0, y0 + height * 0.05, y);
      alpha[y * width + x] = Math.round(255 * Math.min(0.8, Math.max(0, (darkening - 0.06) * 3)) * zone * topFade);
    }
  }
  // Lissage : l'ombre est douce, le bruit de la vidéo ne doit pas y apparaître.
  // extractChannel : sans lui, sharp rend un calque à un canal en RVB (3 canaux).
  const blurred = await sharp(Buffer.from(alpha), { raw: { width, height, channels: 1 } })
    .blur(4)
    .extractChannel(0)
    .raw()
    .toBuffer();
  return { width, height, alpha: Float32Array.from(blurred, (a) => a / 255) };
}

/** Résout m·x = v (pivot de Gauss) — ajustement de la surface du sol. */
function solve(m, v) {
  const n = v.length;
  const a = m.map((row, r) => [...row, v[r]]);
  for (let col = 0; col < n; col++) {
    const pivot = a.slice(col).reduce((best, row, k) => (Math.abs(row[col]) > Math.abs(a[best][col]) ? col + k : best), col);
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col] / a[col][col];
      for (let c = col; c <= n; c++) a[r][c] -= f * a[col][c];
    }
  }
  return a.map((row, r) => row[n] / row[r]);
}

/** Place le calque d'ombre (noir) sous une image détourée. */
async function underlay(path, shadow) {
  const img = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < shadow.width * shadow.height; i++) {
    const a = img.data[i * 4 + 3] / 255;
    const s = shadow.alpha[i];
    const out = a + s * (1 - a);
    if (out <= 0) continue;
    for (let k = 0; k < 3; k++) img.data[i * 4 + k] = Math.round((img.data[i * 4 + k] * a) / out);
    img.data[i * 4 + 3] = Math.round(out * 255);
  }
  await sharp(img.data, { raw: img.info }).png().toFile(path);
}

/** Centre de la partie franchement opaque d'une image (le corps, pas le flou des ailes). */
async function opaqueCentroid(path) {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let [sx, sy, n] = [0, 0, 0];
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3] > 220) {
        sx += x;
        sy += y;
        n++;
      }
    }
  }
  return { x: sx / n, y: sy / n, width: info.width, height: info.height };
}

/** Un cadrage par image, décalé pour que le centre du corps reste immobile. */
async function stabilizedCrops(paths, crop) {
  const centers = await Promise.all(paths.map(opaqueCentroid));
  const mean = {
    x: centers.reduce((sum, c) => sum + c.x, 0) / centers.length,
    y: centers.reduce((sum, c) => sum + c.y, 0) / centers.length,
  };
  return centers.map((c) => ({
    ...crop,
    left: Math.round(Math.max(0, Math.min(crop.left + c.x - mean.x, c.width - crop.width))),
    top: Math.round(Math.max(0, Math.min(crop.top + c.y - mean.y, c.height - crop.height))),
  }));
}

/**
 * Carré qui contient la partie non transparente de toutes les images, centré sur
 * le centre de cette zone (le sprite pivote autour de son centre), avec une marge.
 */
async function opaqueSquare(paths) {
  let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
  let size;
  for (const path of paths) {
    const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    size = info;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        if (data[(y * info.width + x) * 4 + 3] > 8) {
          left = Math.min(left, x);
          right = Math.max(right, x);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
      }
    }
  }
  if (!Number.isFinite(left)) throw new Error('--trim : images entièrement transparentes.');

  const side = Math.min(Math.max(right - left, bottom - top) * 1.08, size.width, size.height);
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  const clamp = (v, max) => Math.round(Math.max(0, Math.min(v, max - side)));
  return { left: clamp(cx - side / 2, size.width), top: clamp(cy - side / 2, size.height), width: Math.round(side), height: Math.round(side) };
}
