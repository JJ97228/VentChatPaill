require('dotenv').config();
const APPLICATION_ID = process.env.APPLICATION_ID;
const TOKEN_URL = process.env.TOKEN_URL;

const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Chemin vers les fichiers de données sources (pour lire les données existantes)
const DATA_FILES_SOURCE = {
    '97232003': path.join(__dirname, 'data/dico.json'),
    '97230001': path.join(__dirname, 'data/dico2.json'),
    '97222002': path.join(__dirname, 'data/dico3.json'),
};

// Chemin vers les fichiers de données de sortie (dans public/data/)
const DATA_FILES_OUTPUT = {
    '97232003': path.join(__dirname, 'public/data/dico.json'),
    '97230001': path.join(__dirname, 'public/data/dico2.json'),
    '97222002': path.join(__dirname, 'public/data/dico3.json'),
};

// Marge de sécurité : on ne demande jamais un créneau plus récent que
// "maintenant - BUFFER_MIN". Doit rester INFÉRIEUR au décalage du cron
// (7 min) : sinon le créneau qui vient de tomber n'est jamais éligible
// au run qui suit immédiatement et prend un cycle complet (30 min) de
// retard à chaque fois (bug identifié le 25/07). Le rattrapage des
// créneaux manquants (voir plus bas) absorbe sans problème les cas où
// Météo-France n'a réellement pas encore publié à ce moment-là.
const BUFFER_MIN = 3;

function parseToGMT(dateStr) {
    const [day, month, year, hour, minute, second] = dateStr.match(/\d+/g);
    const dateGMT4 = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    dateGMT4.setUTCHours(dateGMT4.getUTCHours() + 4);
    return dateGMT4;
}

function formatToGMTMinus4(date) {
    return new Intl.DateTimeFormat('fr-FR', {
        timeZone: 'America/Port_of_Spain', // GMT-4
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).format(date);
}

// Calcule 00h00 (minuit, heure LOCALE Martinique, GMT-4) du jour en cours —
// de façon indépendante du fuseau horaire de la machine qui exécute ce
// script (important : les runners GitHub Actions tournent en UTC, pas en
// GMT-4 ; un simple setHours(0,0,0,0) donnerait minuit dans le fuseau du
// runner, pas minuit local GMT-4).
function getHuizero(maintenant) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Port_of_Spain',
        year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(maintenant).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});

    // 00h00 GMT-4 un jour calendaire local donné = 04h00 UTC ce même jour.
    // Comme parts.day est déjà déterminé à partir de "maintenant" en local,
    // ce point est toujours <= maintenant : pas besoin de reculer d'un jour.
    return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 4, 0, 0, 0));
}

// Liste tous les créneaux de 30 min attendus depuis le début de la journée
// (00h00 heure locale) jusqu'à maintenant - BUFFER_MIN.
function getCreneauxAttendus(maintenant, huizero) {
    const limite = new Date(maintenant.getTime() - BUFFER_MIN * 60 * 1000);
    const creneaux = [];
    let cursor = new Date(huizero);
    while (cursor <= limite) {
        creneaux.push(new Date(cursor));
        cursor = new Date(cursor.getTime() + 30 * 60 * 1000);
    }
    return creneaux;
}

class Client {
    constructor(applicationId, tokenUrl) {
        this.applicationId = applicationId;
        this.tokenUrl = tokenUrl;
        this.token = null;
    }

    async obtainToken() {
        const data = new URLSearchParams({ grant_type: 'client_credentials' });
        const headers = {
            Authorization: `Basic ${this.applicationId}`,
        };

        try {
            const response = await axios.post(this.tokenUrl, data, { headers });
            this.token = response.data.access_token;
        } catch (error) {
            console.error('Error obtaining token:', error.message);
            throw new Error('Failed to obtain token. Check your APPLICATION_ID or token URL.');
        }
    }

    async request(method, url, config = {}) {
        if (!this.token) await this.obtainToken();

        try {
            const response = await axios({
                method,
                url,
                headers: { Authorization: `Bearer ${this.token}` },
                ...config,
            });
            return response.data;
        } catch (error) {
            if (error.response && error.response.status === 401) {
                console.warn('Token expired, obtaining a new one...');
                await this.obtainToken();
                return this.request(method, url, config);
            } else {
                console.error('Error in request:', error.message);
                throw error;
            }
        }
    }
}

async function updateStationData(stationId) {
    const maintenant = new Date();
    const DATA_FILE_SOURCE = DATA_FILES_SOURCE[stationId];
    if (!DATA_FILE_SOURCE) {
        throw new Error(`Station ID inconnu : ${stationId}`);
    }

    // Charger les données existantes
    let dico = {};
    try {
        if (fs.existsSync(DATA_FILE_SOURCE)) {
            const fileContent = fs.readFileSync(DATA_FILE_SOURCE, 'utf8');
            if (fileContent.trim()) {
                dico = JSON.parse(fileContent);
            }
        }
    } catch (error) {
        console.error(`Erreur de lecture du fichier ${DATA_FILE_SOURCE} :`, error.message);
        dico = {};
    }

    console.log(`\n=== Mise à jour pour la station ${stationId} ===`);

    const huizero = getHuizero(maintenant);

    // Purge des données d'avant le début de la journée d'observation en cours
    // (comportement identique à l'appli Heroku : on n'affiche que les
    // données du jour, la veille ne doit pas trainer dans le dictionnaire).
    Object.keys(dico).forEach(key => {
        let date;
        try {
            date = parseToGMT(key);
        } catch (e) {
            date = null;
        }
        if (!date || date < huizero) {
            delete dico[key];
        }
    });

    // Dépannage provisoire (comportement Heroku d'origine) : si le créneau le
    // plus récent (ex. 09h00) n'est pas encore publié, Météo-France renvoie
    // parfois la dernière donnée 6 min disponible (ex. 08h54) plutôt qu'une
    // erreur. On l'affiche quand même (mieux que rien), mais elle est
    // "hors-grille" (pas alignée :00/:30) : on l'efface systématiquement en
    // tête du run SUIVANT avant de retenter le créneau propre, pour ne pas
    // laisser trainer 08h54/07h24/etc. indéfiniment dans le tableau.
    const clesTriees = Object.keys(dico).sort((a, b) => parseToGMT(a) - parseToGMT(b));
    const derniereCle = clesTriees[clesTriees.length - 1];
    if (derniereCle) {
        const d = parseToGMT(derniereCle);
        if (d.getUTCMinutes() % 30 !== 0 || d.getUTCSeconds() !== 0) {
            console.log(`Suppression du dépannage provisoire hors-grille : ${derniereCle}`);
            delete dico[derniereCle];
        }
    }

    const creneaux = getCreneauxAttendus(maintenant, huizero);
    // On ne redemande QUE les créneaux absents du dico (ceux déjà présents ne
    // consomment pas d'appel API et ne sont jamais écrasés). C'est ce qui
    // permet de "réparer" un trou survenu lors d'un run précédent : le
    // créneau reste candidat à chaque exécution tant qu'il n'a pas réussi.
    const creneauxManquants = creneaux.filter(c => !dico[formatToGMTMinus4(c)]);
    const dernierCreneauAttendu = creneaux[creneaux.length - 1];

    if (creneauxManquants.length === 0) {
        console.log('Aucun créneau manquant sur la fenêtre couverte.');
    } else {
        const client = new Client(APPLICATION_ID, TOKEN_URL);
        for (const creneau of creneauxManquants) {
            const dateMFStr = new Date(creneau).toISOString().split('.')[0] + 'Z';
            console.log(`Appel à l'API pour la station ${stationId} avec la date : ${dateMFStr}`);
            try {
                const response = await client.request(
                    'GET',
                    `https://public-api.meteofrance.fr/public/DPObs/v1/station/infrahoraire-6m?id_station=${stationId}&date=${dateMFStr}&format=json`
                );
                const data = response[0];
                if (data && data.validity_time) {
                    const datage = formatToGMTMinus4(new Date(data.validity_time));
                    const estLeCreneauDemande = datage === formatToGMTMinus4(creneau);
                    const estLeDernierCreneau = dernierCreneauAttendu && creneau.getTime() === dernierCreneauAttendu.getTime();

                    if (estLeCreneauDemande || estLeDernierCreneau) {
                        // Soit c'est exactement la bonne donnée, soit c'est un
                        // dépannage provisoire accepté uniquement parce que
                        // c'est le créneau le plus récent de la fenêtre.
                        const v_d = data.dd ? `${data.dd.toString().padStart(3, '0')}°` : '000°';
                        const v_v = (data.ff * 3.6).toFixed(2);
                        dico[datage] = { v_d, v_v };
                        console.log(estLeCreneauDemande
                            ? `Données ajoutées pour ${datage}`
                            : `Dépannage provisoire ajouté pour ${datage} (créneau ${formatToGMTMinus4(creneau)} pas encore publié)`);
                    } else {
                        console.warn(`Donnée hors-grille ignorée pour un créneau ancien (${formatToGMTMinus4(creneau)} -> reçu ${datage}) : nouvel essai au prochain run.`);
                    }
                }
            } catch (apiError) {
                console.warn(`Toujours indisponible pour ${dateMFStr} (station ${stationId}) : ${apiError.message}`);
                // Pas grave : ce créneau sera re-tenté au prochain run tant qu'il manque.
            }
        }
    }

    // Tri chronologique avant sauvegarde : essentiel, car un trou peut être
    // comblé APRÈS coup, dans le désordre d'insertion. Le front (vent.js)
    // s'appuie sur l'ordre des clés pour déterminer "la plus récente".
    const sortedDico = {};
    Object.keys(dico)
        .sort((a, b) => parseToGMT(a) - parseToGMT(b))
        .forEach(k => { sortedDico[k] = dico[k]; });

    fs.writeFileSync(DATA_FILE_SOURCE, JSON.stringify(sortedDico, null, 4));

    const outputDir = path.dirname(DATA_FILES_OUTPUT[stationId]);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    fs.writeFileSync(DATA_FILES_OUTPUT[stationId], JSON.stringify(sortedDico, null, 4));
    console.log(`Données sauvegardées dans ${DATA_FILES_OUTPUT[stationId]}`);

    return sortedDico;
}

async function build() {
    console.log('=== Début de la génération des données ===\n');

    if (!APPLICATION_ID || !TOKEN_URL) {
        throw new Error('APPLICATION_ID et TOKEN_URL doivent être définis (secrets GitHub Actions ou fichier .env en local).');
    }

    const stations = ['97232003', '97230001', '97222002'];

    for (const stationId of stations) {
        try {
            await updateStationData(stationId);
        } catch (error) {
            console.error(`Erreur pour la station ${stationId}:`, error.message);
            // Continue avec les autres stations même en cas d'erreur
        }
    }

    console.log('\n=== Génération terminée ===');
}

build().catch(error => {
    console.error('Erreur fatale:', error.message);
    process.exit(1);
});
