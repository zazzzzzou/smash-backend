// models.js

const mongoose = require('mongoose');

// --- 1. Schéma pour les Logs de Bonus (Utilisé dans le Match Schema) ---

// Bien que les logs puissent être stockés dans le Match, les garder séparés (ou juste dans le Match) est possible.
// Pour la simplicité et le classement, nous allons l'inclure dans le Match (comme sous-document) et créer une collection BonusLog séparée pour les logs détaillés si besoin, bien que ce soit optionnel si vous utilisez le log dans Match.

// Si BonusLog est une collection indépendante (pour le classement des bonus) :
const bonusLogSchema = new mongoose.Schema({
    matchId: { type: Number, required: true },
    userId: { type: String, required: true },
    bonusType: { type: String, required: true },
    targetBot: { type: Number, default: null },
    input: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now }
});
const BonusLog = mongoose.model('BonusLog', bonusLogSchema);


// --- 2. Schéma Utilisateur (User) ---

const userSchema = new mongoose.Schema({
    twitchId: { type: String, required: true, unique: true },
    username: { type: String, required: true },
    
    // NOUVEAUX CHAMPS pour les classements
    totalPoints: { type: Number, default: 0 },
    bonusUsedCount: { type: Number, default: 0 },

    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);


// --- 3. Schéma Match (Match) ---

// Schéma pour le log interne au match
const matchInternalLogSchema = new mongoose.Schema({
    user: { type: String, required: true },
    userId: { type: String, required: true },
    reward: { type: String, required: true },
    input: { type: String },
    timestamp: { type: Date, default: Date.now }
}, { _id: false });


const matchSchema = new mongoose.Schema({
    matchId: { type: Number, required: true, unique: true },
    twitchPredictionId: { type: String, default: null },
    
    status: {
        type: String,
        required: true,
        // ENUMS mis à jour pour la stratégie d'écoute passive
        enum: ['AWAITING_PREDICTION', 'BETTING', 'BONUS_ACTIVE', 'IN_PROGRESS', 'CLOSED'], 
    },
    
    winnerBot: { type: Number, default: null },

    bonusResults: {
        // Niveau de chaque bot (Index 0 = Bot 1, Index 3 = Bot 4)
        botLevels: { type: [Number], default: [8, 8, 8, 8] },
        
        // Bloque un bot spécifique pour le Level UP/DOWN (True si déjà utilisé)
        levelUpUsedForBot: { type: [Boolean], default: [false, false, false, false] },
        levelDownUsedForBot: { type: [Boolean], default: [false, false, false, false] },
        
        // Bloque un bot spécifique pour le Choix Perso (True si déjà utilisé)
        charSelectUsedForBot: { type: [Boolean], default: [false, false, false, false] },
        
        // Log des bonus utilisés
        log: { type: [matchInternalLogSchema], default: [] }
    },
    
    createdAt: { type: Date, default: Date.now }
});
const Match = mongoose.model('Match', matchSchema);


// --- Exportation des Modèles ---

module.exports = {
    User,
    Match,
    // Note: BonusLog est exporté ici si vous en avez besoin, mais la logique actuelle utilise le log interne au Match.
    BonusLog 
};