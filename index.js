require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { RefreshingAuthProvider } = require('@twurple/auth');
const { ApiClient } = require('@twurple/api');
const { EventSubMiddleware } = require('@twurple/eventsub-http');
const { promises: fs } = require('fs');

// --- Configuration ---
const clientId = process.env.TWITCH_CLIENT_ID;
const clientSecret = process.env.TWITCH_CLIENT_SECRET;
const channelUserId = process.env.CHANNEL_USER_ID; 
const eventSubSecret = process.env.EVENTSUB_SECRET;
const hostName = process.env.HOSTNAME; // ex: mon-app.onrender.com
const port = process.env.PORT || 3000;

// Noms des récompenses à chercher (depuis le .env)
const TARGET_REWARD_NAME_1 = process.env.REWARD_NAME_BONUS1; // ex: "invocation bobo"
const TARGET_REWARD_NAME_2 = process.env.REWARD_NAME_BONUS2; // ex: "Screamer"

// --- Gestion des Tokens (Compatible Render & Local) ---
async function getAuthProvider() {
    // 1. Essayer de charger depuis un fichier local (Dev)
    let tokenData = null;
    try {
        const data = await fs.readFile('tokens.json', 'utf-8');
        tokenData = JSON.parse(data);
    } catch (e) {
        // 2. Si pas de fichier (Render), utiliser les variables d'environnement
        if (process.env.INITIAL_ACCESS_TOKEN && process.env.INITIAL_REFRESH_TOKEN) {
            tokenData = {
                accessToken: process.env.INITIAL_ACCESS_TOKEN,
                refreshToken: process.env.INITIAL_REFRESH_TOKEN,
                expiresIn: 0,
                obtainmentTimestamp: 0
            };
            console.log("Utilisation des tokens depuis les variables d'environnement.");
        }
    }

    if (!tokenData) {
        throw new Error("Aucun token trouvé (ni dans tokens.json, ni dans les variables d'env).");
    }

    return new RefreshingAuthProvider({
        clientId,
        clientSecret,
        onRefresh: async (newTokenData) => {
            // Sur Render, on ne peut pas écrire de fichier de manière persistante facilement.
            // Le RefreshingAuthProvider gardera le token frais en mémoire tant que le serveur tourne.
            // En local, on met à jour le fichier.
            try {
                await fs.writeFile('tokens.json', JSON.stringify(newTokenData, null, 4), 'utf-8');
            } catch(e) { /* Ignorer erreur d'écriture sur Render */ }
        }
    }, tokenData);
}

// --- Fonction pour trouver l'ID à partir du nom ---
async function getRewardIdByName(apiClient, rewardName) {
    if (!rewardName) return null;
    
    // Récupère toutes les récompenses de la chaîne
    const rewards = await apiClient.channelPoints.getCustomRewards(channelUserId);
    
    // Cherche celle qui correspond au nom (insensible à la casse)
    const match = rewards.find(r => r.title.toLowerCase() === rewardName.toLowerCase());
    
    if (match) {
        console.log(`✅ ID trouvé pour "${rewardName}" : ${match.id}`);
        return match.id;
    } else {
        console.error(`❌ Aucune récompense trouvée avec le nom "${rewardName}"`);
        return null;
    }
}

async function main() {
    // 1. Initialisation Serveur Web
    const app = express();
    const httpServer = createServer(app);
    const io = new Server(httpServer);
    app.use(express.static('public'));

    // 2. Auth Twitch
    const authProvider = await getAuthProvider();
    const apiClient = new ApiClient({ authProvider });

    // 3. Récupération Automatique des IDs
    console.log("--- Recherche des IDs de récompenses ---");
    const idBonus1 = await getRewardIdByName(apiClient, TARGET_REWARD_NAME_1);
    const idBonus2 = await getRewardIdByName(apiClient, TARGET_REWARD_NAME_2);

    // 4. Configuration EventSub
    const listener = new EventSubMiddleware({
        apiClient,
        hostName: hostName, 
        pathPrefix: '/twitch-events',
        secret: eventSubSecret
    });
    await listener.apply(app);

    // 5. Abonnement aux événements
    if (idBonus1) {
        await listener.onChannelRedemptionAddForReward(channelUserId, idBonus1, (e) => {
            console.log(`Bouton 1 activé par ${e.userDisplayName}`);
            io.emit('trigger-bonus1');
        });
    }

    if (idBonus2) {
        await listener.onChannelRedemptionAddForReward(channelUserId, idBonus2, (e) => {
            console.log(`Bouton 2 activé par ${e.userDisplayName}`);
            io.emit('trigger-bonus2');
        });
    }

    // 6. Démarrage
    await listener.markAsReady();
    httpServer.listen(port, () => {
        console.log(`\n🚀 Serveur lancé sur le port ${port}`);
        console.log(`Variables: Bonus1="${TARGET_REWARD_NAME_1}", Bonus2="${TARGET_REWARD_NAME_2}"`);
    });
}

main().catch(console.error);