const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const CryptoJS = require('crypto-js');
const forge = require('node-forge');
const { query } = require('../config/database');

const router = express.Router();

// Configuração do multer para upload de certificado
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB max
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/x-pkcs12' || 
            file.originalname.endsWith('.pfx') || 
            file.originalname.endsWith('.p12')) {
            cb(null, true);
        } else {
            cb(new Error('Apenas arquivos .pfx ou .p12 são permitidos'));
        }
    }
});

/**
 * Valida senha admin
 */
function validarSenhaAdmin(senha) {
    const SENHA_ADMIN = process.env.ADMIN_PASSWORD || 'admin123MUDE';
    return senha === SENHA_ADMIN;
}

/**
 * Criptografa senha do certificado
 */
function encryptSenha(senha) {
    const key = process.env.ENCRYPTION_KEY;
    if (!key || key.length !== 64) {
        throw new Error('ENCRYPTION_KEY deve ter 64 caracteres');
    }
    return CryptoJS.AES.encrypt(senha, key).toString();
}

/**
 * Valida e extrai informações do certificado
 */
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
            if (numeros.length >= 14) {
                cnpj = numeros.substring(0, 14);
            }
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
        return {
            valido: false,
            erro: error.message
        };
    }
}

/**
 * POST /api/admin/cadastrar-empresa
 * Cadastra uma nova empresa com certificado digital
 */
router.post('/cadastrar-empresa', upload.single('certificado'), async (req, res, next) => {
    try {
        console.log('🏢 Recebendo cadastro de nova empresa...');
        
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
        
        // Extrai dados do body
        const {
            cnpj,
            razao_social,
            nome_fantasia,
            inscricao_municipal,
            codigo_municipio,
            cep,
            logradouro,
            numero,
            complemento,
            bairro,
            uf,
            senha_certificado,
            opcao_simples_nacional,
            regime_apuracao_tributacao,
            regime_especial_tributacao,
            serie_dps,
            tipo_ambiente,
            versao_aplicacao
        } = req.body;
        
        // Validações básicas
        if (!cnpj || cnpj.length !== 14) {
            return res.status(400).json({
                sucesso: false,
                erro: 'CNPJ inválido (deve ter 14 dígitos sem pontuação)'
            });
        }
        
        if (!razao_social) {
            return res.status(400).json({
                sucesso: false,
                erro: 'Razão social é obrigatória'
            });
        }
        
        if (!senha_certificado) {
            return res.status(400).json({
                sucesso: false,
                erro: 'Senha do certificado é obrigatória'
            });
        }
        
        console.log(`  → CNPJ: ${cnpj}`);
        console.log(`  → Razão Social: ${razao_social}`);
        
        // Verifica se empresa já existe
        const sqlVerifica = 'SELECT cnpj FROM empresas WHERE cnpj = ?';
        const empresasExistentes = await query(sqlVerifica, [cnpj]);
        
        if (empresasExistentes.length > 0) {
            return res.status(400).json({
                sucesso: false,
                erro: 'Empresa já cadastrada com este CNPJ',
                mensagem: 'Use a rota /api/admin/gerar-apikey para gerar nova API Key'
            });
        }
        
        // Valida certificado
        console.log('  → Validando certificado digital...');
        const certInfo = validarCertificado(req.file.buffer, senha_certificado);
        
        if (!certInfo.valido) {
            return res.status(400).json({
                sucesso: false,
                erro: 'Certificado inválido ou senha incorreta',
                detalhes: certInfo.erro
            });
        }
        
        console.log(`  → Certificado válido!`);
        console.log(`     Titular: ${certInfo.titular}`);
        console.log(`     CNPJ Cert: ${certInfo.cnpj}`);
        console.log(`     Validade: ${certInfo.validadeFim.toLocaleDateString()}`);
        console.log(`     Dias restantes: ${certInfo.diasRestantes}`);
        
        // Aviso se CNPJ do certificado é diferente
        if (certInfo.cnpj && certInfo.cnpj !== cnpj) {
            console.warn(`  ⚠️  AVISO: CNPJ do certificado (${certInfo.cnpj}) diferente do informado (${cnpj})`);
        }
        
        // Criptografa senha do certificado
        console.log('  → Criptografando senha...');
        const senhaEncrypted = encryptSenha(senha_certificado);
        
        // Gera API Key
        console.log('  → Gerando API Key...');
        const apiKey = crypto.randomBytes(32).toString('hex');
        
        // Insere no banco
        console.log('  → Inserindo no banco de dados...');
        const sqlInsert = `
            INSERT INTO empresas (
                cnpj,
                razao_social,
                nome_fantasia,
                inscricao_municipal,
                codigo_municipio,
                cep,
                logradouro,
                numero,
                complemento,
                bairro,
                uf,
                certificado_pfx,
                senha_certificado_encrypted,
                certificado_validade,
                certificado_emissor,
                certificado_titular,
                opcao_simples_nacional,
                regime_apuracao_tributacao,
                regime_especial_tributacao,
                serie_dps,
                tipo_ambiente,
                versao_aplicacao,
                api_key,
                api_key_ativa,
                ativa
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE, TRUE)
        `;
        
        const params = [
            cnpj,
            razao_social,
            nome_fantasia || null,
            inscricao_municipal || null,
            codigo_municipio,
            cep,
            logradouro,
            numero,
            complemento || null,
            bairro,
            uf.toUpperCase(),
            req.file.buffer,
            senhaEncrypted,
            certInfo.validadeFim.toISOString().split('T')[0],
            certInfo.emissor,
            certInfo.titular,
            opcao_simples_nacional || '3',
            regime_apuracao_tributacao || '1',
            regime_especial_tributacao || '0',
            serie_dps || '00001',
            tipo_ambiente || '2',
            versao_aplicacao || 'NFSeAPI_v1.0',
            apiKey
        ];
        
        const result = await query(sqlInsert, params);
        
        console.log('✅ Empresa cadastrada com sucesso!');
        console.log(`  → ID: ${result.insertId}`);
        console.log(`  → API Key: ${apiKey.substring(0, 16)}...`);
        
        res.status(201).json({
            sucesso: true,
            mensagem: 'Empresa cadastrada com sucesso!',
            empresa: {
                id: result.insertId,
                cnpj: cnpj,
                razaoSocial: razao_social,
                nomeFantasia: nome_fantasia,
                codigoMunicipio: codigo_municipio,
                ambiente: tipo_ambiente === '1' ? 'Produção' : 'Homologação',
                certificado: {
                    titular: certInfo.titular,
                    emissor: certInfo.emissor,
                    validade: certInfo.validadeFim,
                    diasRestantes: certInfo.diasRestantes,
                    status: certInfo.diasRestantes > 30 ? 'válido' : 'vencendo'
                },
                numeracao: {
                    serie: serie_dps || '00001',
                    proximoNumero: 1
                }
            },
            apiKey: apiKey,
            aviso: '⚠️ GUARDE ESTA API KEY! Ela não será mostrada novamente.'
        });
        
    } catch (error) {
        console.error('❌ Erro ao cadastrar empresa:', error);
        next(error);
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
        
        if (!cnpj || cnpj.length !== 14) {
            return res.status(400).json({
                sucesso: false,
                erro: 'CNPJ inválido (deve ter 14 dígitos)'
            });
        }
        
        console.log(`🔑 Gerando nova API Key para CNPJ: ${cnpj}`);
        
        const sqlBusca = `
            SELECT id, cnpj, razao_social, api_key
            FROM empresas
            WHERE cnpj = ?
        `;
        
        const empresas = await query(sqlBusca, [cnpj]);
        
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
        
        await query(sqlUpdate, [novaAPIKey, cnpj]);
        
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
 * GET /api/admin/listar-empresas
 * Lista todas as empresas cadastradas
 */
router.get('/listar-empresas', async (req, res, next) => {
    try {
        const { senha_admin } = req.query;
        
        if (!validarSenhaAdmin(senha_admin)) {
            return res.status(401).json({
                sucesso: false,
                erro: 'Senha administrativa inválida'
            });
        }
        
        console.log('📋 Listando empresas cadastradas...');
        
        const sql = `
            SELECT 
                id,
                cnpj,
                razao_social,
                nome_fantasia,
                CONCAT(LEFT(api_key, 16), '...') as api_key_preview,
                api_key,
                api_key_ativa,
                ativa,
                certificado_validade,
                DATEDIFF(certificado_validade, CURDATE()) as dias_restantes_cert,
                ultimo_numero_dps,
                serie_dps,
                tipo_ambiente,
                created_at
            FROM empresas
            ORDER BY created_at DESC
        `;
        
        const empresas = await query(sql);
        
        res.json({
            sucesso: true,
            total: empresas.length,
            empresas: empresas.map(emp => ({
                id: emp.id,
                cnpj: emp.cnpj,
                razaoSocial: emp.razao_social,
                nomeFantasia: emp.nome_fantasia,
                apiKey: emp.api_key,
                apiKeyPreview: emp.api_key_preview,
                apiKeyAtiva: emp.api_key_ativa === 1,
                ativa: emp.ativa === 1,
                certificado: {
                    validade: emp.certificado_validade,
                    diasRestantes: emp.dias_restantes_cert,
                    status: emp.dias_restantes_cert > 30 ? 'válido' : 
                           emp.dias_restantes_cert > 0 ? 'vencendo' : 'vencido'
                },
                numeracao: {
                    serie: emp.serie_dps,
                    ultimoNumero: emp.ultimo_numero_dps,
                    proximoNumero: emp.ultimo_numero_dps + 1
                },
                ambiente: emp.tipo_ambiente === '1' ? 'Produção' : 'Homologação',
                criadoEm: emp.created_at
            }))
        });
        
    } catch (error) {
        console.error('❌ Erro ao listar empresas:', error);
        next(error);
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
        
        if (!cnpj || cnpj.length !== 14) {
            return res.status(400).json({
                sucesso: false,
                erro: 'CNPJ inválido'
            });
        }
        
        const status = ativar === true || ativar === 'true' || ativar === 1;
        
        console.log(`${status ? '✅ Ativando' : '❌ Desativando'} empresa: ${cnpj}`);
        
        const sql = `
            UPDATE empresas 
            SET ativa = ?, api_key_ativa = ?
            WHERE cnpj = ?
        `;
        
        const result = await query(sql, [status, status, cnpj]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({
                sucesso: false,
                erro: 'Empresa não encontrada'
            });
        }
        
        res.json({
            sucesso: true,
            mensagem: `Empresa ${status ? 'ativada' : 'desativada'} com sucesso`,
            cnpj,
            status: status ? 'ativa' : 'inativa'
        });
        
    } catch (error) {
        console.error('❌ Erro ao ativar/desativar empresa:', error);
        next(error);
    }
});

/**
 * GET /api/admin/consultar-apikey/:cnpj
 * Consulta a API Key de uma empresa
 */
router.get('/consultar-apikey/:cnpj', async (req, res, next) => {
    try {
        const { cnpj } = req.params;
        const { senha_admin } = req.query;
        
        if (!validarSenhaAdmin(senha_admin)) {
            return res.status(401).json({
                sucesso: false,
                erro: 'Senha administrativa inválida'
            });
        }
        
        const sql = `
            SELECT 
                cnpj,
                razao_social,
                api_key,
                api_key_ativa,
                ativa
            FROM empresas
            WHERE cnpj = ?
        `;
        
        const empresas = await query(sql, [cnpj]);
        
        if (empresas.length === 0) {
            return res.status(404).json({
                sucesso: false,
                erro: 'Empresa não encontrada'
            });
        }
        
        const empresa = empresas[0];
        
        res.json({
            sucesso: true,
            empresa: {
                cnpj: empresa.cnpj,
                razaoSocial: empresa.razao_social,
                apiKey: empresa.api_key,
                apiKeyAtiva: empresa.api_key_ativa === 1,
                empresaAtiva: empresa.ativa === 1
            }
        });
        
    } catch (error) {
        console.error('❌ Erro ao consultar API Key:', error);
        next(error);
    }
});

module.exports = router;