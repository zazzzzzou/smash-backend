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

let currentMatch = null; 
let lastPredictionData = null; // Mémoire pour l'overlay
const REWARD_IDS = {}; 
const GAME_PREDICTION_TITLE_MARKER = process.env.GAME_PREDICTION_TITLE_MARKER || "[SMASH BET]"; 

async function getAuthProvider() {
    let tokenData = null;
    try {
        const data = await fs.readFile(TOKEN_FILE_PATH, 'utf-8');
        tokenData = JSON.parse(data);
    } catch (e) {
        if (process.env.INITIAL_ACCESS_TOKEN) {
            tokenData = { accessToken: process.env.INITIAL_ACCESS_TOKEN, refreshToken: process.env.INITIAL_REFRESH_TOKEN, expiresIn: 0, obtainmentTimestamp: 0 };
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

async function updateRewardStatus(apiClient, rewardId, isEnabled, isHidden) {
    if (!rewardId) return;
    try { await apiClient.channelPoints.updateCustomReward(channelUserId, rewardId, { isEnabled, isHidden }); } 
    catch (e) { console.error(`[Twitch API] Erreur reward ${rewardId}:`, e.message); }
}

async function mapRewardNamesToIds(apiClient) {
    const twitchRewards = await apiClient.channelPoints.getCustomRewards(channelUserId);
    NEW_ALL_REWARDS.forEach(r => {
        const found = twitchRewards.find(tr => tr.title.toLowerCase() === r.name.toLowerCase());
        if (found) REWARD_IDS[r.key] = found.id;
    });
}

async function refundRedemption(apiClient, authProvider, rewardId, redemptionId) {
    try {
        const token = await authProvider.getAccessTokenForUser(channelUserId);
        const url = `https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions?broadcaster_id=${channelUserId}&reward_id=${rewardId}&id=${redemptionId}`;
        const response = await fetch(url, {
            method: 'PATCH',
            headers: { 'Client-ID': clientId, 'Authorization': `Bearer ${token.accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'CANCELED' }),
        });
        return response.status === 200;
    } catch (e) { return false; }
}

function setupAdminRoutes(app, apiClient, io) {
    const closeBonusPhase = async () => {
        if (currentMatch && currentMatch.status === 'BONUS_ACTIVE') {
            currentMatch.status = 'IN_PROGRESS';
            await currentMatch.save(); 
            for(const key in REWARD_IDS) await updateRewardStatus(apiClient, REWARD_IDS[key], false, true); 
            io.emit('game-status', currentMatch);
        }
    };

    app.post('/admin/start-match', bodyParser.json(), async (req, res) => {
        const last = await Match.findOne({}).sort({ matchId: -1 });
        currentMatch = new Match({
            matchId: last ? last.matchId + 1 : 1, status: 'AWAITING_PREDICTION',
            bonusResults: { botLevels: [8,8,8,8], levelUpUsedForBot: [false,false,false,false], levelDownUsedForBot: [false,false,false,false], charSelectUsedForBot: [false,false,false,false], log: [] }
        });
        lastPredictionData = null; // Reset votes
        await currentMatch.save();
        io.emit('game-status', currentMatch);
        res.send({ status: 'OK' });
    });

    app.post('/admin/start-bonus', bodyParser.json(), async (req, res) => {
        const duration = parseInt(req.body.duration) || 20; 
        currentMatch.status = 'BONUS_ACTIVE';
        await currentMatch.save();
        for(const key in REWARD_IDS) await updateRewardStatus(apiClient, REWARD_IDS[key], true, false); 
        if (global.bonusTimeout) clearTimeout(global.bonusTimeout);
        global.bonusTimeout = setTimeout(closeBonusPhase, duration * 1000);
        io.emit('game-status', currentMatch);
        res.send({ status: 'OK' });
    });

    app.post('/admin/stop-bonus', async (req, res) => { await closeBonusPhase(); res.send({ status: 'OK' }); });

    app.post('/admin/close-match', async (req, res) => {
        currentMatch.status = 'CLOSED';
        await currentMatch.save();
        io.emit('game-status', currentMatch);
        res.send({ status: 'OK' });
    });

    app.get('/api/current-match', async (req, res) => res.json(currentMatch || { status: 'CLOSED' }));
    return { closeBonusPhase };
}

function setupEventSub(app, apiClient, io, closeBonusPhase, authProvider) { 
    const listener = new EventSubMiddleware({ apiClient, hostName, pathPrefix: '/twitch-events', secret: eventSubSecret });
    listener.apply(app);

    listener.onChannelRedemptionAdd(channelUserId, async (event) => {
        if (!currentMatch || currentMatch.status !== 'BONUS_ACTIVE') return;
        const rewardKey = Object.keys(REWARD_IDS).find(k => REWARD_IDS[k] === event.rewardId);
        if (!rewardKey) return;
        const input = (event.input || '').trim();
        let success = false;

        if (rewardKey === 'LEVEL_UP' || rewardKey === 'LEVEL_DOWN') {
            const idx = parseInt(input) - 1;
            if (idx >= 0 && idx <= 3) {
                const arr = (rewardKey === 'LEVEL_UP') ? currentMatch.bonusResults.levelUpUsedForBot : currentMatch.bonusResults.levelDownUsedForBot;
                if (!arr[idx]) {
                    arr[idx] = true;
                    currentMatch.bonusResults.botLevels[idx] += (rewardKey === 'LEVEL_UP' ? 1 : -1);
                    currentMatch.bonusResults.botLevels[idx] = Math.max(1, Math.min(9, currentMatch.bonusResults.botLevels[idx]));
                    success = true;
                }
            }
        } else if (rewardKey === 'CHOIX_PERSO') {
            const botIdx = parseInt(input.split(' ')[0]) - 1;
            if (botIdx >= 0 && botIdx <= 3 && !currentMatch.bonusResults.charSelectUsedForBot[botIdx]) {
                currentMatch.bonusResults.charSelectUsedForBot[botIdx] = true;
                success = true;
            }
        }

        if (success) {
            currentMatch.bonusResults.log.push({ user: event.userDisplayName, reward: rewardKey, input });
            await currentMatch.save();
            io.emit('bonus-update', { type: rewardKey, user: event.userDisplayName, input, isSuccess: true });
            io.emit('game-status', currentMatch);
        } else {
            await refundRedemption(apiClient, authProvider, event.rewardId, event.id);
            io.emit('bonus-update', { user: event.userDisplayName, isSuccess: false });
        }
    });

    listener.onChannelPredictionBegin(channelUserId, async (event) => {
        if (event.title.startsWith(GAME_PREDICTION_TITLE_MARKER) && currentMatch) {
            currentMatch.status = 'BETTING';
            currentMatch.twitchPredictionId = event.id;
            await currentMatch.save();
            io.emit('game-status', currentMatch);
        }
    });

    listener.onChannelPredictionProgress(channelUserId, (event) => {
        lastPredictionData = event.outcomes.map(o => ({
            title: o.title, channelPoints: o.channelPoints, users: o.users
        }));
        io.emit('prediction-progress', lastPredictionData);
    });

    listener.onChannelPredictionEnd(channelUserId, async (event) => {
        if (currentMatch && event.status.toLowerCase() === 'resolved') {
            const winnerId = event.winningOutcome?.id;
            const outcome = event.outcomes.find(o => o.id === winnerId);
            if (outcome) {
                const matchRes = outcome.title.match(/\d+/);
                currentMatch.winnerBot = matchRes ? parseInt(matchRes[0]) : null;
            }
            currentMatch.status = 'CLOSED';
            await currentMatch.save();
            io.emit('game-status', currentMatch);
        }
    });
    return listener;
}

async function main() {
    await connectDB();
    currentMatch = await Match.findOne({}).sort({ matchId: -1 });
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