import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv'

dotenv.config();

const supabaseUrl = "https://jdxfqqbidofoqsdhhgtc.supabase.co"
const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpkeGZxcWJpZG9mb3FzZGhoZ3RjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NDU0MDY1MiwiZXhwIjoyMDgwMTE2NjUyfQ.fCnOCd6wLJkVGG44AvbuIIlgxuFXZciujT_58r3awlA"
  ; // Utiliser la clé de service pour l'API backend

if (!supabaseUrl || !supabaseKey) {
  console.error('ERREUR: Les variables SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont requises dans le fichier .env');
  process.exit(1);
}

// Initialisation du client Supabase
export const supabase = createClient(supabaseUrl, supabaseKey);

console.log("Supabase client initialized.");