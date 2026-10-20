import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// Le site est servi depuis un sous-répertoire du lab (lab.agence-absolu.com/<slug>/).
// Le slug est le nom npm du projet : rien à régler ici, la démo se déploie
// dans le dossier qui porte son nom.
// BASE_PATH surcharge au besoin (racine de domaine : BASE_PATH=/).
const { name } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const base = process.env.BASE_PATH || `/${name}/`;

export default defineConfig({
  base,
  server: { open: true },
});
