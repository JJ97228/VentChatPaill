document.addEventListener('DOMContentLoaded', async () => {
    let arrondir = false; // Par défaut, pas d'arrondi

    // --- Config déplacée côté client (avant : servie par routes/api.cjs) ---
    const DATA_FILES = {
        '97232003': 'data/dico.json',
        '97230001': 'data/dico2.json',
        '97222002': 'data/dico3.json',
    };

    const STATION_CONFIGS = {
        '97232003': {
            background: 'url("background.jpg")',
            backgroundMobil: 'url("background001.jpg")',
            ville: 'le Vauclin',
            lieu: 'Château-Paille',
            colorBorder: '#29caef',
            colorTexte: 'black',
            colorFond: '#267ed5',
        },
        '97230001': {
            background: 'url("Background02.jpg")',
            backgroundMobil: 'url("Background002.jpg")',
            ville: 'Trinité',
            lieu: 'la Caravelle',
            colorBorder: '#335581',
            colorTexte: 'black',
            colorFond: '#29665e',
        },
        '97222002': {
            background: 'url("Background03.jpg")',
            backgroundMobil: 'url("Background003.jpg")',
            ville: 'le Robert',
            lieu: 'Pointe-Fort',
            colorBorder: '#af4a34',
            colorTexte: '#d6baa6',
            colorFond: '#233c4f',
        },
    };

    // --- Reprend exactement la logique de routes/api.cjs (parseToGMT) pour calculer le flag "manque" côté client ---
    function parseToGMT(dateStr) {
        const [day, month, year, hour, minute, second] = dateStr.match(/\d+/g);
        const dateGMT4 = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
        dateGMT4.setUTCHours(dateGMT4.getUTCHours() + 4);
        return dateGMT4;
    }

    // Tri chronologique défensif : build.js trie déjà les clés avant sauvegarde,
    // mais on ne fait pas confiance à l'ordre d'insertion du JSON pour déterminer
    // "la donnée la plus récente" (un trou comblé après coup casserait sinon
    // l'ordre naturel de Object.keys()).
    function getSortedKeys(dico) {
        return Object.keys(dico).sort((a, b) => {
            try {
                return parseToGMT(a) - parseToGMT(b);
            } catch (e) {
                return 0;
            }
        });
    }

    // Seuil relevé par rapport à l'original (37 min) : le pipeline statique
    // (cron 30 min + marge de publication Météo-France + délai commit/déploiement
    // Pages) ajoute un délai que l'ancien serveur en direct n'avait pas.
    const SEUIL_MANQUE_MIN = 50;

    function computeManque(dico) {
        const keys = getSortedKeys(dico);
        if (keys.length === 0) return true;
        const lastKey = keys[keys.length - 1];
        try {
            const lastDate = parseToGMT(lastKey);
            const maintenant = new Date();
            return ((maintenant - lastDate) / 60000) > SEUIL_MANQUE_MIN;
        } catch (e) {
            return true;
        }
    }

    // Fonction pour charger les données statiques (data/dico*.json généré par le workflow GitHub Actions)
    async function fetchDataForStation(stationId) {
        try {
            const file = DATA_FILES[stationId];
            const config = STATION_CONFIGS[stationId];
            if (!file || !config) throw new Error(`Station inconnue : ${stationId}`);

            // Cache-bust pour éviter que le navigateur/CDN Pages serve une version périmée
            const response = await fetch(`${file}?t=${Date.now()}`);
            if (!response.ok) throw new Error('Erreur lors du chargement des données.');

            const dico = await response.json();
            const manque = computeManque(dico);

            applyStationConfig(config);
            updateTable(dico, config, manque);
        } catch (error) {
            console.error('Erreur lors du chargement des données :', error.message);
        }
    }

    function applyStationConfig(config) {
        const bodyElement = document.querySelector('body');
        const corpsElement = document.querySelector('.corps');
        const thElements = document.querySelectorAll('th');
        const basDePageElement = document.querySelector('.bas-de-page');
        const isMobil2 = window.innerWidth <= 768;

        bodyElement.style.backgroundColor = config.colorFond;
        bodyElement.style.color = config.colorTexte;
        if (isMobil2) {
            corpsElement.style.backgroundImage = config.backgroundMobil;
        } else {
            corpsElement.style.backgroundImage = config.background;
        }

        thElements.forEach(th => th.style.borderColor = config.colorBorder);
        basDePageElement.style.backgroundColor = config.colorFond;

        const h1Element = document.querySelector('h1');
        const h2Element = document.querySelector('h2');
        h1Element.style.color = config.colorTexte;
        h2Element.style.color = config.colorTexte;
        h1Element.innerText = `Le vent à ${config.lieu}, `;
        h2Element.innerText = `${config.ville}, aujourd'hui, `;
    }

    // Fonction pour mettre à jour le tableau
    function updateTable(dico, config, manque) {
        const bandeauAlert = document.getElementById('bandeau-alert');
        bandeauAlert.style.display = manque ? 'block' : 'none'

        const keysAll = getSortedKeys(dico);
        if (keysAll.length === 0) {
            // Rien à afficher (première génération avant le premier passage du workflow)
            document.getElementById('data-table').innerHTML = '';
            return;
        }

        const lastKey = keysAll[keysAll.length - 1];
        const lastDate = new Date(lastKey.replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$2/$1/$3'));

        const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
        const formattedDate = lastDate.toLocaleDateString('fr-FR', options);

        const titleElement = document.querySelector('h2');
        const titleParts = titleElement.innerText.split(', aujourd\'hui,');
        titleElement.innerText = `${titleParts[0]}, aujourd'hui, ${formattedDate}`;

        const tableBody = document.getElementById('data-table');
        tableBody.innerHTML = '';

        const vitesseHeader = document.querySelector('#vitesse-header');
        if (arrondir) {
            vitesseHeader.innerHTML = "Vitesse<br>arrondie au km/h";
        } else {
            vitesseHeader.innerHTML = "Vitesse<br>à ± 0.18 km/h";
        }

        const isMobile = window.innerWidth <= 768;
        const keyCount = Object.keys(dico).length;
        let fontSize = "1em";

        if (isMobile) {
            fontSize = "0.8em";
        } else {
            if (keyCount >= 35 && keyCount <= 38) {
                fontSize = "0.9em";
            } else if (keyCount >= 39 && keyCount <= 42) {
                fontSize = "0.8em";
            } else if (keyCount > 42 && keyCount <= 46) {
                fontSize = "0.7em";
            } else if (keyCount > 46) {
                fontSize = "0.6em";
            }
        }

        const style = document.createElement('style');
        style.innerHTML = `
        td {
            font-size: ${fontSize};
        }
    `;
        document.head.appendChild(style);

        const keys = keysAll; // déjà trié chronologiquement (getSortedKeys)
        for (let i = keys.length - 1; i >= 0; i--) {
            const key = keys[i];
            const values = dico[key];

            if (!values || !values.v_v || !values.v_d) {
                console.warn(`Données manquantes pour la clé : ${key}`);
                continue;
            }

            const heureComplete = key.split(' ')[1];
            const [hh, mm] = heureComplete.split(':');
            const heureFormatee = `${hh}h${mm}`;

            const vitesseArrondie = arrondir
                ? Math.round(parseFloat(values.v_v))
                : parseFloat(values.v_v).toFixed(2);

            const row = document.createElement('tr');
            row.innerHTML = `
            <td>${heureFormatee}</td>
            <td>${values.v_d}</td>
            <td>${vitesseArrondie}</td>
        `;
            tableBody.appendChild(row);
        }

        document.querySelectorAll('td').forEach(td => {
            td.style.borderColor = config.colorBorder;
        });
    }

    async function reloadAndUpdate() {
        const stationId = document.querySelector('input[name="station"]:checked').value;
        await fetchDataForStation(stationId);
    }

    const checkbox = document.getElementById('toggleArrondi');
    checkbox.addEventListener('change', () => {
        arrondir = checkbox.checked;
        reloadAndUpdate();
    });

    const radios = document.querySelectorAll('input[name="station"]');
    radios.forEach(radio => {
        radio.addEventListener('change', () => {
            reloadAndUpdate();
        });
    });

    await reloadAndUpdate();

    // Rafraîchissement auto toutes les 5 min côté client (les données ne changent
    // réellement que toutes les 30 min via le workflow GitHub Actions, mais ça permet
    // à un onglet resté ouvert de voir la mise à jour sans reload manuel)
    setInterval(reloadAndUpdate, 5 * 60 * 1000);
});
