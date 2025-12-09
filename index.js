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
const hostName = process.env.HOSTNAME; 
const port = process.env.PORT || 3000;

const TARGET_REWARD_NAME_1 = process.env.REWARD_NAME_BONUS1; 
const TARGET_REWARD_NAME_2 = process.env.REWARD_NAME_BONUS2; 

// --- Gestion des Tokens ---
async function getAuthProvider() {
    let tokenData = null;
    try {
        const data = await fs.readFile('tokens.json', 'utf-8');
        const rawData = JSON.parse(data);
        
        // CORRECTION ICI : On force les scopes si ils sont absents du fichier
        tokenData = {
            accessToken: rawData.accessToken || rawData.access_token,
            refreshToken: rawData.refreshToken || rawData.refresh_token,
            expiresIn: rawData.expiresIn || rawData.expires_in || 0,
            obtainmentTimestamp: rawData.obtainmentTimestamp || 0,
            // ON FORCE LES SCOPES ICI POUR QUE TWURPLE ARRETE DE SE PLAINDRE
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
            try {
                await fs.writeFile('tokens.json', JSON.stringify(newTokenData, null, 4), 'utf-8');
            } catch(e) { /* Ignorer sur Render */ }
        }
    });

    if (!channelUserId) throw new Error("CHANNEL_USER_ID manquant dans le .env");
    
    // On ajoute l'utilisateur avec les données forcées
    authProvider.addUser(channelUserId, tokenData);
    
    // On confirme les intents (Twurple vérifiera notre liste forcée ci-dessus et sera content)
    authProvider.addIntentsToUser(channelUserId, ['channel:read:redemptions', 'channel:manage:redemptions']);

    return authProvider;
}

// --- Fonction pour trouver l'ID à partir du nom ---
async function getRewardIdByName(apiClient, rewardName) {
    if (!rewardName) return null;
    try {
        const rewards = await apiClient.channelPoints.getCustomRewards(channelUserId);
        const match = rewards.find(r => r.title.toLowerCase() === rewardName.toLowerCase());
        if (match) {
            console.log(`✅ ID trouvé pour "${rewardName}" : ${match.id}`);
            return match.id;
        } else {
            console.warn(`⚠️ Aucune récompense trouvée avec le nom exact "${rewardName}"`);
            return null;
        }
    } catch (e) {
        console.error(`Erreur recherche "${rewardName}":`, e.message);
        return null;
    }
}

async function main() {
    const app = express();
    const httpServer = createServer(app);
    const io = new Server(httpServer);
    app.use(express.static('public'));

    console.log("Authentification...");
    const authProvider = await getAuthProvider();
    const apiClient = new ApiClient({ authProvider });

    console.log("--- Recherche des IDs de récompenses ---");
    const idBonus1 = await getRewardIdByName(apiClient, TARGET_REWARD_NAME_1);
    const idBonus2 = await getRewardIdByName(apiClient, TARGET_REWARD_NAME_2);

    // EventSub (Simulation locale ou Prod)
    const listener = new EventSubMiddleware({
        apiClient,
        hostName: hostName || 'localhost', 
        pathPrefix: '/twitch-events',
        secret: eventSubSecret || 'secret'
    });
    
    try {
        await listener.apply(app);
        if (idBonus1) {
            await listener.onChannelRedemptionAddForReward(channelUserId, idBonus1, (e) => {
                console.log(`🎁 Bonus 1 activé par ${e.userDisplayName}`);
                io.emit('trigger-bonus1');
            });
        }
        if (idBonus2) {
            await listener.onChannelRedemptionAddForReward(channelUserId, idBonus2, (e) => {
                console.log(`🎁 Bonus 2 activé par ${e.userDisplayName}`);
                io.emit('trigger-bonus2');
            });
        }
        await listener.markAsReady();
    } catch (e) {
        console.log("Info: EventSub non démarré (normal en local).");
    }

    httpServer.listen(port, () => {
        console.log(`\n🚀 Serveur lancé sur http://localhost:${port}`);
        console.log(`Cibles: Bonus1="${TARGET_REWARD_NAME_1}" (ID: ${idBonus1 ? 'OK' : 'X'}), Bonus2="${TARGET_REWARD_NAME_2}" (ID: ${idBonus2 ? 'OK' : 'X'})`);
    });
}

main().catch(console.error);