// models.js
const mongoose = require('mongoose');

// --- 1. User Schema (Classement des joueurs) ---

const UserSchema = new mongoose.Schema({
    // ID Twitch de l'utilisateur (unique)
    twitchId: {
        type: String,
        required: true,
        unique: true
    },
    // Nom d'utilisateur Twitch
    username: {
        type: String,
        required: true
    },
    // Score pour le classement des paris corrects
    scorePoints: {
        type: Number,
        default: 0
    },
    // Compteur de l'utilisation des bonus (pour le classement des bonus)
    bonusUsedCount: {
        type: Number,
        default: 0
    }
}, { timestamps: true });


// --- 2. Match Schema (Pour suivre l'état du jeu) ---

const MatchSchema = new mongoose.Schema({
    matchId: { // Identifiant unique du match
        type: Number,
        required: true,
        unique: true
    },
    twitchPredictionId: {
        type: String,
        required: false
    },
    status: { // État du match : BETTING, BONUS_ACTIVE, IN_PROGRESS, CLOSED
        type: String,
        enum: ['BETTING', 'BONUS_ACTIVE', 'IN_PROGRESS', 'CLOSED', 'AWAITING_PREDICTION'],
        default: 'CLOSED'
    },
    bettingResult: { // Le résultat des paris Twitch natifs
        type: String, 
        required: false 
    },
    bonusResults: { 
        bot1Level: { type: Number, default: 8 },
        bot2Level: { type: Number, default: 8 },
        bot3Level: { type: Number, default: 8 },
        bot4Level: { type: Number, default: 8 },
        characterChoices: [ // Ex: { botIndex: 1, characterName: 'Samus' }
            {
                botIndex: Number,
                characterName: String,
                userId: String // Qui a choisi
            }
        ],
        // CORRECTION CRITIQUE : Utiliser un Map pour stocker les états des 9 récompenses.
        // Cela permet d'avoir des clés dynamiques (LEVEL_UP_1, LEVEL_DOWN_2, etc.)
        usersUsedBonus: {
            type: Map, 
            of: Boolean // La valeur de chaque clé sera Vrai ou Faux
        }
    },
    winnerBot: { // Le bot qui a réellement gagné (pour le calcul des points)
        type: Number,
        min: 1,
        max: 4,
        required: false
    }
}, { timestamps: true });


// --- 3. Bonus Log Schema (Historique détaillé) ---

const BonusLogSchema = new mongoose.Schema({
    matchId: {
        type: Number,
        required: true,
        ref: 'Match' // Référence au modèle Match
    },
    userId: {
        type: String,
        required: true,
        ref: 'User' // Référence au modèle User
    },
    bonusType: { // LEVEL_UP_1, LEVEL_DOWN_3, CHARACTER_SELECT
        type: String,
        required: true
    },
    targetBot: { // 1, 2, 3, 4
        type: Number,
        required: true
    },
    input: { // Le personnage choisi ou la valeur du level
        type: String
    }
}, { timestamps: true });


// Création et exportation des Modèles
const User = mongoose.model('User', UserSchema);
const Match = mongoose.model('Match', MatchSchema);
const BonusLog = mongoose.model('BonusLog', BonusLogSchema);

module.exports = { User, Match, BonusLog };