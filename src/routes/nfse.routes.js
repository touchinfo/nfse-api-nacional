const express = require('express');
const multer = require('multer');
const CryptoJS = require('crypto-js');
const forge = require('node-forge');
const { body, query: queryValidator, validationResult } = require('express-validator');
const XMLService = require('../services/xmlService');
const SefinService = require('../services/sefinService');
const SefinResponseProcessor = require('../services/sefinResponseProcessor');
const { query } = require('../config/database');

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
        
        const tipoAmbiente = req.empresa.tipo_ambiente;
        
        const resultado = await SefinService.consultarParametrosConvenio(
            codigoMunicipio,
            cnpjEmpresa,
            tipoAmbiente
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
            ambiente: tipoAmbiente === '1' ? 'Produção' : 'Homologação',
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
        body('xml').notEmpty().withMessage('XML é obrigatório'),
        body('tipoAmbiente').optional().isIn(['1', '2']).withMessage('Tipo de ambiente inválido'),
    ],
    validarErros,
    async (req, res, next) => {
        const inicioProcessamento = Date.now();
        
        try {
            const { xml, tipoAmbiente } = req.body;
            const cnpjEmpresa = req.empresa.cnpj;
            const empresaId = req.empresa.id;
            
            console.log('\n' + '='.repeat(70));
            console.log(`📝 NOVA EMISSÃO - Empresa: ${req.empresa.razao_social}`);
            console.log('='.repeat(70));
            
            // 1. Processa o XML
            const resultado = await XMLService.processarXML(xml, cnpjEmpresa);
            const ambienteEnvio = tipoAmbiente || req.empresa.tipo_ambiente;
            
            // 2. Envia para SEFIN
            const respostaSefin = await SefinService.enviarDPS(
                resultado.dpsXmlGZipB64,
                cnpjEmpresa,
                ambienteEnvio
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
            
            // 4. VERIFICAÇÃO DE DUPLICIDADE (E0014)
            let ehDuplicidadeRecuperavel = false;
            
            if (!respostaSefin.sucesso && respostaSefin.dados?.erros) {
                const erroE0014 = respostaSefin.dados.erros.find(e => 
                    e.Codigo === 'E0014' || e.Codigo === 'E174' || 
                    (e.Descricao && e.Descricao.includes('já existe'))
                );
                
                if (erroE0014) {
                    console.log('⚠️ Erro de Duplicidade detectado! Tentando recuperar nota existente...');
                    ehDuplicidadeRecuperavel = true;
                }
            }

            // 5. PROCESSAMENTO OU RECUPERAÇÃO
            let dadosNFSe = null;
            let mensagemUsuario = '';
            
            if (respostaSefin.sucesso || ehDuplicidadeRecuperavel) {
                console.log('\n🔍 Processando resposta completa...');
                
                if (ehDuplicidadeRecuperavel) {
                    console.log('🔧 Iniciando recuperação de nota duplicada...');
                    
                    const consultaChave = await SefinResponseProcessor.consultarChaveAcesso(
                        resultado.infoDPS.idDPS,
                        cnpjEmpresa,
                        ambienteEnvio
                    );
                    
                    if (consultaChave.sucesso && consultaChave.chaveAcesso) {
                        dadosNFSe = await SefinResponseProcessor.processarRespostaCompleta(
                            {
                                sucesso: true,
                                dados: {
                                    chaveAcesso: consultaChave.chaveAcesso,
                                    codigo: '100', 
                                    mensagem: 'Nota recuperada de duplicidade'
                                }
                            },
                            resultado.infoDPS,
                            cnpjEmpresa,
                            ambienteEnvio
                        );
                        mensagemUsuario = 'Nota Fiscal já constava na base de dados (Recuperada com sucesso)';
                    } else {
                        dadosNFSe = { 
                            sucesso: false, 
                            mensagem: 'Erro de duplicidade: Nota existe mas não foi possível recuperar a chave.' 
                        };
                        mensagemUsuario = dadosNFSe.mensagem;
                    }
                } else {
                    dadosNFSe = await SefinResponseProcessor.processarRespostaCompleta(
                        respostaSefin,
                        resultado.infoDPS,
                        cnpjEmpresa,
                        ambienteEnvio
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
            
            res.status(dadosNFSe.sucesso ? 200 : 400).json({
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
                    xmlNFSe: dadosNFSe.xmlNFSe
                },
                sefin: {
                    protocolo: dadosNFSe.protocolo,
                    mensagem: mensagemUsuario,
                    erros: dadosNFSe.erros || null
                },
                processamento: {
                    tempoTotal: `${tempoTotal}ms`,
                    ambiente: ambienteEnvio === '1' ? 'Produção' : 'Homologação'
                },
                recuperadoDeDuplicidade: ehDuplicidadeRecuperavel
            });
            
        } catch (error) {
            console.error('❌ Erro na emissão:', error.message);
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
 */
router.get('/consultar-por-chave/:chaveAcesso', verificarCertificado, async (req, res, next) => {
    try {
        const { chaveAcesso } = req.params;
        const cnpjEmpresa = req.empresa.cnpj;
        const tipoAmbiente = req.empresa.tipo_ambiente;
        
        console.log(`🔍 Consultando NFS-e por chave: ${chaveAcesso.substring(0, 20)}...`);
        
        if (!chaveAcesso || chaveAcesso.length !== 44) {
            return res.status(400).json({
                sucesso: false,
                erro: 'Chave de acesso inválida (deve ter 44 caracteres)'
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
 * GET /api/nfse/consultar/:idDPS
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