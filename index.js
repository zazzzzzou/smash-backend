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
const mongoose = require('mongoose'); // Ajout pour l'accès aux modèles

// Imports DB et Modèles
const connectDB = require('./db'); 
const { User, Match, BonusLog } = require('./models'); // Assurez-vous que BonusLog est défini

// --- Configuration ---
const clientId = process.env.TWITCH_CLIENT_ID;
const clientSecret = process.env.TWITCH_CLIENT_SECRET;
const channelUserId = process.env.CHANNEL_USER_ID; 
const channelUsername = process.env.CHANNEL_USERNAME;
const eventSubSecret = process.env.EVENTSUB_SECRET;
const hostName = process.env.HOSTNAME; 
const PORT = process.env.PORT || 3000;

// Nom du fichier de tokens
const TOKEN_FILE_PATH = path.join(__dirname, 'tokens.json');

// NOUVEAUX Noms de récompenses simplifiées
const NEW_ALL_REWARDS = [
    { name: process.env.REWARD_NAME_LEVEL_UP, key: 'LEVEL_UP' },
    { name: process.env.REWARD_NAME_LEVEL_DOWN, key: 'LEVEL_DOWN' },
    { name: process.env.REWARD_NAME_CHOIX_PERSO, key: 'CHOIX_PERSO' }
];

// Variables Globales de Jeu
let currentMatchId = 0; 
let currentMatch = null; 
let currentPredictionId = null; 
const BOT_LEVEL_MAX = 9;
const REWARD_IDS = {}; 
const GAME_PREDICTION_TITLE_MARKER = process.env.GAME_PREDICTION_TITLE_MARKER || "[SMASH BET]"; 


// --- Gestion des Tokens (inchangé) ---
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
            scope: ['channel:read:redemptions', 'channel:manage:redemptions', 'channel:read:predictions', 'channel:manage:predictions']
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
        }
    }
    if (!tokenData || !tokenData.accessToken) {
        throw new Error("Aucun token valide trouvé.");
    }
    const authProvider = new RefreshingAuthProvider({
        clientId, clientSecret,
        onRefresh: async (userId, newTokenData) => {
            try { 
                await fs.writeFile(TOKEN_FILE_PATH, JSON.stringify(newTokenData, null, 4), 'utf-8'); 
            } catch(e) { 
                console.error("ERREUR CRITIQUE: Échec de l'écriture du nouveau token:", e.message);
            }
        }
    });
    if (!channelUserId) throw new Error("CHANNEL_USER_ID manquant.");
    authProvider.addUser(channelUserId, tokenData);
    authProvider.addIntentsToUser(channelUserId, ['channel:read:redemptions', 'channel:manage:redemptions', 'channel:read:predictions', 'channel:manage:predictions']);
    return authProvider;
}

// --- Fonctions Utilitaires de Jeu (inchangées) ---

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

// index.js (Remplacez l'ancienne fonction mapRewardNamesToIds)

async function mapRewardNamesToIds(apiClient) {
    console.log("--- Recherche des IDs de récompenses existantes (Lecture Seule) ---");
    const rewardsToFind = NEW_ALL_REWARDS.filter(r => r.name);
    
    if (rewardsToFind.length === 0) {
        console.warn("Aucune récompense n'est définie dans les variables d'environnement.");
    }

    const twitchRewards = await apiClient.channelPoints.getCustomRewards(channelUserId);
    let allFound = true;
    
    for (const reward of rewardsToFind) {
        const existingMatch = twitchRewards.find(r => r.title.toLowerCase() === reward.name.toLowerCase());
        
        if (existingMatch) {
            REWARD_IDS[reward.key] = existingMatch.id;
            console.log(`✅ ID trouvé pour "${reward.name}" : ${existingMatch.id}`);
            // Aucune action de création, suppression ou mise à jour.
        } else {
            console.error(`❌ ERREUR CRITIQUE: Récompense "${reward.name}" introuvable sur Twitch.`);
            console.error(`Veuillez vous assurer que les récompenses "${reward.name}" (LU, LD, CP) sont créées manuellement.`);
            allFound = false;
        }
    }
    
    if (!allFound) {
         // Si toutes ne sont pas trouvées, l'application pourrait avoir un comportement instable.
         // On retourne le nombre de récompenses trouvées pour laisser le main() décider si cela suffit.
         console.error("ATTENTION: Toutes les récompenses nécessaires n'ont pas été trouvées. Le jeu pourrait ne pas fonctionner.");
    }

    return Object.keys(REWARD_IDS).length;
}

// --- Routes d'Administration et API ---

function setupAdminRoutes(app, apiClient, io) {
    
    // Fonction de clôture de phase de bonus (pour Timer ou arrêt manuel)
    async function closeBonusPhase() {
        if (currentMatch && currentMatch.status === 'BONUS_ACTIVE') {
            currentMatch.status = 'IN_PROGRESS';
            currentMatch = await currentMatch.save(); 

            // Masquer et désactiver toutes les récompenses
            for(const key in REWARD_IDS) {
                await updateRewardStatus(apiClient, REWARD_IDS[key], false, true); 
            }
            
            io.emit('game-status', { status: 'IN_PROGRESS', bonusResults: currentMatch.bonusResults });
            console.log(`[JEU] Bonus clôturés. Statut: IN_PROGRESS.`);
        }
    }
    
    // --- Route 1: DÉMARRER MATCH & ATTENDRE PARI TWITCH ---
    app.post('/admin/start-match', 
        bodyParser.json(), 
        bodyParser.urlencoded({ extended: true }), 
        async (req, res) => {
        if (currentMatch && currentMatch.status !== 'CLOSED') {
            return res.status(400).send({ message: "Le match actuel n'est pas terminé." });
        }

        currentMatchId++; 

        try {
            const newMatch = new Match({
                matchId: currentMatchId, 
                twitchPredictionId: null, 
                status: 'AWAITING_PREDICTION', 
                bonusResults: {
                    botLevels: [8, 8, 8, 8],
                    levelUpUsedForBot: [false, false, false, false],
                    levelDownUsedForBot: [false, false, false, false],
                    charSelectUsedForBot: [false, false, false, false],
                    log: []
                }
            });
            currentMatch = await newMatch.save(); 
            currentPredictionId = null; 
        } catch (error) {
            console.error("[DB] Erreur lors de la création du Match DB:", error);
            return res.status(500).send({ message: `Erreur DB : Échec de la création du match. Détails: ${error.message}` });
        }
        
        console.log("[LOG] Match Démarré: En attente de pari Twitch. Récompenses CACHÉES.");
        for(const key in REWARD_IDS) {
            await updateRewardStatus(apiClient, REWARD_IDS[key], false, true); 
        }

        io.emit('game-status', { status: currentMatch.status, matchId: currentMatchId });
        res.send({ status: currentMatch.status, matchId: currentMatchId, message: `Attente du pari Twitch avec marqueur: ${GAME_PREDICTION_TITLE_MARKER}` });
    });


    // --- Route 2: DÉMARRER PHASE BONUS (Gérée par l'admin) ---
    app.post('/admin/start-bonus', 
        bodyParser.json(), 
        bodyParser.urlencoded({ extended: true }), 
        async (req, res) => {
        
        const duration = parseInt(req.body.duration || 60); // Durée du timer par défaut 60s
        
        if (!currentMatch || currentMatch.status !== 'BETTING') {
            return res.status(400).send({ message: "La phase bonus ne peut démarrer qu'après le lancement du pari Twitch (statut BETTING)." });
        }
        
        currentMatch.status = 'BONUS_ACTIVE';
        currentMatch = await currentMatch.save();

        console.log(`[LOG] Phase Bonus: Transition vers BONUS_ACTIVE. Démarrage du timer ${duration}s.`);
        
        // Activer les récompenses (visibles et activées)
        for(const key in REWARD_IDS) {
             await updateRewardStatus(apiClient, REWARD_IDS[key], true, false); 
        }
        
        setTimeout(async () => {
            if (currentMatch && currentMatch.status === 'BONUS_ACTIVE') {
                console.log("[TIMER] Fin du temps de bonus écoulé. Clôture des récompenses.");
                await closeBonusPhase();
            }
        }, duration * 1000);

        io.emit('game-status', { status: currentMatch.status, timer: duration });
        res.send({ status: 'BONUS_ACTIVE', timer: duration });
    });


    // --- Route 3: ARRÊTER PHASE BONUS MANUELLEMENT ---
    app.post('/admin/stop-bonus', async (req, res) => {
        if (!currentMatch || currentMatch.status !== 'BONUS_ACTIVE') {
            return res.status(400).send({ message: "Aucune phase bonus active à arrêter." });
        }
        await closeBonusPhase();
        res.send({ status: 'IN_PROGRESS', message: "Phase bonus arrêtée manuellement." });
    });
    
    // --- Route 4: CLÔTURER MATCH DB (Maintenant manuel pour l'admin) ---
    app.post('/admin/close-match', async (req, res) => {
        if (!currentMatch || currentMatch.status === 'CLOSED') {
            return res.status(400).send({ message: "Aucun match actif à clôturer." });
        }
        
        if (currentMatch.status === 'BONUS_ACTIVE') {
            await closeBonusPhase();
        }

        currentMatch.status = 'CLOSED';
        currentMatch = await currentMatch.save(); 
        currentPredictionId = null; 

        io.emit('game-status', { status: 'CLOSED' });
        res.send({ status: 'CLOSED', message: "Match DB clôturé." });
    });

    // --- Route 5: API CLASSEMENT POINTS (pour smashbettingshow.html) ---
    app.get('/api/classement/points', async (req, res) => {
        try {
            const classement = await User.find({})
                .sort({ totalPoints: -1 })
                .limit(20)
                .select('username totalPoints -_id');
            res.json(classement);
        } catch (error) {
            res.status(500).json({ message: "Erreur lors de la récupération du classement des points.", error });
        }
    });

    // --- Route 6: API CLASSEMENT BONUS (pour smashbettingshow.html) ---
    app.get('/api/classement/bonus', async (req, res) => {
        try {
            // Trie par nombre de bonus utilisés (le champ bonusUsedCount dans le modèle User)
            const classement = await User.find({})
                .sort({ bonusUsedCount: -1 })
                .limit(20)
                .select('username bonusUsedCount -_id');
            res.json(classement);
        } catch (error) {
            res.status(500).json({ message: "Erreur lors de la récupération du classement des bonus.", error });
        }
    });
    
    // --- Route 7: API ETAT DU MATCH ACTUEL (pour admin.html) ---
    app.get('/api/current-match', async (req, res) => {
        res.json(currentMatch || { status: 'CLOSED' });
    });

    return { closeBonusPhase };
}


// --- Logique EventSub ---

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
        const userInput = (event.input || '').trim();
        
        const usedReward = NEW_ALL_REWARDS.find(r => REWARD_IDS[r.key] === rewardId);
        if (!usedReward) return;
        
        const rewardKey = usedReward.key;
        let isSuccess = false;
        let logMessage = '';

        // --- Logique Level Up / Level Down / Choix Perso ---
        if (currentMatch.status === 'BONUS_ACTIVE') {
            
            if (rewardKey === 'LEVEL_UP' || rewardKey === 'LEVEL_DOWN') {
                const isUp = rewardKey === 'LEVEL_UP';
                const botIndexInput = parseInt(userInput); 
                const botIndex = botIndexInput - 1; 

                if (isNaN(botIndexInput) || botIndexInput < 1 || botIndexInput > 4) {
                    logMessage = `Échec: Entrée invalide "${userInput}". Utilisez un chiffre entre 1 et 4.`;
                } else {
                    const usedArray = isUp ? currentMatch.bonusResults.levelUpUsedForBot : currentMatch.bonusResults.levelDownUsedForBot;
                    
                    if (usedArray[botIndex] === true) {
                        logMessage = `Échec: Bot ${botIndexInput} déjà Level ${isUp ? 'UP' : 'DOWN'} ce match.`;
                    } else {
                        usedArray[botIndex] = true;
                        logMessage = `Succès: Bot ${botIndexInput} Level ${isUp ? 'UP' : 'DOWN'}.`;
                        isSuccess = true;
                    }
                }

            } else if (rewardKey === 'CHOIX_PERSO') {
                const parts = userInput.split(' ');
                const botIndexInput = parseInt(parts[0]);
                const characterName = parts.slice(1).join(' ').trim();
                const botIndex = botIndexInput - 1;

                if (isNaN(botIndexInput) || botIndexInput < 1 || botIndexInput > 4 || !characterName) {
                     logMessage = `Échec: Format invalide "${userInput}". Utilisez: [1-4] [Nom Personnage].`;
                } else if (currentMatch.bonusResults.charSelectUsedForBot[botIndex] === true) {
                     logMessage = `Échec: Personnage pour Bot ${botIndexInput} déjà sélectionné.`;
                } else {
                     currentMatch.bonusResults.charSelectUsedForBot[botIndex] = true;
                     logMessage = `Succès: Bot ${botIndexInput} assigné à ${characterName}.`;
                     isSuccess = true;
                }
            }
        } else {
            logMessage = `Échec: La phase bonus n'est pas active.`;
        }

        
        // Finalisation
        if (isSuccess) {
            // Log de la récompense
            currentMatch.bonusResults.log.push({
                user: userDisplayName,
                userId: userId,
                reward: rewardKey,
                input: userInput,
                timestamp: new Date()
            });
            
            // Incrémenter le compteur de bonus de l'utilisateur
            await User.findOneAndUpdate(
                 { twitchId: userId },
                 { $inc: { bonusUsedCount: 1 }, $setOnInsert: { username: userDisplayName } },
                 { upsert: true }
            );

            // Confirmer l'action auprès de l'utilisateur (pour le front)
            io.emit('bonus-update', { 
                type: rewardKey, 
                user: userDisplayName, 
                input: userInput, 
                isSuccess: true 
            });

            // Dire à Twitch de valider la récompense (et potentiellement la rembourser s'il y a un bogue)
            // Laissez Twitch gérer cela si c'est une récompense auto-fulfill
            console.log(`[REWARD SUCCESS] ${logMessage} Utilisateur: ${userDisplayName}`);

        } else {
            console.warn(`[REWARD FAILED] ${logMessage} Utilisateur: ${userDisplayName}`);
            // Pas d'action si échec, l'utilisateur est censé être remboursé par Twitch si le code n'est pas "fulfillé".
            // Pour l'instant, on ne fait rien et on compte sur le remboursement automatique.
            io.emit('bonus-update', { 
                type: rewardKey, 
                user: userDisplayName, 
                input: userInput, 
                isSuccess: false,
                message: logMessage
            });
        }

        currentMatch = await currentMatch.save();
    });


    // ********** ÉCOUTE DES PARIS TWITCH (Predictions) **********

    listener.onChannelPredictionBegin(channelUserId, async (event) => {
        if (!event.title.startsWith(GAME_PREDICTION_TITLE_MARKER)) {
            console.log(`[PREDICTION IGNORED] Pari sans marqueur : ${event.title}`);
            return;
        }

        console.log(`[PREDICTION TRACKED] Pari de jeu commencé: ${event.title} (ID: ${event.id})`);

        if (currentMatch && currentMatch.status === 'AWAITING_PREDICTION') {
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

    listener.onChannelPredictionEnd(channelUserId, async (event) => {
        if (event.id === currentPredictionId && currentMatch && currentMatch.status !== 'CLOSED') {
            
            console.log(`[PREDICTION] Pari terminé (ID: ${event.id}). Statut final: ${event.status}.`);

            if (event.status === 'RESOLVED' && event.winningOutcome) {
                const winningOutcomeTitle = event.winningOutcome.title;
                const winningOutcomeId = event.winningOutcome.id;
                
                console.log(`[PAYOUT CONFIRMATION] Gagnant: ${winningOutcomeTitle}. Calcul des points...`);
                
                const prediction = await apiClient.predictions.getPredictionById(channelUserId, event.id);
                const winningOutcome = prediction.outcomes.find(o => o.id === winningOutcomeId);

                if (winningOutcome && winningOutcome.users) {
                    let usersAwarded = 0;
                    
                    // L'EventSub PredictionEnd ne donne pas tous les parieurs, mais getPredictionById OUI.
                    // Nous parcourons tous les résultats pour trouver les utilisateurs du résultat gagnant.
                    
                    // Note: Twurple PredictionOutcome fournit une liste de "topPredictors" simplifiée.
                    // Pour le classement complet, nous supposons que tous les parieurs ont misé pour un montant.
                    
                    // Simple logic: Award 1 point to all users who participated in the winning outcome's top predictors
                    for (const predictor of winningOutcome.topPredictors) { 
                        await User.findOneAndUpdate(
                            { twitchId: predictor.userId },
                            { $inc: { totalPoints: 1 }, $setOnInsert: { username: predictor.userName } }, 
                            { upsert: true }
                        );
                        usersAwarded++;
                    }
                    console.log(`[POINTS] ${usersAwarded} utilisateurs récompensés par 1 point (basé sur top predictors).`);
                }
                
                // Clôture automatique du match DB
                currentMatch.status = 'CLOSED';
                // Essaie d'extraire le numéro du bot (Choix X)
                currentMatch.winnerBot = winningOutcomeTitle.match(/\d/)?.[0] || 'N/A';
                currentMatch = await currentMatch.save(); 
                currentPredictionId = null; 

                io.emit('game-status', { status: 'CLOSED', winner: currentMatch.winnerBot });
                io.emit('prediction-status', { id: event.id, status: event.status, winner: winningOutcomeTitle });
                
            } else {
                 // Si pari annulé ou autre statut non résolu
                 io.emit('prediction-status', { id: event.id, status: event.status });
            }
        }
    });

    return listener;
}


// --- Fonction Principale (Main) ---

async function main() {
    await connectDB();
    
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
    
    const { closeBonusPhase } = setupAdminRoutes(app, apiClient, io);
    
    const listener = setupEventSub(app, apiClient, io, closeBonusPhase);
    
    try {
        await listener.markAsReady();
    } catch (e) {
        console.warn(`[EVENT SUB] Erreur au démarrage du listener: ${e.message}`);
    }

    httpServer.listen(PORT, () => {
        console.log(`\n🚀 Serveur lancé sur http://localhost:${PORT}`);
    });

    io.on('connection', (socket) => {
        console.log('Client connecté. Envoi de l’état actuel...');
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