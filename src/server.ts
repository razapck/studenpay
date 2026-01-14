import express from 'express';
import cors from 'cors';
import pool from './db';
import { Transaction, TransactionStatus, TransactionType, DBTransaction, DBWallet, DBUser } from './types';
import { uuidToBinary, binaryToUuid } from './shared/uuid';
import { RowDataPacket, ResultSetHeader } from 'mysql2';

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json() as any);

// --- HELPERS DE MAPPING ---

const mapTransactionTypeToApi = (type: string): TransactionType => {
  switch (type) {
    case 'deposit': return TransactionType.DEPOSIT;
    case 'transfer': return TransactionType.TRANSFER;
    case 'payment': return TransactionType.PAYMENT;
    default: return TransactionType.TRANSFER;
  }
};

const mapApiTypeToDb = (type: TransactionType | string): 'deposit' | 'transfer' | 'payment' => {
  if (type === TransactionType.DEPOSIT || type === 'deposit') return 'deposit';
  if (type === TransactionType.TRANSFER || type === 'transfer') return 'transfer';
  if (type === TransactionType.PAYMENT || type === 'payment') return 'payment';
  return 'transfer';
};

// --- AUTH ---

app.post('/api/auth/login', async (req: any, res: any) => {
  const { identifier } = req.body;

  if (!identifier) return res.status(400).json({ error: "Identifiant requis" });

  try {
    const [rows] = await pool.execute<RowDataPacket[]>(
      'SELECT * FROM users WHERE passwd = ?',
      [parseInt(identifier)]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: "Identifiant incorrect" });
    }

    const user = rows[0] as DBUser;
    // MySQL returns binary(16) as Buffer
    const responseUser = {
      ...user,
      id: binaryToUuid(user.id as unknown as Buffer)
    };

    res.json(responseUser);
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// --- WALLET ---

// Get Wallet by User ID
app.get('/api/wallets/user/:userId', async (req: any, res: any) => {
  const { userId } = req.params;

  try {
    const [rows] = await pool.execute<RowDataPacket[]>(
      'SELECT * FROM wallets WHERE titulaire_id = ?',
      [uuidToBinary(userId)]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Wallet introuvable" });
    }

    const data = rows[0] as DBWallet;

    // Mapping DB -> API
    const wallet = {
      id: binaryToUuid(data.id as unknown as Buffer),
      userId: userId,
      balance: data.solde,
      currency: data.monnaie
    };

    res.json(wallet);
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// --- TRANSACTIONS ---

// Get Transactions for a Wallet
app.get('/api/transactions/:walletId', async (req: any, res: any) => {
  const { walletId } = req.params;

  try {
    // 1. Trouver le User ID associé à ce wallet
    const [walletRows] = await pool.execute<RowDataPacket[]>(
      'SELECT titulaire_id FROM wallets WHERE id = ?',
      [uuidToBinary(walletId)]
    );

    if (walletRows.length === 0) {
      return res.status(404).json({ error: "Wallet introuvable" });
    }

    const userIdBinary = walletRows[0].titulaire_id;

    // 2. Récupérer les transactions où l'user est donneur ou bénéficiaire
    const [txRows] = await pool.execute<RowDataPacket[]>(
      'SELECT * FROM transactions WHERE donneur_ordre_id = ? OR beneficiaire_id = ? ORDER BY created_at DESC',
      [userIdBinary, userIdBinary]
    );

    // 3. Mapper sourceWalletId et destinationWalletId
    const userIds = new Set<string>();
    txRows.forEach(tx => {
      if (tx.donneur_ordre_id) userIds.add(binaryToUuid(tx.donneur_ordre_id));
      if (tx.beneficiaire_id) userIds.add(binaryToUuid(tx.beneficiaire_id));
    });

    const userToWalletMap: Record<string, string> = {};
    if (userIds.size > 0) {
      const placeholders = Array.from(userIds).map(() => '?').join(',');
      const [walletsMapRows] = await pool.execute<RowDataPacket[]>(
        `SELECT id, titulaire_id FROM wallets WHERE titulaire_id IN (${placeholders})`,
        Array.from(userIds).map(uuid => uuidToBinary(uuid))
      );
      walletsMapRows.forEach(w => {
        userToWalletMap[binaryToUuid(w.titulaire_id)] = binaryToUuid(w.id);
      });
    }

    // 4. Mapping Final
    const transactions: Transaction[] = txRows.map(tx => ({
      id: binaryToUuid(tx.id),
      amount: tx.montant,
      type: mapTransactionTypeToApi(tx.type),
      status: tx.status === 'completed' ? TransactionStatus.COMPLETED :
        tx.status === 'pending' ? TransactionStatus.PENDING : TransactionStatus.FAILED,
      createdAt: tx.created_at,
      description: tx.description || '',
      sourceWalletId: tx.donneur_ordre_id ? userToWalletMap[binaryToUuid(tx.donneur_ordre_id)] : undefined,
      destinationWalletId: tx.beneficiaire_id ? userToWalletMap[binaryToUuid(tx.beneficiaire_id)] : undefined
    }));

    res.json(transactions);
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Create Transaction
app.post('/api/transactions', async (req: any, res: any) => {
  const { amount, type, destinationWalletId, sourceWalletId, description } = req.body;

  if (!amount || amount <= 0) return res.status(400).json({ error: "Montant invalide" });

  const dbType = mapApiTypeToDb(type);
  let donneurId = null;
  let beneficiaireId = null;

  const connection = await pool.getConnection();
  await connection.beginTransaction();

  try {
    // 1. Résolution des IDs Utilisateurs et Vérification Solde
    if (sourceWalletId) {
      const [sourceRows] = await connection.execute<RowDataPacket[]>(
        'SELECT * FROM wallets WHERE id = ? FOR UPDATE',
        [uuidToBinary(sourceWalletId)]
      );
      if (sourceRows.length === 0) throw new Error("Wallet source introuvable");

      const sourceWallet = sourceRows[0];
      if ((dbType === 'transfer' || dbType === 'payment') && sourceWallet.solde < amount) {
        throw new Error("Solde insuffisant");
      }
      donneurId = sourceWallet.titulaire_id;
    }

    if (destinationWalletId) {
      const [destRows] = await connection.execute<RowDataPacket[]>(
        'SELECT titulaire_id FROM wallets WHERE id = ? FOR UPDATE',
        [uuidToBinary(destinationWalletId)]
      );
      if (destRows.length === 0) throw new Error("Wallet destinataire introuvable");
      beneficiaireId = destRows[0].titulaire_id;
    }

    // 2. Exécution de la transaction

    // Débit du donneur d'ordre (PAYMENT ou TRANSFER)
    if (sourceWalletId && (dbType === 'transfer' || dbType === 'payment')) {
      const [updateResult] = await connection.execute<ResultSetHeader>(
        'UPDATE wallets SET solde = solde - ? WHERE id = ?',
        [amount, uuidToBinary(sourceWalletId)]
      );
      if (updateResult.affectedRows === 0) {
        throw new Error("Erreur lors du débit du wallet source");
      }
    }

    // Crédit du bénéficiaire
    if (destinationWalletId) {
      const [updateResult] = await connection.execute<ResultSetHeader>(
        'UPDATE wallets SET solde = solde + ? WHERE id = ?',
        [amount, uuidToBinary(destinationWalletId)]
      );
      if (updateResult.affectedRows === 0) {
        throw new Error("Erreur lors du crédit du wallet destinataire");
      }
    }

    // Insert Transaction Record
    const txId = require('crypto').randomUUID();
    const [insertResult] = await connection.execute<ResultSetHeader>(
      'INSERT INTO transactions (id, donneur_ordre_id, beneficiaire_id, montant, type, description, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [uuidToBinary(txId), donneurId, beneficiaireId, amount, dbType, description, 'completed']
    );

    if (insertResult.affectedRows === 0) throw new Error("Erreur insertion transaction");

    await connection.commit();

    // Réponse au format API
    const responseTx: Transaction = {
      id: txId,
      amount: amount,
      type: type,
      status: TransactionStatus.COMPLETED,
      createdAt: new Date().toISOString(),
      description: description,
      sourceWalletId,
      destinationWalletId
    };

    res.status(201).json(responseTx);

  } catch (err: any) {
    await connection.rollback();
    console.error(err);
    res.status(400).json({ error: err.message || "Erreur transaction" });
  } finally {
    connection.release();
  }
});

app.listen(PORT, () => {
  console.log(`Backend StudentPay (MySQL) running on http://localhost:${PORT}`);
});