const express = require('express');
const multer = require('multer');
const CryptoJS = require('crypto-js');
const forge = require('node-forge');
const { body, query: queryValidator, validationResult } = require('express-validator');
const XMLService = require('../services/xmlService');
const SefinService = require('../services/sefinService');
const SefinResponseProcessor = require('../services/sefinResponseProcessor');
const { query } = require('../config/database');
const SefinConfig = require('../services/sefinConfig'); 

const router = express.Router();

// ============================================
// CONFIGURAÇÃO MULTER PARA UPLOAD DE CERTIFICADO
// ============================================
const uploadCertificado = multer({ 
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB max
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/x-pkcs12' || 
            file.originalname?.endsWith('.pfx') || 
            file.originalname?.endsWith('.p12')) {
            cb(null, true);
        } else {
            cb(new Error('Apenas arquivos .pfx ou .p12 são permitidos'));
        }
    }
});

// ============================================
// FUNÇÕES AUXILIARES
// ============================================

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
function validarCertificado(bufferCertificado, senha) {
    try {
        const p12Der = forge.util.binary.raw.encode(new Uint8Array(bufferCertificado));
        const p12Asn1 = forge.asn1.fromDer(p12Der);
        const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, senha);

        const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
        const certificate = certBags[forge.pki.oids.certBag][0].cert;

        const subject = certificate.subject.attributes.reduce((obj, attr) => {
            obj[attr.shortName || attr.name] = attr.value;
            return obj;
        }, {});

        const issuer = certificate.issuer.attributes.reduce((obj, attr) => {
            obj[attr.shortName || attr.name] = attr.value;
            return obj;
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
 * Middleware para validar erros de validação
 */
function validarErros(req, res, next) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            sucesso: false,
            erro: 'Erro de validação',
            detalhes: errors.array()
        });
    }
    next();
}

/**
 * Middleware para verificar se empresa tem certificado
 */
async function verificarCertificado(req, res, next) {
    const sql = 'SELECT certificado_pfx IS NOT NULL as tem_certificado FROM empresas WHERE id = ?';
    const result = await query(sql, [req.empresa.id]);

    if (!result[0]?.tem_certificado) {
        return res.status(400).json({
            sucesso: false,
            erro: 'Certificado digital não configurado',
            mensagem: 'Você precisa enviar seu certificado digital antes de emitir NFS-e',
            acao: 'Use POST /api/nfse/certificado para enviar seu certificado .pfx/.p12'
        });
    }
    next();
}

// ============================================
// ROTAS DE CERTIFICADO (CLIENTE AUTENTICADO)
// ============================================

/**
 * POST /api/nfse/certificado
 * Cliente envia/atualiza seu certificado digital
 * Requer autenticação via API Key
 */
router.post('/certificado', uploadCertificado.single('certificado'), async (req, res, next) => {
    try {
        console.log(`📄 Cliente enviando certificado - Empresa: ${req.empresa.razao_social}`);
        
        // Valida se certificado foi enviado
        if (!req.file) {
            return res.status(400).json({
                sucesso: false,
                erro: 'Certificado digital (.pfx ou .p12) não foi enviado',
                instrucoes: {
                    campo: 'certificado',
                    tipo: 'file (multipart/form-data)',
                    formatos: ['.pfx', '.p12']
                }
            });
        }
        
        const { senha_certificado } = req.body;
        
        if (!senha_certificado) {
            return res.status(400).json({
                sucesso: false,
                erro: 'Senha do certificado é obrigatória',
                instrucoes: {
                    campo: 'senha_certificado',
                    tipo: 'string'
                }
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
        
        // Verifica se CNPJ do certificado bate com a empresa
        if (certInfo.cnpj && certInfo.cnpj !== req.empresa.cnpj) {
            console.warn(`  ⚠️  AVISO: CNPJ do certificado (${certInfo.cnpj}) diferente da empresa (${req.empresa.cnpj})`);
            // Não bloqueia, apenas avisa (alguns certificados têm CNPJ diferente)
        }
        
        // Verifica validade
        if (certInfo.diasRestantes <= 0) {
            return res.status(400).json({
                sucesso: false,
                erro: 'Certificado vencido',
                detalhes: {
                    validade: certInfo.validadeFim,
                    diasVencido: Math.abs(certInfo.diasRestantes)
                },
                mensagem: 'Por favor, envie um certificado válido'
            });
        }
        
        // Criptografa senha
        console.log('  → Criptografando senha...');
        const senhaEncrypted = encryptSenha(senha_certificado);
        
        // Busca info do certificado anterior (se existir)
        const sqlBuscaAnterior = 'SELECT certificado_validade FROM empresas WHERE id = ?';
        const certAnterior = await query(sqlBuscaAnterior, [req.empresa.id]);
        const tinhaAnterior = certAnterior[0]?.certificado_validade != null;
        
        // Atualiza no banco
        console.log('  → Salvando certificado...');
        const sqlUpdate = `
            UPDATE empresas 
            SET 
                certificado_pfx = ?,
                senha_certificado_encrypted = ?,
                certificado_validade = ?,
                certificado_emissor = ?,
                certificado_titular = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `;
        
        await query(sqlUpdate, [
            req.file.buffer,
            senhaEncrypted,
            certInfo.validadeFim.toISOString().split('T')[0],
            certInfo.emissor,
            certInfo.titular,
            req.empresa.id
        ]);
        
        console.log('✅ Certificado salvo com sucesso!');
        
        res.json({
            sucesso: true,
            mensagem: tinhaAnterior ? 'Certificado atualizado com sucesso!' : 'Certificado cadastrado com sucesso!',
            empresa: {
                cnpj: req.empresa.cnpj,
                razaoSocial: req.empresa.razao_social
            },
            certificado: {
                titular: certInfo.titular,
                emissor: certInfo.emissor,
                validade: certInfo.validadeFim,
                diasRestantes: certInfo.diasRestantes,
                status: certInfo.diasRestantes > 30 ? 'válido' : 'próximo do vencimento',
                cnpjCertificado: certInfo.cnpj
            },
            aviso: certInfo.diasRestantes <= 30 
                ? `⚠️ Seu certificado vence em ${certInfo.diasRestantes} dias. Lembre-se de renová-lo!`
                : null,
            proximosPasso: 'Agora você pode emitir NFS-e usando POST /api/nfse/emitir'
        });
        
    } catch (error) {
        console.error('❌ Erro ao salvar certificado:', error);
        next(error);
    }
});

/**
 * Helper: Descrição do tipo de evento
 */
function obterDescricaoTipoEvento(tipo) {
    const tipos = {
        '1': 'Cancelamento',
        '2': 'Carta de Correção'
    };
    return tipos[tipo] || `Tipo ${tipo}`;
}

/**
 * GET /api/nfse/:chaveAcesso/eventos
 * Lista TODOS os eventos da NFS-e
 */
router.get('/:chaveAcesso/eventos', verificarCertificado, async (req, res, next) => {
    try {
        const { chaveAcesso } = req.params;
        const { descomprimir } = req.query; // ?descomprimir=true para obter XMLs
        const cnpjEmpresa = req.empresa.cnpj;
        const tipoAmbiente = process.env.SEFIN_AMBIENTE || req.empresa.tipo_ambiente; 
        console.log(`📋 Consultando eventos da NFS-e: ${chaveAcesso.substring(0, 20)}...`);
        
        // Valida chave de acesso
        if (!chaveAcesso || chaveAcesso.length !== 50) {
            return res.status(400).json({
                sucesso: false,
                erro: 'Chave de acesso inválida (deve ter 50 caracteres)'
            });
        }
        
        const descomprimirXML = descomprimir === 'true' || descomprimir === '1';
        
        const resultado = await SefinService.consultarEventosNFSe(
            chaveAcesso,
            cnpjEmpresa,
            tipoAmbiente,
            descomprimirXML
        );
        
        if (!resultado.sucesso && resultado.status !== 404) {
            return res.status(resultado.status || 500).json(resultado);
        }
        
        // Formata resposta amigável
        const eventosFormatados = resultado.eventos.map(evento => ({
            tipoEvento: evento.tpEvento || evento.tipoEvento,
            descricao: obterDescricaoTipoEvento(evento.tpEvento || evento.tipoEvento),
            numeroSequencia: evento.nSeqEvento || evento.numSeqEvento,
            dataHora: evento.dhEvento || evento.dataHoraProcessamento,
            versaoApp: evento.verAplic || evento.versaoAplicativo,
            ambiente: evento.tpAmb || evento.tipoAmbiente,
            situacao: evento.situacao || 'Registrado',
            eventoXmlGZipB64: evento.eventoXmlGZipB64,
            eventoXML: evento.eventoXML // Só vem se descomprimir=true
        }));
        
        res.json({
            sucesso: true,
            chaveAcesso: chaveAcesso,
            quantidade: resultado.quantidade,
            eventos: eventosFormatados,
            mensagem: resultado.quantidade === 0 
                ? 'Nenhum evento registrado para esta NFS-e' 
                : `${resultado.quantidade} evento(s) encontrado(s)`
        });
        
    } catch (error) {
        console.error('❌ Erro ao consultar eventos:', error.message);
        next(error);
    }
});

/**
 * GET /api/nfse/:chaveAcesso/eventos/:tipoEvento/:numSeqEvento
 * Consulta um evento ESPECÍFICO
 */
router.get('/:chaveAcesso/eventos/:tipoEvento/:numSeqEvento', verificarCertificado, async (req, res, next) => {
    try {
        const { chaveAcesso, tipoEvento, numSeqEvento } = req.params;
        const { descomprimir } = req.query; // ?descomprimir=true para obter XML
        const cnpjEmpresa = req.empresa.cnpj;
        const tipoAmbiente = req.empresa.tipo_ambiente;
        
        console.log(`🔍 Consultando evento específico: tipo ${tipoEvento}, seq ${numSeqEvento}`);
        
        // Validações
        if (!chaveAcesso || chaveAcesso.length !== 50) {
            return res.status(400).json({
                sucesso: false,
                erro: 'Chave de acesso inválida (deve ter 50 caracteres)'
            });
        }
        
        if (!['1', '2'].includes(tipoEvento)) {
            return res.status(400).json({
                sucesso: false,
                erro: 'Tipo de evento inválido (1=Cancelamento, 2=Carta Correção)'
            });
        }
        
        const descomprimirXML = descomprimir === 'true' || descomprimir === '1';
        
        const resultado = await SefinService.consultarEventoEspecifico(
            chaveAcesso,
            tipoEvento,
            numSeqEvento,
            cnpjEmpresa,
            tipoAmbiente,
            descomprimirXML
        );
        
        if (!resultado.sucesso) {
            return res.status(resultado.status || 404).json(resultado);
        }
        
        res.json({
            sucesso: true,
            chaveAcesso: chaveAcesso,
            evento: {
                tipo: tipoEvento,
                descricao: obterDescricaoTipoEvento(tipoEvento),
                numeroSequencia: numSeqEvento,
                ambiente: resultado.evento.tipoAmbiente,
                versaoApp: resultado.evento.versaoAplicativo,
                dataHoraProcessamento: resultado.evento.dataHoraProcessamento,
                eventoXmlGZipB64: resultado.evento.eventoXmlGZipB64,
                eventoXML: resultado.evento.eventoXML // Só vem se descomprimir=true
            }
        });
        
    } catch (error) {
        console.error('❌ Erro ao consultar evento específico:', error.message);
        next(error);
    }
});

/**
 * ADICIONE ESTE CÓDIGO NO SEU nfse.routes.js
 * 
 * Adicione os imports no topo:
 * const XMLEventoService = require('../services/xmlEventoService');
 * const SefinEventoService = require('../services/sefinEventoService');
 */

/**
 * POST /api/nfse/:chaveAcesso/cancelar
 * Cancela uma NFS-e emitida
 * 
 * URL: /api/nfse/33045572201800344000148000000000002325124472728969/cancelar
 * 
 * Body:
 *   {
 *     "codigoMotivo": "1",
 *     "motivo": "Erro no serviço prestado"
 *   }
 */
router.post('/:chaveAcesso/cancelar',
    verificarCertificado,
    [
        body('codigoMotivo').notEmpty().withMessage('Código do motivo é obrigatório'),
        body('motivo').notEmpty().withMessage('Motivo é obrigatório')
    ],
    validarErros,
    async (req, res, next) => {
        try {
            const { chaveAcesso } = req.params;
            const { codigoMotivo, motivo } = req.body;
            const cnpjEmpresa = req.empresa.cnpj;
            const tipoAmbiente = req.empresa.tipo_ambiente;

            // Validar chave de acesso (50 dígitos)
            if (!chaveAcesso || chaveAcesso.length !== 50) {
                return res.status(400).json({
                    sucesso: false,
                    erro: 'Chave de acesso inválida (deve ter 50 caracteres)',
                    recebido: chaveAcesso?.length || 0
                });
            }

            console.log('\n' + '='.repeat(70));
            console.log(`🚫 CANCELAMENTO - Empresa: ${req.empresa.razao_social}`);
            console.log(`   Chave: ${chaveAcesso}`);
            console.log(`   Motivo: ${codigoMotivo} - ${motivo}`);
            console.log('='.repeat(70));

            // 1. Processa o evento de cancelamento
            const XMLEventoService = require('../services/xmlEventoService');
            const SefinEventoService = require('../services/sefinEventoService');

            const resultado = await XMLEventoService.processarCancelamento({
                chaveAcesso,
                codigoMotivo: parseInt(codigoMotivo),
                motivoTexto: motivo,
                tipoAmbiente,
                versaoAplicacao: 'NFSeAPI_v1.0'
            }, cnpjEmpresa);

            // 2. Envia para SEFIN (chaveAcesso vai na URL)
            const respostaSefin = await SefinEventoService.enviarEvento(
                resultado.eventoXmlGZipB64,
                chaveAcesso,  // chave vai na URL: /nfse/{chaveAcesso}/eventos
                cnpjEmpresa,
                tipoAmbiente
            );

            // 3. Processa resposta
            if (respostaSefin.sucesso) {
                console.log('✅ Cancelamento processado com sucesso!');

                res.json({
                    sucesso: true,
                    mensagem: 'NFS-e cancelada com sucesso',
                    evento: {
                        tipoEvento: '101101',
                        chaveAcesso,
                        protocolo: respostaSefin.dados?.protocolo,
                        dataEvento: new Date().toISOString()
                    },
                    sefin: respostaSefin.dados
                });
            } else {
                console.log('❌ Erro no cancelamento:', respostaSefin.erro);

                res.status(400).json({
                    sucesso: false,
                    erro: respostaSefin.erro || 'Erro ao cancelar NFS-e',
                    detalhes: respostaSefin.dados?.erros || respostaSefin.detalhes
                });
            }

        } catch (error) {
            console.error('❌ Erro no cancelamento:', error.message);
            next(error);
        }
    }
);
/**
 * POST /api/nfse/:chaveAcesso/eventos
 * Registra um evento genérico (cancelamento, carta correção, etc)
 */
router.post('/:chaveAcesso/eventos',
    verificarCertificado,
    [
        body('tpEvento')
            .notEmpty().withMessage('Tipo de evento é obrigatório')
            .isIn(['1', '2']).withMessage('Tipo de evento inválido (1=Cancelamento, 2=Carta Correção)'),
        body('nSeqEvento')
            .notEmpty().withMessage('Número de sequência é obrigatório')
            .isInt({ min: 1 }).withMessage('Número de sequência deve ser >= 1'),
        body('xMotivo')
            .notEmpty().withMessage('Motivo é obrigatório')
            .isLength({ min: 15 }).withMessage('Motivo deve ter no mínimo 15 caracteres')
    ],
    validarErros,
    async (req, res, next) => {
        try {
            const { chaveAcesso } = req.params;
            const { tpEvento, nSeqEvento, xMotivo } = req.body;
            const cnpjEmpresa = req.empresa.cnpj;
            const tipoAmbiente = req.empresa.tipo_ambiente;
            
            console.log(`📤 Registrando evento tipo ${tpEvento} seq ${nSeqEvento}`);
            
            // Valida chave de acesso
            if (!chaveAcesso || chaveAcesso.length !== 50) {
                return res.status(400).json({
                    sucesso: false,
                    erro: 'Chave de acesso inválida (deve ter 50 caracteres)'
                });
            }
            
            // Monta dados do evento
            const dadosEvento = {
                chNFSe: chaveAcesso,
                tpAmb: tipoAmbiente,
                verAplic: 'NFSeAPI_v1.0',
                CNPJAutor: cnpjEmpresa,
                dhEvento: new Date().toISOString(),
                tpEvento: tpEvento,
                nSeqEvento: nSeqEvento.toString(),
                xMotivo: xMotivo
            };
            
            // Registra evento
            const resultado = await SefinService.registrarEvento(
                chaveAcesso,
                dadosEvento,
                cnpjEmpresa,
                tipoAmbiente
            );
            
            if (!resultado.sucesso) {
                return res.status(400).json({
                    sucesso: false,
                    erro: 'Erro ao registrar evento',
                    detalhes: resultado.erro || resultado.detalhes,
                    dados: resultado.dados
                });
            }
            
            res.json({
                sucesso: true,
                mensagem: 'Evento registrado com sucesso',
                evento: {
                    tipo: tpEvento,
                    descricao: obterDescricaoTipoEvento(tpEvento),
                    numeroSequencia: nSeqEvento,
                    motivo: xMotivo
                },
                retornoSEFIN: resultado.dados,
                debug: {
                    xmlOriginal: resultado.xmlOriginal,
                    xmlAssinado: resultado.xmlAssinado
                }
            });
            
        } catch (error) {
            console.error('❌ Erro ao registrar evento:', error.message);
            next(error);
        }
    }
);

/**
 * GET /api/nfse/certificado
 * Consulta status do certificado da empresa
 */
router.get('/certificado', async (req, res, next) => {
    try {
        const sql = `
            SELECT 
                certificado_pfx IS NOT NULL as tem_certificado,
                certificado_validade,
                certificado_titular,
                certificado_emissor,
                DATEDIFF(certificado_validade, CURDATE()) as dias_restantes
            FROM empresas
            WHERE id = ?
        `;
        
        const result = await query(sql, [req.empresa.id]);
        const empresa = result[0];
        
        if (!empresa.tem_certificado) {
            return res.json({
                sucesso: true,
                temCertificado: false,
                certificado: null,
                mensagem: 'Certificado digital não configurado',
                acao: 'Use POST /api/nfse/certificado para enviar seu certificado .pfx/.p12'
            });
        }
        
        let status;
        if (empresa.dias_restantes <= 0) {
            status = 'vencido';
        } else if (empresa.dias_restantes <= 7) {
            status = 'crítico';
        } else if (empresa.dias_restantes <= 30) {
            status = 'atenção';
        } else {
            status = 'válido';
        }
        
        res.json({
            sucesso: true,
            temCertificado: true,
            certificado: {
                titular: empresa.certificado_titular,
                emissor: empresa.certificado_emissor,
                validade: empresa.certificado_validade,
                diasRestantes: empresa.dias_restantes,
                status: status
            },
            aviso: empresa.dias_restantes <= 30 
                ? `⚠️ Seu certificado ${empresa.dias_restantes <= 0 ? 'está vencido!' : `vence em ${empresa.dias_restantes} dias`}`
                : null
        });
        
    } catch (error) {
        console.error('❌ Erro ao consultar certificado:', error);
        next(error);
    }
});

/**
 * DELETE /api/nfse/certificado
 * Remove o certificado da empresa (cliente pode querer trocar)
 */
router.delete('/certificado', async (req, res, next) => {
    try {
        console.log(`🗑️ Removendo certificado - Empresa: ${req.empresa.razao_social}`);
        
        const sql = `
            UPDATE empresas 
            SET 
                certificado_pfx = NULL,
                senha_certificado_encrypted = NULL,
                certificado_validade = NULL,
                certificado_emissor = NULL,
                certificado_titular = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `;
        
        await query(sql, [req.empresa.id]);
        
        console.log('✅ Certificado removido!');
        
        res.json({
            sucesso: true,
            mensagem: 'Certificado removido com sucesso',
            aviso: 'Você não poderá emitir NFS-e até enviar um novo certificado',
            acao: 'Use POST /api/nfse/certificado para enviar um novo certificado'
        });
        
    } catch (error) {
        console.error('❌ Erro ao remover certificado:', error);
        next(error);
    }
});

// ============================================
// ROTAS DE NFS-E (REQUEREM CERTIFICADO)
// ============================================

/**
 * GET /api/nfse/parametros-convenio/:codigoMunicipio
 */
router.get('/parametros-convenio/:codigoMunicipio', verificarCertificado, async (req, res, next) => {
    try {
        const { codigoMunicipio } = req.params;
        const cnpjEmpresa = req.empresa.cnpj;

        if (!codigoMunicipio || codigoMunicipio.length !== 7) {
            return res.status(400).json({
                sucesso: false,
                erro: 'Código do município inválido (deve ter 7 dígitos)'
            });
        }

        console.log(`📋 Consultando parâmetros de convênio - Município: ${codigoMunicipio}`);

        // ✅ CORRIGIDO: sem parâmetro tipoAmbiente
        const resultado = await SefinService.consultarParametrosConvenio(
            codigoMunicipio,
            cnpjEmpresa
        );

        if (!resultado.sucesso) {
            return res.status(resultado.status || 500).json({
                sucesso: false,
                erro: resultado.erro,
                detalhes: resultado.detalhes,
                mensagem: 'Não foi possível consultar os parâmetros do município'
            });
        }

        res.json({
            sucesso: true,
            codigoMunicipio,
            ambiente: SefinConfig.getNomeAmbiente(), // ✅ CORRIGIDO
            parametros: resultado.dados,
            processamento: {
                tempoConsulta: `${resultado.tempoProcessamento}ms`,
                timestamp: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('❌ Erro ao consultar parâmetros:', error.message);
        next(error);
    }
});

/**
 * POST /api/nfse/emitir
 * Emite NFS-e (requer certificado configurado)
 */
router.post('/emitir',
    verificarCertificado,
    [
        body('xml').notEmpty().withMessage('XML é obrigatório')
    ],
    validarErros,
    async (req, res, next) => {
        const inicioProcessamento = Date.now();

        try {
            const { xml } = req.body;
            const cnpjEmpresa = req.empresa.cnpj;
            const empresaId = req.empresa.id;

            console.log('\n' + '='.repeat(70));
            console.log(`📝 NOVA EMISSÃO - Empresa: ${req.empresa.razao_social}`);
            console.log('='.repeat(70));

            // 1. Processa o XML
            const resultado = await XMLService.processarXML(xml, cnpjEmpresa);

            // 2. Envia para SEFIN (✅ SEM parâmetro tipoAmbiente)
            const respostaSefin = await SefinService.enviarDPS(
                resultado.dpsXmlGZipB64,
                cnpjEmpresa
            );

            const tempoTotal = Date.now() - inicioProcessamento;
            const statusEnvio = respostaSefin.sucesso ? 'sucesso' : 'erro';

            // 3. Registra transmissão inicial
            const transmissaoId = await SefinService.registrarTransmissao({
                empresaId,
                idDPS: resultado.infoDPS.idDPS,
                numeroDPS: resultado.infoDPS.numeroDPS,
                serieDPS: resultado.infoDPS.serieDPS,
                xmlOriginal: xml,
                xmlAssinado: resultado.xmlAssinado,
                dpsBase64: resultado.dpsXmlGZipB64,
                statusEnvio,
                codigoRetorno: respostaSefin.dados?.codigo,
                mensagemRetorno: respostaSefin.dados?.mensagem,
                respostaCompleta: respostaSefin.dados,
                numeroProtocolo: respostaSefin.dados?.protocolo,
                dataRecebimento: respostaSefin.sucesso ? new Date() : null,
                ipOrigem: req.ip,
                userAgent: req.get('user-agent'),
                tempoProcessamento: tempoTotal
            });

            // 4. Processa resposta completa
            let dadosNFSe;
            let mensagemUsuario;
            let ehDuplicidadeRecuperavel = false;

            if (respostaSefin.sucesso) {
                const codigo = respostaSefin.dados?.codigo;

                if (codigo === 'A2100' || codigo === 'E2100') {
                    const idDPS = resultado.infoDPS.idDPS;
                    const chaveResult = await SefinResponseProcessor.buscarChaveAcessoPorDPS(idDPS, cnpjEmpresa);

                    if (chaveResult.sucesso) {
                        ehDuplicidadeRecuperavel = true;
                        dadosNFSe = await SefinResponseProcessor.consultarDadosNFSe(
                            chaveResult.chaveAcesso,
                            cnpjEmpresa
                        );
                        mensagemUsuario = dadosNFSe.mensagem;
                    }
                } else {
                    dadosNFSe = await SefinResponseProcessor.processarRespostaCompleta(
                        respostaSefin,
                        resultado.infoDPS,
                        cnpjEmpresa
                    );
                    mensagemUsuario = dadosNFSe.mensagem || 'NFS-e emitida com sucesso';
                }

                if (dadosNFSe && dadosNFSe.sucesso && dadosNFSe.chaveAcesso) {
                    await SefinResponseProcessor.atualizarTransmissaoComDadosNFSe(
                        transmissaoId,
                        dadosNFSe
                    );

                    if (resultado.infoDPS.numeroDPS) {
                        await SefinService.atualizarUltimoNumeroDPS(
                            empresaId,
                            parseInt(resultado.infoDPS.numeroDPS)
                        );
                    }
                }
            } else {
                dadosNFSe = {
                    sucesso: false,
                    mensagem: respostaSefin.dados?.mensagem || 'Erro no envio',
                    erros: respostaSefin.dados?.erros || []
                };
                mensagemUsuario = dadosNFSe.mensagem;
            }

            console.log('='.repeat(70));
            console.log(`✅ PROCESSO CONCLUÍDO - Tempo: ${tempoTotal}ms`);
            console.log('='.repeat(70) + '\n');

            const responseData = {
                sucesso: dadosNFSe.sucesso,
                transmissaoId,
                dps: {
                    idDPS: resultado.infoDPS.idDPS,
                    numeroDPS: resultado.infoDPS.numeroDPS,
                    serieDPS: resultado.infoDPS.serieDPS
                },
                nfse: {
                    chaveAcesso: dadosNFSe.chaveAcesso,
                    numeroNFSe: dadosNFSe.numeroNFSe,
                    codigoVerificacao: dadosNFSe.codigoVerificacao,
                    linkConsulta: dadosNFSe.linkConsulta,
                    dataEmissao: dadosNFSe.dataEmissao,
                    situacao: dadosNFSe.situacao,
                    xmlNFSe: dadosNFSe.xmlNFSe || null
                },
                sefin: {
                    protocolo: dadosNFSe.protocolo,
                    mensagem: mensagemUsuario,
                    erros: dadosNFSe.erros || null
                },
                processamento: {
                    tempoTotal: `${tempoTotal}ms`,
                    ambiente: SefinConfig.getNomeAmbiente(), // ✅ CORRIGIDO
                    timestamp: new Date().toISOString()
                },
                recuperadoDeDuplicidade: ehDuplicidadeRecuperavel
            };

            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.status(dadosNFSe.sucesso ? 200 : 400).send(
                JSON.stringify(responseData)
            );

        } catch (error) {
            console.error('❌ Erro na emissão:', error.message);
            next(error);
        }
    }
);

/**
 * POST /api/nfse/validar
 */
router.post('/validar',
    verificarCertificado,
    [
        body('xml').notEmpty().withMessage('XML é obrigatório')
    ],
    validarErros,
    async (req, res, next) => {
        try {
            const { xml } = req.body;
            const cnpjEmpresa = req.empresa.cnpj;
            
            console.log(`📋 Validando XML - Empresa: ${req.empresa.razao_social}`);
            
            const resultado = await XMLService.processarXML(xml, cnpjEmpresa);
            
            res.json({
                sucesso: true,
                mensagem: 'XML válido e pronto para envio',
                dps: {
                    idDPS: resultado.infoDPS.idDPS,
                    numeroDPS: resultado.infoDPS.numeroDPS,
                    serieDPS: resultado.infoDPS.serieDPS,
                    cnpjPrestador: resultado.infoDPS.cnpjPrestador,
                    cnpjTomador: resultado.infoDPS.cnpjTomador
                },
                validacao: resultado.validacao,
                debug: {
                    xmlAssinado: resultado.xmlAssinado,
                    tamanhoBase64: resultado.dpsXmlGZipB64.length
                }
            });
            
        } catch (error) {
            console.error('❌ Erro na validação:', error.message);
            try {
                const errorObj = JSON.parse(error.message);
                if (errorObj.tipo === 'VALIDACAO_XSD') {
                    return res.status(422).json({
                        sucesso: false,
                        tipo: 'validacao_xsd',
                        mensagem: errorObj.mensagem,
                        erros: errorObj.erros,
                        totalErros: errorObj.totalErros
                    });
                }
            } catch (e) {}
            next(error);
        }
    }
);

/**
 * GET /api/nfse/consultar-por-chave/:chaveAcesso
 * Consulta dados básicos da NFS-e pela chave de acesso
 */
router.get('/consultar-por-chave/:chaveAcesso', verificarCertificado, async (req, res, next) => {
    try {
        const { chaveAcesso } = req.params;
        const cnpjEmpresa = req.empresa.cnpj;
        const tipoAmbiente = req.empresa.tipo_ambiente;
        
        console.log(`🔍 Consultando NFS-e por chave: ${chaveAcesso.substring(0, 20)}...`);
        
        // Valida chave de acesso (NFS-e Nacional = 50 caracteres)
        if (!chaveAcesso || chaveAcesso.length !== 50) {
            return res.status(400).json({
                sucesso: false,
                erro: 'Chave de acesso inválida (deve ter 50 caracteres)',
                recebido: chaveAcesso?.length || 0
            });
        }
        
        const resultado = await SefinResponseProcessor.consultarDadosNFSe(
            chaveAcesso,
            cnpjEmpresa,
            tipoAmbiente
        );
        
        if (!resultado.sucesso) {
            return res.status(404).json({
                sucesso: false,
                erro: 'NFS-e não encontrada',
                detalhes: resultado.erro
            });
        }
        
        res.json({
            sucesso: true,
            nfse: {
                chaveAcesso: chaveAcesso,
                numeroNFSe: resultado.numeroNFSe,
                codigoVerificacao: resultado.codigoVerificacao,
                dataEmissao: resultado.dataEmissao,
                situacao: resultado.situacao,
                linkConsulta: SefinResponseProcessor.montarLinkConsulta(chaveAcesso, tipoAmbiente)
            },
            dadosCompletos: resultado.dadosCompletos
        });
        
    } catch (error) {
        console.error('❌ Erro ao consultar NFS-e:', error.message);
        next(error);
    }
});

/**
 * GET /api/nfse/:chaveAcesso/xml
 * Retorna o XML completo da NFS-e
 * 
 * Query params:
 *   - formato=raw : Retorna XML puro para download
 *   - (padrão)    : Retorna JSON com XML embutido
 */
router.get('/:chaveAcesso/xml', verificarCertificado, async (req, res, next) => {
    try {
        const { chaveAcesso } = req.params;
        const { formato } = req.query; // ?formato=raw para XML puro
        const cnpjEmpresa = req.empresa.cnpj;
        const tipoAmbiente = req.empresa.tipo_ambiente;
        
        console.log(`📄 Consultando XML da NFS-e: ${chaveAcesso.substring(0, 20)}...`);
        
        // Valida chave de acesso (NFS-e Nacional = 50 caracteres)
        if (!chaveAcesso || chaveAcesso.length !== 50) {
            return res.status(400).json({
                sucesso: false,
                erro: 'Chave de acesso inválida (deve ter 50 caracteres)',
                recebido: chaveAcesso?.length || 0
            });
        }
        
        // Consulta na SEFIN
        const resultado = await SefinResponseProcessor.consultarDadosNFSe(
            chaveAcesso,
            cnpjEmpresa,
            tipoAmbiente
        );
        
        if (!resultado.sucesso) {
            return res.status(404).json({
                sucesso: false,
                erro: 'NFS-e não encontrada',
                detalhes: resultado.erro
            });
        }
        
        if (!resultado.xmlNFSe) {
            return res.status(404).json({
                sucesso: false,
                erro: 'XML da NFS-e não disponível',
                mensagem: 'A nota foi encontrada mas o XML ainda não está disponível para download'
            });
        }
        
        // Se formato=raw, retorna XML puro para download
        if (formato === 'raw') {
            res.setHeader('Content-Type', 'application/xml; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="NFSe_${chaveAcesso}.xml"`);
            return res.send(resultado.xmlNFSe);
        }
        
        // Padrão: retorna JSON com XML embutido
        res.json({
            sucesso: true,
            nfse: {
                chaveAcesso: chaveAcesso,
                numeroNFSe: resultado.numeroNFSe,
                codigoVerificacao: resultado.codigoVerificacao,
                dataEmissao: resultado.dataEmissao,
                situacao: resultado.situacao
            },
            xml: resultado.xmlNFSe
        });
        
    } catch (error) {
        console.error('❌ Erro ao consultar XML:', error.message);
        next(error);
    }
});

/**
 * GET /api/nfse/:chaveAcesso/pdf
 * Retorna o PDF (DANFSE) da NFS-e para download
 * 
 * Query params:
 *   - formato=base64 : Retorna JSON com PDF em Base64
 *   - (padrão)       : Retorna PDF binário para download direto
 */
router.get('/:chaveAcesso/pdf', verificarCertificado, async (req, res, next) => {
    try {
        const { chaveAcesso } = req.params;
        const { formato } = req.query; // ?formato=base64 para retornar em JSON
        const cnpjEmpresa = req.empresa.cnpj;
        const tipoAmbiente = process.env.SEFIN_AMBIENTE || req.empresa.tipo_ambiente;
        
        console.log(`📥 Baixando PDF da NFS-e: ${chaveAcesso.substring(0, 20)}...`);
        
        // Valida chave de acesso
        // Valida chave de acesso (NFS-e Nacional = 50 caracteres)
        if (!chaveAcesso || chaveAcesso.length !== 50) {
            return res.status(400).json({
                sucesso: false,
                erro: 'Chave de acesso inválida (deve ter 50 caracteres)',
                recebido: chaveAcesso?.length || 0
            });
        }
        
        // Baixa o PDF da SEFIN
        const resultado = await SefinResponseProcessor.baixarPDFBase64(
            chaveAcesso,
            cnpjEmpresa,
            tipoAmbiente
        );
        
        if (!resultado.sucesso) {
            return res.status(404).json({
                sucesso: false,
                erro: 'PDF não disponível',
                detalhes: resultado.erro,
                mensagem: 'O DANFSE pode não estar disponível ainda. Tente novamente em alguns minutos.',
                linkAlternativo: SefinResponseProcessor.montarLinkPDF(chaveAcesso, tipoAmbiente)
            });
        }
        
        // Se formato=base64, retorna JSON com PDF em Base64
        if (formato === 'base64') {
            return res.json({
                sucesso: true,
                chaveAcesso: chaveAcesso,
                pdfBase64: resultado.pdfBase64,
                tamanho: resultado.tamanhoKB,
                contentType: 'application/pdf',
                nomeArquivo: `DANFSE_${chaveAcesso}.pdf`
            });
        }
        
        // Padrão: retorna o PDF binário para download direto
        const pdfBuffer = Buffer.from(resultado.pdfBase64, 'base64');
        
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="DANFSE_${chaveAcesso}.pdf"`);
        res.setHeader('Content-Length', pdfBuffer.length);
        
        res.send(pdfBuffer);
        
    } catch (error) {
        console.error('❌ Erro ao baixar PDF:', error.message);
        next(error);
    }
});

/**
 * GET /api/nfse/consultar/:idDPS
 * Consulta uma transmissão pelo ID da DPS (banco local)
 */
router.get('/consultar/:idDPS', async (req, res, next) => {
    try {
        const { idDPS } = req.params;
        const cnpjEmpresa = req.empresa.cnpj;
        
        const transmissao = await SefinService.consultarTransmissao(idDPS, cnpjEmpresa);
        
        if (!transmissao) {
            return res.status(404).json({
                sucesso: false,
                erro: 'Transmissão não encontrada'
            });
        }
        
        res.json({
            sucesso: true,
            transmissao: {
                id: transmissao.id,
                idDPS: transmissao.id_dps,
                numeroDPS: transmissao.numero_dps,
                serieDPS: transmissao.serie_dps,
                status: transmissao.status_envio,
                protocolo: transmissao.numero_protocolo,
                dataEnvio: transmissao.created_at,
                dataRecebimento: transmissao.data_recebimento,
                nfse: {
                    chaveAcesso: transmissao.chave_acesso_nfse,
                    numeroNFSe: transmissao.numero_nfse,
                    codigoVerificacao: transmissao.codigo_verificacao,
                    linkConsulta: transmissao.link_consulta,
                    dataEmissao: transmissao.data_emissao_nfse,
                    situacao: transmissao.situacao_nfse
                },
                resposta: transmissao.resposta_completa
            }
        });
        
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/nfse/listar
 * Lista transmissões com paginação
 */
router.get('/listar',
    [
        queryValidator('pagina').optional().isInt({ min: 1 }).toInt(),
        queryValidator('limite').optional().isInt({ min: 1, max: 100 }).toInt()
    ],
    validarErros,
    async (req, res, next) => {
        try {
            const pagina = req.query.pagina || 1;
            const limite = req.query.limite || 20;
            const cnpjEmpresa = req.empresa.cnpj;
            
            const resultado = await SefinService.listarTransmissoes(
                cnpjEmpresa,
                pagina,
                limite
            );
            
            res.json({
                sucesso: true,
                ...resultado
            });
            
        } catch (error) {
            next(error);
        }
    }
);

/**
 * GET /api/nfse/status
 * Status da empresa e última numeração
 */
router.get('/status', async (req, res, next) => {
    try {
        const sql = `
            SELECT 
                cnpj,
                razao_social,
                codigo_municipio,
                ultimo_numero_dps,
                serie_dps,
                tipo_ambiente,
                certificado_validade,
                certificado_pfx IS NOT NULL as tem_certificado,
                DATEDIFF(certificado_validade, CURDATE()) as dias_restantes_certificado
            FROM empresas
            WHERE id = ?
        `;
        
        const results = await query(sql, [req.empresa.id]);
        const empresa = results[0];
        
        let statusCertificado;
        if (!empresa.tem_certificado) {
            statusCertificado = 'pendente';
        } else if (empresa.dias_restantes_certificado <= 0) {
            statusCertificado = 'vencido';
        } else if (empresa.dias_restantes_certificado <= 30) {
            statusCertificado = 'próximo do vencimento';
        } else {
            statusCertificado = 'válido';
        }
        
        res.json({
            sucesso: true,
            empresa: {
                cnpj: empresa.cnpj,
                razaoSocial: empresa.razao_social,
                codigoMunicipio: empresa.codigo_municipio,
                ambiente: empresa.tipo_ambiente === '1' ? 'Produção' : 'Homologação',
                numeracao: {
                    serie: empresa.serie_dps,
                    ultimoNumero: empresa.ultimo_numero_dps,
                    proximoNumero: empresa.ultimo_numero_dps + 1
                },
                certificado: {
                    configurado: empresa.tem_certificado === 1,
                    validade: empresa.certificado_validade,
                    diasRestantes: empresa.dias_restantes_certificado,
                    status: statusCertificado
                }
            },
            podeEmitir: empresa.tem_certificado === 1 && empresa.dias_restantes_certificado > 0,
            acaoPendente: !empresa.tem_certificado 
                ? 'Envie seu certificado digital via POST /api/nfse/certificado' 
                : empresa.dias_restantes_certificado <= 0 
                    ? 'Seu certificado está vencido! Atualize via POST /api/nfse/certificado'
                    : null
        });
        
    } catch (error) {
        next(error);
    }
});

module.exports = router;