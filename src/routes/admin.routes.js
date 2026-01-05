const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const CryptoJS = require('crypto-js');
const forge = require('node-forge');
const { query } = require('../config/database');
const { autenticarAdmin } = require('../middlewares/auth');

const router = express.Router();

// --- CONFIGURAÇÃO DO MULTER (UPLOAD) ---
// Configurado para não travar se o arquivo for 'estranho', apenas ignora.
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => {
        // Aceita PFX, P12 e tipos genéricos que o Windows envia
        const allowedMimes = ['application/x-pkcs12', 'application/pkcs12', 'application/octet-stream'];
        const isExtValid = file.originalname.toLowerCase().endsWith('.pfx') || 
                           file.originalname.toLowerCase().endsWith('.p12');

        if (allowedMimes.includes(file.mimetype) || isExtValid) {
            cb(null, true);
        } else {
            // Se o arquivo não for válido, aceitamos a requisição mas sem o arquivo (req.file = undefined)
            cb(null, false); 
        }
    }
});

/**
 * Valida senha admin
 */
function validarSenhaAdmin(senha) {
    const SENHA_ADMIN = process.env.ADMIN_PASSWORD;
    return senha === SENHA_ADMIN;
}

/**
 * Criptografa senha do certificado
 */
function encryptSenha(senha) {
    const key = process.env.ENCRYPTION_KEY;
    if (!key) return senha; // CUIDADO: Em produção, sempre tenha a chave
    return CryptoJS.AES.encrypt(senha, key).toString();
}

function validarCertificado(certificadoBuffer, senha) {
    try {
        const p12Der = certificadoBuffer.toString('binary');
        const p12Asn1 = forge.asn1.fromDer(p12Der);
        const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, senha);
        
        const bags = p12.getBags({ bagType: forge.pki.oids.certBag });
        const certBag = bags[forge.pki.oids.certBag][0];
        const certificate = certBag.cert;
        
        const subject = certificate.subject.attributes.reduce((acc, attr) => {
            acc[attr.shortName] = attr.value;
            return acc;
        }, {});
        
        const issuer = certificate.issuer.attributes.reduce((acc, attr) => {
            acc[attr.shortName] = attr.value;
            return acc;
        }, {});
        
        let cnpj = null;
        if (subject.serialNumber) {
            const numeros = subject.serialNumber.replace(/\D/g, '');
            if (numeros.length >= 14) cnpj = numeros.substring(0, 14);
        }
        
        return {
            valido: true,
            titular: subject.CN || 'N/A',
            cnpj: cnpj,
            emissor: issuer.CN || 'N/A',
            validadeFim: certificate.validity.notAfter,
            diasRestantes: Math.ceil((certificate.validity.notAfter - new Date()) / (1000 * 60 * 60 * 24))
        };
    } catch (error) {
        return { valido: false, erro: error.message };
    }
}

/**
 * 4. CADASTRAR EMPRESA
 * Já era POST, agora usamos o middleware
 */
router.post('/cadastrar-empresa', upload.single('certificado'), autenticarAdmin, async (req, res) => {
    // Agora o código começa direto na lógica, sem validar senha manualmente
    try {
        const { cnpj, razao_social /*... outros campos ...*/ } = req.body;
        // ... sua lógica de cadastro ...
        res.status(201).json({ sucesso: true, mensagem: 'Empresa cadastrada!' });
    } catch (error) {
        res.status(500).json({ sucesso: false, erro: error.message });
    }
});

/**
 * POST /api/admin/gerar-apikey
 * Gera uma nova API Key para uma empresa
 */
router.post('/gerar-apikey', async (req, res, next) => {
    try {
        const { cnpj, senha_admin } = req.body;
        
        if (!validarSenhaAdmin(senha_admin)) {
            return res.status(401).json({
                sucesso: false,
                erro: 'Senha administrativa inválida'
            });
        }
        
        const rawCnpj = cnpj ? cnpj.replace(/\D/g, '') : null;
        
        if (!rawCnpj || rawCnpj.length !== 14) {
            return res.status(400).json({
                sucesso: false,
                erro: 'CNPJ inválido (deve ter 14 dígitos)'
            });
        }
        
        console.log(`🔑 Gerando nova API Key para CNPJ: ${rawCnpj}`);
        
        const sqlBusca = `
            SELECT id, cnpj, razao_social, api_key
            FROM empresas
            WHERE cnpj = ?
        `;
        
        const empresas = await query(sqlBusca, [rawCnpj]);
        
        if (empresas.length === 0) {
            return res.status(404).json({
                sucesso: false,
                erro: 'Empresa não encontrada',
                mensagem: 'Use POST /api/admin/cadastrar-empresa para cadastrar'
            });
        }
        
        const empresa = empresas[0];
        const apiKeyAntiga = empresa.api_key;
        const novaAPIKey = crypto.randomBytes(32).toString('hex');
        
        console.log(`  → Empresa: ${empresa.razao_social}`);
        console.log(`  → API Key antiga: ${apiKeyAntiga.substring(0, 16)}...`);
        console.log(`  → API Key nova: ${novaAPIKey.substring(0, 16)}...`);
        
        const sqlUpdate = `
            UPDATE empresas 
            SET 
                api_key = ?,
                api_key_ativa = TRUE,
                ativa = TRUE
            WHERE cnpj = ?
        `;
        
        await query(sqlUpdate, [novaAPIKey, rawCnpj]);
        
        console.log(`✅ API Key gerada com sucesso!`);
        
        res.json({
            sucesso: true,
            mensagem: 'Nova API Key gerada com sucesso',
            empresa: {
                cnpj: empresa.cnpj,
                razaoSocial: empresa.razao_social
            },
            apiKeyAntiga: apiKeyAntiga,
            apiKeyNova: novaAPIKey,
            aviso: '⚠️ Guarde esta API Key! A antiga foi invalidada.'
        });
        
    } catch (error) {
        console.error('❌ Erro ao gerar API Key:', error);
        next(error);
    }
});

/**
 * 1. LISTAR EMPRESAS
 * MUDOU: De GET para POST para proteger a senha_admin
 */
router.post('/listar-empresas', autenticarAdmin, async (req, res) => {
    try {
        const sql = `
            SELECT id, cnpj, razao_social, api_key, api_key_ativa, ativa,
            certificado_validade, certificado_pfx IS NOT NULL as tem_certificado,
            DATEDIFF(certificado_validade, CURDATE()) as dias_restantes_cert
            FROM empresas ORDER BY created_at DESC
        `;
        const empresas = await query(sql);
        res.json({ sucesso: true, total: empresas.length, empresas });
    } catch (error) {
        res.status(500).json({ sucesso: false, erro: error.message });
    }
});

/**
 * POST /api/admin/ativar-empresa
 * Ativa/desativa uma empresa
 */
router.post('/ativar-empresa', async (req, res, next) => {
    try {
        const { cnpj, ativar, senha_admin } = req.body;
        
        if (!validarSenhaAdmin(senha_admin)) {
            return res.status(401).json({
                sucesso: false,
                erro: 'Senha administrativa inválida'
            });
        }
        
        const rawCnpj = cnpj ? cnpj.replace(/\D/g, '') : null;
        
        if (!rawCnpj || rawCnpj.length !== 14) {
            return res.status(400).json({
                sucesso: false,
                erro: 'CNPJ inválido'
            });
        }
        
        const status = ativar === true || ativar === 'true' || ativar === 1;
        
        console.log(`${status ? '✅ Ativando' : '❌ Desativando'} empresa: ${rawCnpj}`);
        
        const sql = `
            UPDATE empresas 
            SET ativa = ?, api_key_ativa = ?
            WHERE cnpj = ?
        `;
        
        const result = await query(sql, [status, status, rawCnpj]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({
                sucesso: false,
                erro: 'Empresa não encontrada'
            });
        }
        
        res.json({
            sucesso: true,
            mensagem: `Empresa ${status ? 'ativada' : 'desativada'} com sucesso`,
            cnpj: rawCnpj,
            status: status ? 'ativa' : 'inativa'
        });
        
    } catch (error) {
        console.error('❌ Erro ao ativar/desativar empresa:', error);
        next(error);
    }
});

/**
 * 2. CONSULTAR API KEY POR CNPJ
 * MUDOU: De GET para POST
 */
router.post('/consultar-apikey/:cnpj', autenticarAdmin, async (req, res) => {
    try {
        const rawCnpj = req.params.cnpj.replace(/\D/g, '');
        const sql = `SELECT cnpj, razao_social, api_key, api_key_ativa FROM empresas WHERE cnpj = ?`;
        const results = await query(sql, [rawCnpj]);

        if (results.length === 0) return res.status(404).json({ sucesso: false, erro: 'Empresa não encontrada' });
        res.json({ sucesso: true, empresa: results[0] });
    } catch (error) {
        res.status(500).json({ sucesso: false, erro: error.message });
    }
});

/**
 * POST /api/admin/atualizar-certificado
 * Atualiza o certificado digital de uma empresa (via admin)
 */
router.post('/atualizar-certificado', upload.single('certificado'), async (req, res, next) => {
    try {
        console.log('📄 Atualizando certificado digital (admin)...');
        
        // Valida senha admin
        const { senha_admin } = req.body;
        if (!validarSenhaAdmin(senha_admin)) {
            return res.status(401).json({
                sucesso: false,
                erro: 'Senha administrativa inválida'
            });
        }
        
        // Valida se certificado foi enviado
        if (!req.file) {
            return res.status(400).json({
                sucesso: false,
                erro: 'Certificado digital (.pfx ou .p12) não foi enviado'
            });
        }
        
        const { cnpj, senha_certificado } = req.body;
        
        const rawCnpj = cnpj ? cnpj.replace(/\D/g, '') : null;
        
        // Validações básicas
        if (!rawCnpj || rawCnpj.length !== 14) {
            return res.status(400).json({
                sucesso: false,
                erro: 'CNPJ inválido (deve ter 14 dígitos)'
            });
        }
        
        if (!senha_certificado) {
            return res.status(400).json({
                sucesso: false,
                erro: 'Senha do certificado é obrigatória'
            });
        }
        
        console.log(`  → CNPJ: ${rawCnpj}`);
        
        // Verifica se empresa existe
        const sqlVerifica = 'SELECT id, cnpj, razao_social, certificado_validade FROM empresas WHERE cnpj = ?';
        const empresasExistentes = await query(sqlVerifica, [rawCnpj]);
        
        if (empresasExistentes.length === 0) {
            return res.status(404).json({
                sucesso: false,
                erro: 'Empresa não encontrada'
            });
        }
        
        const empresaAtual = empresasExistentes[0];
        
        console.log(`  → Empresa: ${empresaAtual.razao_social}`);
        
        // Valida novo certificado
        console.log('  → Validando novo certificado digital...');
        const certInfo = validarCertificado(req.file.buffer, senha_certificado);
        
        if (!certInfo.valido) {
            return res.status(400).json({
                sucesso: false,
                erro: 'Certificado inválido ou senha incorreta',
                detalhes: certInfo.erro
            });
        }
        
        console.log(`  → Novo certificado válido!`);
        console.log(`     Titular: ${certInfo.titular}`);
        console.log(`     Validade: ${certInfo.validadeFim.toLocaleDateString()}`);
        
        // Criptografa senha do certificado
        console.log('  → Criptografando senha...');
        const senhaEncrypted = encryptSenha(senha_certificado);
        
        // Atualiza no banco
        console.log('  → Atualizando no banco de dados...');
        const sqlUpdate = `
            UPDATE empresas 
            SET 
                certificado_pfx = ?,
                senha_certificado_encrypted = ?,
                certificado_validade = ?,
                certificado_emissor = ?,
                certificado_titular = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE cnpj = ?
        `;
        
        const params = [
            req.file.buffer,
            senhaEncrypted,
            certInfo.validadeFim.toISOString().split('T')[0],
            certInfo.emissor,
            certInfo.titular,
            rawCnpj
        ];
        
        await query(sqlUpdate, params);
        
        console.log('✅ Certificado atualizado com sucesso!');
        
        res.json({
            sucesso: true,
            mensagem: 'Certificado digital atualizado com sucesso!',
            empresa: {
                cnpj: rawCnpj,
                razaoSocial: empresaAtual.razao_social
            },
            certificadoAnterior: {
                validade: empresaAtual.certificado_validade,
                status: empresaAtual.certificado_validade ? 'substituído' : 'não havia'
            },
            certificadoNovo: {
                titular: certInfo.titular,
                emissor: certInfo.emissor,
                validade: certInfo.validadeFim,
                diasRestantes: certInfo.diasRestantes,
                status: certInfo.diasRestantes > 30 ? 'válido' : certInfo.diasRestantes > 0 ? 'vencendo' : 'vencido'
            }
        });
        
    } catch (error) {
        console.error('❌ Erro ao atualizar certificado:', error);
        next(error);
    }
});

/**
 * POST /api/admin/validar-senha
 * Valida apenas a senha administrativa (sem cadastrar nada)
 */
router.post('/validar-senha', async (req, res, next) => {
    try {
        const { senha_admin } = req.body;
        
        if (!validarSenhaAdmin(senha_admin)) {
            return res.status(401).json({
                sucesso: false,
                erro: 'Senha administrativa inválida'
            });
        }
        
        res.json({
            sucesso: true,
            mensagem: 'Senha válida'
        });
        
    } catch (error) {
        console.error('❌ Erro ao validar senha:', error);
        next(error);
    }
});

/**
* 3. CERTIFICADOS VENCENDO
 * MUDOU: De GET para POST
 */
router.post('/certificados-vencendo', autenticarAdmin, async (req, res) => {
    try {
        const diasAlerta = parseInt(req.body.dias) || 30;
        const sql = `
            SELECT cnpj, razao_social, certificado_validade, 
            DATEDIFF(certificado_validade, CURDATE()) as dias_restantes
            FROM empresas
            WHERE certificado_pfx IS NULL OR DATEDIFF(certificado_validade, CURDATE()) <= ?
            ORDER BY certificado_validade ASC
        `;
        const certificados = await query(sql, [diasAlerta]);
        res.json({ sucesso: true, total: certificados.length, certificados });
    } catch (error) {
        res.status(500).json({ sucesso: false, erro: error.message });
    }
});

module.exports = router;