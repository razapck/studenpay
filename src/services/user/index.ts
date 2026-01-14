import express from 'express';
import cors from 'cors';
import { db, uuidToBinary, binaryToUuid } from '../../shared/db';
import { RowDataPacket, ResultSetHeader } from 'mysql2';

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

// --- HELPERS ---
const mapDbUserToApi = (user: any) => ({
    ...user,
    id: binaryToUuid(user.id)
});

// --- AUTH ---

app.post('/api/auth/login', async (req: any, res: any) => {
    const { mail, "mot de passe": password } = req.body;

    if (!mail || !password) return res.status(400).json({ error: "Email et mot de passe requis" });

    try {
        const [rows] = await db.execute<RowDataPacket[]>(
            'SELECT * FROM users WHERE email = ? AND passwd = ?',
            [mail, parseInt(password)]
        );

        if (rows.length === 0) {
            return res.status(401).json({ error: "Identifiants incorrects" });
        }

        res.json(mapDbUserToApi(rows[0]));
    } catch (error: any) {
        console.error(error);
        res.status(500).json({ error: "Erreur serveur" });
    }
});

// Get All Users
app.get('/api/users', async (req: any, res: any) => {
    try {
        const [rows] = await db.execute<RowDataPacket[]>(
            'SELECT * FROM users ORDER BY created_at DESC'
        );
        res.json(rows.map(mapDbUserToApi));
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// Get User by ID
app.get('/api/users/:id', async (req: any, res: any) => {
    const { id } = req.params;

    try {
        const [rows] = await db.execute<RowDataPacket[]>(
            'SELECT * FROM users WHERE id = ?',
            [uuidToBinary(id)]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: "Utilisateur introuvable" });
        }

        res.json(mapDbUserToApi(rows[0]));
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// --- USER CRUD ---

// Create User
app.post('/api/users', async (req: any, res: any) => {
    const { nom, email, passwd, type, adresse, num_CIN, role, type_utilisateur } = req.body;

    if (!nom || !email) return res.status(400).json({ error: "Nom et email requis" });

    try {
        const id = require('crypto').randomUUID();
        await db.execute(
            'INSERT INTO users (id, nom, email, passwd, type, adresse, num_CIN, role, type_utilisateur) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
                uuidToBinary(id),
                nom,
                email,
                passwd ? parseInt(passwd) : null,
                type,
                adresse,
                num_CIN,
                role,
                type_utilisateur
            ]
        );

        const [rows] = await db.execute<RowDataPacket[]>(
            'SELECT * FROM users WHERE id = ?',
            [uuidToBinary(id)]
        );

        res.status(201).json(mapDbUserToApi(rows[0]));
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

// Update User
app.put('/api/users/:id', async (req: any, res: any) => {
    const { id } = req.params;
    const { nom, email, passwd, type, adresse, num_CIN, role, type_utilisateur } = req.body;

    try {
        const updates: string[] = [];
        const params: any[] = [];

        if (nom !== undefined) { updates.push('nom = ?'); params.push(nom); }
        if (email !== undefined) { updates.push('email = ?'); params.push(email); }
        if (passwd !== undefined) { updates.push('passwd = ?'); params.push(passwd ? parseInt(passwd) : null); }
        if (type !== undefined) { updates.push('type = ?'); params.push(type); }
        if (adresse !== undefined) { updates.push('adresse = ?'); params.push(adresse); }
        if (num_CIN !== undefined) { updates.push('num_CIN = ?'); params.push(num_CIN); }
        if (role !== undefined) { updates.push('role = ?'); params.push(role); }
        if (type_utilisateur !== undefined) { updates.push('type_utilisateur = ?'); params.push(type_utilisateur); }

        if (updates.length > 0) {
            params.push(uuidToBinary(id));
            await db.execute(
                `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
                params
            );
        }

        const [rows] = await db.execute<RowDataPacket[]>(
            'SELECT * FROM users WHERE id = ?',
            [uuidToBinary(id)]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: "Utilisateur introuvable" });
        }

        res.json(mapDbUserToApi(rows[0]));
    } catch (error: any) {
        res.status(404).json({ error: "Erreur de mise à jour: " + error.message });
    }
});

// Delete User
app.delete('/api/users/:id', async (req: any, res: any) => {
    const { id } = req.params;

    try {
        const [result] = await db.execute<ResultSetHeader>(
            'DELETE FROM users WHERE id = ?',
            [uuidToBinary(id)]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "Utilisateur introuvable" });
        }

        res.json({ success: true, message: "Utilisateur supprimé" });
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`User Service running on http://localhost:${PORT}`);
    });
}

export { app };
