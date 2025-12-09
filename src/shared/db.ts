import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv'

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('ERREUR: Les variables SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont requises dans le fichier .env');
    process.exit(1);
}

// Initialisation du client Supabase
export const supabase = createClient(supabaseUrl, supabaseKey);

console.log("Supabase client initialized.");
