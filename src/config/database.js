const mysql = require('mysql2/promise');
require('dotenv').config();

/**
 * Pool de conexões MySQL
 * Usa pool para melhor performance e gerenciamento de conexões
 */
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    timezone: '-03:00' // Horário de Brasília
});

/**
 * Testa a conexão com o banco
 */
async function testarConexao() {
    try {
        const connection = await pool.getConnection();
        console.log('✅ Conexão com MySQL estabelecida com sucesso');
        connection.release();
        return true;
    } catch (error) {
        console.error('❌ Erro ao conectar no MySQL:', error.message);
        return false;
    }
}

/**
 * Executa uma query e retorna os resultados
 */
async function query(sql, params = []) {
    try {
        const [results] = await pool.execute(sql, params);
        return results;
    } catch (error) {
        console.error('Erro ao executar query:', error.message);
        throw error;
    }
}

/**
 * Inicia uma transação
 */
async function beginTransaction() {
    const connection = await pool.getConnection();
    await connection.beginTransaction();
    return connection;
}

/**
 * Fecha o pool de conexões (útil para testes ou shutdown)
 */
async function closePool() {
    await pool.end();
    console.log('Pool de conexões fechado');
}

module.exports = {
    pool,
    query,
    testarConexao,
    beginTransaction,
    closePool
};