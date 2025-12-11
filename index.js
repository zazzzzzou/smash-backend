require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { RefreshingAuthProvider } = require('@twurple/auth');
const { ApiClient } = require('@twurple/api');
const { EventSubMiddleware } = require('@twurple/eventsub-http');
const bodyParser = require('body-parser'); 
const { promises: fs } = require('fs');

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
const BOT_LEVEL_MAX = 9;
const REWARD_IDS = {}; 


// --- Gestion des Tokens ---
async function getAuthProvider() {
    let tokenData = null;
    try {
        const data = await fs.readFile('tokens.json', 'utf-8');
        const rawData = JSON.parse(data);
        tokenData = {
            accessToken: rawData.accessToken || rawData.access_token,
            refreshToken: rawData.refreshToken || rawData.refresh_token,
            expiresIn: rawData.expiresIn || rawData.expires_in || 0,
            obtainmentTimestamp: rawData.obtainmentTimestamp || 0,
            scope: rawData.scope || ['channel:read:redemptions', 'channel:manage:redemptions']
        };
    } catch (e) {
        if (process.env.INITIAL_ACCESS_TOKEN && process.env.INITIAL_REFRESH_TOKEN) {
            tokenData = {
                accessToken: process.env.INITIAL_ACCESS_TOKEN,
                refreshToken: process.env.INITIAL_REFRESH_TOKEN,
                expiresIn: 0,
                obtainmentTimestamp: 0,
                scope: ['channel:read:redemptions', 'channel:manage:redemptions']
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
            console.log("🔄 Rafraîchissement du token...");
            try { await fs.writeFile('tokens.json', JSON.stringify(newTokenData, null, 4), 'utf-8'); } catch(e) { /* Ignorer sur Render */ }
        }
    });

    if (!channelUserId) throw new Error("CHANNEL_USER_ID manquant dans le .env");
    
    authProvider.addUser(channelUserId, tokenData);
    authProvider.addIntentsToUser(channelUserId, ['channel:read:redemptions', 'channel:manage:redemptions']);

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


// --- Routes d'Administration (Gérées par BLB) ---

function setupAdminRoutes(app, apiClient, io) {
    // ! ATTENTION: body-parser n'est plus appliqué globalement, mais par route !
    
    // Fonction interne pour la clôture des bonus
    async function closeBonusPhase() {
        if (currentMatch && currentMatch.status === 'BONUS_ACTIVE') {
            currentMatch.status = 'IN_PROGRESS';
            currentMatch = await currentMatch.save(); 

            // Action: Bloquer et Cacher toutes les 9 récompenses (Logique "Caché")
            for(const key in REWARD_IDS) {
                console.log(`[LOG: CLOSE PHASE] Bonus ${key}: Désactivation et CACHÉ.`);
                await updateRewardStatus(apiClient, REWARD_IDS[key], false, true); // isEnabled: false, isHidden: true
            }
            
            io.emit('game-status', { status: 'IN_PROGRESS', bonusUsed: currentMatch.bonusResults });
            console.log(`[JEU] Bonus clôturés. Statut: IN_PROGRESS.`);
        }
    }

    // NOUVELLE ROUTE : Visible et Activé (Bouton de contrôle)
    app.post('/admin/set-active', async (req, res) => {
        let count = 0;
        console.log("[ADMIN LOG: SET-ACTIVE] Tentative: isEnabled=true, isHidden=false (ACTIF ET VISIBLE)");
        for(const key in REWARD_IDS) {
            await updateRewardStatus(apiClient, REWARD_IDS[key], true, false); 
            count++;
        }
        res.send({ message: `Activation et Visibilité de ${count} récompenses.` });
    });

    // NOUVELLE ROUTE : Caché (Bouton de contrôle)
    app.post('/admin/set-hidden', async (req, res) => {
        let count = 0;
        console.log("[ADMIN LOG: SET-HIDDEN] Tentative: isEnabled=false, isHidden=true (CACHÉ ET INACTIF)");
        for(const key in REWARD_IDS) {
            await updateRewardStatus(apiClient, REWARD_IDS[key], false, true); 
            count++;
        }
        res.send({ message: `Mise en état Caché de ${count} récompenses.` });
    });

    // --- Routes de Flux de Jeu (body-parser appliqué localement) ---
    
    app.post('/admin/start-match', 
        bodyParser.json(), // Appliqué ici
        bodyParser.urlencoded({ extended: true }), // Appliqué ici
        async (req, res) => {
        if (currentMatch && currentMatch.status !== 'CLOSED') {
            return res.status(400).send({ message: "Le match actuel n'est pas terminé." });
        }

        currentMatchId++; 
        
        const initialBonusMap = new Map();
        for (const reward of ALL_REWARDS) { initialBonusMap.set(reward.key, false); } 

        try {
            const newMatch = new Match({
                matchId: currentMatchId, 
                status: 'BETTING',
                bonusResults: {
                    bot1Level: 8, bot2Level: 8, bot3Level: 8, bot4Level: 8,
                    characterChoices: [],
                    usersUsedBonus: initialBonusMap
                }
            });
            currentMatch = await newMatch.save(); 
        } catch (error) {
            console.error(error);
            return res.status(500).send({ message: "Erreur lors de la création du match (DB). Consultez les logs serveur." });
        }
        
        // Au démarrage (phase BETTING), on met en état Caché (Repos)
        console.log("[LOG] Match Démarré: Forçage à l'état CACHÉ.");
        for(const key in REWARD_IDS) {
            await updateRewardStatus(apiClient, REWARD_IDS[key], false, true); // Disabled, Hidden
        }

        io.emit('game-status', { status: currentMatch.status, matchId: currentMatchId });
        console.log(`[ADMIN] Match ${currentMatchId} démarré. Statut: BETTING. Récompenses CACHÉES.`);
        res.send({ status: currentMatch.status, matchId: currentMatchId });
    });


    app.post('/admin/allow-bonus', 
        bodyParser.json(), // Appliqué ici
        bodyParser.urlencoded({ extended: true }), // Appliqué ici
        async (req, res) => {
        if (!currentMatch) {
            return res.status(400).send({ message: "Veuillez démarrer un match avant d'autoriser les bonus." });
        }
        
        currentMatch.status = 'BONUS_ACTIVE';
        currentMatch = await currentMatch.save();

        // 1. Débloquer et Rendre Visible les 9 récompenses
        console.log("[LOG] Phase Bonus: Forçage à l'état VISIBLE et ACTIVÉ.");
        for(const key in REWARD_IDS) {
            if (currentMatch.bonusResults.usersUsedBonus.get(key) === false) { 
                 await updateRewardStatus(apiClient, REWARD_IDS[key], true, false); 
            }
        }
        
        // 2. Déclencher l'arrêt automatique après 10 secondes
        setTimeout(async () => {
            if (currentMatch && currentMatch.status === 'BONUS_ACTIVE') {
                console.log("[TIMER] Fin du temps de bonus (10s écoulées). Fermeture des récompenses. Forçage à l'état CACHÉ.");
                await closeBonusPhase();
            }
        }, 10000); // 10 secondes

        io.emit('game-status', { status: currentMatch.status });
        res.send({ status: 'BONUS_ACTIVE', timer: '10s démarré' });
    });


    app.post('/admin/close-match', 
        bodyParser.json(), // Appliqué ici
        bodyParser.urlencoded({ extended: true }), // Appliqué ici
        async (req, res) => {
        const winnerBotIndex = parseInt(req.body.winner); 

        if (!currentMatch || currentMatch.status === 'CLOSED') {
            return res.status(400).send({ message: "Aucun match actif à clôturer." });
        }
        
        if (currentMatch.status === 'BONUS_ACTIVE') {
            await closeBonusPhase();
        }

        currentMatch.status = 'CLOSED';
        currentMatch.winnerBot = winnerBotIndex;
        currentMatch = await currentMatch.save(); 

        // TODO: LOGIQUE DE CALCUL DES POINTS (Étape future)

        io.emit('game-status', { status: 'CLOSED', winner: winnerBotIndex });
        res.send({ status: 'CLOSED', winner: winnerBotIndex });
    });
    
    return { closeBonusPhase };
}


// --- Logique EventSub (Réception des Bonus) ---

function setupEventSub(app, apiClient, io, closeBonusPhase) {
    const listener = new EventSubMiddleware({
        apiClient,
        hostName: hostName || 'localhost', 
        pathPrefix: '/twitch-events',
        secret: eventSubSecret || 'secret'
    });
    
    listener.apply(app);

    listener.onChannelRedemptionAdd(channelUserId, async (event) => {
        if (!currentMatch || currentMatch.status === 'CLOSED') {
            return;
        }
        
        const rewardId = event.rewardId;
        const rewardTitle = event.rewardTitle;
        const userId = event.userId;
        const userDisplayName = event.userDisplayName;
        const userInput = event.input || '';

        const usedReward = ALL_REWARDS.find(r => REWARD_IDS[r.key] === rewardId);
        if (!usedReward) return;
        
        const rewardKey = usedReward.key;

        // 1. Logique de blocage : si cette récompense spécifique est déjà utilisée, ignorer.
        if (currentMatch.bonusResults.usersUsedBonus.get(rewardKey) === true) {
            return;
        }

        // --- Le bonus est valide et est le premier à l'utiliser ---
        
        currentMatch.bonusResults.usersUsedBonus.set(rewardKey, true); 
        
        // Action: Blocage immédiat sur Twitch (Logique "Caché")
        console.log(`[LOG] Bonus ${rewardKey} utilisé par ${userDisplayName} : Désactivation et CACHÉ.`);
        await updateRewardStatus(apiClient, rewardId, false, true); // isEnabled: false, isHidden: true
        
        // 2. Logique Level Up/Down
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
        
        // 3. Logique Choix Perso
        if (rewardKey === 'CHOIX_PERSO') {
             currentMatch.bonusResults.characterChoices.push({
                 botIndex: 1, 
                 characterName: userInput,
                 userId: userId
             });

             console.log(`[LOGIC] Choix Perso utilisé par ${userDisplayName}. Input: ${userInput}`);
             io.emit('bonus-applied', { type: 'charSelect', user: userDisplayName, input: userInput });
        }

        // 4. Enregistrement dans la DB
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
        console.log(`[DB] Reprise du Match ID : ${currentMatchId}. Statut : ${currentMatch.status}`);
    } else {
        currentMatchId = 0;
        console.log(`[DB] Démarrage du Match ID à 0.`);
    }

    const app = express();
    const httpServer = createServer(app);
    const io = new Server(httpServer);
    
    // Servir les fichiers statiques du dossier 'public'
    app.use(express.static('public'));

    // Rediriger la racine vers l'interface Admin
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
        console.warn(`[EVENT SUB] Erreur au démarrage du listener (normal en local sans tunnel HTTPS): ${e.message}`);
    }

    httpServer.listen(port, () => {
        console.log(`\n🚀 Serveur lancé sur http://localhost:${port}`);
    });

    // Synchronisation Socket.IO au démarrage
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