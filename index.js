require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { RefreshingAuthProvider } = require('@twurple/auth');
const { ApiClient } = require('@twurple/api');
const { EventSubMiddleware } = require('@twurple/eventsub-http');
const bodyParser = require('body-parser'); 
const { promises: fs } = require('fs');
const path = require('path');

// Imports DB et Modèles
const connectDB = require('./db'); 
const { User, Match, BonusLog } = require('./models');

// --- Configuration ---
const clientId = process.env.TWITCH_CLIENT_ID;
const clientSecret = process.env.TWITCH_CLIENT_SECRET;
const channelUserId = process.env.CHANNEL_USER_ID; 
const channelUsername = process.env.CHANNEL_USERNAME;
const eventSubSecret = process.env.EVENTSUB_SECRET;
const hostName = process.env.HOSTNAME; 
const port = process.env.PORT || 3000;

// Nom du fichier de tokens
const TOKEN_FILE_PATH = path.join(__dirname, 'tokens.json');

// Noms de toutes les 9 récompenses
const ALL_REWARDS = [
    { name: process.env.REWARD_NAME_LEVEL_UP_1, key: 'LEVEL_UP_1' },
    { name: process.env.REWARD_NAME_LEVEL_UP_2, key: 'LEVEL_UP_2' },
    { name: process.env.REWARD_NAME_LEVEL_UP_3, key: 'LEVEL_UP_3' },
    { name: process.env.REWARD_NAME_LEVEL_UP_4, key: 'LEVEL_UP_4' },
    { name: process.env.REWARD_NAME_LEVEL_DOWN_1, key: 'LEVEL_DOWN_1' },
    { name: process.env.REWARD_NAME_LEVEL_DOWN_2, key: 'LEVEL_DOWN_2' },
    { name: process.env.REWARD_NAME_LEVEL_DOWN_3, key: 'LEVEL_DOWN_3' },
    { name: process.env.REWARD_NAME_LEVEL_DOWN_4, key: 'LEVEL_DOWN_4' },
    { name: process.env.REWARD_NAME_CHOIX_PERSO, key: 'CHOIX_PERSO' }
];

// Variables Globales de Jeu
let currentMatchId = 0; 
let currentMatch = null; 
let currentPredictionId = null; 
const BOT_LEVEL_MAX = 9;
const REWARD_IDS = {}; 

// NOUVELLE CONSTANTE : Marqueur pour identifier les paris de jeu (nécessite d'être défini dans .env)
const GAME_PREDICTION_TITLE_MARKER = process.env.GAME_PREDICTION_TITLE_MARKER || "[SMASH BET]"; 


// --- Gestion des Tokens ---
async function getAuthProvider() {
    let tokenData = null;
    try {
        const data = await fs.readFile(TOKEN_FILE_PATH, 'utf-8');
        const rawData = JSON.parse(data);
        tokenData = {
            accessToken: rawData.accessToken || rawData.access_token,
            refreshToken: rawData.refreshToken || rawData.refresh_token,
            expiresIn: rawData.expiresIn || rawData.expires_in || 0,
            obtainmentTimestamp: rawData.obtainmentTimestamp || 0,
            scope: rawData.scope || ['channel:read:redemptions', 'channel:manage:redemptions', 'channel:read:predictions', 'channel:manage:predictions']
        };
    } catch (e) {
        if (process.env.INITIAL_ACCESS_TOKEN && process.env.INITIAL_REFRESH_TOKEN) {
            tokenData = {
                accessToken: process.env.INITIAL_ACCESS_TOKEN,
                refreshToken: process.env.INITIAL_REFRESH_TOKEN,
                expiresIn: 0,
                obtainmentTimestamp: 0,
                scope: ['channel:read:redemptions', 'channel:manage:redemptions', 'channel:read:predictions', 'channel:manage:predictions']
            };
            console.log("Utilisation des tokens depuis les variables d'environnement.");
        }
    }

    if (!tokenData || !tokenData.accessToken) {
        throw new Error("Aucun token valide trouvé.");
    }

    const authProvider = new RefreshingAuthProvider({
        clientId,
        clientSecret,
        onRefresh: async (userId, newTokenData) => {
            console.log("🔄 Rafraîchissement du token... Écriture du nouveau token dans tokens.json");
            try { 
                await fs.writeFile(TOKEN_FILE_PATH, JSON.stringify(newTokenData, null, 4), 'utf-8'); 
            } catch(e) { 
                console.error("ERREUR CRITIQUE: Échec de l'écriture du nouveau token dans tokens.json:", e.message);
            }
        }
    });

    if (!channelUserId) throw new Error("CHANNEL_USER_ID manquant dans le .env ou mal défini.");
    
    authProvider.addUser(channelUserId, tokenData);
    authProvider.addIntentsToUser(channelUserId, ['channel:read:redemptions', 'channel:manage:redemptions', 'channel:read:predictions', 'channel:manage:predictions']);

    return authProvider;
}

// --- Fonctions Utilitaires de Jeu (updatePredictionStatus supprimé) ---

async function updateRewardStatus(apiClient, rewardId, isEnabled, isHidden) {
    if (!rewardId) return;

    try {
        await apiClient.channelPoints.updateCustomReward(channelUserId, rewardId, {
            isEnabled: isEnabled,
            isHidden: isHidden
        });
    } catch (e) {
        console.error(`[Twitch API] Erreur statut récompense ${rewardId}:`, e.message);
    }
}

async function mapRewardNamesToIds(apiClient) {
    console.log("--- Recherche et Création des IDs de récompenses ---");
    const rewardsToFind = ALL_REWARDS.filter(r => r.name);
    
    if (rewardsToFind.length === 0) {
        throw new Error("Aucune récompense n'est définie dans les variables d'environnement (REWARD_NAME_...).");
    }

    const twitchRewards = await apiClient.channelPoints.getCustomRewards(channelUserId);
    
    for (const reward of rewardsToFind) {
        const existingMatch = twitchRewards.find(r => r.title.toLowerCase() === reward.name.toLowerCase());
        
        if (existingMatch) {
            REWARD_IDS[reward.key] = existingMatch.id;
            console.log(`✅ ID trouvé pour "${reward.name}" : ${existingMatch.id}`);
        } else {
            console.warn(`⚠️ Récompense "${reward.name}" introuvable. Création en cours...`);
            
            try {
                const newReward = await apiClient.channelPoints.createCustomReward(channelUserId, {
                    title: reward.name,
                    cost: 10, 
                    isEnabled: false, 
                    isHidden: true, 
                    prompt: `Impacte le match du Bot ${reward.key.includes('LEVEL_') ? reward.key.slice(-1) : 'Choix'}`,
                    isUserInputRequired: reward.key === 'CHOIX_PERSO', 
                    shouldRedemptionsSkipQueue: true 
                });
                
                REWARD_IDS[reward.key] = newReward.id;
                console.log(`✨ Récompense "${reward.name}" créée avec succès : ${newReward.id}`);
            } catch (createError) {
                console.error(`❌ ERREUR CRITIQUE DE CRÉATION pour ${reward.name}:`, createError.message);
            }
        }
    }
    return Object.keys(REWARD_IDS).length;
}


// --- Routes d'Administration (Simplifiées) ---

// MODIFICATION: authProvider retiré car plus de PATCH
function setupAdminRoutes(app, apiClient, io) {
    
    async function closeBonusPhase() {
        if (currentMatch && currentMatch.status === 'BONUS_ACTIVE') {
            currentMatch.status = 'IN_PROGRESS';
            currentMatch = await currentMatch.save(); 

            for(const key in REWARD_IDS) {
                console.log(`[LOG: CLOSE PHASE] Bonus ${key}: Désactivation et CACHÉ.`);
                await updateRewardStatus(apiClient, REWARD_IDS[key], false, true); 
            }
            
            io.emit('game-status', { status: 'IN_PROGRESS', bonusUsed: currentMatch.bonusResults });
            console.log(`[JEU] Bonus clôturés. Statut: IN_PROGRESS.`);
        }
    }

    // Contrôles manuels (non modifiés)
    app.post('/admin/set-active', async (req, res) => { /* ... */ });
    app.post('/admin/set-hidden', async (req, res) => { /* ... */ });


    // --- Route 1: DÉMARRER MATCH & ATTENDRE PARI TWITCH ---
    app.post('/admin/start-match', 
        bodyParser.json(), 
        bodyParser.urlencoded({ extended: true }), 
        async (req, res) => {
        if (currentMatch && currentMatch.status !== 'CLOSED') {
            return res.status(400).send({ message: "Le match actuel n'est pas terminé." });
        }

        // 1. Création du Match DB (Le pari Twitch est lancé manuellement par BLB)
        currentMatchId++; 
        const initialBonusMap = new Map();
        for (const reward of ALL_REWARDS) { initialBonusMap.set(reward.key, false); } 

        try {
            const newMatch = new Match({
                matchId: currentMatchId, 
                // twitchPredictionId est null au départ, rempli par EventSub
                twitchPredictionId: null, 
                status: 'AWAITING_PREDICTION', // NOUVEAU STATUT
                bonusResults: {
                    bot1Level: 8, bot2Level: 8, bot3Level: 8, bot4Level: 8,
                    characterChoices: [],
                    usersUsedBonus: initialBonusMap
                }
            });
            currentMatch = await newMatch.save(); 
            currentPredictionId = null; 
        } catch (error) {
            console.error("[DB] Erreur lors de la création du Match DB:", error);
            return res.status(500).send({ message: "Erreur DB : Échec de la création du match." });
        }
        
        // 2. Mise à jour des récompenses et réponse
        console.log("[LOG] Match Démarré: En attente de pari Twitch. Récompenses CACHÉES.");
        for(const key in REWARD_IDS) {
            await updateRewardStatus(apiClient, REWARD_IDS[key], false, true); 
        }

        io.emit('game-status', { status: currentMatch.status, matchId: currentMatchId });
        res.send({ status: currentMatch.status, matchId: currentMatchId, message: `Attente du pari Twitch avec marqueur: ${GAME_PREDICTION_TITLE_MARKER}` });
    });


    // --- Route 2: AUTORISER BONUS (Simplifiée : ne verrouille plus le pari) ---
    app.post('/admin/allow-bonus', 
        bodyParser.json(), 
        bodyParser.urlencoded({ extended: true }), 
        async (req, res) => {
        if (!currentMatch || currentMatch.status !== 'BETTING') {
            // Le statut BETTING est mis par l'EventSub (dès que le pari Twitch est détecté)
            return res.status(400).send({ message: "Le match n'est pas dans la phase BETTING. Le pari Twitch doit être lancé et actif." });
        }
        
        // La clôture du pari Twitch est maintenant manuelle (ou automatique via Twitch)
        console.log("[LOG] Phase Bonus: Transition vers BONUS_ACTIVE.");
        currentMatch.status = 'BONUS_ACTIVE';
        currentMatch = await currentMatch.save();

        console.log("[LOG] Phase Bonus: Forçage à l'état VISIBLE et ACTIVÉ.");
        for(const key in REWARD_IDS) {
            if (currentMatch.bonusResults.usersUsedBonus.get(key) === false) { 
                 await updateRewardStatus(apiClient, REWARD_IDS[key], true, false); 
            }
        }
        
        setTimeout(async () => {
            if (currentMatch && currentMatch.status === 'BONUS_ACTIVE') {
                console.log("[TIMER] Fin du temps de bonus (10s écoulées). Fermeture des récompenses.");
                await closeBonusPhase();
            }
        }, 10000); // 10 secondes

        io.emit('game-status', { status: currentMatch.status });
        res.send({ status: 'BONUS_ACTIVE', timer: '10s démarré' });
    });


    // --- Route 3: CLÔTURER MATCH & PAIEMENT (Simplifiée : ne résout plus le pari) ---
    app.post('/admin/close-match', 
        bodyParser.json(), 
        bodyParser.urlencoded({ extended: true }), 
        async (req, res) => {
        const winnerBotIndex = parseInt(req.body.winner); // 1, 2, 3, ou 4

        if (!currentMatch || currentMatch.status === 'CLOSED') {
            return res.status(400).send({ message: "Aucun match actif à clôturer." });
        }
        
        if (currentMatch.status === 'BONUS_ACTIVE') {
            await closeBonusPhase();
        }

        // Le paiement est géré par Twitch lorsque BLB clôture le pari dans son interface.
        console.log(`[JEU] Clôture DB du Match ${currentMatch.matchId}. Paiement des points attendu de Twitch.`);
        
        // 1. Mise à jour de l'état du Match DB
        currentMatch.status = 'CLOSED';
        currentMatch.winnerBot = winnerBotIndex;
        currentMatch = await currentMatch.save(); 
        currentPredictionId = null; // Réinitialisation de l'ID du pari

        io.emit('game-status', { status: 'CLOSED', winner: winnerBotIndex });
        res.send({ status: 'CLOSED', winner: winnerBotIndex, message: "Match clôturé. Assurez-vous de résoudre le pari Twitch manuellement." });
    });
    
    return { closeBonusPhase };
}


// --- Logique EventSub (Écoute des Paris) ---

function setupEventSub(app, apiClient, io, closeBonusPhase) {
    const listener = new EventSubMiddleware({
        apiClient,
        hostName: hostName || 'localhost', 
        pathPrefix: '/twitch-events',
        secret: eventSubSecret || 'secret'
    });
    
    listener.apply(app);

    // ********** ÉCOUTE DES BONUS DE POINTS DE CHAÎNE (Reward) **********
    listener.onChannelRedemptionAdd(channelUserId, async (event) => {
        if (!currentMatch || currentMatch.status === 'CLOSED') { return; }
        
        const rewardId = event.rewardId;
        const userId = event.userId;
        const userDisplayName = event.userDisplayName;
        const userInput = event.input || '';

        const usedReward = ALL_REWARDS.find(r => REWARD_IDS[r.key] === rewardId);
        if (!usedReward) return;
        
        const rewardKey = usedReward.key;

        if (currentMatch.bonusResults.usersUsedBonus.get(rewardKey) === true) { return; }

        currentMatch.bonusResults.usersUsedBonus.set(rewardKey, true); 
        
        console.log(`[LOG] Bonus ${rewardKey} utilisé par ${userDisplayName} : Désactivation et CACHÉ.`);
        // NOTE: updateRewardStatus ne fait pas de PATCH sur les prédictions, il est sûr.
        await updateRewardStatus(apiClient, rewardId, false, true); 
        
        // 2. Logique Level Up/Down (non modifiée)
        if (rewardKey.startsWith('LEVEL_')) {
            const isUp = rewardKey.includes('UP');
            const botIndex = parseInt(rewardKey.slice(-1)); 
            const levelField = `bot${botIndex}Level`; 
            
            currentMatch.bonusResults[levelField] = isUp 
                ? Math.min(currentMatch.bonusResults[levelField] + 1, BOT_LEVEL_MAX)
                : Math.max(currentMatch.bonusResults[levelField] - 1, 1);
            
            console.log(`[LOGIC] Level ${isUp ? 'UP' : 'DOWN'} Bot ${botIndex} à ${currentMatch.bonusResults[levelField]} par ${userDisplayName}`);

            io.emit('bonus-applied', { type: isUp ? 'levelUp' : 'levelDown', bot: botIndex, newLevel: currentMatch.bonusResults[levelField] });
        }
        
        // 3. Logique Choix Perso (non modifiée)
        if (rewardKey === 'CHOIX_PERSO') {
             currentMatch.bonusResults.characterChoices.push({
                 botIndex: 1, 
                 characterName: userInput,
                 userId: userId
             });

             console.log(`[LOGIC] Choix Perso utilisé par ${userDisplayName}. Input: ${userInput}`);
             io.emit('bonus-applied', { type: 'charSelect', user: userDisplayName, input: userInput });
        }


        // 4. Enregistrement dans la DB (non modifiée)
        const logEntry = new BonusLog({
            matchId: currentMatchId,
            userId: userId,
            bonusType: rewardKey,
            targetBot: rewardKey.includes('LEVEL_') ? parseInt(rewardKey.slice(-1)) : null,
            input: userInput
        });
        await logEntry.save();
        
        currentMatch = await currentMatch.save();

        // 5. Vérifier si tous les 9 bonus sont utilisés pour fermer immédiatement
        const allUsed = ALL_REWARDS.every(r => currentMatch.bonusResults.usersUsedBonus.get(r.key) === true);
        if (allUsed) {
             await closeBonusPhase();
        }
    });

    // ********** ÉCOUTE DES PARIS TWITCH (Predictions) **********

    listener.onChannelPredictionBegin(channelUserId, async (event) => {
        // NOUVEAU: Vérifie le marqueur de titre
        if (!event.title.startsWith(GAME_PREDICTION_TITLE_MARKER)) {
            console.log(`[PREDICTION IGNORED] Pari sans marqueur : ${event.title}`);
            return;
        }

        console.log(`[PREDICTION TRACKED] Pari de jeu commencé: ${event.title} (ID: ${event.id})`);

        if (currentMatch && currentMatch.status === 'AWAITING_PREDICTION') {
             // Mise à jour du match DB avec l'ID du pari Twitch
            currentMatch.twitchPredictionId = event.id;
            currentMatch.status = 'BETTING'; 
            currentMatch = await currentMatch.save();
            currentPredictionId = event.id;

            console.log(`[JEU] Match ${currentMatch.matchId} lié au pari Twitch. Statut: BETTING.`);
            io.emit('game-status', { status: currentMatch.status, matchId: currentMatch.matchId, predictionId: currentPredictionId });
        } else {
             console.warn("[PREDICTION WARNING] Nouveau pari de jeu détecté, mais aucun match DB n'attend le pari. Ignoré.");
        }
    });

    listener.onChannelPredictionProgress(channelUserId, async (event) => {
        if (event.id === currentPredictionId) {
             // Continue de suivre les topPredictors si vous voulez construire un classement
             for (const outcome of event.outcomes) {
                for (const topPredictor of outcome.topPredictors) {
                    await User.findOneAndUpdate(
                        { twitchId: topPredictor.userId },
                        { $setOnInsert: { username: topPredictor.userName } }, 
                        { upsert: true, new: true }
                    );
                }
            }
        }
    });


    listener.onChannelPredictionEnd(channelUserId, async (event) => {
        console.log(`[PREDICTION] Pari terminé (ID: ${event.id}). Statut final: ${event.status}.`);

        if (event.id === currentPredictionId && currentMatch && currentMatch.status !== 'CLOSED') {
            
            if (event.status === 'RESOLVED' && event.winningOutcome) {
                const winningOutcomeTitle = event.winningOutcome.title;
                console.log(`[PAYOUT CONFIRMATION] Gagnant: ${winningOutcomeTitle}. Twitch a payé les points.`);
                
                io.emit('prediction-status', { id: event.id, status: event.status, winner: winningOutcomeTitle });
            } else {
                 io.emit('prediction-status', { id: event.id, status: event.status });
            }
        }
    });

    return listener;
}


// --- Fonction Principale (Main) ---

async function main() {
    await connectDB();
    
    // Récupérer le dernier Match ID et l'état de l'instance
    const lastMatch = await Match.findOne({}).sort({ matchId: -1 });
    if (lastMatch) {
        currentMatchId = lastMatch.matchId;
        currentMatch = lastMatch; 
        currentPredictionId = lastMatch.twitchPredictionId || null; 
        console.log(`[DB] Reprise du Match ID : ${currentMatchId}. Statut : ${currentMatch.status}. Prediction ID: ${currentPredictionId}`);
    } else {
        currentMatchId = 0;
        console.log(`[DB] Démarrage du Match ID à 0.`);
    }

    const app = express();
    const httpServer = createServer(app);
    const io = new Server(httpServer);
    
    app.use(express.static('public'));

    app.get('/', (req, res) => {
        res.redirect('/admin.html');
    });

    console.log("Authentification...");
    const authProvider = await getAuthProvider();
    const apiClient = new ApiClient({ authProvider });

    const totalRewardsFound = await mapRewardNamesToIds(apiClient);
    if (totalRewardsFound === 0) {
        console.error("ERREUR CRITIQUE: Aucune des récompenses nécessaires n'a été trouvée/créée. Le jeu ne peut pas démarrer.");
        process.exit(1);
    }
    
    // MODIFICATION : authProvider retiré
    const { closeBonusPhase } = setupAdminRoutes(app, apiClient, io);
    
    const listener = setupEventSub(app, apiClient, io, closeBonusPhase);
    
    try {
        await listener.markAsReady();
    } catch (e) {
        console.warn(`[EVENT SUB] Erreur au démarrage du listener (normal en local sans tunnel HTTPS): ${e.message}`);
    }

    httpServer.listen(port, () => {
        console.log(`\n🚀 Serveur lancé sur http://localhost:${port}`);
    });

    io.on('connection', (socket) => {
        console.log('Client Admin connecté. Envoi de l’état actuel...');
        if (currentMatch) {
            socket.emit('game-status', { 
                status: currentMatch.status, 
                matchId: currentMatch.matchId 
            });
        } else {
             socket.emit('game-status', { status: 'CLOSED', matchId: 0 });
        }
    });
}

main().catch(console.error);