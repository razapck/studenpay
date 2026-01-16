import express from 'express';
import cors from 'cors';
import { supabase } from '../../shared/db';

const app = express();
const PORT = 3001;



app.use(cors({
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use((req: any, res: any, next: any) => {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    next();
});
app.use(express.json() as any);

// Handle preflight requests for Private Network Access
app.options('*', (req: any, res: any) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.status(204).send();
});

// --- AUTH ---

app.post('/api/auth/login', async (req: any, res: any) => {
    const { mail, "mot de passe": password } = req.body;

    if (!mail || !password) return res.status(400).json({ error: "Email et mot de passe requis" });

    // On cherche l'utilisateur par email et passwd
    const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('email', mail)
        .eq('passwd', parseInt(password))
        .single();

    if (error || !data) {
        return res.status(401).json({ error: "Identifiants incorrects" });
    }

    res.json(data);
});

// Get All Users
app.get('/api/users', async (req: any, res: any) => {
    const { data, error } = await supabase
        .from('users')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    res.json(data);
});

// Get User by ID
app.get('/api/users/:id', async (req: any, res: any) => {
    const { id } = req.params;

    const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('id', id)
        .single();

    if (error || !data) {
        return res.status(404).json({ error: "Utilisateur introuvable" });
    }

    res.json(data);
});

// --- USER CRUD ---

// Create User
app.post('/api/users', async (req: any, res: any) => {
    const { nom, email, passwd, type, adresse, num_CIN, role, type_utilisateur } = req.body;

    if (!nom || !email) return res.status(400).json({ error: "Nom et email requis" });

    const { data, error } = await supabase
        .from('users')
        .insert({
            nom,
            email,
            passwd: passwd ? parseInt(passwd) : null,
            type,
            adresse,
            num_CIN,
            role,
            type_utilisateur
        })
        .select()
        .single();

    if (error) {
        return res.status(400).json({ error: error.message });
    }

    res.status(201).json(data);
});

// Update User
app.put('/api/users/:id', async (req: any, res: any) => {
    const { id } = req.params;
    const { nom, email, passwd, type, adresse, num_CIN, role, type_utilisateur } = req.body;

    const updateData: any = {};
    if (nom !== undefined) updateData.nom = nom;
    if (email !== undefined) updateData.email = email;
    if (passwd !== undefined) updateData.passwd = passwd ? parseInt(passwd) : null;
    if (type !== undefined) updateData.type = type;
    if (adresse !== undefined) updateData.adresse = adresse;
    if (num_CIN !== undefined) updateData.num_CIN = num_CIN;
    if (role !== undefined) updateData.role = role;
    if (type_utilisateur !== undefined) updateData.type_utilisateur = type_utilisateur;

    const { data, error } = await supabase
        .from('users')
        .update(updateData)
        .eq('id', id)
        .select()
        .single();

    if (error || !data) {
        return res.status(404).json({ error: "Utilisateur introuvable ou erreur de mise à jour" });
    }

    res.json(data);
});

// Delete User
app.delete('/api/users/:id', async (req: any, res: any) => {
    const { id } = req.params;

    const { error } = await supabase
        .from('users')
        .delete()
        .eq('id', id);

    if (error) {
        return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, message: "Utilisateur supprimé" });
});

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`User Service running on http://localhost:${PORT}`);
    });
}

export { app };
