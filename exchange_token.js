// exchange_token_http.js
require('dotenv').config();
const { promises: fs } = require('fs');
const path = require('path');

// --- Configuration ---
const clientId = process.env.TWITCH_CLIENT_ID;
const clientSecret = process.env.TWITCH_CLIENT_SECRET;
const tokenFile = 'tokens.json';
const redirectUri = 'http://localhost:8080';

// NOUVEAU CODE REÇU DE VOTRE AMI (À REMPLACER !!)
const AUTH_CODE_RECEIVED = 'rzu0se1fnttk2l5iro3fxrkxcpusxb'; 
// Assurez-vous que c'est le code le plus récent !

async function exchangeTokenHttp() {
    console.log("--- Échange du Code contre les Jetons d'Accès (Méthode HTTP Directe) ---");

    if (AUTH_CODE_RECEIVED === 'NOUVEAU_CODE_RECU_ICI') {
        console.error("ERREUR: Veuillez coller le code d'autorisation le plus récent dans la variable AUTH_CODE_RECEIVED.");
        return;
    }

    try {
        const body = new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            code: AUTH_CODE_RECEIVED,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri,
        });

        // Appel direct au point de terminaison OAuth de Twitch
        const response = await fetch('https://id.twitch.tv/oauth2/token', {
            method: 'POST',
            body: body,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
        });

        const data = await response.json();

        if (response.status !== 200) {
            console.error("❌ ERREUR HTTP:", response.status);
            console.error("Détails de l'erreur Twitch:", data.message || data.error);
            return;
        }

        // Sauvegarde des jetons dans tokens.json (Access Token et Refresh Token)
        const tokenFilePath = path.join(__dirname, tokenFile);
        await fs.writeFile(tokenFilePath, JSON.stringify(data, null, 4), 'utf-8');
        
        console.log("✅ SUCCÈS : Les jetons ont été récupérés et sauvegardés dans tokens.json.");

    } catch (error) {
        console.error("❌ Erreur critique lors de l'échange HTTP:", error.message);
    }
}

exchangeTokenHttp().catch(console.error);