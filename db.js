// db.js
const mongoose = require('mongoose');

// Récupère l'URI de connexion depuis le fichier .env
const mongoUri = process.env.MONGODB_URI;

/**
 * Fonction pour établir la connexion à MongoDB Atlas.
 */
const connectDB = async () => {
    if (!mongoUri) {
        console.error("ERREUR CRITIQUE: MONGODB_URI n'est pas défini dans le .env!");
        return;
    }

    try {
        await mongoose.connect(mongoUri);
        console.log("✅ Connexion à MongoDB réussie !");
    } catch (err) {
        console.error("❌ ERREUR DE CONNEXION MONGO DB:", err.message);
        // Si la connexion échoue, il est vital d'arrêter l'application
        process.exit(1); 
    }
};

module.exports = connectDB;