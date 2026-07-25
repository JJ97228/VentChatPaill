# Version test statique — vent Vauclin (GitHub Pages + Actions)

Ce dossier est une **copie de test isolée**, indépendante du site Heroku de production. Il ne remplace rien : Heroku continue de tourner tel quel tant que vous ne décidez pas explicitement de basculer.

## Ce qui a changé par rapport à la version Heroku

- `routes/api.cjs` et `server.cjs` (Express) supprimés : plus de serveur qui tourne en continu.
- `public/vent.js` : lit désormais directement `data/dico.json` / `dico2.json` / `dico3.json` au lieu d'appeler `/api/update`. Le calcul du bandeau "données manquantes" (seuil 37 min) est repris côté client, à l'identique.
- `build.js` : conservé quasi tel quel (c'est déjà lui qui interrogeait Météo-France et écrivait les JSON) — c'est maintenant lui qui tourne périodiquement via GitHub Actions au lieu d'être appelé manuellement.
- Un workflow `.github/workflows/update-and-deploy.yml` : toutes les 30 min, il relance `build.js`, commite les JSON s'ils ont changé, puis republie le site sur GitHub Pages.
- Chemins absolus (`/favicon.png`, `/background.jpg`, etc.) rendus relatifs, car GitHub Pages sert un repo projet sous `https://<user>.github.io/<repo>/`, pas à la racine du domaine.

## Étapes manuelles à faire une seule fois (je ne peux pas les automatiser sans connecteur GitHub autorisé)

1. **Créer le repo GitHub** (public — condition pour que Pages soit gratuit) et y pousser ce dossier `github-pages-test/` en tant que racine du repo :
   ```
   cd github-pages-test
   git init
   git add .
   git commit -m "Version test statique GitHub Pages"
   git branch -M main
   git remote add origin https://github.com/<votre-user>/<nom-repo>.git
   git push -u origin main
   ```

2. **Ajouter les secrets Météo-France** : Settings → Secrets and variables → Actions → New repository secret
   - `APPLICATION_ID` (même valeur que celle configurée aujourd'hui sur Heroku)
   - `TOKEN_URL` (idem)

3. **Activer GitHub Pages** : Settings → Pages → Build and deployment → Source : **GitHub Actions** (pas "Deploy from a branch"). Le workflow se charge du reste.

4. **Lancer le workflow une première fois manuellement** pour vérifier sans attendre le cron : onglet Actions → "Mise à jour données vent + déploiement Pages" → Run workflow.

5. Le site sera visible à `https://<votre-user>.github.io/<nom-repo>/`.

## Vérifications à faire une fois en ligne

- Les 3 stations s'affichent et changent bien de fond/couleurs.
- Le bandeau "données manquantes" apparaît/disparaît de façon cohérente.
- Après ~30-40 min, une nouvelle ligne apparaît dans le tableau (preuve que le cron + le commit + le redéploiement Pages fonctionnent bout en bout).

## Aucun impact sur Heroku

Ce dossier n'est pas suivi par le remote `heroku` (git.heroku.com). Ne l'ajoutez pas à un `git push heroku` — il n'a de toute façon aucune raison de l'être, Heroku continue de déployer `server.cjs` comme avant.
