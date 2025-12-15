// index.js (Intégral avec FIXES)

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
const mongoose = require('mongoose');
const fetch = require('node-fetch'); // <-- 1. AJOUT DE NODE-FETCH

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
const PORT = process.env.PORT || 3000;

// Nom du fichier de tokens
const TOKEN_FILE_PATH = path.join(__dirname, 'tokens.json');

// NOUVEAUX Noms de récompenses simplifiées (définies dans .env: LU, LD, CP)
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

// --- Fonctions Utilitaires de Jeu ---

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

// Fonction de lecture seule des IDs
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
        } else {
            console.error(`❌ ERREUR CRITIQUE: Récompense "${reward.name}" introuvable sur Twitch.`);
            allFound = false;
        }
    }
    
    if (!allFound) {
         console.error("ATTENTION: Toutes les récompenses nécessaires n'ont pas été trouvées. Le jeu pourrait ne pas fonctionner.");
    }

    return Object.keys(REWARD_IDS).length;
}

// FIX: Nouvelle fonction utilitaire pour le remboursement (utilise FETCH avec jeton frais)
async function refundRedemption(apiClient, authProvider, rewardId, redemptionId) {
    
    // Obtenir le jeton d'accès le plus frais (étape critique)
    const { accessToken } = await authProvider.getAccessToken(channelUserId); 

    try {
        const twitchUrl = `https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions`;
        
        const response = await fetch(twitchUrl, {
            method: 'PATCH',
            headers: {
                'Client-ID': apiClient.options.clientId,
                'Authorization': `Bearer ${accessToken}`, // Utilisation du jeton le plus frais
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                broadcaster_id: channelUserId,
                reward_id: rewardId,
                id: redemptionId,
                status: 'CANCELED' 
            }),
        });
        
        const responseText = await response.text();

        if (response.status !== 200) {
            console.error(`[TWITCH API REFUND FORCE] ÉCHEC HTTP ${response.status}:`, responseText);
            // Si le jeton est mauvais, cette erreur sera lancée
            throw new Error(`Échec du remboursement: ${response.status} - ${JSON.parse(responseText).message || responseText}`);
        }
        return true;
    } catch (e) {
        throw e;
    }
}


// --- Routes d'Administration et API ---

function setupAdminRoutes(app, apiClient, io) {
    // ... (Reste des routes admin inchangé)
    
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

    // --- Reste des routes admin inchangé ---
    app.post('/admin/start-match', bodyParser.json(), bodyParser.urlencoded({ extended: true }), async (req, res) => {
        // ... (Logique inchangée)
    });

    app.post('/admin/start-bonus', bodyParser.json(), bodyParser.urlencoded({ extended: true }), async (req, res) => {
        // ... (Logique inchangée)
    });

    app.post('/admin/stop-bonus', async (req, res) => {
        // ... (Logique inchangée)
    });
    
    app.post('/admin/close-match', async (req, res) => {
        // ... (Logique inchangée)
    });

    app.get('/api/classement/points', async (req, res) => {
        // ... (Logique inchangée)
    });

    app.get('/api/classement/bonus', async (req, res) => {
        // ... (Logique inchangée)
    });
    
    app.get('/api/current-match', async (req, res) => {
        // ... (Logique inchangée)
    });

    return { closeBonusPhase };
}


// --- Logique EventSub ---

// FIX: setupEventSub doit maintenant accepter authProvider
function setupEventSub(app, apiClient, io, closeBonusPhase, authProvider) { 
    const listener = new EventSubMiddleware({
        apiClient,
        hostName: hostName || 'localhost', 
        pathPrefix: '/twitch-events',
        secret: eventSubSecret || 'secret'
    });
    
    listener.apply(app);

    // ********** ÉCOUTE DES BONUS DE POINTS DE CHAÎNE (Reward) **********
    listener.onChannelRedemptionAdd(channelUserId, async (event) => {
        if (!currentMatch || currentMatch.status !== 'BONUS_ACTIVE') { 
            return; 
        }
        
        const rewardId = event.rewardId;
        const userId = event.userId;
        const userDisplayName = event.userDisplayName;
        const userInput = (event.input || '').trim();
        
        const usedReward = NEW_ALL_REWARDS.find(r => REWARD_IDS[r.key] === rewardId);
        if (!usedReward) return;
        
        const rewardKey = usedReward.key;
        let isSuccess = false;
        let logMessage = '';

        
        // --- Logique Level Up / Level Down / Choix Perso (Inchangé) ---
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

        
        // Finalisation
        if (isSuccess) {
            
            // Logique des niveaux (Point 5 - Inchangé)
            if (rewardKey === 'LEVEL_UP' || rewardKey === 'LEVEL_DOWN') {
                const isUp = rewardKey === 'LEVEL_UP';
                const botIndex = parseInt(userInput) - 1; 
                
                if (isUp) {
                    currentMatch.bonusResults.botLevels[botIndex] = 
                        Math.min(currentMatch.bonusResults.botLevels[botIndex] + 1, BOT_LEVEL_MAX);
                } else {
                    currentMatch.bonusResults.botLevels[botIndex] = 
                        Math.max(currentMatch.bonusResults.botLevels[botIndex] - 1, 1);
                }
            }
            
            // ... (Logique DB et incrémentation des compteurs inchangée)
            
            // Log interne au Match
            currentMatch.bonusResults.log.push({
                user: userDisplayName,
                userId: userId,
                reward: rewardKey,
                input: userInput,
                timestamp: new Date()
            });

            // Logique d'incrémentation des bonus par type
            let updateQuery = { $inc: { bonusUsedCount: 1 }, $setOnInsert: { username: userDisplayName } };
            const countKey = rewardKey === 'LEVEL_UP' ? 'luCount' : 
                             (rewardKey === 'LEVEL_DOWN' ? 'ldCount' : 'cpCount');
            updateQuery.$inc[countKey] = 1;
            
            await User.findOneAndUpdate(
                 { twitchId: userId },
                 updateQuery,
                 { upsert: true }
            );

            // Logique d'écriture du log historique 
            const logEntry = new BonusLog({
                matchId: currentMatch.matchId,
                userId: userId,
                bonusType: rewardKey,
                targetBot: (rewardKey === 'LEVEL_UP' || rewardKey === 'LEVEL_DOWN') ? parseInt(userInput) : null,
                input: userInput
            });
            await logEntry.save();
            
            io.emit('bonus-update', { 
                type: rewardKey, 
                user: userDisplayName, 
                input: userInput, 
                isSuccess: true 
            });

            // FIX: Force la mise à jour de l'UI Admin (Niveaux)
            io.emit('game-status', { 
                status: currentMatch.status, 
                matchId: currentMatch.matchId,
                twitchPredictionId: currentMatch.twitchPredictionId,
                bonusResults: currentMatch.bonusResults
            });

            console.log(`[REWARD SUCCESS] ${logMessage} Utilisateur: ${userDisplayName}`);

        } else {
            console.warn(`[REWARD FAILED] ${logMessage} Utilisateur: ${userDisplayName}`);
            
            // ⭐️ FIX: Logique de remboursement avec la fonction utilitaire PATCH ⭐️
            try {
                // Utilise la fonction avec l'authProvider
                await refundRedemption(apiClient, authProvider, rewardId, event.id); 
                logMessage += " => REMBOURSÉ.";
                console.log(`[REFUND] Rachat de ${userDisplayName} remboursé.`);
            } catch (refundError) {
                logMessage += " => ERREUR DE REMBOURSEMENT.";
                console.error(`[ERROR] Échec du remboursement du rachat ${event.id}:`, refundError);
            }
            
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
        // ... (Logique inchangée)
    });

    listener.onChannelPredictionProgress(channelUserId, async (event) => {
        // ... (Logique inchangée)
    });


    listener.onChannelPredictionEnd(channelUserId, async (event) => {
        if (event.id === currentPredictionId && currentMatch && currentMatch.status !== 'CLOSED') {
            
            console.log(`[PREDICTION] Pari terminé (ID: ${event.id}). Statut final: ${event.status}.`);

            if (event.status === 'RESOLVED' && event.winningOutcome) {
                const winningOutcomeTitle = event.winningOutcome.title;
                const winningOutcomeId = event.winningOutcome.id;
                
                // ⭐️ FIX: Débogage pour vérifier si on entre dans le bloc de clôture ⭐️
                console.log(`[DEBUG] Tentative de clôture DB: Titre Gagnant reçu: "${winningOutcomeTitle}"`);

                try {
                    // 1. Obtenir les détails complets du pari (utilise jeton frais via Twurple)
                    const prediction = await apiClient.predictions.getPredictionById(channelUserId, event.id);
                    const winningOutcome = prediction.outcomes.find(o => o.id === winningOutcomeId);

                    if (!winningOutcome) {
                        console.error("[ERROR] Échec de l'extraction de l'objet gagnant du pari. Abandon de la clôture DB.");
                        return; 
                    }

                    // 2. Attribution des points aux gagnants (Inchagé)
                    const winnerParticipants = winningOutcome.users || winningOutcome.topPredictors || [];
                    let usersAwarded = 0;

                    for (const participant of winnerParticipants) { 
                        await User.findOneAndUpdate(
                            { twitchId: participant.userId },
                            { $inc: { totalPoints: 1 }, $setOnInsert: { username: participant.userName } }, 
                            { upsert: true }
                        );
                        usersAwarded++;
                    }
                    console.log(`[POINTS] ${usersAwarded} utilisateurs récompensés par 1 point.`);
                    
                    // 3. Clôture automatique et extraction du vainqueur 
                    currentMatch.status = 'CLOSED';
                    
                    const matchResult = winningOutcomeTitle.match(/Choix\s*(\d+)/i);
                    if (matchResult && matchResult[1]) {
                        currentMatch.winnerBot = parseInt(matchResult[1]);
                    } else {
                        currentMatch.winnerBot = null;
                        console.warn(`[WARNING] Échec de la regex pour trouver "Choix X". WinnerBot reste NULL.`);
                    }
                    
                    currentMatch = await currentMatch.save(); 
                    currentPredictionId = null; 

                    io.emit('game-status', { status: 'CLOSED', winner: currentMatch.winnerBot });
                    io.emit('prediction-status', { id: event.id, status: event.status, winner: winningOutcomeTitle });

                } catch (apiError) {
                    console.error("[ERROR] ÉCHEC CRITIQUE lors de la récupération des détails du pari pour clôture (getPredictionById). L'API a retourné:", apiError);
                    console.error("Le jeton d'utilisateur a probablement expiré. Le match DB DOIT être clôturé manuellement.");
                    return; 
                }
                
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
    
    // ... (Logique de reprise de match inchangée)
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
    
    // FIX: Passer authProvider à setupEventSub
    const listener = setupEventSub(app, apiClient, io, closeBonusPhase, authProvider); 
    
    try {
        await listener.markAsReady();
    } catch (e) {
        console.warn(`[EVENT SUB] Erreur au démarrage du listener: ${e.message}`);
    }

    httpServer.listen(PORT, () => {
        console.log(`\n🚀 Serveur lancé sur http://localhost:${PORT}`);
    });

    io.on('connection', (socket) => {
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