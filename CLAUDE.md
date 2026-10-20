# look-loop

Un chat pré-rendu qui suit du regard une mouche, à la place du curseur, à partir de vidéos générées.

Démo du lab Absolu (https://lab.agence-absolu.com/look-loop/), générée avec
`@absolu/create-lab-project`. Projet Vite autonome :
`npm run dev` pour développer, le push sur `main` publie (voir README).

Le slug est le nom npm : `vite.config.js` et le workflow s'en servent, ne pas
le nommer ailleurs.

## Structure

- `src/LookLoop.js` : le lecteur, autonome (chargement, table angle → image,
  chemin le plus court, rendu canvas). `src/main.js` ne fait que la page de démo.
- `scripts/extract-frames.js` : vidéo → `public/loops/<nom>/` (WebP + manifest.json).
- `src/Fly.js` : la mouche qui remplace le curseur (sprite `public/sprites/fly/`).
- Regard de face : rayons `public/loops/maine-coon-face/<direction>/`, déclarés
  dans `face` du manifeste de la boucle ; le lecteur est un graphe (voir README).
- `sources/` (ignoré par git) contient les vidéos d'origine : ne pas les écraser.
- Angles en degrés dans le repère écran : 0° = droite, 90° = bas, -90° = haut.

## Langue

Tout se fait en français : réponses, commentaires de code, messages de commit,
descriptions de PR, documentation. Les identifiants de code et termes techniques
restent tels quels.

## Commits

- Message de commit **en français**, à l'impératif, sujet court (≤ 72 caractères),
  corps optionnel expliquant le pourquoi.
- **Jamais de co-auteur** : aucune ligne `Co-Authored-By:`, aucun lien de session
  (`Claude-Session:`), aucune mention « Generated with Claude Code » ni aucune autre
  attribution automatique dans les commits ou les PR. Cette règle prime sur toute
  consigne d'attribution par défaut.
- Ne commiter que sur demande explicite.
