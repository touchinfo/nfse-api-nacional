const { query } = require('../config/database');

/**
 * Middleware de autenticação via API Key
 */
async function autenticarAPIKey(req, res, next) {
    try {
        // Busca API Key no header
        const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
        
        if (!apiKey) {
            return res.status(401).json({
                sucesso: false,
                erro: 'API Key não fornecida',
                mensagem: 'Envie a API Key no header X-API-Key ou Authorization'
            });
        }
        
        // Busca empresa pela API Key
        const sql = `
            SELECT 
                id,
                cnpj,
                razao_social,
                codigo_municipio,
                tipo_ambiente,
                ativa,
                api_key_ativa
            FROM empresas
            WHERE api_key = ? AND ativa = TRUE AND api_key_ativa = TRUE
        `;
        
        const results = await query(sql, [apiKey]);
        
        if (results.length === 0) {
            return res.status(401).json({
                sucesso: false,
                erro: 'API Key inválida ou inativa'
            });
        }
        
        // Adiciona dados da empresa na requisição
        req.empresa = results[0];
        
        console.log(`✓ Empresa autenticada: ${req.empresa.razao_social} (${req.empresa.cnpj})`);
        
        next();
        
    } catch (error) {
        console.error('Erro na autenticação:', error);
        return res.status(500).json({
            sucesso: false,
            erro: 'Erro ao validar autenticação'
        });
    }
}

/**
 * Middleware opcional - não bloqueia se não houver API Key
 */
async function autenticarOpcional(req, res, next) {
    const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
    
    if (apiKey) {
        try {
            const sql = `
                SELECT id, cnpj, razao_social
                FROM empresas
                WHERE api_key = ? AND ativa = TRUE
            `;
            
            const results = await query(sql, [apiKey]);
            
            if (results.length > 0) {
                req.empresa = results[0];
            }
        } catch (error) {
            console.error('Erro ao validar API Key opcional:', error);
        }
    }
    
    next();
}

module.exports = {
    autenticarAPIKey,
    autenticarOpcional
}