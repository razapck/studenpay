import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'basevatelpay',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

export const db = pool;

// Helpers pour UUID <-> BINARY(16)
export const uuidToBinary = (uuid: string): Buffer => {
    const buf = Buffer.from(uuid.replace(/-/g, ''), 'hex');
    return buf;
};

export const binaryToUuid = (buf: Buffer | any): string => {
    if (!buf) return '';
    if (!(buf instanceof Buffer)) {
        // Si c'est déjà un string (cas rare selon driver)
        if (typeof buf === 'string') return buf;
        buf = Buffer.from(buf);
    }
    const hex = buf.toString('hex');
    return [
        hex.substring(0, 8),
        hex.substring(8, 12),
        hex.substring(12, 16),
        hex.substring(16, 20),
        hex.substring(20)
    ].join('-');
};

console.log("MySQL connection pool initialized (Shared).");
