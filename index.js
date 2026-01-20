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
const fetch = require('node-fetch');

const connectDB = require('./db'); 
const { User, Match, BonusLog } = require('./models');

// --- Configuration ---
const clientId = process.env.TWITCH_CLIENT_ID;
const clientSecret = process.env.TWITCH_CLIENT_SECRET;
const channelUserId = process.env.CHANNEL_USER_ID; 
const eventSubSecret = process.env.EVENTSUB_SECRET;
const hostName = process.env.HOSTNAME; 
const PORT = process.env.PORT || 3000;
const TOKEN_FILE_PATH = path.join(__dirname, 'tokens.json');

const NEW_ALL_REWARDS = [
    { name: process.env.REWARD_NAME_LEVEL_UP, key: 'LEVEL_UP' },
    { name: process.env.REWARD_NAME_LEVEL_DOWN, key: 'LEVEL_DOWN' },
    { name: process.env.REWARD_NAME_CHOIX_PERSO, key: 'CHOIX_PERSO' }
];

let currentMatchId = 0; 
let currentMatch = null; 
let currentPredictionId = null; 
let lastPredictionData = null; 
const BOT_LEVEL_MAX = 9;
const REWARD_IDS = {}; 
const GAME_PREDICTION_TITLE_MARKER = process.env.GAME_PREDICTION_TITLE_MARKER || "[SMASH BET]"; 

// --- Authentification ---
async function getAuthProvider() {
    let tokenData = null;
    try {
        const data = await fs.readFile(TOKEN_FILE_PATH, 'utf-8');
        tokenData = JSON.parse(data);
    } catch (e) {
        if (process.env.INITIAL_ACCESS_TOKEN) {
            tokenData = { 
                accessToken: process.env.INITIAL_ACCESS_TOKEN, 
                refreshToken: process.env.INITIAL_REFRESH_TOKEN, 
                expiresIn: 0, 
                obtainmentTimestamp: 0 
            };
        }
    }
    const authProvider = new RefreshingAuthProvider({
        clientId, clientSecret,
        onRefresh: async (userId, newTokenData) => {
            await fs.writeFile(TOKEN_FILE_PATH, JSON.stringify(newTokenData, null, 4), 'utf-8');
        }
    });
    await authProvider.addUserForToken(tokenData, ['chat']);
    return authProvider;
}

// --- Utilitaires ---
async function updateRewardStatus(apiClient, rewardId, isEnabled, isHidden) {
    if (!rewardId) return;
    try {
        await apiClient.channelPoints.updateCustomReward(channelUserId, rewardId, { isEnabled, isHidden });
    } catch (e) { console.error(`[Twitch API] Erreur reward ${rewardId}:`, e.message); }
}

async function mapRewardNamesToIds(apiClient) {
    const twitchRewards = await apiClient.channelPoints.getCustomRewards(channelUserId);
    NEW_ALL_REWARDS.forEach(r => {
        const found = twitchRewards.find(tr => tr.title.toLowerCase() === r.name.toLowerCase());
        if (found) REWARD_IDS[r.key] = found.id;
    });
    return Object.keys(REWARD_IDS).length;
}

async function refundRedemption(apiClient, authProvider, rewardId, redemptionId) {
    console.log(`[REFUND-LOG] Début tentative: Reward=${rewardId}, ID=${redemptionId}`);
    try {
        const token = await authProvider.getAccessTokenForUser(channelUserId);
        if (!token || !token.accessToken) return false;
        
        const url = `https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions?broadcaster_id=${channelUserId}&reward_id=${rewardId}&id=${redemptionId}`;
        const response = await fetch(url, {
            method: 'PATCH',
            headers: { 'Client-ID': clientId, 'Authorization': `Bearer ${token.accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'CANCELED' }),
        });
        return response.status === 200;
    } catch (e) { return false; }
}

// --- Routes Admin ---
function setupAdminRoutes(app, apiClient, io) {
    const closeBonusPhase = async () => {
        if (currentMatch && currentMatch.status === 'BONUS_ACTIVE') {
            currentMatch.status = 'IN_PROGRESS';
            
            // ⭐️ CALCUL FINAL DES NIVEAUX SELON LES COMPTEURS ⭐️
            // Si compteur entre -10 et -7 -> Niv 7
            // Si compteur entre -6 et +6 -> Niv 8
            // Si compteur entre +7 et +10 -> Niv 9
            if (currentMatch.bonusResults.botCounters) {
                currentMatch.bonusResults.botCounters.forEach((val, idx) => {
                    let finalLevel = 8;
                    if (val <= -7) finalLevel = 7;
                    if (val >= 7) finalLevel = 9;
                    currentMatch.bonusResults.botLevels[idx] = finalLevel;
                });
            }

            currentMatch = await currentMatch.save(); 
            for(const key in REWARD_IDS) await updateRewardStatus(apiClient, REWARD_IDS[key], false, true); 
            io.emit('game-status', currentMatch); 
        }
    };

    app.post('/admin/start-match', bodyParser.json(), async (req, res) => {
        if (currentMatch && currentMatch.status !== 'CLOSED') return res.status(400).send("Match en cours.");
        const last = await Match.findOne({}).sort({ matchId: -1 });
        currentMatchId = last ? last.matchId + 1 : 1;
        
        currentMatch = new Match({
            matchId: currentMatchId, status: 'AWAITING_PREDICTION',
            bonusResults: { 
                botLevels: [8,8,8,8], 
                botCounters: [0,0,0,0], // ⭐️ NOUVEAU: Compteurs pour la barre de progression (-10 à +10)
                charSelectUsedForBot: [false,false,false,false], 
                log: [] 
            }
        });
        lastPredictionData = null; 
        await currentMatch.save();
        io.emit('game-status', currentMatch);
        res.send({ status: 'OK' });
    });

    app.post('/admin/start-bonus', bodyParser.json(), async (req, res) => {
        const duration = parseInt(req.body.duration) || 20; 
        if (!currentMatch || currentMatch.status !== 'BETTING') return res.status(400).send("Pari non lancé.");
        currentMatch.status = 'BONUS_ACTIVE';
        await currentMatch.save();
        for(const key in REWARD_IDS) await updateRewardStatus(apiClient, REWARD_IDS[key], true, false); 
        if (global.bonusTimeout) clearTimeout(global.bonusTimeout);
        global.bonusTimeout = setTimeout(closeBonusPhase, duration * 1000);
        io.emit('game-status', currentMatch);
        res.send({ status: 'OK' });
    });

    app.post('/admin/stop-bonus', async (req, res) => {
        await closeBonusPhase();
        res.send({ status: 'IN_PROGRESS' });
    });

    app.post('/admin/close-match', async (req, res) => {
        if (currentMatch) {
            currentMatch.status = 'CLOSED';
            await currentMatch.save();
            io.emit('game-status', currentMatch);
        }
        res.send({ status: 'OK' });
    });

    // Routes API Classement
    app.get('/api/classement/points', async (req, res) => {
        try { res.json(await User.find({}).sort({ totalPoints: -1 }).limit(20).select('username totalPoints -_id')); } 
        catch (e) { res.status(500).send(e.message); }
    });

    app.get('/api/classement/bonus', async (req, res) => {
        try { res.json(await User.find({}).sort({ bonusUsedCount: -1 }).limit(20).select('username bonusUsedCount luCount ldCount cpCount -_id')); } 
        catch (e) { res.status(500).send(e.message); }
    });

    app.get('/api/current-match', async (req, res) => res.json(currentMatch || { status: 'CLOSED' }));

    return { closeBonusPhase };
}

// --- EventSub ---
function setupEventSub(app, apiClient, io, closeBonusPhase, authProvider) { 
    const listener = new EventSubMiddleware({ apiClient, hostName, pathPrefix: '/twitch-events', secret: eventSubSecret });
    listener.apply(app);

    listener.onChannelRedemptionAdd(channelUserId, async (event) => {
        if (!currentMatch || currentMatch.status !== 'BONUS_ACTIVE') return;
        const rewardKey = Object.keys(REWARD_IDS).find(k => REWARD_IDS[k] === event.rewardId);
        if (!rewardKey) return;
        const input = (event.input || '').trim();
        let success = false;
        let logMsg = "";

        // ⭐️ LOGIQUE LEVEL UP / DOWN (SPAM & BORNES) ⭐️
        if (rewardKey === 'LEVEL_UP' || rewardKey === 'LEVEL_DOWN') {
            const idx = parseInt(input) - 1;
            const isUp = rewardKey === 'LEVEL_UP';
            
            if (idx >= 0 && idx <= 3) {
                // Initialisation sécu si pas encore créé
                if (!currentMatch.bonusResults.botCounters) currentMatch.bonusResults.botCounters = [0,0,0,0];
                
                let currentVal = currentMatch.bonusResults.botCounters[idx];

                // Vérification des bornes
                if (isUp) {
                    if (currentVal < 10) {
                        currentMatch.bonusResults.botCounters[idx] += 1;
                        success = true;
                    } else {
                        logMsg = "Max (+10) atteint.";
                    }
                } else {
                    if (currentVal > -10) {
                        currentMatch.bonusResults.botCounters[idx] -= 1;
                        success = true;
                    } else {
                        logMsg = "Min (-10) atteint.";
                    }
                }
            } else logMsg = "Chiffre 1-4 requis.";
        
        // ⭐️ LOGIQUE CHOIX PERSO (VALIDATION SYNTAXE) ⭐️
        } else if (rewardKey === 'CHOIX_PERSO') {
            // Regex: Chiffre(s) + Espace + Au moins un caractère qui n'est pas un espace
            if (/^\d+\s+\S+/.test(input)) {
                const botIdx = parseInt(input.split(' ')[0]) - 1;
                if (botIdx >= 0 && botIdx <= 3 && !currentMatch.bonusResults.charSelectUsedForBot[botIdx]) {
                    currentMatch.bonusResults.charSelectUsedForBot[botIdx] = true;
                    success = true;
                } else logMsg = "Ordi invalide ou déjà pris.";
            } else {
                logMsg = "Format invalide (Ex: '2 Mario').";
            }
        }

        if (success) {
            currentMatch.bonusResults.log.push({ user: event.userDisplayName, userId: event.userId, reward: rewardKey, input });
            const countKey = rewardKey === 'LEVEL_UP' ? 'luCount' : (rewardKey === 'LEVEL_DOWN' ? 'ldCount' : 'cpCount');
            await User.findOneAndUpdate({ twitchId: event.userId }, { $inc: { bonusUsedCount: 1, [countKey]: 1 }, $setOnInsert: { username: event.userDisplayName } }, { upsert: true });
            await (new BonusLog({ matchId: currentMatch.matchId, userId: event.userId, bonusType: rewardKey, input })).save();
            io.emit('bonus-update', { type: rewardKey, user: event.userDisplayName, input, isSuccess: true });
            io.emit('game-status', currentMatch); // Met à jour l'overlay immédiatement
        } else {
            const isRefunded = await refundRedemption(apiClient, authProvider, event.rewardId, event.id);
            io.emit('bonus-update', { type: rewardKey, user: event.userDisplayName, input: input || "N/A", isSuccess: false, message: logMsg + (isRefunded ? " (Remboursé)" : "") });
        }
        
        // On marque le tableau modifié pour Mongoose car c'est un tableau de Primitives
        currentMatch.markModified('bonusResults.botCounters');
        await currentMatch.save();
    });

    listener.onChannelPredictionBegin(channelUserId, async (event) => {
        if (event.title.startsWith(GAME_PREDICTION_TITLE_MARKER) && currentMatch?.status === 'AWAITING_PREDICTION') {
            currentMatch.twitchPredictionId = event.id;
            currentMatch.status = 'BETTING';
            await currentMatch.save();
            currentPredictionId = event.id;
            io.emit('game-status', currentMatch);
        }
    });

    listener.onChannelPredictionProgress(channelUserId, (event) => {
        lastPredictionData = event.outcomes.map(o => ({
            title: o.title,
            channelPoints: o.channelPoints,
            users: o.users
        }));
        io.emit('prediction-progress', lastPredictionData);
    });

    listener.onChannelPredictionEnd(channelUserId, async (event) => {
        if (event.id === currentPredictionId && currentMatch) {
            if (event.status.toLowerCase() === 'resolved' && event.winningOutcome) {
                try {
                    const prediction = await apiClient.predictions.getPredictionById(channelUserId, event.id);
                    const outcome = prediction.outcomes.find(o => o.id === event.winningOutcome.id);
                    if (outcome) {
                        const voters = outcome.topPredictors || []; 
                        for (const v of voters) {
                            if (v.userId) await User.findOneAndUpdate({ twitchId: v.userId }, { $inc: { totalPoints: 1 }, $setOnInsert: { username: v.userName } }, { upsert: true });
                        }
                    }
                    currentMatch.status = 'CLOSED';
                    const matchRes = event.winningOutcome.title.match(/(?:choix|bot|ordi|ordinateur)?\s*(\d+)/i);
                    currentMatch.winnerBot = matchRes ? parseInt(matchRes[1]) : null;
                    await currentMatch.save();
                    currentPredictionId = null;
                    io.emit('game-status', currentMatch);
                } catch (e) { console.error("Erreur clôture:", e.message); }
            }
        }
    });
    return listener;
}

// --- Main ---
async function main() {
    await connectDB();
    const lastMatch = await Match.findOne({}).sort({ matchId: -1 });
    if (lastMatch) {
        currentMatch = lastMatch; 
        currentMatchId = lastMatch.matchId;
        currentPredictionId = lastMatch.twitchPredictionId;
    }
    const app = express();
    const httpServer = createServer(app);
    const io = new Server(httpServer);
    app.use(express.static('public'));
    const authProvider = await getAuthProvider();
    const apiClient = new ApiClient({ authProvider });
    await mapRewardNamesToIds(apiClient);
    const { closeBonusPhase } = setupAdminRoutes(app, apiClient, io);
    const listener = setupEventSub(app, apiClient, io, closeBonusPhase, authProvider);

    io.on('connection', (socket) => {
        if (currentMatch) socket.emit('game-status', currentMatch);
        if (lastPredictionData) socket.emit('prediction-progress', lastPredictionData);
    });

    await listener.markAsReady();
    httpServer.listen(PORT, () => console.log(`🚀 Serveur actif port ${PORT}`));
}
main().catch(console.error);