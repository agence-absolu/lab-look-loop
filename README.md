# Look loop

Un chat pré-rendu qui suit du regard une mouche, à la place du curseur, à partir de vidéos générées.

Le personnage n'est pas en 3D : c'est un clip pré-rendu (vidéo générée par IA,
rendu 3D…) où il fait **un tour complet du regard**, découpé en images. Chaque
image correspond à un angle ; selon la position du curseur, le lecteur cherche
l'image qui regarde vers lui et s'y rend en parcourant la boucle **par le chemin
le plus court**. Le principe du template « Pouterby » de Scrolltide.

Démo du lab Absolu, publiée sur **https://lab.agence-absolu.com/look-loop/**.

## Développement

```bash
npm install
npm run dev       # http://localhost:5173/look-loop/
npm run build     # compile dans dist/
npm run preview   # prévisualise dist/ sur le même sous-chemin
```

Le site est servi depuis un sous-répertoire du lab : `vite.config.js` déduit la
base des chemins du nom npm (`look-loop`). `BASE_PATH=/ npm run build` pour une
racine de domaine.

## Brancher son propre clip

1. **Le clip** : le personnage fait un tour complet du regard (haut → droite →
   bas → gauche → haut, ou l'inverse), cadrage et lumière fixes, et la dernière
   image se raccorde à la première. Fond uni accordé à la page, ou détouré.
2. **L'extraction** :

   ```bash
   npm run extract -- clips/mon-clip.mp4 public/loops/mon-clip --start-angle=-90
   ```

   `--start-angle` est le regard de la première image (0 = droite, 90 = bas,
   -90 = haut ; le `=` est requis pour une valeur négative), `--ccw` si le regard
   tourne dans le sens antihoraire, `--drop-last` si la dernière image double la
   première, `--every 2` pour alléger. Toutes les options sont en tête de
   `scripts/extract-frames.js`. Un WebM détouré (VP9 avec alpha) donne des
   images transparentes : c'est le cas de `maine-coon`.
3. **L'essai** : `http://localhost:5173/look-loop/?loop=mon-clip` (sans paramètre :
   `maine-coon`, le clip généré avec Magnific).
4. **La calibration** : un clip généré tourne rarement à vitesse constante.
   Dans le panneau Réglages (lil-gui, replié en haut à droite), dossier
   « Calibration » : cocher « Calibrer », faire défiler les images et cliquer sur
   la scène dans la direction du regard, pour quelques images repères. Le JSON
   obtenu se colle dans `manifest.json` (`keys`), et une nouvelle extraction le
   conserve. Régler aussi `anchor` (origine du regard, en fractions de l'image)
   avec la case « Afficher l'ancre du regard », et `background` (couleur du bord
   des images) pour que la page se fonde dans le clip.

Les images sont gardées en `HTMLImageElement` et non en `ImageBitmap` : le
navigateur gère la mémoire décodée, là où 190 bitmaps de 720 px occuperaient
près de 400 Mo.

## Le regard de face

Une boucle ne code qu'une direction, jamais « droit devant ». Le manifeste peut
déclarer des **rayons** (`face.spokes`) : de courtes séquences qui vont de la pose
de face (image 0) à une image de la boucle (`ring`, dernière image). Le lecteur
en fait un graphe (boucle + rayons qui convergent vers la face) :

- dans un rayon de `face.radius` (fraction de la scène) autour de l'ancre, le
  regard descend le long du rayon le plus proche en angle, d'autant plus près de
  la face que la cible est proche du nez ;
- le lecteur suit toujours le plus court chemin du graphe (`face.step` = poids
  d'un pas de rayon) : de gauche à droite, la tête tourne en passant par la face.
- la cible du regard est lissée, fortement près de l'ancre (`smoothNear`), où
  quelques pixels changent beaucoup l'angle, et le rayon suivi ne change que si
  un autre est nettement plus proche (`spokeHysteresis`).

Pour `maine-coon`, 8 rayons (`public/loops/maine-coon-face/`, 33 images chacun),
générés avec Seedance 2.5 :

1. « haut → face » depuis l'image d'origine (= image 0 de la boucle) ; lue à
   l'envers (`--reverse`), c'est le rayon « haut », et sa dernière image donne la
   pose de face ;
2. 7 vidéos « face → direction », première image = la pose de face, dernière =
   l'image exacte de la boucle (extraite de la vidéo de la boucle) ; raccords
   vérifiés à l'image près (43, 66, 89, 112, 127, 149, 163) ;
3. détourage Magnific, puis :

   ```bash
   npm run extract -- sources/maine-coon-face-right-alpha.webm public/loops/maine-coon-face/right --every 3 --shadow-from sources/maine-coon.mp4 --width 1080
   ```

`--shadow-from` (boucle et rayons) récupère l'ombre de contact du chat sur la
vidéo non détourée, et seulement elle.

## La mouche

Le chat ne suit pas le curseur mais une mouche (`src/Fly.js`) qui vole par petites
fusées autour du pointeur, et explore seule les abords du chat quand il
s'immobilise. Le vrai curseur est masqué au-dessus de la scène seulement. Avec
`prefers-reduced-motion`, la mouche suit le pointeur sans fusées ni exploration.

Le sprite (`public/sprites/fly/`, 13 images de 192 px) vient d'un clip généré :
une mouche vue de dessus en vol stationnaire, détourée par Magnific (le flou des
ailes reste semi-transparent), dont on garde un extrait recadré :

```bash
npm run extract -- sources/fly-alpha.webm public/sprites/fly --wings-from sources/fly.mp4 --from 60 --to 84 --every 2 --trim --stabilize --width 192 --fps 24
```

## Publication

`.github/workflows/deploy.yml` compile et envoie `dist/` par rsync sur SSH dans
`lab.agence-absolu.com/lab-projects/look-loop/` à chaque push sur `main` — ou à
la demande, onglet Actions. Le hub sert ce dossier sur `/look-loop/` sans
aucune configuration de son côté.

### 1. Le dépôt

```bash
gh repo create agence-absolu/lab-look-loop --public --source=. --push
```

**Public, obligatoirement** : les secrets SSH sont définis au niveau de
l'organisation `agence-absolu`, et GitHub ne les partage qu'avec les dépôts
publics (limite du plan gratuit). Un dépôt privé verrait son workflow échouer
faute de secrets.

### 2. Les secrets

Rien à créer dans le dépôt : le workflow lit ceux de l'organisation
(Settings de l'organisation › Secrets and variables › Actions).

| Secret | Contenu |
| --- | --- |
| `LAB_SSH_HOST` | hôte SSH Infomaniak (`…ssh.hosting-ik.com`) |
| `LAB_SSH_USER` | compte SSH |
| `LAB_SSH_PASSWORD` | mot de passe |
| `LAB_SSH_KNOWN_HOSTS` | facultatif — sortie de `ssh-keyscan <hôte>`, pour épingler l'empreinte du serveur |

Sans le dernier, le workflow relève l'empreinte du serveur au premier contact
et la croit sur parole. Un secret de dépôt du même nom, s'il en existe un,
prime sur celui de l'organisation.

Pourquoi un mot de passe et pas une clé : chez Infomaniak, l'authentification
par clé n'est pas disponible sur un site Node.js et le port FTP est filtré.

### 3. Pousser

Premier push sur `main` : le workflow compile, envoie, et la démo apparaît sur
la page d'accueil du lab.

## Règles du hub

- le slug (`"name"` de `package.json`) est en minuscules : lettres, chiffres,
  tirets ;
- `index.html` est revalidé à chaque visite, le reste est mis en cache un an —
  les bundles portent une empreinte dans leur nom (Vite le fait) ;
- une URL sans extension qui ne correspond à aucun fichier retombe sur
  `index.html` (routage côté client).
