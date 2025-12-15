// models.js

const mongoose = require('mongoose');

// --- 1. Schéma BonusLog (Collection séparée pour l'historique détaillé) ---

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
    
    // CHAMPS POUR LES CLASSEMENTS
    totalPoints: { type: Number, default: 0 },
    
    // Champs détaillés pour le classement Bonus
    bonusUsedCount: { type: Number, default: 0 }, // Total Global
    luCount: { type: Number, default: 0 }, // Level Up Count
    ldCount: { type: Number, default: 0 }, // Level Down Count
    cpCount: { type: Number, default: 0 }, // Choix Perso Count

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
        enum: ['AWAITING_PREDICTION', 'BETTING', 'BONUS_ACTIVE', 'IN_PROGRESS', 'CLOSED'], 
    },
    
    // CORRIGÉ: Stocke le numéro du bot gagnant
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
    BonusLog 
};