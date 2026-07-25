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

function parseToGMT(dateStr) {
    const [day, month, year, hour, minute, second] = dateStr.match(/\d+/g);
    // Crée une date en GMT-4 (sans décalage initial)
    const dateGMT4 = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    // Corrige pour avoir l'heure en GMT
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

function noexisteouVide(maintenant) {
    let huizero = new Date(maintenant);
    huizero.setHours(4, 0, 0, 0);
    if (huizero > maintenant) {
        huizero = new Date(huizero - (24 * 3600 * 1000));
    }
    let dateDebut = new Date(huizero);
    return dateDebut;
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

async function initDico(stationId) {
    const maintenant = new Date();
    let dico = {};
    let fini = false;
    let BOUCLE = 0;
    let dateDebut;

    if (!DATA_FILES_SOURCE[stationId]) {
        throw new Error(`Station ID inconnu : ${stationId}`);
    }
    const DATA_FILE_SOURCE = DATA_FILES_SOURCE[stationId];

    try {
        if (fs.existsSync(DATA_FILE_SOURCE)) {
            const fileContent = fs.readFileSync(DATA_FILE_SOURCE, 'utf8');
            if (fileContent.trim()) {
                dico = JSON.parse(fileContent);
                const lastKey = Object.keys(dico).pop();
                if (lastKey) {
                    const lastDate = parseToGMT(lastKey);
                    // Si les données sont récentes (moins de 36 minutes), elles sont considérées comme à jour
                    if (maintenant - lastDate < 36 * 60 * 1000) {
                        fini = true;
                    } else {
                        delete dico[lastKey];
                        let huizero = new Date(maintenant);
                        huizero.setHours(4, 0, 0, 0);
                        if (huizero > maintenant) {
                            huizero = new Date(huizero - (24 * 3600 * 1000));
                        }
                        if (lastDate > huizero) {
                            dateDebut = new Date(lastDate);
                        } else {
                            dateDebut = new Date(huizero);
                            dico = {};
                        }
                    }
                } else {
                    dateDebut = noexisteouVide(maintenant);
                }
            } else {
                dateDebut = noexisteouVide(maintenant);
            }
        } else {
            dateDebut = noexisteouVide(maintenant);
        }
        BOUCLE = Math.floor((maintenant - dateDebut) / (30 * 60 * 1000)) + 1;
    } catch (error) {
        console.error('Erreur lors de l\'initialisation du dico :', error.message);
        throw new Error('Impossible d\'initialiser les données locales.');
    }
    console.log('retour :', { dico, fini, BOUCLE, dateDebut });
    return { dico, fini, BOUCLE, dateDebut };
}

async function updateStationData(stationId) {
    try {
        const { dico, fini, BOUCLE, dateDebut } = await initDico(stationId);
        console.log(`\n=== Mise à jour pour la station ${stationId} ===`);
        console.log('Début de la mise à jour des données.');

        if (fini) {
            console.log('Les données sont déjà à jour.');
            console.log('Retour :', { dico, fini, BOUCLE, dateDebut });
        } else {
            const dateMF = new Date(dateDebut);
            const client = new Client(APPLICATION_ID, TOKEN_URL);

            for (let i = 0; i < BOUCLE; i++) {
                const timeChange = 30 * 60 * 1000 * i;
                const dateMFBoucle = new Date(dateMF.getTime() + timeChange);

                // Alignement des minutes à 00 ou 30
                if (![0, 30].includes(dateMFBoucle.getMinutes())) {
                    const delta = dateMFBoucle.getMinutes() < 30 
                        ? 30 - dateMFBoucle.getMinutes() 
                        : 60 - dateMFBoucle.getMinutes();
                    dateMFBoucle.setMinutes(dateMFBoucle.getMinutes() + delta);
                }
                // Génération de l'URL en format ISO limité aux secondes
                const dateMFStr = new Date(dateMFBoucle.setMilliseconds(0)).toISOString().split('.')[0] + 'Z';
                console.log(`Appel à l'API pour la station ${stationId} avec la date : ${dateMFStr}`);
                
                try {
                    const response = await client.request(
                        'GET',
                        `https://public-api.meteofrance.fr/public/DPObs/v1/station/infrahoraire-6m?id_station=${stationId}&date=${dateMFStr}&format=json`
                    );
                    console.log('Réponse de l\'API reçue');
                    
                    // Extraction et formatage des données
                    const data = response[0];
                    if (data && data.validity_time) {
                        const datage = formatToGMTMinus4(new Date(data.validity_time));
                        const v_d = data.dd ? `${data.dd.toString().padStart(3, '0')}°` : '000°';
                        const v_v = (data.ff * 3.6).toFixed(2);
                        dico[datage] = { v_d, v_v };
                        console.log(`Données ajoutées pour ${datage}`);
                    }
                } catch (apiError) {
                    console.error(`Erreur lors de l'appel API pour ${dateMFStr}:`, apiError.message);
                    // Continue avec les autres dates même en cas d'erreur
                }
            }

            // Sauvegarde dans le fichier source
            fs.writeFileSync(DATA_FILES_SOURCE[stationId], JSON.stringify(dico, null, 4));
            console.log('Données mises à jour dans le fichier source.');
        }

        // Créer le répertoire public/data s'il n'existe pas
        const outputDir = path.dirname(DATA_FILES_OUTPUT[stationId]);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        // Copier vers public/data pour le site statique
        fs.writeFileSync(DATA_FILES_OUTPUT[stationId], JSON.stringify(dico, null, 4));
        console.log(`Données sauvegardées dans ${DATA_FILES_OUTPUT[stationId]}`);

        return dico;
    } catch (error) {
        console.error(`Erreur lors de la mise à jour de la station ${stationId}:`, error.message);
        throw error;
    }
}

async function build() {
    console.log('=== Début de la génération des données ===\n');

    if (!APPLICATION_ID || !TOKEN_URL) {
        throw new Error('APPLICATION_ID et TOKEN_URL doivent être définis dans le fichier .env');
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

// Exécuter le build
build().catch(error => {
    console.error('Erreur fatale:', error.message);
    process.exit(1);
});
